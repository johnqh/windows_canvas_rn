// Text laid out with DirectWrite, the same way for drawing and for measuring.
#pragma once

#include "CanvasCommon.h"

#include <unordered_map>

namespace WindowsCanvas {

/** A font and the canvas text properties that shape a layout. */
struct TextSpec {
  std::string family; // comma-separated; the first installed is used
  float size = 10;
  int weight = 400;
  int style = 0; // Format::FontStyle
  int stretch = 5; // DWRITE_FONT_STRETCH
  bool rtl = false;
  float letterSpacing = 0;
  float wordSpacing = 0;
  int kerning = 0; // Format::Kerning
  int variantCaps = 0; // Format::VariantCaps
};

/** A single line of text, its box exactly as wide as the text. */
struct TextLine {
  winrt::com_ptr<IDWriteTextLayout> layout;
  float width = 0;
  float height = 0;
  float baseline = 0;
  float inkLeft = 0;
  float inkRight = 0;
  float inkAscent = 0;
  float inkDescent = 0;
  float fontAscent = 0;
  float fontDescent = 0;
  float emAscent = 0;
  float emDescent = 0;
  float hanging = 0;
};

/**
 * Text formats and font metrics, cached. One per thread that lays text out —
 * the view on the UI thread, the measuring module on the JS thread — so
 * neither locks.
 */
class TextEngine {
 public:
  TextLine Lay(const TextSpec &spec, const std::string &text) noexcept;

  /** The glyph outlines of `line` with its box at (x, y), for stroking or masking. */
  winrt::com_ptr<ID2D1Geometry> Outline(ID2D1Factory *factory, const TextLine &line, float x, float y) noexcept;

 private:
  IDWriteTextFormat *Format(const TextSpec &spec) noexcept;
  std::wstring ResolveFamily(const std::string &list) noexcept;
  DWRITE_FONT_METRICS Metrics(const std::wstring &family, const TextSpec &spec) noexcept;

  std::unordered_map<std::string, winrt::com_ptr<IDWriteTextFormat>> m_formats;
  std::unordered_map<std::string, std::wstring> m_families;
  std::unordered_map<std::string, DWRITE_FONT_METRICS> m_metrics;
};

IDWriteFactory *SharedDWriteFactory() noexcept;

} // namespace WindowsCanvas
