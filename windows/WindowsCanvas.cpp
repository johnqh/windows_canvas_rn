// See WindowsCanvas.h: the picture view and the measuring module.
#include "CanvasCommon.h"

#include <algorithm>
#include <cmath>

#include <winrt/Microsoft.ReactNative.Composition.Experimental.h>
#include <winrt/Microsoft.ReactNative.Composition.h>

#include <AutoDraw.h>
#include <JSValueComposition.h>
#include <NativeModules.h>

#include "CanvasReplay.h"
#include "CanvasText.h"
#include "LineScene.h"
#include "WindowsCanvas.h"

namespace WindowsCanvas {

namespace RN = winrt::Microsoft::ReactNative;
namespace Experimental = winrt::Microsoft::ReactNative::Composition::Experimental;

// ---- the module ------------------------------------------------------------------

REACT_MODULE(WindowsCanvasModule, L"WindowsCanvas")
struct WindowsCanvasModule {
  /**
   * Text measured with the layout the view draws it with: the advance, the
   * ink box, the font's and the em box's ascent and descent, and the hanging
   * baseline — everything `TextMetrics` and text anchoring are built from.
   */
  REACT_SYNC_METHOD(measureText)
  RN::JSValueObject measureText(std::string family, double size, double weight, double style, double stretch,
                                double letterSpacing, double wordSpacing, double kerning, double variantCaps,
                                bool rtl, std::string text) noexcept {
    TextSpec spec;
    spec.family = family;
    spec.size = static_cast<float>(size);
    spec.weight = static_cast<int>(weight);
    spec.style = static_cast<int>(style);
    spec.stretch = static_cast<int>(stretch);
    spec.rtl = rtl;
    spec.letterSpacing = static_cast<float>(letterSpacing);
    spec.wordSpacing = static_cast<float>(wordSpacing);
    spec.kerning = static_cast<int>(kerning);
    spec.variantCaps = static_cast<int>(variantCaps);
    const auto line = m_text.Lay(spec, text);
    if (!line.layout) {
      // The recorder's own approximation, so a missing font is not a crash.
      const double width = text.size() * size * 0.56;
      const double emAscent = size * 0.811;
      return RN::JSValueObject{{"width", width},       {"inkLeft", 0.0},
                               {"inkRight", width},    {"inkAscent", size * 0.7},
                               {"inkDescent", 0.0},    {"fontAscent", size * 1.079},
                               {"fontDescent", size * 0.251}, {"emAscent", emAscent},
                               {"emDescent", size - emAscent}, {"hanging", emAscent * 0.8}};
    }
    return RN::JSValueObject{{"width", static_cast<double>(line.width)},
                             {"inkLeft", static_cast<double>(line.inkLeft)},
                             {"inkRight", static_cast<double>(line.inkRight)},
                             {"inkAscent", static_cast<double>(line.inkAscent)},
                             {"inkDescent", static_cast<double>(line.inkDescent)},
                             {"fontAscent", static_cast<double>(line.fontAscent)},
                             {"fontDescent", static_cast<double>(line.fontDescent)},
                             {"emAscent", static_cast<double>(line.emAscent)},
                             {"emDescent", static_cast<double>(line.emDescent)},
                             {"hanging", static_cast<double>(line.hanging)}};
  }

 private:
  TextEngine m_text;
};

// ---- the view --------------------------------------------------------------------

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

struct PictureView : winrt::implements<PictureView, winrt::Windows::Foundation::IInspectable> {
  explicit PictureView(const Experimental::ICompositionContext &context) : m_compContext(context) {}

