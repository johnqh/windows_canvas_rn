// See WindowsCanvas.h. Compiled without the consumer's precompiled header, so
// it includes everything it uses.
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <unknwn.h>

#include <d2d1_3.h>
#include <dwrite.h>

#include <algorithm>
#include <cmath>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include <winrt/base.h>
#include <winrt/Microsoft.ReactNative.Composition.Experimental.h>
#include <winrt/Microsoft.ReactNative.Composition.h>
#include <winrt/Microsoft.ReactNative.h>

#include <AutoDraw.h>
#include <JSValueComposition.h>
#include <NativeModules.h>

#include "PictureFormat.h"
#include "WindowsCanvas.h"

#pragma comment(lib, "d2d1.lib")
#pragma comment(lib, "dwrite.lib")

namespace WindowsCanvas {

namespace RN = winrt::Microsoft::ReactNative;
namespace Experimental = winrt::Microsoft::ReactNative::Composition::Experimental;
using namespace Format;

// ---- text ------------------------------------------------------------------

namespace {

IDWriteFactory *SharedDWriteFactory() noexcept {
  static winrt::com_ptr<IDWriteFactory> factory = [] {
    winrt::com_ptr<IDWriteFactory> created;
    DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory),
                        reinterpret_cast<IUnknown **>(created.put()));
    return created;
  }();
  return factory.get();
}

std::wstring Wide(const std::string &utf8) {
  const auto converted = winrt::to_hstring(utf8);
  return std::wstring{converted.c_str(), converted.size()};
}

// Formats by family, size, weight and style. One cache per thread that uses
// it — the view draws on the UI thread, the module measures on the JS thread —
// so neither locks.
class TextFormats {
 public:
  IDWriteTextFormat *Get(const std::string &family, float size, int weight, bool italic) noexcept {
    const std::string key = family + '|' + std::to_string(size) + '|' + std::to_string(weight) +
        (italic ? "|i" : "|n");
    if (auto found = m_formats.find(key); found != m_formats.end()) return found->second.get();
    auto *factory = SharedDWriteFactory();
    if (!factory || !(size > 0)) return nullptr;
    winrt::com_ptr<IDWriteTextFormat> format;
    const auto name = Wide(family.empty() ? std::string{"Segoe UI"} : family);
    if (FAILED(factory->CreateTextFormat(
            name.c_str(), nullptr,
            static_cast<DWRITE_FONT_WEIGHT>(std::clamp(weight, 1, 999)),
            italic ? DWRITE_FONT_STYLE_ITALIC : DWRITE_FONT_STYLE_NORMAL,
            DWRITE_FONT_STRETCH_NORMAL, size, L"", format.put()))) {
      return nullptr;
    }
    format->SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
    if (m_formats.size() > 256) m_formats.clear();
    return m_formats.emplace(key, std::move(format)).first->second.get();
  }

 private:
  std::unordered_map<std::string, winrt::com_ptr<IDWriteTextFormat>> m_formats;
};

struct LaidOut {
  winrt::com_ptr<IDWriteTextLayout> layout;
  float width = 0;
  float baseline = 0;
  float height = 0;
};

LaidOut Layout(TextFormats &formats, const std::string &family, float size, int weight,
               bool italic, const std::string &text) noexcept {
  LaidOut result;
  auto *format = formats.Get(family, size, weight, italic);
  auto *factory = SharedDWriteFactory();
  if (!format || !factory) return result;
  const auto wide = Wide(text);
  if (FAILED(factory->CreateTextLayout(wide.c_str(), static_cast<UINT32>(wide.size()), format,
                                       100000.0f, 100000.0f, result.layout.put()))) {
    result.layout = nullptr;
    return result;
  }
  DWRITE_TEXT_METRICS metrics{};
  if (SUCCEEDED(result.layout->GetMetrics(&metrics))) {
    result.width = metrics.widthIncludingTrailingWhitespace;
    result.height = metrics.height;
  }
  DWRITE_LINE_METRICS line{};
  UINT32 lines = 0;
  result.layout->GetLineMetrics(&line, 1, &lines);
  result.baseline = lines > 0 ? line.baseline : size * 0.8f;
  if (lines > 0) result.height = line.height;
  return result;
}

} // namespace

