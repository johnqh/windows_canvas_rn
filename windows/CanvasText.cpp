#include "CanvasText.h"

#include <algorithm>

#include "PictureFormat.h"

#pragma comment(lib, "dwrite.lib")

namespace WindowsCanvas {

using namespace Format;

std::wstring Wide(const std::string &utf8) {
  const auto converted = winrt::to_hstring(utf8);
  return std::wstring{converted.c_str(), converted.size()};
}

D2D1_COLOR_F UnpackColor(double packed) noexcept {
  const auto value = static_cast<uint32_t>(std::max(0.0, std::min(packed, 4294967295.0)));
  return D2D1::ColorF(((value >> 24) & 0xff) / 255.0f, ((value >> 16) & 0xff) / 255.0f,
                      ((value >> 8) & 0xff) / 255.0f, (value & 0xff) / 255.0f);
}

IDWriteFactory *SharedDWriteFactory() noexcept {
  static winrt::com_ptr<IDWriteFactory> factory = [] {
    winrt::com_ptr<IDWriteFactory> created;
    DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory),
                        reinterpret_cast<IUnknown **>(created.put()));
    return created;
  }();
  return factory.get();
}

namespace {

DWRITE_FONT_STYLE Style(int style) noexcept {
  return style == FontStyle::Italic    ? DWRITE_FONT_STYLE_ITALIC
      : style == FontStyle::Oblique    ? DWRITE_FONT_STYLE_OBLIQUE
                                       : DWRITE_FONT_STYLE_NORMAL;
}

std::string Key(const TextSpec &spec) {
  return spec.family + '|' + std::to_string(spec.size) + '|' + std::to_string(spec.weight) + '|' +
      std::to_string(spec.style) + '|' + std::to_string(spec.stretch) + '|' + (spec.rtl ? "r" : "l");
}

// The OpenType features a canvas's fontKerning and fontVariantCaps ask for.
winrt::com_ptr<IDWriteTypography> Typography(const TextSpec &spec) noexcept {
  std::vector<DWRITE_FONT_FEATURE> features;
  if (spec.kerning == Kerning::None) features.push_back({DWRITE_FONT_FEATURE_TAG_KERNING, 0});
  switch (spec.variantCaps) {
    case VariantCaps::SmallCaps:
      features.push_back({DWRITE_FONT_FEATURE_TAG_SMALL_CAPITALS, 1});
      break;
    case VariantCaps::AllSmallCaps:
      features.push_back({DWRITE_FONT_FEATURE_TAG_SMALL_CAPITALS, 1});
      features.push_back({DWRITE_FONT_FEATURE_TAG_SMALL_CAPITALS_FROM_CAPITALS, 1});
      break;
    case VariantCaps::PetiteCaps:
      features.push_back({DWRITE_FONT_FEATURE_TAG_PETITE_CAPITALS, 1});
      break;
    case VariantCaps::AllPetiteCaps:
      features.push_back({DWRITE_FONT_FEATURE_TAG_PETITE_CAPITALS, 1});
      features.push_back({DWRITE_FONT_FEATURE_TAG_PETITE_CAPITALS_FROM_CAPITALS, 1});
      break;
    case VariantCaps::Unicase:
      features.push_back({DWRITE_FONT_FEATURE_TAG_UNICASE, 1});
      break;
    case VariantCaps::TitlingCaps:
      features.push_back({DWRITE_FONT_FEATURE_TAG_TITLING, 1});
      break;
    default:
      break;
  }
  if (features.empty()) return nullptr;
  winrt::com_ptr<IDWriteTypography> typography;
  if (FAILED(SharedDWriteFactory()->CreateTypography(typography.put()))) return nullptr;
  for (const auto &feature : features) typography->AddFontFeature(feature);
  return typography;
}

// Collects the glyph outlines a layout would draw, as geometry.
struct OutlineCollector : winrt::implements<OutlineCollector, IDWriteTextRenderer> {
  explicit OutlineCollector(ID2D1Factory *factory) : m_factory(factory) {}

