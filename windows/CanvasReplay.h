// Replays a recorded picture onto a Direct2D device context.
#pragma once

#include "CanvasCommon.h"
#include "CanvasText.h"

#include <unordered_map>

namespace WindowsCanvas {

/** Device-dependent resources a view keeps between draws. */
struct DeviceCaches {
  ID2D1Device *device = nullptr;
  std::unordered_map<std::string, winrt::com_ptr<ID2D1Bitmap1>> bitmaps;

  /** Drops everything made on another device. */
  void Use(ID2D1Device *current) noexcept {
    if (device != current) {
      bitmaps.clear();
      device = current;
    }
  }
};

/**
 * Draws one picture into `target`, which must be the context's target, inside
 * its BeginDraw/EndDraw. Coordinates are DIPs; the context's DPI maps them to
 * the bitmap's pixels.
 *
 * Source-over drawing with no shadow or filter goes straight to the target,
 * clipped by layers. Anything else is recorded into a command list and run
 * through an effect graph — a filter chain, a shadow, a composite or blend
 * against a copy of the destination — and written back through the clip as a
 * mask, because a layer composites its content with source-over and would
 * undo a `copy` or a `destination-in`.
 */
class Replayer {
 public:
  Replayer(ID2D1DeviceContext *context, ID2D1Bitmap1 *target, TextEngine &text, DeviceCaches &caches,
           std::function<void()> requestRedraw, int depth = 0) noexcept;

  void Run(const std::vector<double> &ops, const std::vector<std::string> &strings) noexcept;

 private:
  class Reader;
  struct PaintSpec;
  struct StrokeSpec;

  PaintSpec ReadPaint(Reader &reader) noexcept;
  StrokeSpec ReadStroke(Reader &reader) noexcept;
  winrt::com_ptr<ID2D1PathGeometry> ReadPath(Reader &reader, int fillRule) noexcept;

  // Drawing through the compositing pipeline.
  void Draw(const std::function<void()> &primitive) noexcept;
  winrt::com_ptr<ID2D1Image> Record(const std::function<void()> &primitive) noexcept;
  winrt::com_ptr<ID2D1Image> ApplyFilter(winrt::com_ptr<ID2D1Image> image) noexcept;
  winrt::com_ptr<ID2D1Image> ShadowOf(ID2D1Image *image, D2D1_COLOR_F color, float deviation, float dx,
                                      float dy) noexcept;
  void CompositeImage(ID2D1Image *image) noexcept;
  void ReplaceThroughClip(ID2D1Image *result, ID2D1Image *destination) noexcept;
  winrt::com_ptr<ID2D1Image> ClipMask(ID2D1Geometry *within) noexcept;
  winrt::com_ptr<ID2D1Bitmap1> CopyTarget() noexcept;
  winrt::com_ptr<ID2D1Image> Effect(const CLSID &id, std::initializer_list<ID2D1Image *> inputs,
                                    const std::function<void(ID2D1Effect *)> &configure) noexcept;
  void PushClips() noexcept;
  void PopClips() noexcept;

  // Paints.
  winrt::com_ptr<ID2D1Brush> MakeBrush(const PaintSpec &paint, const D2D1::Matrix3x2F &render) noexcept;
  void FillGeometry(ID2D1Geometry *geometry, const PaintSpec &paint, const D2D1::Matrix3x2F &render) noexcept;
  void FillWithPattern(ID2D1Geometry *geometry, const PaintSpec &paint, const D2D1::Matrix3x2F &render) noexcept;
  winrt::com_ptr<ID2D1StrokeStyle> MakeStrokeStyle(const StrokeSpec &stroke) noexcept;
  winrt::com_ptr<ID2D1Geometry> Widen(ID2D1Geometry *geometry, const StrokeSpec &stroke) noexcept;

  // Images.
  winrt::com_ptr<ID2D1Bitmap1> Bitmap(const std::string &source) noexcept;
  winrt::com_ptr<ID2D1Bitmap1> RenderNested(const std::string &source) noexcept;
  D2D1_INTERPOLATION_MODE Interpolation() const noexcept;

  ID2D1DeviceContext *m_dc;
  ID2D1Bitmap1 *m_target;
  winrt::com_ptr<ID2D1Factory1> m_factory;
  TextEngine &m_text;
  DeviceCaches &m_caches;
  std::function<void()> m_requestRedraw;
  int m_depth;
  const std::vector<std::string> *m_strings = nullptr;

  // State the picture sets with Set… ops.
  int m_composite = 0;
  D2D1_COLOR_F m_shadowColor{0, 0, 0, 0};
  float m_shadowBlur = 0;
  float m_shadowX = 0;
  float m_shadowY = 0;
  std::vector<double> m_filter;
  bool m_smoothing = true;
  int m_quality = 0;

  std::vector<winrt::com_ptr<ID2D1Geometry>> m_clips;
  size_t m_pushed = 0;
};

} // namespace WindowsCanvas