// ---- the module ------------------------------------------------------------

REACT_MODULE(WindowsCanvasModule, L"WindowsCanvas")
struct WindowsCanvasModule {
  REACT_SYNC_METHOD(measureText)
  RN::JSValueObject measureText(std::string family, double size, double weight, bool italic,
                                std::string text) noexcept {
    const auto laid = Layout(m_formats, family, static_cast<float>(size),
                             static_cast<int>(weight), italic, text);
    if (!laid.layout) {
      // The recorder's own approximation, so a missing font is not a crash.
      return RN::JSValueObject{{"width", text.size() * size * 0.56},
                               {"ascent", size * 0.8},
                               {"descent", size * 0.2}};
    }
    return RN::JSValueObject{{"width", laid.width},
                             {"ascent", laid.baseline},
                             {"descent", std::max(0.0f, laid.height - laid.baseline)}};
  }

 private:
  TextFormats m_formats;
};

// ---- the view --------------------------------------------------------------

REACT_STRUCT(PictureProps)
struct PictureProps : winrt::implements<PictureProps, RN::IComponentProps> {
  PictureProps(RN::ViewProps props, const RN::IComponentProps &cloneFrom) : ViewProps(props) {
    if (cloneFrom) {
      auto from = cloneFrom.as<PictureProps>();
      ops = from->ops;
      strings = from->strings;
    }
  }

  void SetProp(uint32_t hash, winrt::hstring propName, RN::IJSValueReader value) noexcept {
    RN::ReadProp(hash, propName, value, *this);
  }

  REACT_FIELD(ops)
  std::vector<double> ops;
  REACT_FIELD(strings)
  std::vector<std::string> strings;

  const RN::ViewProps ViewProps;
};

class PictureReader {
 public:
  explicit PictureReader(const std::vector<double> &ops) : m_ops(ops) {}
  bool More() const noexcept { return m_at < m_ops.size(); }
  double Next() noexcept { return m_at < m_ops.size() ? m_ops[m_at++] : 0.0; }
  float Float() noexcept { return static_cast<float>(Next()); }
  int Int() noexcept { return static_cast<int>(Next()); }
  // A truncated or corrupt picture stops the replay rather than reading past it.
  bool Ok() const noexcept { return m_at <= m_ops.size(); }

 private:
  const std::vector<double> &m_ops;
  size_t m_at = 0;
};

D2D1_COLOR_F Color(double packed) noexcept {
  const auto value = static_cast<uint32_t>(std::max(0.0, std::min(packed, 4294967295.0)));
  return D2D1::ColorF(((value >> 24) & 0xff) / 255.0f, ((value >> 16) & 0xff) / 255.0f,
                      ((value >> 8) & 0xff) / 255.0f, (value & 0xff) / 255.0f);
}

