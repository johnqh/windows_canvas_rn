#include "CanvasReplay.h"

#include <algorithm>
#include <cmath>

#include <winrt/Windows.Data.Json.h>

#include "CanvasImages.h"
#include "PictureFormat.h"

#pragma comment(lib, "d2d1.lib")
#pragma comment(lib, "dxguid.lib")

namespace WindowsCanvas {

using namespace Format;
using winrt::com_ptr;

namespace {

constexpr int kMaxNesting = 4;
constexpr float kPi = 3.14159265358979323846f;

D2D1::Matrix3x2F Inverse(D2D1::Matrix3x2F m) noexcept {
  return m.Invert() ? m : D2D1::Matrix3x2F::Identity();
}

/** A CSS filter's colour matrix, rows of outputs → D2D's rows of inputs. */
D2D1_MATRIX_5X4_F ColorMatrix(const float (&rgb)[3][3], float offset = 0) noexcept {
  D2D1_MATRIX_5X4_F m{};
  for (int out = 0; out < 3; ++out) {
    for (int in = 0; in < 3; ++in) m.m[in][out] = rgb[out][in];
    m.m[4][out] = offset;
  }
  m.m[3][3] = 1;
  return m;
}

D2D1_MATRIX_5X4_F Scale(float r, float g, float b, float a, float offset = 0) noexcept {
  D2D1_MATRIX_5X4_F m{};
  m.m[0][0] = r;
  m.m[1][1] = g;
  m.m[2][2] = b;
  m.m[3][3] = a;
  m.m[4][0] = m.m[4][1] = m.m[4][2] = offset;
  return m;
}

D2D1_COMPOSITE_MODE PorterDuff(int composite, bool &found) noexcept {
  found = true;
  switch (composite) {
    case Composite::SourceIn: return D2D1_COMPOSITE_MODE_SOURCE_IN;
    case Composite::SourceOut: return D2D1_COMPOSITE_MODE_SOURCE_OUT;
    case Composite::SourceAtop: return D2D1_COMPOSITE_MODE_SOURCE_ATOP;
    case Composite::DestinationOver: return D2D1_COMPOSITE_MODE_DESTINATION_OVER;
    case Composite::DestinationIn: return D2D1_COMPOSITE_MODE_DESTINATION_IN;
    case Composite::DestinationOut: return D2D1_COMPOSITE_MODE_DESTINATION_OUT;
    case Composite::DestinationAtop: return D2D1_COMPOSITE_MODE_DESTINATION_ATOP;
    case Composite::Lighter: return D2D1_COMPOSITE_MODE_PLUS;
    case Composite::Copy: return D2D1_COMPOSITE_MODE_SOURCE_COPY;
    case Composite::Xor: return D2D1_COMPOSITE_MODE_XOR;
    case Composite::SourceOver: return D2D1_COMPOSITE_MODE_SOURCE_OVER;
    default: found = false; return D2D1_COMPOSITE_MODE_SOURCE_OVER;
  }
}

D2D1_BLEND_MODE Blend(int composite) noexcept {
  switch (composite) {
    case Composite::Multiply: return D2D1_BLEND_MODE_MULTIPLY;
    case Composite::Screen: return D2D1_BLEND_MODE_SCREEN;
    case Composite::Overlay: return D2D1_BLEND_MODE_OVERLAY;
    case Composite::Darken: return D2D1_BLEND_MODE_DARKEN;
    case Composite::Lighten: return D2D1_BLEND_MODE_LIGHTEN;
    case Composite::ColorDodge: return D2D1_BLEND_MODE_COLOR_DODGE;
    case Composite::ColorBurn: return D2D1_BLEND_MODE_COLOR_BURN;
    case Composite::HardLight: return D2D1_BLEND_MODE_HARD_LIGHT;
    case Composite::SoftLight: return D2D1_BLEND_MODE_SOFT_LIGHT;
    case Composite::Difference: return D2D1_BLEND_MODE_DIFFERENCE;
    case Composite::Exclusion: return D2D1_BLEND_MODE_EXCLUSION;
    case Composite::Hue: return D2D1_BLEND_MODE_HUE;
    case Composite::Saturation: return D2D1_BLEND_MODE_SATURATION;
    case Composite::Color: return D2D1_BLEND_MODE_COLOR;
    default: return D2D1_BLEND_MODE_LUMINOSITY;
  }
}

/** Parsed nested pictures (`picture;{json}`), by source. UI thread only. */
struct NestedPicture {
  float width = 0;
  float height = 0;
  std::vector<double> ops;
  std::vector<std::string> strings;
};

const NestedPicture *ParseNested(const std::string &source) noexcept {
  static std::unordered_map<std::string, NestedPicture> parsed;
  if (auto found = parsed.find(source); found != parsed.end()) return &found->second;
  NestedPicture picture;
  try {
    using namespace winrt::Windows::Data::Json;
    const auto json = JsonObject::Parse(winrt::to_hstring(source.substr(8)));
    picture.width = static_cast<float>(json.GetNamedNumber(L"width", 0));
    picture.height = static_cast<float>(json.GetNamedNumber(L"height", 0));
    for (const auto &value : json.GetNamedArray(L"ops")) picture.ops.push_back(value.GetNumber());
    for (const auto &value : json.GetNamedArray(L"strings")) {
      picture.strings.push_back(winrt::to_string(value.GetString()));
    }
  } catch (...) {
    return nullptr;
  }
  if (parsed.size() > 64) parsed.clear();
  return &parsed.emplace(source, std::move(picture)).first->second;
}

} // namespace

// ---- reading -----------------------------------------------------------------

class Replayer::Reader {
 public:
  explicit Reader(const std::vector<double> &ops) : m_ops(ops) {}
  bool More() const noexcept { return m_at < m_ops.size(); }
  double Next() noexcept { return m_at < m_ops.size() ? m_ops[m_at++] : 0.0; }
  float Float() noexcept { return static_cast<float>(Next()); }
  int Int() noexcept { return static_cast<int>(Next()); }
  D2D1::Matrix3x2F Matrix() noexcept {
    // One read per statement: argument evaluation order is unspecified.
    float m[6];
    for (auto &value : m) value = Float();
    return D2D1::Matrix3x2F(m[0], m[1], m[2], m[3], m[4], m[5]);
  }