  IFACEMETHODIMP IsPixelSnappingDisabled(void *, BOOL *disabled) noexcept override {
    *disabled = TRUE;
    return S_OK;
  }
  IFACEMETHODIMP GetCurrentTransform(void *, DWRITE_MATRIX *transform) noexcept override {
    *transform = DWRITE_MATRIX{1, 0, 0, 1, 0, 0};
    return S_OK;
  }
  IFACEMETHODIMP GetPixelsPerDip(void *, FLOAT *pixelsPerDip) noexcept override {
    *pixelsPerDip = 1;
    return S_OK;
  }
  IFACEMETHODIMP DrawGlyphRun(void *, FLOAT baselineX, FLOAT baselineY, DWRITE_MEASURING_MODE,
                              const DWRITE_GLYPH_RUN *run, const DWRITE_GLYPH_RUN_DESCRIPTION *,
                              IUnknown *) noexcept override {
    winrt::com_ptr<ID2D1PathGeometry> path;
    winrt::com_ptr<ID2D1GeometrySink> sink;
    if (FAILED(m_factory->CreatePathGeometry(path.put())) || FAILED(path->Open(sink.put()))) return S_OK;
    run->fontFace->GetGlyphRunOutline(run->fontEmSize, run->glyphIndices, run->glyphAdvances,
                                      run->glyphOffsets, run->glyphCount, run->isSideways,
                                      run->bidiLevel % 2 == 1, sink.get());
    sink->Close();
    winrt::com_ptr<ID2D1TransformedGeometry> moved;
    if (SUCCEEDED(m_factory->CreateTransformedGeometry(
            path.get(), D2D1::Matrix3x2F::Translation(baselineX, baselineY), moved.put()))) {
      m_parts.push_back(moved);
    }
    return S_OK;
  }
  IFACEMETHODIMP DrawUnderline(void *, FLOAT, FLOAT, const DWRITE_UNDERLINE *, IUnknown *) noexcept override {
    return S_OK;
  }
  IFACEMETHODIMP DrawStrikethrough(void *, FLOAT, FLOAT, const DWRITE_STRIKETHROUGH *, IUnknown *) noexcept override {
    return S_OK;
  }
  IFACEMETHODIMP DrawInlineObject(void *, FLOAT, FLOAT, IDWriteInlineObject *, BOOL, BOOL, IUnknown *) noexcept override {
    return S_OK;
  }

  winrt::com_ptr<ID2D1Geometry> Geometry() noexcept {
    std::vector<ID2D1Geometry *> raw;
    for (auto &part : m_parts) raw.push_back(part.get());
    winrt::com_ptr<ID2D1GeometryGroup> group;
    if (FAILED(m_factory->CreateGeometryGroup(D2D1_FILL_MODE_WINDING, raw.data(),
                                              static_cast<UINT32>(raw.size()), group.put()))) {
      return nullptr;
    }
    return group.as<ID2D1Geometry>();
  }

 private:
  ID2D1Factory *m_factory;
  std::vector<winrt::com_ptr<ID2D1TransformedGeometry>> m_parts;
};

} // namespace

std::wstring TextEngine::ResolveFamily(const std::string &list) noexcept {
  if (auto found = m_families.find(list); found != m_families.end()) return found->second;
  winrt::com_ptr<IDWriteFontCollection> fonts;
  SharedDWriteFactory()->GetSystemFontCollection(fonts.put());
  std::wstring chosen;
  size_t start = 0;
  while (start <= list.size()) {
    const auto end = list.find(',', start);
    auto name = Wide(list.substr(start, end == std::string::npos ? std::string::npos : end - start));
    name.erase(0, name.find_first_not_of(L" "));
    name.erase(name.find_last_not_of(L" ") + 1);
    UINT32 index = 0;
    BOOL exists = FALSE;
    if (!name.empty() && fonts && SUCCEEDED(fonts->FindFamilyName(name.c_str(), &index, &exists)) && exists) {
      chosen = name;
      break;
    }
    if (chosen.empty() && !name.empty() && start == 0) chosen = name; // DirectWrite falls back from it
    if (end == std::string::npos) break;
    start = end + 1;
  }
  if (chosen.empty()) chosen = L"Segoe UI";
  if (m_families.size() > 256) m_families.clear();
  m_families.emplace(list, chosen);
  return chosen;
}

IDWriteTextFormat *TextEngine::Format(const TextSpec &spec) noexcept {
  const auto key = Key(spec);
  if (auto found = m_formats.find(key); found != m_formats.end()) return found->second.get();
  if (!(spec.size > 0)) return nullptr;
  winrt::com_ptr<IDWriteTextFormat> format;
  const auto family = ResolveFamily(spec.family);
  if (FAILED(SharedDWriteFactory()->CreateTextFormat(
          family.c_str(), nullptr, static_cast<DWRITE_FONT_WEIGHT>(std::clamp(spec.weight, 1, 999)),
          Style(spec.style), static_cast<DWRITE_FONT_STRETCH>(std::clamp(spec.stretch, 1, 9)),
          spec.size, L"", format.put()))) {
    return nullptr;
  }
  format->SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
  if (spec.rtl) format->SetReadingDirection(DWRITE_READING_DIRECTION_RIGHT_TO_LEFT);
  if (m_formats.size() > 256) m_formats.clear();
  return m_formats.emplace(key, std::move(format)).first->second.get();
}