  void Initialize(const RN::ComponentView &view) noexcept {
    m_view = view;
    if (auto context = view.ReactContext()) m_dispatcher = context.UIDispatcher();
    view.as<Experimental::IInternalCreateVisual>().CreateInternalVisualHandler(
        [weak = get_weak()](const RN::ComponentView &) {
          auto self = weak.get();
          return self ? self->CreateInternalVisual() : Experimental::IVisual{nullptr};
        });
    view.LayoutMetricsChanged([weak = get_weak()](const winrt::Windows::Foundation::IInspectable &,
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
  // Props, layout and mounting can all arrive in one transaction: one draw,
  // after it, on the UI thread. Drawing in each callback is the
  // react-native-svg bug this package exists to avoid.
  void Invalidate() noexcept {
    if (m_drawPending) return;
    if (!m_dispatcher) {
      Draw();
      return;
    }
    m_drawPending = true;
    m_dispatcher.Post([weak = get_weak()]() {
      if (auto self = weak.get()) {
        self->m_drawPending = false;
        self->Draw();
      }
    });
  }

  /** From any thread: an image this picture uses has finished loading. */
  std::function<void()> RedrawLater() noexcept {
    return [weak = get_weak(), dispatcher = m_dispatcher]() {
      if (!dispatcher) return;
      dispatcher.Post([weak]() {
        if (auto self = weak.get()) self->Invalidate();
      });
    };
  }

  void Draw() noexcept {
    if (!m_visual) return;
    const float width = m_layout.Frame.Width;
    const float height = m_layout.Frame.Height;
    const float scale = m_layout.PointScaleFactor > 0 ? m_layout.PointScaleFactor : 1.0f;
    if (width <= 0 || height <= 0) return;
    const float dpi = 96.0f * scale;
    const auto pixels = D2D1::SizeU(static_cast<UINT32>(std::ceil(width * scale)),
                                    static_cast<UINT32>(std::ceil(height * scale)));

    auto surface = m_compContext.CreateDrawingSurfaceBrush(
        {static_cast<float>(pixels.width), static_cast<float>(pixels.height)},
        winrt::Windows::Graphics::DirectX::DirectXPixelFormat::B8G8R8A8UIntNormalized,
        winrt::Windows::Graphics::DirectX::DirectXAlphaMode::Premultiplied);
    POINT offset{};
    {
      ::Microsoft::ReactNative::Composition::AutoDrawDrawingSurface autoDraw(surface, 1.0, &offset);
      auto *surfaceContext = autoDraw.GetRenderTarget();
      if (!surfaceContext) return;
      auto picture = Render(surfaceContext, pixels, dpi);
      float oldDpiX = 96;
      float oldDpiY = 96;
      surfaceContext->GetDpi(&oldDpiX, &oldDpiY);
      surfaceContext->SetDpi(dpi, dpi);
      surfaceContext->SetTransform(D2D1::Matrix3x2F::Translation(offset.x / scale, offset.y / scale));
      surfaceContext->Clear(D2D1::ColorF(0, 0, 0, 0));
      if (picture) {
        surfaceContext->DrawImage(picture.get(), D2D1_INTERPOLATION_MODE_NEAREST_NEIGHBOR,
                                  D2D1_COMPOSITE_MODE_SOURCE_OVER);
      }
      surfaceContext->SetTransform(D2D1::Matrix3x2F::Identity());
      surfaceContext->SetDpi(oldDpiX, oldDpiY);
    }
    m_visual.Brush(surface);
  }

  /**
   * The picture, drawn into a bitmap of the view's own on a context of its
   * own. The replay switches targets (command lists, effect inputs, nested
   * pictures) and copies its target, none of which belongs on the
   * composition surface's context or its shared atlas.
   */
  winrt::com_ptr<ID2D1Bitmap1> Render(ID2D1DeviceContext *surfaceContext, D2D1_SIZE_U pixels, float dpi) noexcept {
    winrt::com_ptr<ID2D1Device> device;
    surfaceContext->GetDevice(device.put());
    if (!device) return nullptr;
    if (device.get() != m_caches.device || !m_context) {
      m_context = nullptr;
      m_target = nullptr;
      if (FAILED(device->CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE, m_context.put()))) return nullptr;
      m_caches.Use(device.get());
    }
    if (!m_target || m_target->GetPixelSize().width != pixels.width ||
        m_target->GetPixelSize().height != pixels.height || m_targetDpi != dpi) {
      m_target = nullptr;
      if (FAILED(m_context->CreateBitmap(
              pixels, nullptr, 0,
              D2D1::BitmapProperties1(D2D1_BITMAP_OPTIONS_TARGET,
                                      D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_PREMULTIPLIED),
                                      dpi, dpi),
              m_target.put()))) {
        return nullptr;
      }
      m_targetDpi = dpi;
    }
    m_context->SetTarget(m_target.get());
    m_context->SetDpi(dpi, dpi);
    m_context->BeginDraw();
    m_context->SetTransform(D2D1::Matrix3x2F::Identity());
    m_context->Clear(D2D1::ColorF(0, 0, 0, 0));
    if (m_props) {
      Replayer replayer(m_context.get(), m_target.get(), m_text, m_caches, RedrawLater());
      replayer.Run(m_props->ops, m_props->strings);
    }
    const HRESULT result = m_context->EndDraw();
    m_context->SetTarget(nullptr);
    if (result == D2DERR_RECREATE_TARGET) {
      // The device went away: start again on the next draw.
      m_context = nullptr;
      m_target = nullptr;
      m_caches.Use(nullptr);
      Invalidate();
      return nullptr;
    }
    return m_target;
  }

  Experimental::ICompositionContext m_compContext{nullptr};
  Experimental::ISpriteVisual m_visual{nullptr};
  winrt::weak_ref<RN::ComponentView> m_view;
  RN::IReactDispatcher m_dispatcher{nullptr};
  RN::LayoutMetrics m_layout{{0, 0, 0, 0}, 1.0};
  winrt::com_ptr<PictureProps> m_props;
  winrt::com_ptr<ID2D1DeviceContext> m_context;
  winrt::com_ptr<ID2D1Bitmap1> m_target;
  float m_targetDpi = 0;
  DeviceCaches m_caches;
  TextEngine m_text;
  bool m_drawPending = false;
};

void RegisterWindowsCanvas(RN::IReactPackageBuilder const &packageBuilder) noexcept {
  packageBuilder.as<RN::IReactPackageBuilderFabric>().AddViewComponent(
      L"WindowsCanvasPicture", [](RN::IReactViewComponentBuilder const &builder) noexcept {
        builder.SetCreateProps([](RN::ViewProps props, const RN::IComponentProps &cloneFrom) noexcept {
          return winrt::make<PictureProps>(props, cloneFrom);
        });
        builder.SetUpdatePropsHandler(
            [](const RN::ComponentView &view, const RN::IComponentProps &newProps, const RN::IComponentProps &) noexcept {
              winrt::get_self<PictureView>(view.UserData())
                  ->UpdateProps(newProps ? newProps.as<PictureProps>() : nullptr);
            });
        auto compBuilder = builder.as<winrt::Microsoft::ReactNative::Composition::IReactCompositionViewComponentBuilder>();
        compBuilder.SetViewComponentViewInitializer([](const RN::ComponentView &view) noexcept {
          auto userData =
              winrt::make_self<PictureView>(view.as<Experimental::IInternalComponentView>().CompositionContext());
          userData->Initialize(view);
          view.UserData(*userData);
        });
        compBuilder.SetViewFeatures(winrt::Microsoft::ReactNative::Composition::ComponentViewFeatures::Default &
                                    ~winrt::Microsoft::ReactNative::Composition::ComponentViewFeatures::Background);
      });
  RegisterLineScene(packageBuilder);
}

} // namespace WindowsCanvas