 private:
  const std::vector<double> &m_ops;
  size_t m_at = 0;
};

struct Replayer::PaintSpec {
  int kind = Paint::Solid;
  float alpha = 1;
  D2D1_COLOR_F color{0, 0, 0, 1};
  float geometry[6]{}; // linear: x0 y0 x1 y1; radial: x0 y0 r0 x1 y1 r1; conic: angle x y
  D2D1::Matrix3x2F matrix = D2D1::Matrix3x2F::Identity();
  std::vector<std::pair<float, D2D1_COLOR_F>> stops;
  std::string image;
  int repetition = Repetition::Repeat;
  float imageWidth = 0;
  float imageHeight = 0;
  bool valid = true;
};

struct Replayer::StrokeSpec {
  float width = 1;
  int cap = LineCap::Butt;
  int join = LineJoin::Miter;
  float miterLimit = 10;
  std::vector<float> dashes;
  float dashOffset = 0;
};

Replayer::Replayer(ID2D1DeviceContext *context, ID2D1Bitmap1 *target, TextEngine &text, DeviceCaches &caches,
                   std::function<void()> requestRedraw, int depth) noexcept
    : m_dc(context), m_target(target), m_text(text), m_caches(caches),
      m_requestRedraw(std::move(requestRedraw)), m_depth(depth) {
  com_ptr<ID2D1Factory> factory;
  m_dc->GetFactory(factory.put());
  m_factory = factory.try_as<ID2D1Factory1>();
}

Replayer::PaintSpec Replayer::ReadPaint(Reader &reader) noexcept {
  PaintSpec paint;
  paint.kind = reader.Int();
  paint.alpha = reader.Float();
  auto readStops = [&]() {
    const int count = std::max(0, reader.Int());
    for (int i = 0; i < count; ++i) {
      const float offset = reader.Float();
      paint.stops.emplace_back(offset, UnpackColor(reader.Next()));
    }
  };
  switch (paint.kind) {
    case Paint::Solid:
      paint.color = UnpackColor(reader.Next());
      break;
    case Paint::Linear:
      for (int i = 0; i < 4; ++i) paint.geometry[i] = reader.Float();
      paint.matrix = reader.Matrix();
      readStops();
      break;
    case Paint::Radial:
      for (int i = 0; i < 6; ++i) paint.geometry[i] = reader.Float();
      paint.matrix = reader.Matrix();
      readStops();
      break;
    case Paint::Conic:
      for (int i = 0; i < 3; ++i) paint.geometry[i] = reader.Float();
      paint.matrix = reader.Matrix();
      readStops();
      break;
    case Paint::Pattern: {
      const int index = reader.Int();
      paint.image = index >= 0 && static_cast<size_t>(index) < m_strings->size() ? (*m_strings)[index] : "";
      paint.repetition = reader.Int();
      paint.imageWidth = reader.Float();
      paint.imageHeight = reader.Float();
      paint.matrix = reader.Matrix();
      break;
    }
    default:
      paint.valid = false;
  }
  return paint;
}

Replayer::StrokeSpec Replayer::ReadStroke(Reader &reader) noexcept {
  StrokeSpec stroke;
  stroke.width = reader.Float();
  stroke.cap = reader.Int();
  stroke.join = reader.Int();
  stroke.miterLimit = reader.Float();
  const int count = std::max(0, reader.Int());
  for (int i = 0; i < count; ++i) stroke.dashes.push_back(reader.Float());
  stroke.dashOffset = reader.Float();
  return stroke;
}

com_ptr<ID2D1PathGeometry> Replayer::ReadPath(Reader &reader, int fillRule) noexcept {
  const int count = reader.Int();
  com_ptr<ID2D1PathGeometry> geometry;
  com_ptr<ID2D1GeometrySink> sink;
  const bool ok = m_factory && SUCCEEDED(m_factory->CreatePathGeometry(geometry.put())) &&
      SUCCEEDED(geometry->Open(sink.put()));
  if (ok) {
    sink->SetFillMode(fillRule == FillRule::EvenOdd ? D2D1_FILL_MODE_ALTERNATE : D2D1_FILL_MODE_WINDING);
  }
  bool open = false;
  for (int i = 0; i < count && reader.More(); ++i) {
    switch (reader.Int()) {
      case Segment::Move: {
        const float x = reader.Float();
        const float y = reader.Float();
        if (!ok) break;
        if (open) sink->EndFigure(D2D1_FIGURE_END_OPEN);
        sink->BeginFigure({x, y}, D2D1_FIGURE_BEGIN_FILLED);
        open = true;
        break;
      }
      case Segment::Line: {
        const float x = reader.Float();
        const float y = reader.Float();
        if (ok && open) sink->AddLine({x, y});
        break;
      }
      case Segment::Quad: {
        float p[4];
        for (auto &value : p) value = reader.Float();
        if (ok && open) sink->AddQuadraticBezier(D2D1::QuadraticBezierSegment({p[0], p[1]}, {p[2], p[3]}));
        break;
      }
      case Segment::Cubic: {
        float p[6];
        for (auto &value : p) value = reader.Float();
        if (ok && open) sink->AddBezier(D2D1::BezierSegment({p[0], p[1]}, {p[2], p[3]}, {p[4], p[5]}));
        break;
      }
      case Segment::Close:
        if (ok && open) sink->EndFigure(D2D1_FIGURE_END_CLOSED);
        open = false;
        break;
      default:
        break;
    }
  }
  if (!ok) return nullptr;
  if (open) sink->EndFigure(D2D1_FIGURE_END_OPEN);
  sink->Close();
  return geometry;
}

// ---- the op loop ---------------------------------------------------------------

void Replayer::Run(const std::vector<double> &ops, const std::vector<std::string> &strings) noexcept {
  m_strings = &strings;
  Reader reader(ops);
  if (!reader.More() || reader.Int() != kVersion || !m_factory) return;
  m_dc->SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
  const auto text = [&strings](int index) -> std::string {
    return index >= 0 && static_cast<size_t>(index) < strings.size() ? strings[index] : std::string{};
  };

  while (reader.More()) {
    switch (reader.Int()) {
      case Op::Fill: {
        const int rule = reader.Int();
        const auto paint = ReadPaint(reader);
        auto geometry = ReadPath(reader, rule);
        if (!geometry || !paint.valid) break;
        if (paint.kind == Paint::Pattern) Bitmap(paint.image);
        Draw([&] { FillGeometry(geometry.get(), paint, D2D1::Matrix3x2F::Identity()); });
        break;
      }
      case Op::Stroke: {
        const auto paint = ReadPaint(reader);
        const auto stroke = ReadStroke(reader);
        const auto matrix = reader.Matrix();
        auto geometry = ReadPath(reader, FillRule::NonZero);
        if (!geometry || !paint.valid || !(stroke.width > 0)) break;
        if (paint.kind == Paint::Pattern) {
          Bitmap(paint.image);
          auto widened = Widen(geometry.get(), stroke);
          if (widened) Draw([&] { FillWithPattern(widened.get(), paint, matrix); });
          break;
        }
        auto style = MakeStrokeStyle(stroke);
        Draw([&] {
          auto brush = MakeBrush(paint, matrix);
          if (!brush) return;
          m_dc->SetTransform(matrix);
          m_dc->DrawGeometry(geometry.get(), brush.get(), stroke.width, style.get());
        });
        break;
      }
      case Op::Text: {
        const int mode = reader.Int();
        const auto paint = ReadPaint(reader);
        StrokeSpec stroke;
        if (mode == 1) stroke = ReadStroke(reader);
        TextSpec spec;
        const auto content = text(reader.Int());
        spec.family = text(reader.Int());
        spec.size = reader.Float();
        spec.weight = reader.Int();
        spec.style = reader.Int();
        spec.stretch = reader.Int();
        spec.rtl = reader.Int() != 0;
        spec.letterSpacing = reader.Float();
        spec.wordSpacing = reader.Float();
        spec.kerning = reader.Int();
        spec.variantCaps = reader.Int();
        const int rendering = reader.Int();
        const auto matrix = reader.Matrix();
        const float x = reader.Float();
        const float y = reader.Float();
        if (!paint.valid) break;
        const auto line = m_text.Lay(spec, content);
        if (!line.layout) break;
        const D2D1_POINT_2F origin{x, y - line.baseline};
        if (paint.kind == Paint::Pattern) Bitmap(paint.image);
        if (mode == 1 || paint.kind == Paint::Pattern) {
          auto outline = m_text.Outline(m_factory.get(), line, origin.x, origin.y);
          if (!outline) break;
          if (mode == 1 && paint.kind != Paint::Pattern) {
            auto style = MakeStrokeStyle(stroke);
            Draw([&] {
              auto brush = MakeBrush(paint, matrix);
              if (!brush) return;
              m_dc->SetTransform(matrix);
              m_dc->DrawGeometry(outline.get(), brush.get(), stroke.width, style.get());
            });
          } else {
            auto shape = mode == 1 ? Widen(outline.get(), stroke) : outline;
            if (shape) Draw([&] { FillWithPattern(shape.get(), paint, matrix); });
          }
          break;
        }
        Draw([&] {
          auto brush = MakeBrush(paint, matrix);
          if (!brush) return;
          m_dc->SetTransform(matrix);
          // Colour fonts on, so an emoji keeps its colours as it does on a
          // browser canvas; geometric precision turns off pixel snapping.
          auto options = D2D1_DRAW_TEXT_OPTIONS_ENABLE_COLOR_FONT;
          if (rendering == TextRendering::GeometricPrecision) {
            options = options | D2D1_DRAW_TEXT_OPTIONS_NO_SNAP;
          }
          m_dc->DrawTextLayout(origin, line.layout.get(), brush.get(), options);
        });
        break;
      }
      case Op::Image: {
        const auto source = text(reader.Int());
        const float alpha = reader.Float();
        const float declaredWidth = reader.Float();
        const float declaredHeight = reader.Float();
        float r[8];
        for (auto &value : r) value = reader.Float();
        const auto matrix = reader.Matrix();
        auto bitmap = Bitmap(source);
        if (!bitmap || !(declaredWidth > 0) || !(declaredHeight > 0)) break;
        // The source rectangle is in the units the image was placed with (an
        // asset's logical size); the bitmap may have more pixels than that.
        const auto size = bitmap->GetSize();
        const float kx = size.width / declaredWidth;
        const float ky = size.height / declaredHeight;
        const auto sourceRect = D2D1::RectF(r[0] * kx, r[1] * ky, (r[0] + r[2]) * kx, (r[1] + r[3]) * ky);
        const auto destination = D2D1::RectF(r[4], r[5], r[4] + r[6], r[5] + r[7]);
        Draw([&] {
          m_dc->SetTransform(matrix);
          m_dc->DrawBitmap(bitmap.get(), destination, alpha, Interpolation(), &sourceRect);
        });
        break;
      }
      case Op::Clear: {
        auto geometry = ReadPath(reader, FillRule::NonZero);
        if (!geometry) break;
        if (m_clips.empty()) {
          // Nothing clips it: erase in place.
          PopClips();
          com_ptr<ID2D1SolidColorBrush> clear;
          m_dc->CreateSolidColorBrush(D2D1::ColorF(0, 0, 0, 0), clear.put());
          m_dc->SetTransform(D2D1::Matrix3x2F::Identity());
          m_dc->SetPrimitiveBlend(D2D1_PRIMITIVE_BLEND_COPY);
          m_dc->FillGeometry(geometry.get(), clear.get());
          m_dc->SetPrimitiveBlend(D2D1_PRIMITIVE_BLEND_SOURCE_OVER);
          break;
        }
        PopClips();
        auto destination = CopyTarget();
        auto mask = ClipMask(geometry.get());
        if (!destination || !mask) break;
        auto cleared = Effect(CLSID_D2D1Composite, {destination.get(), mask.get()}, [](ID2D1Effect *effect) {
          effect->SetValue(D2D1_COMPOSITE_PROP_MODE, D2D1_COMPOSITE_MODE_DESTINATION_OUT);
        });
        if (!cleared) break;
        m_dc->SetTransform(D2D1::Matrix3x2F::Identity());
        m_dc->DrawImage(cleared.get(), D2D1_INTERPOLATION_MODE_NEAREST_NEIGHBOR,
                        D2D1_COMPOSITE_MODE_SOURCE_COPY);
        break;
      }
      case Op::Clip: {
        const int rule = reader.Int();
        auto geometry = ReadPath(reader, rule);
        if (geometry) m_clips.push_back(geometry.as<ID2D1Geometry>());
        break;
      }
      case Op::PopClip: {
        for (int count = reader.Int(); count > 0 && !m_clips.empty(); --count) {
          if (m_pushed == m_clips.size()) {
            m_dc->PopLayer();
            --m_pushed;
          }
          m_clips.pop_back();
        }
        break;
      }
      case Op::PutImage: {
        const auto source = text(reader.Int());
        float p[6];
        for (auto &value : p) value = reader.Float();
        // Raw pixels, unaffected by the clip, the alpha, the composite and
        // the transform.
        auto bitmap = Bitmap(source);
        if (!bitmap) break;
        PopClips();
        m_dc->SetTransform(D2D1::Matrix3x2F::Identity());
        const auto region = D2D1::RectF(p[2], p[3], p[2] + p[4], p[3] + p[5]);
        m_dc->DrawImage(bitmap.get(), D2D1::Point2F(p[0] + p[2], p[1] + p[3]), region,
                        D2D1_INTERPOLATION_MODE_NEAREST_NEIGHBOR, D2D1_COMPOSITE_MODE_BOUNDED_SOURCE_COPY);
        break;
      }
      case Op::SetComposite:
        m_composite = reader.Int();
        break;
      case Op::SetShadow:
        m_shadowColor = UnpackColor(reader.Next());
        m_shadowBlur = reader.Float();
        m_shadowX = reader.Float();
        m_shadowY = reader.Float();
        break;
      case Op::SetFilter: {
        m_filter.clear();
        const int count = reader.Int();
        for (int i = 0; i < count && reader.More(); ++i) {
          const int kind = reader.Int();
          m_filter.push_back(kind);
          const int arguments = kind == Filter::DropShadow ? 4 : 1;
          for (int a = 0; a < arguments; ++a) m_filter.push_back(reader.Next());
        }
        break;
      }
      case Op::SetSmoothing:
        m_smoothing = reader.Int() != 0;
        m_quality = reader.Int();
        break;
      default:
        // An op this build does not know: nothing after it can be read.
        PopClips();
        return;
    }
  }
  PopClips();
  m_dc->SetTransform(D2D1::Matrix3x2F::Identity());
}

// ---- compositing ----------------------------------------------------------------

void Replayer::PushClips() noexcept {
  m_dc->SetTransform(D2D1::Matrix3x2F::Identity());
  for (; m_pushed < m_clips.size(); ++m_pushed) {
    m_dc->PushLayer(D2D1::LayerParameters1(D2D1::InfiniteRect(), m_clips[m_pushed].get(),
                                           D2D1_ANTIALIAS_MODE_PER_PRIMITIVE),
                    nullptr);
  }
}

void Replayer::PopClips() noexcept {
  for (; m_pushed > 0; --m_pushed) m_dc->PopLayer();
}

void Replayer::Draw(const std::function<void()> &primitive) noexcept {
  const bool shadow = m_shadowColor.a > 0;
  if (m_composite == Composite::SourceOver && !shadow && m_filter.empty()) {
    PushClips();
    primitive();
    return;
  }
  PopClips();
  auto image = Record(primitive);
  if (!image) return;
  image = ApplyFilter(image);
  if (!image) return;
  if (shadow) {
    // Blurred by half the canvas's shadowBlur, as the spec defines it.
    if (auto cast = ShadowOf(image.get(), m_shadowColor, m_shadowBlur / 2, m_shadowX, m_shadowY)) {
      CompositeImage(cast.get());
    }
  }
  CompositeImage(image.get());
}

com_ptr<ID2D1Image> Replayer::Record(const std::function<void()> &primitive) noexcept {
  com_ptr<ID2D1CommandList> list;
  if (FAILED(m_dc->CreateCommandList(list.put()))) return nullptr;
  com_ptr<ID2D1Image> previous;
  m_dc->GetTarget(previous.put());
  m_dc->SetTarget(list.get());
  primitive();
  m_dc->SetTarget(previous.get());
  list->Close();
  return list.as<ID2D1Image>();
}

com_ptr<ID2D1Image> Replayer::Effect(const CLSID &id, std::initializer_list<ID2D1Image *> inputs,
                                     const std::function<void(ID2D1Effect *)> &configure) noexcept {
  com_ptr<ID2D1Effect> effect;
  if (FAILED(m_dc->CreateEffect(id, effect.put()))) return nullptr;
  effect->SetInputCount(static_cast<UINT32>(inputs.size()));
  UINT32 index = 0;
  for (auto *input : inputs) effect->SetInput(index++, input);
  if (configure) configure(effect.get());
  com_ptr<ID2D1Image> output;
  effect->GetOutput(output.put());
  return output;
}

com_ptr<ID2D1Image> Replayer::ShadowOf(ID2D1Image *image, D2D1_COLOR_F color, float deviation, float dx,
                                       float dy) noexcept {
  auto shadow = Effect(CLSID_D2D1Shadow, {image}, [&](ID2D1Effect *effect) {
    effect->SetValue(D2D1_SHADOW_PROP_BLUR_STANDARD_DEVIATION, std::max(0.0f, deviation));
    effect->SetValue(D2D1_SHADOW_PROP_COLOR, D2D1::Vector4F(color.r, color.g, color.b, color.a));
  });
  if (!shadow) return nullptr;
  return Effect(CLSID_D2D12DAffineTransform, {shadow.get()}, [&](ID2D1Effect *effect) {
    effect->SetValue(D2D1_2DAFFINETRANSFORM_PROP_TRANSFORM_MATRIX, D2D1::Matrix3x2F::Translation(dx, dy));
  });
}

com_ptr<ID2D1Image> Replayer::ApplyFilter(com_ptr<ID2D1Image> image) noexcept {
  size_t i = 0;
  while (image && i < m_filter.size()) {
    const int kind = static_cast<int>(m_filter[i]);
    const float amount = static_cast<float>(m_filter[i + 1]);
    auto matrix = [&](const D2D1_MATRIX_5X4_F &m) {
      return Effect(CLSID_D2D1ColorMatrix, {image.get()}, [&](ID2D1Effect *effect) {
        effect->SetValue(D2D1_COLORMATRIX_PROP_COLOR_MATRIX, m);
        effect->SetValue(D2D1_COLORMATRIX_PROP_CLAMP_OUTPUT, TRUE);
      });
    };
    switch (kind) {
      case Filter::Blur:
        // A CSS blur's length is the standard deviation itself.
        image = Effect(CLSID_D2D1GaussianBlur, {image.get()}, [&](ID2D1Effect *effect) {
          effect->SetValue(D2D1_GAUSSIANBLUR_PROP_STANDARD_DEVIATION, amount);
        });
        break;
      case Filter::Brightness:
        image = matrix(Scale(amount, amount, amount, 1));
        break;
      case Filter::Contrast:
        image = matrix(Scale(amount, amount, amount, 1, 0.5f - 0.5f * amount));
        break;
      case Filter::Invert:
        image = matrix(Scale(1 - 2 * amount, 1 - 2 * amount, 1 - 2 * amount, 1, amount));
        break;
      case Filter::Opacity:
        image = matrix(Scale(1, 1, 1, amount));
        break;
      case Filter::Saturate: {
        const float s = amount;
        const float m[3][3] = {{0.213f + 0.787f * s, 0.715f - 0.715f * s, 0.072f - 0.072f * s},
                               {0.213f - 0.213f * s, 0.715f + 0.285f * s, 0.072f - 0.072f * s},
                               {0.213f - 0.213f * s, 0.715f - 0.715f * s, 0.072f + 0.928f * s}};
        image = matrix(ColorMatrix(m));
        break;
      }
      case Filter::Grayscale: {
        const float s = 1 - amount;
        const float m[3][3] = {{0.2126f + 0.7874f * s, 0.7152f - 0.7152f * s, 0.0722f - 0.0722f * s},
                               {0.2126f - 0.2126f * s, 0.7152f + 0.2848f * s, 0.0722f - 0.0722f * s},
                               {0.2126f - 0.2126f * s, 0.7152f - 0.7152f * s, 0.0722f + 0.9278f * s}};
        image = matrix(ColorMatrix(m));
        break;
      }
      case Filter::Sepia: {
        const float s = 1 - amount;
        const float m[3][3] = {{0.393f + 0.607f * s, 0.769f - 0.769f * s, 0.189f - 0.189f * s},
                               {0.349f - 0.349f * s, 0.686f + 0.314f * s, 0.168f - 0.168f * s},
                               {0.272f - 0.272f * s, 0.534f - 0.534f * s, 0.131f + 0.869f * s}};
        image = matrix(ColorMatrix(m));
        break;
      }
      case Filter::HueRotate: {
        const float c = std::cos(amount * kPi / 180);
        const float s = std::sin(amount * kPi / 180);
        const float m[3][3] = {
            {0.213f + c * 0.787f - s * 0.213f, 0.715f - c * 0.715f - s * 0.715f, 0.072f - c * 0.072f + s * 0.928f},
            {0.213f - c * 0.213f + s * 0.143f, 0.715f + c * 0.285f + s * 0.140f, 0.072f - c * 0.072f - s * 0.283f},
            {0.213f - c * 0.213f - s * 0.787f, 0.715f - c * 0.715f + s * 0.715f, 0.072f + c * 0.928f + s * 0.072f}};
        image = matrix(ColorMatrix(m));
        break;
      }
      case Filter::DropShadow: {
        const float dx = static_cast<float>(m_filter[i + 1]);
        const float dy = static_cast<float>(m_filter[i + 2]);
        const float blur = static_cast<float>(m_filter[i + 3]);
        const auto color = UnpackColor(m_filter[i + 4]);
        auto cast = ShadowOf(image.get(), color, blur / 2, dx, dy);
        if (cast) {
          image = Effect(CLSID_D2D1Composite, {cast.get(), image.get()}, [](ID2D1Effect *effect) {
            effect->SetValue(D2D1_COMPOSITE_PROP_MODE, D2D1_COMPOSITE_MODE_SOURCE_OVER);
          });
        }
        i += 5;
        continue;
      }
      default:
        break;
    }
    i += 2;
  }
  return image;
}

void Replayer::CompositeImage(ID2D1Image *image) noexcept {
  if (m_composite == Composite::SourceOver) {
    PushClips();
    m_dc->SetTransform(D2D1::Matrix3x2F::Identity());
    m_dc->DrawImage(image, D2D1_INTERPOLATION_MODE_LINEAR, D2D1_COMPOSITE_MODE_SOURCE_OVER);
    return;
  }
  // Every other operation can change pixels the source does not cover (a
  // `copy` clears them), so it is computed over the whole canvas against a
  // copy of it, and written back.
  PopClips();
  auto destination = CopyTarget();
  if (!destination) return;
  bool porterDuff = false;
  const auto mode = PorterDuff(m_composite, porterDuff);
  com_ptr<ID2D1Image> result;
  if (porterDuff) {
    result = Effect(CLSID_D2D1Composite, {destination.get(), image}, [mode](ID2D1Effect *effect) {
      effect->SetValue(D2D1_COMPOSITE_PROP_MODE, mode);
    });
  } else {
    const auto blend = Blend(m_composite);
    result = Effect(CLSID_D2D1Blend, {destination.get(), image}, [blend](ID2D1Effect *effect) {
      effect->SetValue(D2D1_BLEND_PROP_MODE, blend);
    });
  }
  if (result) ReplaceThroughClip(result.get(), destination.get());
}

void Replayer::ReplaceThroughClip(ID2D1Image *result, ID2D1Image *destination) noexcept {
  com_ptr<ID2D1Image> output;
  output.copy_from(result);
  if (!m_clips.empty()) {
    // Outside the clip the destination stays: dest·(1−mask) + result·mask.
    auto mask = ClipMask(nullptr);
    if (!mask) return;
    auto outside = Effect(CLSID_D2D1Composite, {destination, mask.get()}, [](ID2D1Effect *effect) {
      effect->SetValue(D2D1_COMPOSITE_PROP_MODE, D2D1_COMPOSITE_MODE_DESTINATION_OUT);
    });
    auto inside = Effect(CLSID_D2D1Composite, {result, mask.get()}, [](ID2D1Effect *effect) {
      effect->SetValue(D2D1_COMPOSITE_PROP_MODE, D2D1_COMPOSITE_MODE_DESTINATION_IN);
    });
    if (!outside || !inside) return;
    output = Effect(CLSID_D2D1Composite, {outside.get(), inside.get()}, [](ID2D1Effect *effect) {
      effect->SetValue(D2D1_COMPOSITE_PROP_MODE, D2D1_COMPOSITE_MODE_PLUS);
    });
    if (!output) return;
  }
  m_dc->SetTransform(D2D1::Matrix3x2F::Identity());
  m_dc->DrawImage(output.get(), D2D1_INTERPOLATION_MODE_NEAREST_NEIGHBOR, D2D1_COMPOSITE_MODE_SOURCE_COPY);
}

com_ptr<ID2D1Image> Replayer::ClipMask(ID2D1Geometry *within) noexcept {
  com_ptr<ID2D1SolidColorBrush> white;
  if (FAILED(m_dc->CreateSolidColorBrush(D2D1::ColorF(1, 1, 1, 1), white.put()))) return nullptr;
  const auto size = m_target->GetSize();
  return Record([&] {
    m_dc->SetTransform(D2D1::Matrix3x2F::Identity());
    for (auto &clip : m_clips) {
      m_dc->PushLayer(D2D1::LayerParameters1(D2D1::InfiniteRect(), clip.get(), D2D1_ANTIALIAS_MODE_PER_PRIMITIVE),
                      nullptr);
    }
    if (within) {
      m_dc->FillGeometry(within, white.get());
    } else {
      m_dc->FillRectangle(D2D1::RectF(0, 0, size.width, size.height), white.get());
    }
    for (size_t i = 0; i < m_clips.size(); ++i) m_dc->PopLayer();
  });
}

com_ptr<ID2D1Bitmap1> Replayer::CopyTarget() noexcept {
  float dpiX = 96;
  float dpiY = 96;
  m_target->GetDpi(&dpiX, &dpiY);
  com_ptr<ID2D1Bitmap1> copy;
  if (FAILED(m_dc->CreateBitmap(
          m_target->GetPixelSize(), nullptr, 0,
          D2D1::BitmapProperties1(D2D1_BITMAP_OPTIONS_NONE,
                                  D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_PREMULTIPLIED),
                                  dpiX, dpiY),
          copy.put()))) {
    return nullptr;
  }
  // Pending drawing reaches the target before it is copied.
  m_dc->Flush();
  if (FAILED(copy->CopyFromBitmap(nullptr, m_target, nullptr))) return nullptr;
  return copy;
}