winrt::com_ptr<ID2D1PathGeometry> ReadPath(ID2D1Factory *factory, PictureReader &reader,
                                           int fillRule) noexcept {
  winrt::com_ptr<ID2D1PathGeometry> geometry;
  winrt::com_ptr<ID2D1GeometrySink> sink;
  const int count = reader.Int();
  if (!factory || FAILED(factory->CreatePathGeometry(geometry.put())) ||
      FAILED(geometry->Open(sink.put()))) {
    // Still consume the segments, so the ops after this one are read right.
    for (int i = 0; i < count && reader.More(); ++i) {
      switch (reader.Int()) {
        case Segment::Move:
        case Segment::Line: reader.Next(); reader.Next(); break;
        case Segment::Quad: for (int k = 0; k < 4; ++k) reader.Next(); break;
        case Segment::Cubic: for (int k = 0; k < 6; ++k) reader.Next(); break;
        default: break;
      }
    }
    return nullptr;
  }
  sink->SetFillMode(fillRule == FillRule::EvenOdd ? D2D1_FILL_MODE_ALTERNATE
                                                  : D2D1_FILL_MODE_WINDING);
  bool open = false;
  for (int i = 0; i < count && reader.More(); ++i) {
    switch (reader.Int()) {
      case Segment::Move: {
        const float x = reader.Float();
        const float y = reader.Float();
        if (open) sink->EndFigure(D2D1_FIGURE_END_OPEN);
        sink->BeginFigure({x, y}, D2D1_FIGURE_BEGIN_FILLED);
        open = true;
        break;
      }
      case Segment::Line: {
        const float x = reader.Float();
        const float y = reader.Float();
        if (open) sink->AddLine({x, y});
        break;
      }
      case Segment::Quad: {
        const float cx = reader.Float();
        const float cy = reader.Float();
        const float x = reader.Float();
        const float y = reader.Float();
        if (open) sink->AddQuadraticBezier(D2D1::QuadraticBezierSegment({cx, cy}, {x, y}));
        break;
      }
      case Segment::Cubic: {
        const float c1x = reader.Float();
        const float c1y = reader.Float();
        const float c2x = reader.Float();
        const float c2y = reader.Float();
        const float x = reader.Float();
        const float y = reader.Float();
        if (open) sink->AddBezier(D2D1::BezierSegment({c1x, c1y}, {c2x, c2y}, {x, y}));
        break;
      }
      case Segment::Close:
        if (open) sink->EndFigure(D2D1_FIGURE_END_CLOSED);
        open = false;
        break;
      default:
        break;
    }
  }
  if (open) sink->EndFigure(D2D1_FIGURE_END_OPEN);
  sink->Close();
  return geometry;
}

struct PictureView : winrt::implements<PictureView, winrt::Windows::Foundation::IInspectable> {
  explicit PictureView(const Experimental::ICompositionContext &context) : m_compContext(context) {}

  void Initialize(const RN::ComponentView &view) noexcept {
    m_view = view;
    view.as<Experimental::IInternalCreateVisual>().CreateInternalVisualHandler(
        [weak = get_weak()](const RN::ComponentView &) {
          auto self = weak.get();
          return self ? self->CreateInternalVisual() : Experimental::IVisual{nullptr};
        });
    view.LayoutMetricsChanged(
        [weak = get_weak()](const winrt::Windows::Foundation::IInspectable &,
                            const RN::LayoutMetricsChangedArgs &args) {
          if (auto self = weak.get()) {
            self->m_layout = args.NewLayoutMetrics();
            self->Invalidate();
          }
        });
  }

  Experimental::IVisual CreateInternalVisual() noexcept {
    m_visual = m_compContext.CreateSpriteVisual();
    m_visual.Comment(L"WindowsCanvasPicture");
    Invalidate();
    return m_visual;
  }

  void UpdateProps(const winrt::com_ptr<PictureProps> &props) noexcept {
    m_props = props;
    Invalidate();
  }

 private:
  // Props, layout and mounting can all arrive in one transaction: draw once,
  // after it, on the UI thread.
  void Invalidate() noexcept {
    if (m_drawPending) return;
    auto view = m_view.get();
    if (!view) return;
    RN::IReactDispatcher dispatcher{nullptr};
    if (auto context = view.ReactContext()) dispatcher = context.UIDispatcher();
    if (!dispatcher) {
      Draw();
      return;
    }
    m_drawPending = true;
    dispatcher.Post([weak = get_weak()]() {
      if (auto self = weak.get()) {
        self->m_drawPending = false;
        self->Draw();
      }
    });
  }

  void Draw() noexcept {
    if (!m_visual) return;
    const float width = m_layout.Frame.Width;
    const float height = m_layout.Frame.Height;
    const float scale = m_layout.PointScaleFactor > 0 ? m_layout.PointScaleFactor : 1.0f;
    if (width <= 0 || height <= 0) return;

    auto surface = m_compContext.CreateDrawingSurfaceBrush(
        {width * scale, height * scale},
        winrt::Windows::Graphics::DirectX::DirectXPixelFormat::B8G8R8A8UIntNormalized,
        winrt::Windows::Graphics::DirectX::DirectXAlphaMode::Premultiplied);
    POINT offset{};
    {
      ::Microsoft::ReactNative::Composition::AutoDrawDrawingSurface autoDraw(surface, 1.0, &offset);
      if (auto *context = autoDraw.GetRenderTarget()) {
        float oldDpiX = 96.0f;
        float oldDpiY = 96.0f;
        context->GetDpi(&oldDpiX, &oldDpiY);
        context->SetDpi(96.0f * scale, 96.0f * scale);
        const auto base = D2D1::Matrix3x2F::Translation(offset.x / scale, offset.y / scale);
        context->SetTransform(base);
        context->Clear(D2D1::ColorF(0, 0, 0, 0));
        if (m_props) Replay(*context, base);
        context->SetTransform(D2D1::Matrix3x2F::Identity());
        context->SetDpi(oldDpiX, oldDpiY);
      }
    }
    m_visual.Brush(surface);
  }