DWRITE_FONT_METRICS TextEngine::Metrics(const std::wstring &family, const TextSpec &spec) noexcept {
  const auto key = Key(spec);
  if (auto found = m_metrics.find(key); found != m_metrics.end()) return found->second;
  // Segoe UI's, if the family cannot be found.
  DWRITE_FONT_METRICS metrics{2048, 2210, 514, 0, 0, 0, 0, 0, 0, 0};
  winrt::com_ptr<IDWriteFontCollection> fonts;
  UINT32 index = 0;
  BOOL exists = FALSE;
  if (SUCCEEDED(SharedDWriteFactory()->GetSystemFontCollection(fonts.put())) &&
      SUCCEEDED(fonts->FindFamilyName(family.c_str(), &index, &exists)) && exists) {
    winrt::com_ptr<IDWriteFontFamily> fontFamily;
    winrt::com_ptr<IDWriteFont> font;
    if (SUCCEEDED(fonts->GetFontFamily(index, fontFamily.put())) &&
        SUCCEEDED(fontFamily->GetFirstMatchingFont(
            static_cast<DWRITE_FONT_WEIGHT>(std::clamp(spec.weight, 1, 999)),
            static_cast<DWRITE_FONT_STRETCH>(std::clamp(spec.stretch, 1, 9)), Style(spec.style),
            font.put()))) {
      font->GetMetrics(&metrics);
    }
  }
  if (m_metrics.size() > 256) m_metrics.clear();
  m_metrics.emplace(key, metrics);
  return metrics;
}

TextLine TextEngine::Lay(const TextSpec &spec, const std::string &text) noexcept {
  TextLine line;
  auto *format = Format(spec);
  auto *factory = SharedDWriteFactory();
  if (!format || !factory) return line;
  const auto wide = Wide(text);
  const auto length = static_cast<UINT32>(wide.size());
  if (FAILED(factory->CreateTextLayout(wide.c_str(), length, format, 100000.0f, 100000.0f,
                                       line.layout.put()))) {
    line.layout = nullptr;
    return line;
  }
  const DWRITE_TEXT_RANGE all{0, length};
  if (auto typography = Typography(spec)) line.layout->SetTypography(typography.get(), all);
  if (spec.letterSpacing != 0 || spec.wordSpacing != 0) {
    if (auto spaced = line.layout.try_as<IDWriteTextLayout1>()) {
      if (spec.letterSpacing != 0) spaced->SetCharacterSpacing(0, spec.letterSpacing, 0, all);
      if (spec.wordSpacing != 0) {
        for (UINT32 i = 0; i < length; ++i) {
          if (wide[i] == L' ') {
            spaced->SetCharacterSpacing(0, spec.letterSpacing + spec.wordSpacing, 0, {i, 1});
          }
        }
      }
    }
  }

  DWRITE_TEXT_METRICS metrics{};
  line.layout->GetMetrics(&metrics);
  line.width = metrics.widthIncludingTrailingWhitespace;
  DWRITE_LINE_METRICS lineMetrics{};
  UINT32 lines = 0;
  line.layout->GetLineMetrics(&lineMetrics, 1, &lines);
  line.height = lines > 0 ? lineMetrics.height : metrics.height;
  line.baseline = lines > 0 ? lineMetrics.baseline : spec.size * 0.8f;
  // The box is exactly the text, so its left edge is the text's start whichever
  // way it reads, and the overhangs below are measured against the ink.
  line.layout->SetMaxWidth(std::max(line.width, 0.001f));
  line.layout->SetMaxHeight(std::max(line.height, 0.001f));

  DWRITE_OVERHANG_METRICS overhang{};
  line.layout->GetOverhangMetrics(&overhang);
  line.inkLeft = -overhang.left;
  line.inkRight = line.width + overhang.right;
  line.inkAscent = line.baseline + overhang.top;
  line.inkDescent = (line.height - line.baseline) + overhang.bottom;

  const auto font = Metrics(ResolveFamily(spec.family), spec);
  const float units = font.designUnitsPerEm > 0 ? font.designUnitsPerEm : 2048.0f;
  line.fontAscent = spec.size * font.ascent / units;
  line.fontDescent = spec.size * font.descent / units;
  const float total = static_cast<float>(font.ascent + font.descent);
  line.emAscent = total > 0 ? spec.size * font.ascent / total : spec.size * 0.8f;
  line.emDescent = spec.size - line.emAscent;
  line.hanging = line.emAscent * 0.8f;
  return line;
}

winrt::com_ptr<ID2D1Geometry> TextEngine::Outline(ID2D1Factory *factory, const TextLine &line, float x, float y) noexcept {
  if (!line.layout || !factory) return nullptr;
  auto collector = winrt::make_self<OutlineCollector>(factory);
  if (FAILED(line.layout->Draw(nullptr, collector.get(), x, y))) return nullptr;
  return collector->Geometry();
}

} // namespace WindowsCanvas