// ---- paints ----------------------------------------------------------------------

com_ptr<ID2D1Brush> Replayer::MakeBrush(const PaintSpec &paint, const D2D1::Matrix3x2F &render) noexcept {
  // The paint is defined in its own space, mapped to the view by `matrix`; the
  // brush lives in the space the shape is drawn in, mapped by `render`.
  const auto brushTransform = paint.matrix * Inverse(render);
  if (paint.kind == Paint::Solid) {
    com_ptr<ID2D1SolidColorBrush> brush;
    if (FAILED(m_dc->CreateSolidColorBrush(paint.color, D2D1::BrushProperties(paint.alpha), brush.put()))) {
      return nullptr;
    }
    return brush.as<ID2D1Brush>();
  }

  auto makeStops = [&](const std::vector<std::pair<float, D2D1_COLOR_F>> &stops) {
    std::vector<D2D1_GRADIENT_STOP> raw;
    for (const auto &[offset, color] : stops) raw.push_back({offset, color});
    com_ptr<ID2D1GradientStopCollection1> collection;
    m_dc->CreateGradientStopCollection(raw.data(), static_cast<UINT32>(raw.size()), D2D1_COLOR_SPACE_SRGB,
                                       D2D1_COLOR_SPACE_SRGB, D2D1_BUFFER_PRECISION_8BPC_UNORM,
                                       D2D1_EXTEND_MODE_CLAMP, D2D1_COLOR_INTERPOLATION_MODE_PREMULTIPLIED,
                                       collection.put());
    return collection;
  };

  if (paint.kind == Paint::Linear) {
    auto stops = makeStops(paint.stops);
    com_ptr<ID2D1LinearGradientBrush> brush;
    if (!stops ||
        FAILED(m_dc->CreateLinearGradientBrush(
            D2D1::LinearGradientBrushProperties({paint.geometry[0], paint.geometry[1]},
                                                {paint.geometry[2], paint.geometry[3]}),
            D2D1::BrushProperties(paint.alpha, brushTransform), stops.get(), brush.put()))) {
      return nullptr;
    }
    return brush.as<ID2D1Brush>();
  }

  if (paint.kind == Paint::Radial) {
    // Direct2D's radial gradient runs from a focal point to one circle. A
    // canvas's runs between two circles: drawn about the larger, from the
    // smaller's centre, with the stops moved out to start at its radius. Exact
    // for a zero start radius and for concentric circles.
    float x0 = paint.geometry[0], y0 = paint.geometry[1], r0 = paint.geometry[2];
    float x1 = paint.geometry[3], y1 = paint.geometry[4], r1 = paint.geometry[5];
    auto stops = paint.stops;
    const bool reversed = r0 > r1;
    if (reversed) {
      std::swap(x0, x1);
      std::swap(y0, y1);
      std::swap(r0, r1);
      std::reverse(stops.begin(), stops.end());
      for (auto &stop : stops) stop.first = 1 - stop.first;
    }
    const float inner = r1 > 0 ? r0 / r1 : 0;
    for (auto &stop : stops) stop.first = inner + stop.first * (1 - inner);
    float ox = x0 - x1;
    float oy = y0 - y1;
    const float reach = std::hypot(ox, oy);
    if (reach >= r1 * 0.999f && reach > 0) {
      ox *= r1 * 0.999f / reach;
      oy *= r1 * 0.999f / reach;
    }
    auto collection = makeStops(stops);
    com_ptr<ID2D1RadialGradientBrush> brush;
    if (!collection ||
        FAILED(m_dc->CreateRadialGradientBrush(
            D2D1::RadialGradientBrushProperties({x1, y1}, {ox, oy}, r1, r1),
            D2D1::BrushProperties(paint.alpha, brushTransform), collection.get(), brush.put()))) {
      return nullptr;
    }
    return brush.as<ID2D1Brush>();
  }

  if (paint.kind == Paint::Conic) {
    // Direct2D has no conic gradient: computed per pixel over the canvas.
    const auto pixels = m_target->GetPixelSize();
    float dpiX = 96;
    float dpiY = 96;
    m_target->GetDpi(&dpiX, &dpiY);
    const float scale = dpiX / 96;
    const auto inverse = Inverse(paint.matrix);
    std::vector<uint8_t> data(static_cast<size_t>(pixels.width) * pixels.height * 4);
    const float start = paint.geometry[0];
    const float cx = paint.geometry[1];
    const float cy = paint.geometry[2];
    // Premultiplied colour at a turn, interpolated as a canvas does.
    struct Premultiplied {
      float r, g, b, a;
    };
    auto premultiply = [](const D2D1_COLOR_F &c) { return Premultiplied{c.r * c.a, c.g * c.a, c.b * c.a, c.a}; };
    auto colorAt = [&](float t) -> Premultiplied {
      const auto &s = paint.stops;
      if (s.empty()) return {0, 0, 0, 0};
      if (t <= s.front().first) return premultiply(s.front().second);
      for (size_t k = 1; k < s.size(); ++k) {
        if (t <= s[k].first) {
          const float span = s[k].first - s[k - 1].first;
          const float f = span > 0 ? (t - s[k - 1].first) / span : 1;
          const auto a = premultiply(s[k - 1].second);
          const auto b = premultiply(s[k].second);
          return {a.r + (b.r - a.r) * f, a.g + (b.g - a.g) * f, a.b + (b.b - a.b) * f, a.a + (b.a - a.a) * f};
        }
      }
      return premultiply(s.back().second);
    };
    auto byte = [](float value) { return static_cast<uint8_t>(std::clamp(value, 0.0f, 1.0f) * 255 + 0.5f); };
    for (UINT32 py = 0; py < pixels.height; ++py) {
      for (UINT32 px = 0; px < pixels.width; ++px) {
        const auto user = inverse.TransformPoint({(px + 0.5f) / scale, (py + 0.5f) / scale});
        float turn = (std::atan2(user.y - cy, user.x - cx) - start) / (2 * kPi);
        turn -= std::floor(turn);
        const auto c = colorAt(turn);
        auto *out = &data[(static_cast<size_t>(py) * pixels.width + px) * 4];
        out[0] = byte(c.b);
        out[1] = byte(c.g);
        out[2] = byte(c.r);
        out[3] = byte(c.a);
      }
    }
    com_ptr<ID2D1Bitmap1> bitmap;
    com_ptr<ID2D1BitmapBrush1> brush;
    if (paint.stops.empty() ||
        FAILED(m_dc->CreateBitmap(pixels, data.data(), pixels.width * 4,
                                  D2D1::BitmapProperties1(D2D1_BITMAP_OPTIONS_NONE,
                                                          D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM,
                                                                            D2D1_ALPHA_MODE_PREMULTIPLIED),
                                                          dpiX, dpiY),
                                  bitmap.put())) ||
        FAILED(m_dc->CreateBitmapBrush(bitmap.get(), D2D1::BitmapBrushProperties1(),
                                       D2D1::BrushProperties(paint.alpha, Inverse(render)), brush.put()))) {
      return nullptr;
    }
    return brush.as<ID2D1Brush>();
  }
  return nullptr;
}