  void Replay(ID2D1DeviceContext &context, const D2D1::Matrix3x2F &base) noexcept {
    const auto &ops = m_props->ops;
    const auto &strings = m_props->strings;
    PictureReader reader(ops);
    if (!reader.More() || reader.Int() != kVersion) return;

    winrt::com_ptr<ID2D1Factory> factory;
    context.GetFactory(factory.put());
    winrt::com_ptr<ID2D1SolidColorBrush> brush;
    if (FAILED(context.CreateSolidColorBrush(D2D1::ColorF(0, 0, 0, 1), brush.put()))) return;
    const auto text = [&strings](int index) -> const std::string & {
      static const std::string empty;
      return index >= 0 && static_cast<size_t>(index) < strings.size() ? strings[index] : empty;
    };

    int clips = 0;
    while (reader.More()) {
      switch (reader.Int()) {
        case Op::Fill: {
          brush->SetColor(Color(reader.Next()));
          const int rule = reader.Int();
          if (auto geometry = ReadPath(factory.get(), reader, rule)) {
            context.FillGeometry(geometry.get(), brush.get());
          }
          break;
        }
        case Op::Stroke: {
          brush->SetColor(Color(reader.Next()));
          const float width = reader.Float();
          const int cap = reader.Int();
          const int join = reader.Int();
          const float miter = reader.Float();
          const int dashCount = std::max(0, reader.Int());
          std::vector<float> dashes;
          dashes.reserve(dashCount);
          for (int i = 0; i < dashCount; ++i) dashes.push_back(reader.Float());
          const float dashOffset = reader.Float();
          auto geometry = ReadPath(factory.get(), reader, FillRule::NonZero);
          if (!geometry || !(width > 0)) break;
          // D2D measures dashes in stroke widths; a canvas measures them in px.
          for (auto &dash : dashes) dash /= width;
          const auto capStyle = cap == LineCap::Round  ? D2D1_CAP_STYLE_ROUND
              : cap == LineCap::Square                 ? D2D1_CAP_STYLE_SQUARE
                                                       : D2D1_CAP_STYLE_FLAT;
          const auto joinStyle = join == LineJoin::Round ? D2D1_LINE_JOIN_ROUND
              : join == LineJoin::Bevel                  ? D2D1_LINE_JOIN_BEVEL
                                                         : D2D1_LINE_JOIN_MITER_OR_BEVEL;
          winrt::com_ptr<ID2D1StrokeStyle> style;
          const auto properties = D2D1::StrokeStyleProperties(
              capStyle, capStyle, capStyle, joinStyle, miter,
              dashes.empty() ? D2D1_DASH_STYLE_SOLID : D2D1_DASH_STYLE_CUSTOM,
              dashes.empty() ? 0.0f : dashOffset / width);
          factory->CreateStrokeStyle(properties, dashes.empty() ? nullptr : dashes.data(),
                                     static_cast<UINT32>(dashes.size()), style.put());
          context.DrawGeometry(geometry.get(), brush.get(), width, style.get());
          break;
        }
        case Op::Text: {
          brush->SetColor(Color(reader.Next()));
          const auto &content = text(reader.Int());
          const auto &family = text(reader.Int());
          const float size = reader.Float();
          const int weight = reader.Int();
          const bool italic = reader.Int() != 0;
          const int align = reader.Int();
          const int baseline = reader.Int();
          // One read per statement: argument evaluation order is unspecified.
          float m[6];
          for (auto &value : m) value = reader.Float();
          const D2D1::Matrix3x2F matrix(m[0], m[1], m[2], m[3], m[4], m[5]);
          const float x = reader.Float();
          const float y = reader.Float();
          const auto laid = Layout(m_formats, family, size, weight, italic, content);
          if (!laid.layout) break;
          const float dx = align == TextAlign::Center ? -laid.width / 2
              : align == TextAlign::End               ? -laid.width
                                                      : 0.0f;
          const float dy = baseline == TextBaseline::Top ? 0.0f
              : baseline == TextBaseline::Middle         ? -laid.height / 2
              : baseline == TextBaseline::Bottom         ? -laid.height
                                                         : -laid.baseline;
          context.SetTransform(matrix * base);
          // Colour fonts on: an emoji is drawn in its own colours, as a
          // browser canvas draws it, rather than as a silhouette in the brush.
          context.DrawTextLayout({x + dx, y + dy}, laid.layout.get(), brush.get(),
                                 D2D1_DRAW_TEXT_OPTIONS_ENABLE_COLOR_FONT);
          context.SetTransform(base);
          break;
        }
        case Op::ClearRect: {
          const float x = reader.Float();
          const float y = reader.Float();
          const float w = reader.Float();
          const float h = reader.Float();
          context.PushAxisAlignedClip(D2D1::RectF(x, y, x + w, y + h), D2D1_ANTIALIAS_MODE_ALIASED);
          context.Clear(D2D1::ColorF(0, 0, 0, 0));
          context.PopAxisAlignedClip();
          break;
        }
        case Op::Clip: {
          const int rule = reader.Int();
          auto geometry = ReadPath(factory.get(), reader, rule);
          if (!geometry) break;
          context.PushLayer(D2D1::LayerParameters1(D2D1::InfiniteRect(), geometry.get()), nullptr);
          ++clips;
          break;
        }
        case Op::PopClip: {
          for (int count = reader.Int(); count > 0 && clips > 0; --count, --clips) {
            context.PopLayer();
          }
          break;
        }
        default:
          // An op this build does not know: nothing after it can be read.
          while (clips-- > 0) context.PopLayer();
          return;
      }
      if (!reader.Ok()) break;
    }
    while (clips-- > 0) context.PopLayer();
  }