void Replayer::FillGeometry(ID2D1Geometry *geometry, const PaintSpec &paint, const D2D1::Matrix3x2F &render) noexcept {
  if (paint.kind == Paint::Pattern) {
    FillWithPattern(geometry, paint, render);
    return;
  }
  auto brush = MakeBrush(paint, render);
  if (!brush) return;
  m_dc->SetTransform(render);
  m_dc->FillGeometry(geometry, brush.get());
}

void Replayer::FillWithPattern(ID2D1Geometry *geometry, const PaintSpec &paint,
                               const D2D1::Matrix3x2F &render) noexcept {
  auto it = m_caches.bitmaps.find(paint.image);
  if (it == m_caches.bitmaps.end() || !it->second) return; // not loaded yet: redrawn when it is
  auto *bitmap = it->second.get();
  const auto size = bitmap->GetSize();
  if (!(paint.imageWidth > 0) || !(paint.imageHeight > 0) || !(size.width > 0) || !(size.height > 0)) return;
  // A tile is the size the image was placed with, however many pixels it has.
  const auto tile = D2D1::Matrix3x2F::Scale(paint.imageWidth / size.width, paint.imageHeight / size.height) *
      paint.matrix;
  // The shape is the mask, and its opacity the paint's alpha.
  m_dc->SetTransform(render);
  m_dc->PushLayer(D2D1::LayerParameters1(D2D1::InfiniteRect(), geometry, D2D1_ANTIALIAS_MODE_PER_PRIMITIVE,
                                         D2D1::IdentityMatrix(), paint.alpha),
                  nullptr);
  m_dc->SetTransform(tile);
  // The shape's extent in the tile's own space: the area to cover.
  D2D1_RECT_F bounds{};
  geometry->GetBounds(render * Inverse(tile), &bounds);
  if (paint.repetition == Repetition::NoRepeat) {
    m_dc->DrawBitmap(bitmap, D2D1::RectF(0, 0, size.width, size.height), 1, Interpolation());
  } else {
    const bool wrapX = paint.repetition == Repetition::Repeat || paint.repetition == Repetition::RepeatX;
    const bool wrapY = paint.repetition == Repetition::Repeat || paint.repetition == Repetition::RepeatY;
    com_ptr<ID2D1BitmapBrush1> brush;
    if (SUCCEEDED(m_dc->CreateBitmapBrush(
            bitmap,
            D2D1::BitmapBrushProperties1(wrapX ? D2D1_EXTEND_MODE_WRAP : D2D1_EXTEND_MODE_CLAMP,
                                         wrapY ? D2D1_EXTEND_MODE_WRAP : D2D1_EXTEND_MODE_CLAMP, Interpolation()),
            brush.put()))) {
      // A clamped axis is drawn one tile deep only: past it a canvas paints nothing.
      const auto area = D2D1::RectF(wrapX ? bounds.left : 0, wrapY ? bounds.top : 0,
                                    wrapX ? bounds.right : size.width, wrapY ? bounds.bottom : size.height);
      m_dc->FillRectangle(area, brush.get());
    }
  }
  m_dc->SetTransform(render);
  m_dc->PopLayer();
}

com_ptr<ID2D1StrokeStyle> Replayer::MakeStrokeStyle(const StrokeSpec &stroke) noexcept {
  const auto cap = stroke.cap == LineCap::Round ? D2D1_CAP_STYLE_ROUND
      : stroke.cap == LineCap::Square           ? D2D1_CAP_STYLE_SQUARE
                                                : D2D1_CAP_STYLE_FLAT;
  const auto join = stroke.join == LineJoin::Round ? D2D1_LINE_JOIN_ROUND
      : stroke.join == LineJoin::Bevel             ? D2D1_LINE_JOIN_BEVEL
                                                   : D2D1_LINE_JOIN_MITER_OR_BEVEL;
  // Direct2D measures dashes in stroke widths; a canvas in units of the space.
  std::vector<float> dashes;
  for (float dash : stroke.dashes) dashes.push_back(dash / stroke.width);
  com_ptr<ID2D1StrokeStyle1> style;
  m_factory->CreateStrokeStyle(
      D2D1::StrokeStyleProperties1(cap, cap, cap, join, stroke.miterLimit,
                                   dashes.empty() ? D2D1_DASH_STYLE_SOLID : D2D1_DASH_STYLE_CUSTOM,
                                   dashes.empty() ? 0.0f : stroke.dashOffset / stroke.width),
      dashes.empty() ? nullptr : dashes.data(), static_cast<UINT32>(dashes.size()), style.put());
  return style ? style.as<ID2D1StrokeStyle>() : nullptr;
}