  Experimental::ICompositionContext m_compContext{nullptr};
  Experimental::ISpriteVisual m_visual{nullptr};
  winrt::weak_ref<RN::ComponentView> m_view;
  RN::LayoutMetrics m_layout{{0, 0, 0, 0}, 1.0};
  winrt::com_ptr<PictureProps> m_props;
  TextFormats m_formats;
  bool m_drawPending = false;
};

void RegisterWindowsCanvas(RN::IReactPackageBuilder const &packageBuilder) noexcept {
  packageBuilder.as<RN::IReactPackageBuilderFabric>().AddViewComponent(
      L"WindowsCanvasPicture", [](RN::IReactViewComponentBuilder const &builder) noexcept {
        builder.SetCreateProps(
            [](RN::ViewProps props, const RN::IComponentProps &cloneFrom) noexcept {
              return winrt::make<PictureProps>(props, cloneFrom);
            });
        builder.SetUpdatePropsHandler([](const RN::ComponentView &view,
                                         const RN::IComponentProps &newProps,
                                         const RN::IComponentProps &) noexcept {
          winrt::get_self<PictureView>(view.UserData())
              ->UpdateProps(newProps ? newProps.as<PictureProps>() : nullptr);
        });
        auto compBuilder =
            builder.as<winrt::Microsoft::ReactNative::Composition::IReactCompositionViewComponentBuilder>();
        compBuilder.SetViewComponentViewInitializer([](const RN::ComponentView &view) noexcept {
          auto userData = winrt::make_self<PictureView>(
              view.as<Experimental::IInternalComponentView>().CompositionContext());
          userData->Initialize(view);
          view.UserData(*userData);
        });
        compBuilder.SetViewFeatures(
            winrt::Microsoft::ReactNative::Composition::ComponentViewFeatures::Default &
            ~winrt::Microsoft::ReactNative::Composition::ComponentViewFeatures::Background);
      });
}

} // namespace WindowsCanvas