com_ptr<ID2D1Geometry> Replayer::Widen(ID2D1Geometry *geometry, const StrokeSpec &stroke) noexcept {
  auto style = MakeStrokeStyle(stroke);
  com_ptr<ID2D1PathGeometry> widened;
  com_ptr<ID2D1GeometrySink> sink;
  if (FAILED(m_factory->CreatePathGeometry(widened.put())) || FAILED(widened->Open(sink.put()))) return nullptr;
  geometry->Widen(stroke.width, style.get(), nullptr, D2D1_DEFAULT_FLATTENING_TOLERANCE, sink.get());
  sink->Close();
  return widened.as<ID2D1Geometry>();
}

// ---- images ----------------------------------------------------------------------

D2D1_INTERPOLATION_MODE Replayer::Interpolation() const noexcept {
  if (!m_smoothing) return D2D1_INTERPOLATION_MODE_NEAREST_NEIGHBOR;
  switch (m_quality) {
    case SmoothingQuality::High: return D2D1_INTERPOLATION_MODE_HIGH_QUALITY_CUBIC;
    case SmoothingQuality::Medium: return D2D1_INTERPOLATION_MODE_CUBIC;
    default: return D2D1_INTERPOLATION_MODE_LINEAR;
  }
}

com_ptr<ID2D1Bitmap1> Replayer::Bitmap(const std::string &source) noexcept {
  if (source.empty()) return nullptr;
  if (auto found = m_caches.bitmaps.find(source); found != m_caches.bitmaps.end()) return found->second;
  if (source.rfind("picture;", 0) == 0) return RenderNested(source);
  auto wic = ImageCache::Shared().Get(source, m_requestRedraw);
  if (!wic) return nullptr; // loading: drawn again when it has loaded
  com_ptr<ID2D1Bitmap1> bitmap;
  // 96 DPI: one image pixel is one unit of the space it is drawn in.
  if (FAILED(m_dc->CreateBitmapFromWicBitmap(
          wic.get(),
          D2D1::BitmapProperties1(D2D1_BITMAP_OPTIONS_NONE,
                                  D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_PREMULTIPLIED),
                                  96, 96),
          bitmap.put()))) {
    return nullptr;
  }
  if (m_caches.bitmaps.size() > 128) m_caches.bitmaps.clear();
  m_caches.bitmaps.emplace(source, bitmap);
  return bitmap;
}

com_ptr<ID2D1Bitmap1> Replayer::RenderNested(const std::string &source) noexcept {
  if (m_depth >= kMaxNesting) return nullptr;
  const auto *picture = ParseNested(source);
  if (!picture || !(picture->width > 0) || !(picture->height > 0)) return nullptr;
  float dpiX = 96;
  float dpiY = 96;
  m_target->GetDpi(&dpiX, &dpiY);
  const auto pixels = D2D1::SizeU(static_cast<UINT32>(std::ceil(picture->width * dpiX / 96)),
                                  static_cast<UINT32>(std::ceil(picture->height * dpiY / 96)));
  com_ptr<ID2D1Bitmap1> target;
  if (FAILED(m_dc->CreateBitmap(
          pixels, nullptr, 0,
          D2D1::BitmapProperties1(D2D1_BITMAP_OPTIONS_TARGET,
                                  D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_PREMULTIPLIED),
                                  dpiX, dpiY),
          target.put()))) {
    return nullptr;
  }
  // Drawn on this context: the outer clip layers come off while its target is
  // switched, and go back on with the next draw that needs them.
  PopClips();
  com_ptr<ID2D1Image> previous;
  m_dc->GetTarget(previous.put());
  m_dc->SetTarget(target.get());
  m_dc->Clear(D2D1::ColorF(0, 0, 0, 0));
  {
    Replayer nested(m_dc, target.get(), m_text, m_caches, m_requestRedraw, m_depth + 1);
    nested.Run(picture->ops, picture->strings);
  }
  m_dc->SetTarget(previous.get());
  // As an image it is drawn at one unit per picture unit, whatever its DPI.
  com_ptr<ID2D1Bitmap1> image;
  if (FAILED(m_dc->CreateBitmap(
          pixels, nullptr, 0,
          D2D1::BitmapProperties1(D2D1_BITMAP_OPTIONS_NONE,
                                  D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_PREMULTIPLIED),
                                  dpiX, dpiY),
          image.put()))) {
    return nullptr;
  }
  m_dc->Flush();
  image->CopyFromBitmap(nullptr, target.get(), nullptr);
  if (m_caches.bitmaps.size() > 128) m_caches.bitmaps.clear();
  m_caches.bitmaps.emplace(source, image);
  return image;
}

} // namespace WindowsCanvas
