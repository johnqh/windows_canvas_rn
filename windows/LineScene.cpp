// See LineScene.h. The props are written by src/LineScene.tsx; their layout
// is src/line-scene.ts's.
#include "CanvasCommon.h"

#include <d3d11_1.h>
#include <d3dcompiler.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

#include <winrt/Microsoft.ReactNative.Composition.Experimental.h>
#include <winrt/Microsoft.ReactNative.Composition.h>

#include <AutoDraw.h>
#include <NativeModules.h>

#include "LineScene.h"

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "d3dcompiler.lib")

namespace WindowsCanvas {

namespace RN = winrt::Microsoft::ReactNative;
namespace Experimental = winrt::Microsoft::ReactNative::Composition::Experimental;

namespace {

/** Column-major, as three.js and HLSL's default packing lay one out: row r, column c at c * 4 + r. */
using Matrix = std::array<float, 16>;

constexpr Matrix kIdentity{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
constexpr float kPi = 3.14159265358979f;

Matrix Multiply(const Matrix &a, const Matrix &b) noexcept {
  Matrix out{};
  for (int c = 0; c < 4; ++c) {
    for (int r = 0; r < 4; ++r) {
      float sum = 0;
      for (int k = 0; k < 4; ++k) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

/**
 * three.js's eye space (right-handed, looking down -z) into Direct3D's clip
 * space (depth 0 at the near plane, 1 at the far).
 */
Matrix Perspective(float fovY, float aspect, float zNear, float zFar) noexcept {
  const float f = 1.0f / std::tan(fovY / 2);
  Matrix m{};
  m[0] = f / aspect;
  m[5] = f;
  m[10] = zFar / (zNear - zFar);
  m[11] = -1;
  m[14] = zNear * zFar / (zNear - zFar);
  return m;
}

Matrix MatrixAt(const std::vector<double> &values, size_t offset) noexcept {
  if (values.size() < offset + 16) return kIdentity;
  Matrix m{};
  for (size_t i = 0; i < 16; ++i) m[i] = static_cast<float>(values[offset + i]);
  return m;
}

/** Where the eye of a rigid world-to-view matrix [R | t] is: -Rᵀt. */
std::array<float, 4> EyeOf(const Matrix &view) noexcept {
  std::array<float, 4> eye{0, 0, 0, 1};
  for (int i = 0; i < 3; ++i) {
    eye[i] = -(view[i * 4 + 0] * view[12] + view[i * 4 + 1] * view[13] + view[i * 4 + 2] * view[14]);
  }
  return eye;
}

std::array<float, 4> Premultiplied(double packed) noexcept {
  const auto c = UnpackColor(packed);
  return {c.r * c.a, c.g * c.a, c.b * c.a, c.a};
}

/**
 * One line list per batch. Colours arrive premultiplied, and the fog is a
 * lerp toward the background in that space — the same as drawing the line at
 * (1 - t) opacity over it, which is what the CPU projection in
 * music_spatial_core does with its fade.
 */
constexpr char kShaders[] = R"(
cbuffer Frame : register(b0) {
  float4x4 viewProjection;
  float4 eye;
  float4 fogColor;
  float4 fog;
};
cbuffer Batch : register(b1) {
  float4x4 model;
  float4 color;
};
struct Varyings {
  float4 position : SV_Position;
  float3 world : TEXCOORD0;
};
Varyings VS(float3 position : POSITION) {
  Varyings v;
  float4 world = mul(model, float4(position, 1));
  v.world = world.xyz;
  v.position = mul(viewProjection, world);
  return v;
}
float4 PS(Varyings v) : SV_Target {
  float t = 0;
  if (fog.z > 0) {
    t = saturate((distance(v.world, eye.xyz) - fog.x) / max(fog.y - fog.x, 0.0001));
  }
  return lerp(color, fogColor, t);
}
)";

struct FrameConstants {
  Matrix viewProjection;
  std::array<float, 4> eye;
  std::array<float, 4> fogColor;
  /** near, far, enabled. */
  std::array<float, 4> fog;
};
static_assert(sizeof(FrameConstants) == 112);

struct BatchConstants {
  Matrix model;
  std::array<float, 4> color;
};
static_assert(sizeof(BatchConstants) == 80);

constexpr uint64_t kNothingUploaded = UINT64_MAX;
constexpr UINT kMaxPixels = 16384;

winrt::com_ptr<ID3D11Device> CreateOwnDevice() noexcept {
  winrt::com_ptr<ID3D11Device> device;
  for (const auto type : {D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP}) {
    if (SUCCEEDED(D3D11CreateDevice(nullptr, type, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
                                    D3D11_SDK_VERSION, device.put(), nullptr, nullptr))) {
      return device;
    }
  }
  return nullptr;
}

/**
 * The Direct3D device the Composition surface is drawn with — the target of
 * the surface's Direct2D context is a bitmap over a DXGI surface of it.
 * Drawing on that device lets Direct2D draw the result without a copy
 * through memory.
 */
winrt::com_ptr<ID3D11Device> SurfaceDevice(ID2D1DeviceContext *context) noexcept {
  winrt::com_ptr<ID2D1Image> target;
  context->GetTarget(target.put());
  const auto bitmap = target.try_as<ID2D1Bitmap1>();
  if (!bitmap) return nullptr;
  winrt::com_ptr<IDXGISurface> surface;
  if (FAILED(bitmap->GetSurface(surface.put())) || !surface) return nullptr;
  winrt::com_ptr<ID3D11Device> device;
  if (FAILED(surface->GetDevice(IID_PPV_ARGS(device.put())))) return nullptr;
  return device;
}

} // namespace

// ---- the props -------------------------------------------------------------------

REACT_STRUCT(LineSceneProps)
struct LineSceneProps : winrt::implements<LineSceneProps, RN::IComponentProps> {
  LineSceneProps(RN::ViewProps props, const RN::IComponentProps &cloneFrom) : ViewProps(props) {
    if (cloneFrom) {
      auto from = cloneFrom.as<LineSceneProps>();
      vertices = from->vertices;
      vertexCounts = from->vertexCounts;
      transforms = from->transforms;
      colors = from->colors;
      camera = from->camera;
      fog = from->fog;
      background = from->background;
      geometryGeneration = from->geometryGeneration;
    }
  }

  void SetProp(uint32_t hash, winrt::hstring propName, RN::IJSValueReader value) noexcept {
    // These props start as a copy of the previous ones, and RNW's reader
    // appends an array's items to the vector it reads into: unemptied, every
    // camera after the first was added behind it and never drawn.
    if (propName == L"vertices") vertices.clear();
    else if (propName == L"vertexCounts") vertexCounts.clear();
    else if (propName == L"transforms") transforms.clear();
    else if (propName == L"colors") colors.clear();
    else if (propName == L"camera") camera.clear();
    else if (propName == L"fog") fog.clear();
    RN::ReadProp(hash, propName, value, *this);
    // React sends a prop only when it changed, and LineScene.tsx keeps the
    // vertices the same array until they do: this is the one signal that
    // the vertex buffer is stale.
    if (propName == L"vertices") ++geometryGeneration;
  }

  REACT_FIELD(vertices)
  std::vector<double> vertices;
  REACT_FIELD(vertexCounts)
  std::vector<double> vertexCounts;
  REACT_FIELD(transforms)
  std::vector<double> transforms;
  REACT_FIELD(colors)
  std::vector<double> colors;
  /** fovDeg, near, far, then the 16 numbers of the view matrix. */
  REACT_FIELD(camera)
  std::vector<double> camera;
  /** near, far — or empty for none. */
  REACT_FIELD(fog)
  std::vector<double> fog;
  /** 0xRRGGBBAA. */
  REACT_FIELD(background)
  double background = 0;

  uint64_t geometryGeneration = 0;
  const RN::ViewProps ViewProps;
};

// ---- the renderer ----------------------------------------------------------------

/**
 * Draws the scene into a texture of its own on a given device. Its pipeline
 * state lives in a device context state object swapped in for the draw and
 * out again, so nothing it sets leaks into Direct2D's use of the same
 * immediate context, and nothing Direct2D sets leaks in.
 */
class LineSceneRenderer {
 public:
  /** The drawn scene, or null when the device cannot draw it. */
  ID3D11Texture2D *Render(ID3D11Device *device, const LineSceneProps &props, UINT width, UINT height) noexcept {
    if (!EnsureDevice(device) || !EnsureTargets(width, height) || !EnsureGeometry(props)) return nullptr;
    winrt::com_ptr<ID3DDeviceContextState> previous;
    m_context->SwapDeviceContextState(m_state.get(), previous.put());
    Draw(props, width, height);
    m_context->SwapDeviceContextState(previous.get(), nullptr);
    return m_resolved.get();
  }

  /**
   * The drawn scene as a Direct2D bitmap on `context`'s device. Shared when
   * the scene was drawn on the surface's own Direct3D device; otherwise read
   * back through memory.
   */
  winrt::com_ptr<ID2D1Bitmap1> Bitmap(ID2D1DeviceContext *context, bool shared, float dpi) noexcept {
    if (!m_resolved) return nullptr;
    const auto properties = D2D1::BitmapProperties1(
        D2D1_BITMAP_OPTIONS_NONE, D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_PREMULTIPLIED), dpi,
        dpi);
    if (shared) {
      winrt::com_ptr<ID2D1Device> d2dDevice;
      context->GetDevice(d2dDevice.put());
      if (m_bitmap && m_bitmapDevice == d2dDevice && m_bitmapDpi == dpi) return m_bitmap;
      m_bitmap = nullptr;
      const auto surface = m_resolved.try_as<IDXGISurface>();
      if (!surface || FAILED(context->CreateBitmapFromDxgiSurface(surface.get(), &properties, m_bitmap.put()))) {
        m_bitmap = nullptr;
        return nullptr;
      }
      m_bitmapDevice = d2dDevice;
      m_bitmapDpi = dpi;
      return m_bitmap;
    }

    D3D11_TEXTURE2D_DESC desc{};
    m_resolved->GetDesc(&desc);
    if (!m_staging) {
      desc.Usage = D3D11_USAGE_STAGING;
      desc.BindFlags = 0;
      desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
      if (FAILED(m_device->CreateTexture2D(&desc, nullptr, m_staging.put()))) return nullptr;
    }
    m_context->CopyResource(m_staging.get(), m_resolved.get());
    D3D11_MAPPED_SUBRESOURCE mapped{};
    if (FAILED(m_context->Map(m_staging.get(), 0, D3D11_MAP_READ, 0, &mapped))) return nullptr;
    winrt::com_ptr<ID2D1Bitmap1> bitmap;
    const HRESULT created = context->CreateBitmap(D2D1::SizeU(desc.Width, desc.Height), mapped.pData,
                                                  mapped.RowPitch, properties, bitmap.put());
    m_context->Unmap(m_staging.get(), 0);
    return SUCCEEDED(created) ? bitmap : nullptr;
  }

  /** Forget the device; the next draw starts again. */
  void Reset() noexcept {
    *this = LineSceneRenderer();
  }

 private:
  bool EnsureDevice(ID3D11Device *device) noexcept {
    if (m_device.get() == device && m_vertexShader) return true;
    Reset();
    m_device.copy_from(device);

    winrt::com_ptr<ID3D11DeviceContext> context;
    device->GetImmediateContext(context.put());
    m_context = context.try_as<ID3D11DeviceContext1>();
    const auto device1 = m_device.try_as<ID3D11Device1>();
    if (!m_context || !device1) return Failed();

    const D3D_FEATURE_LEVEL level = device->GetFeatureLevel();
    const UINT stateFlags = (device->GetCreationFlags() & D3D11_CREATE_DEVICE_SINGLETHREADED)
                                ? D3D11_1_CREATE_DEVICE_CONTEXT_STATE_SINGLETHREADED
                                : 0;
    if (FAILED(device1->CreateDeviceContextState(stateFlags, &level, 1, D3D11_SDK_VERSION, __uuidof(ID3D11Device1),
                                                 nullptr, m_state.put()))) {
      return Failed();
    }

    const bool level10 = level >= D3D_FEATURE_LEVEL_10_0;
    const auto vertexCode = Compile("VS", level10 ? "vs_4_0" : "vs_4_0_level_9_1");
    const auto pixelCode = Compile("PS", level10 ? "ps_4_0" : "ps_4_0_level_9_1");
    if (!vertexCode || !pixelCode) return Failed();
    if (FAILED(device->CreateVertexShader(vertexCode->GetBufferPointer(), vertexCode->GetBufferSize(), nullptr,
                                          m_vertexShader.put())) ||
        FAILED(device->CreatePixelShader(pixelCode->GetBufferPointer(), pixelCode->GetBufferSize(), nullptr,
                                         m_pixelShader.put()))) {
      return Failed();
    }
    const D3D11_INPUT_ELEMENT_DESC position{
        "POSITION", 0, DXGI_FORMAT_R32G32B32_FLOAT, 0, 0, D3D11_INPUT_PER_VERTEX_DATA, 0};
    if (FAILED(device->CreateInputLayout(&position, 1, vertexCode->GetBufferPointer(), vertexCode->GetBufferSize(),
                                         m_layout.put()))) {
      return Failed();
    }

    D3D11_BUFFER_DESC constants{};
    constants.Usage = D3D11_USAGE_DEFAULT;
    constants.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
    constants.ByteWidth = sizeof(FrameConstants);
    if (FAILED(device->CreateBuffer(&constants, nullptr, m_frameConstants.put()))) return Failed();
    constants.ByteWidth = sizeof(BatchConstants);
    if (FAILED(device->CreateBuffer(&constants, nullptr, m_batchConstants.put()))) return Failed();

    // 4× multisampling where both the colour and the depth format allow it.
    m_samples = 1;
    UINT colorQuality = 0;
    UINT depthQuality = 0;
    if (SUCCEEDED(device->CheckMultisampleQualityLevels(DXGI_FORMAT_B8G8R8A8_UNORM, 4, &colorQuality)) &&
        SUCCEEDED(device->CheckMultisampleQualityLevels(DXGI_FORMAT_D24_UNORM_S8_UINT, 4, &depthQuality)) &&
        colorQuality > 0 && depthQuality > 0) {
      m_samples = 4;
    }

    D3D11_RASTERIZER_DESC rasterizer{};
    rasterizer.FillMode = D3D11_FILL_SOLID;
    rasterizer.CullMode = D3D11_CULL_NONE;
    rasterizer.DepthClipEnable = TRUE;
    rasterizer.MultisampleEnable = m_samples > 1;
    // Only meaningful without multisampling, and then the best a line gets.
    rasterizer.AntialiasedLineEnable = m_samples == 1;
    if (FAILED(device->CreateRasterizerState(&rasterizer, m_rasterizer.put()))) return Failed();

    D3D11_DEPTH_STENCIL_DESC depth{};
    depth.DepthEnable = TRUE;
    depth.DepthWriteMask = D3D11_DEPTH_WRITE_MASK_ALL;
    depth.DepthFunc = D3D11_COMPARISON_LESS_EQUAL;
    if (FAILED(device->CreateDepthStencilState(&depth, m_depthState.put()))) return Failed();

    D3D11_BLEND_DESC blend{};
    auto &target = blend.RenderTarget[0];
    target.BlendEnable = TRUE;
    target.SrcBlend = D3D11_BLEND_ONE;
    target.DestBlend = D3D11_BLEND_INV_SRC_ALPHA;
    target.BlendOp = D3D11_BLEND_OP_ADD;
    target.SrcBlendAlpha = D3D11_BLEND_ONE;
    target.DestBlendAlpha = D3D11_BLEND_INV_SRC_ALPHA;
    target.BlendOpAlpha = D3D11_BLEND_OP_ADD;
    target.RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
    if (FAILED(device->CreateBlendState(&blend, m_blend.put()))) return Failed();
    return true;
  }

  winrt::com_ptr<ID3DBlob> Compile(const char *entry, const char *profile) noexcept {
    winrt::com_ptr<ID3DBlob> code;
    winrt::com_ptr<ID3DBlob> errors;
    if (FAILED(D3DCompile(kShaders, sizeof(kShaders) - 1, "WindowsLineScene", nullptr, nullptr, entry, profile,
                          D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, code.put(), errors.put()))) {
      if (errors) OutputDebugStringA(static_cast<const char *>(errors->GetBufferPointer()));
      return nullptr;
    }
    return code;
  }

  bool EnsureTargets(UINT width, UINT height) noexcept {
    if (m_resolved && m_width == width && m_height == height) return true;
    m_multisampled = nullptr;
    m_resolved = nullptr;
    m_staging = nullptr;
    m_target = nullptr;
    m_depth = nullptr;
    m_bitmap = nullptr;

    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = width;
    desc.Height = height;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc = {1, 0};
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    if (FAILED(m_device->CreateTexture2D(&desc, nullptr, m_resolved.put()))) return false;
    if (m_samples > 1) {
      desc.SampleDesc = {m_samples, 0};
      desc.BindFlags = D3D11_BIND_RENDER_TARGET;
      if (FAILED(m_device->CreateTexture2D(&desc, nullptr, m_multisampled.put()))) return false;
    }
    ID3D11Texture2D *drawn = m_multisampled ? m_multisampled.get() : m_resolved.get();
    if (FAILED(m_device->CreateRenderTargetView(drawn, nullptr, m_target.put()))) return false;

    desc.Format = DXGI_FORMAT_D24_UNORM_S8_UINT;
    desc.SampleDesc = {m_samples, 0};
    desc.BindFlags = D3D11_BIND_DEPTH_STENCIL;
    winrt::com_ptr<ID3D11Texture2D> depth;
    if (FAILED(m_device->CreateTexture2D(&desc, nullptr, depth.put())) ||
        FAILED(m_device->CreateDepthStencilView(depth.get(), nullptr, m_depth.put()))) {
      return false;
    }
    m_width = width;
    m_height = height;
    return true;
  }

  bool EnsureGeometry(const LineSceneProps &props) noexcept {
    if (m_uploadedGeneration == props.geometryGeneration) return true;
    m_vertices = nullptr;
    m_vertexCount = 0;
    const size_t count = props.vertices.size() / 3;
    if (count > 0) {
      std::vector<float> floats(count * 3);
      for (size_t i = 0; i < floats.size(); ++i) floats[i] = static_cast<float>(props.vertices[i]);
      D3D11_BUFFER_DESC desc{};
      desc.Usage = D3D11_USAGE_IMMUTABLE;
      desc.BindFlags = D3D11_BIND_VERTEX_BUFFER;
      desc.ByteWidth = static_cast<UINT>(floats.size() * sizeof(float));
      D3D11_SUBRESOURCE_DATA data{floats.data(), 0, 0};
      if (FAILED(m_device->CreateBuffer(&desc, &data, m_vertices.put()))) return false;
      m_vertexCount = static_cast<UINT>(count);
    }
    m_uploadedGeneration = props.geometryGeneration;
    return true;
  }

  void Draw(const LineSceneProps &props, UINT width, UINT height) noexcept {
    ID3D11DeviceContext1 *context = m_context.get();
    ID3D11RenderTargetView *targets[] = {m_target.get()};
    context->OMSetRenderTargets(1, targets, m_depth.get());
    const auto background = Premultiplied(props.background);
    context->ClearRenderTargetView(m_target.get(), background.data());
    context->ClearDepthStencilView(m_depth.get(), D3D11_CLEAR_DEPTH, 1.0f, 0);

    const auto &camera = props.camera;
    const bool lens = camera.size() >= 19 && camera[0] > 0 && camera[0] < 180 && camera[1] > 0 && camera[2] > camera[1];
    if (lens && m_vertices) {
      const Matrix view = MatrixAt(camera, 3);
      FrameConstants frame{};
      frame.viewProjection =
          Multiply(Perspective(static_cast<float>(camera[0]) * kPi / 180, static_cast<float>(width) / height,
                               static_cast<float>(camera[1]), static_cast<float>(camera[2])),
                   view);
      frame.eye = EyeOf(view);
      frame.fogColor = background;
      if (props.fog.size() >= 2 && props.fog[1] > props.fog[0]) {
        frame.fog = {static_cast<float>(props.fog[0]), static_cast<float>(props.fog[1]), 1, 0};
      }
      context->UpdateSubresource(m_frameConstants.get(), 0, nullptr, &frame, 0, 0);

      const D3D11_VIEWPORT viewport{0, 0, static_cast<float>(width), static_cast<float>(height), 0, 1};
      context->RSSetViewports(1, &viewport);
      context->RSSetState(m_rasterizer.get());
      context->OMSetDepthStencilState(m_depthState.get(), 0);
      const float blendFactor[4]{};
      context->OMSetBlendState(m_blend.get(), blendFactor, 0xffffffff);
      context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_LINELIST);
      context->IASetInputLayout(m_layout.get());
      ID3D11Buffer *vertexBuffers[] = {m_vertices.get()};
      const UINT stride = 3 * sizeof(float);
      const UINT offset = 0;
      context->IASetVertexBuffers(0, 1, vertexBuffers, &stride, &offset);
      context->VSSetShader(m_vertexShader.get(), nullptr, 0);
      context->PSSetShader(m_pixelShader.get(), nullptr, 0);
      ID3D11Buffer *constantBuffers[] = {m_frameConstants.get(), m_batchConstants.get()};
      context->VSSetConstantBuffers(0, 2, constantBuffers);
      context->PSSetConstantBuffers(0, 2, constantBuffers);

      UINT first = 0;
      for (size_t i = 0; i < props.vertexCounts.size() && first < m_vertexCount; ++i) {
        const double requested = props.vertexCounts[i];
        if (!(requested > 0)) continue;
        const UINT count = static_cast<UINT>(std::min(requested, static_cast<double>(m_vertexCount - first)));
        const UINT segmentsOnly = count & ~1u;
        if (segmentsOnly > 0) {
          BatchConstants batch{};
          batch.model = MatrixAt(props.transforms, i * 16);
          batch.color = Premultiplied(i < props.colors.size() ? props.colors[i] : 0x000000ff);
          context->UpdateSubresource(m_batchConstants.get(), 0, nullptr, &batch, 0, 0);
          context->Draw(segmentsOnly, first);
        }
        first += count;
      }
    }

    if (m_multisampled) {
      context->ResolveSubresource(m_resolved.get(), 0, m_multisampled.get(), 0, DXGI_FORMAT_B8G8R8A8_UNORM);
    }
    ID3D11RenderTargetView *none[] = {nullptr};
    context->OMSetRenderTargets(1, none, nullptr);
  }

  bool Failed() noexcept {
    Reset();
    return false;
  }

  winrt::com_ptr<ID3D11Device> m_device;
  winrt::com_ptr<ID3D11DeviceContext1> m_context;
  winrt::com_ptr<ID3DDeviceContextState> m_state;
  winrt::com_ptr<ID3D11VertexShader> m_vertexShader;
  winrt::com_ptr<ID3D11PixelShader> m_pixelShader;
  winrt::com_ptr<ID3D11InputLayout> m_layout;
  winrt::com_ptr<ID3D11Buffer> m_frameConstants;
  winrt::com_ptr<ID3D11Buffer> m_batchConstants;
  winrt::com_ptr<ID3D11RasterizerState> m_rasterizer;
  winrt::com_ptr<ID3D11DepthStencilState> m_depthState;
  winrt::com_ptr<ID3D11BlendState> m_blend;
  UINT m_samples = 1;

  winrt::com_ptr<ID3D11Texture2D> m_multisampled;
  winrt::com_ptr<ID3D11Texture2D> m_resolved;
  winrt::com_ptr<ID3D11Texture2D> m_staging;
  winrt::com_ptr<ID3D11RenderTargetView> m_target;
  winrt::com_ptr<ID3D11DepthStencilView> m_depth;
  UINT m_width = 0;
  UINT m_height = 0;

  winrt::com_ptr<ID3D11Buffer> m_vertices;
  UINT m_vertexCount = 0;
  uint64_t m_uploadedGeneration = kNothingUploaded;

  winrt::com_ptr<ID2D1Bitmap1> m_bitmap;
  winrt::com_ptr<ID2D1Device> m_bitmapDevice;
  float m_bitmapDpi = 0;
};

// ---- the view --------------------------------------------------------------------

struct LineSceneView : winrt::implements<LineSceneView, winrt::Windows::Foundation::IInspectable> {
  explicit LineSceneView(const Experimental::ICompositionContext &context) : m_compContext(context) {}

  void Initialize(const RN::ComponentView &view) noexcept {
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
    m_visual.Comment(L"WindowsLineScene");
    Invalidate();
    return m_visual;
  }

  void UpdateProps(const winrt::com_ptr<LineSceneProps> &props) noexcept {
    m_props = props;
    Invalidate();
  }

 private:
  // One draw per transaction, after it, on the UI thread — as the picture
  // view does, and for the same reason.
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

  void Draw() noexcept {
    if (!m_visual || !m_props) return;
    const float width = m_layout.Frame.Width;
    const float height = m_layout.Frame.Height;
    const float scale = m_layout.PointScaleFactor > 0 ? m_layout.PointScaleFactor : 1.0f;
    if (width <= 0 || height <= 0) return;
    const float dpi = 96.0f * scale;
    const auto pixels = D2D1::SizeU(std::min(kMaxPixels, static_cast<UINT32>(std::ceil(width * scale))),
                                    std::min(kMaxPixels, static_cast<UINT32>(std::ceil(height * scale))));

    auto surface = m_compContext.CreateDrawingSurfaceBrush(
        {static_cast<float>(pixels.width), static_cast<float>(pixels.height)},
        winrt::Windows::Graphics::DirectX::DirectXPixelFormat::B8G8R8A8UIntNormalized,
        winrt::Windows::Graphics::DirectX::DirectXAlphaMode::Premultiplied);
    POINT offset{};
    {
      ::Microsoft::ReactNative::Composition::AutoDrawDrawingSurface autoDraw(surface, 1.0, &offset);
      auto *surfaceContext = autoDraw.GetRenderTarget();
      if (!surfaceContext) return;
      auto scene = Render(surfaceContext, pixels, dpi);
      float oldDpiX = 96;
      float oldDpiY = 96;
      surfaceContext->GetDpi(&oldDpiX, &oldDpiY);
      surfaceContext->SetDpi(dpi, dpi);
      surfaceContext->SetTransform(D2D1::Matrix3x2F::Translation(offset.x / scale, offset.y / scale));
      surfaceContext->Clear(D2D1::ColorF(0, 0, 0, 0));
      if (scene) {
        surfaceContext->DrawImage(scene.get(), D2D1_INTERPOLATION_MODE_NEAREST_NEIGHBOR,
                                  D2D1_COMPOSITE_MODE_SOURCE_OVER);
      }
      surfaceContext->SetTransform(D2D1::Matrix3x2F::Identity());
      surfaceContext->SetDpi(oldDpiX, oldDpiY);
    }
    m_visual.Brush(surface);
  }

  /**
   * The scene, drawn with Direct3D on the surface's own device when it can
   * be reached — so Direct2D draws the result without a copy — and on a
   * device of this view's own, read back through memory, when it cannot.
   */
  winrt::com_ptr<ID2D1Bitmap1> Render(ID2D1DeviceContext *surfaceContext, D2D1_SIZE_U pixels, float dpi) noexcept {
    // Whatever the surface's context has batched goes to the device before
    // Direct3D draws on it.
    surfaceContext->Flush();

    // Direct2D's lock, which also guards its use of the Direct3D immediate
    // context, when its factory is multithreaded.
    winrt::com_ptr<ID2D1Factory> factory;
    surfaceContext->GetFactory(factory.put());
    const auto lock = factory.try_as<ID2D1Multithread>();
    const bool locked = lock && lock->GetMultithreadProtected();
    if (locked) lock->Enter();

    winrt::com_ptr<ID2D1Bitmap1> bitmap;
    auto device = SurfaceDevice(surfaceContext);
    const bool shared = static_cast<bool>(device);
    if (!shared) {
      if (!m_ownDevice) m_ownDevice = CreateOwnDevice();
      device = m_ownDevice;
    }
    if (device && m_renderer.Render(device.get(), *m_props.get(), pixels.width, pixels.height)) {
      bitmap = m_renderer.Bitmap(surfaceContext, shared, dpi);
    } else if (device) {
      // A device that cannot draw — removed, or missing what the shaders
      // need. Start over on the next change rather than draw nothing forever.
      m_renderer.Reset();
      if (!shared) m_ownDevice = nullptr;
    }

    if (locked) lock->Leave();
    return bitmap;
  }

  Experimental::ICompositionContext m_compContext{nullptr};
  Experimental::ISpriteVisual m_visual{nullptr};
  RN::IReactDispatcher m_dispatcher{nullptr};
  RN::LayoutMetrics m_layout{{0, 0, 0, 0}, 1.0};
  winrt::com_ptr<LineSceneProps> m_props;
  LineSceneRenderer m_renderer;
  winrt::com_ptr<ID3D11Device> m_ownDevice;
  bool m_drawPending = false;
};

void RegisterLineScene(RN::IReactPackageBuilder const &packageBuilder) noexcept {
  packageBuilder.as<RN::IReactPackageBuilderFabric>().AddViewComponent(
      L"WindowsLineScene", [](RN::IReactViewComponentBuilder const &builder) noexcept {
        builder.SetCreateProps([](RN::ViewProps props, const RN::IComponentProps &cloneFrom) noexcept {
          return winrt::make<LineSceneProps>(props, cloneFrom);
        });
        builder.SetUpdatePropsHandler(
            [](const RN::ComponentView &view, const RN::IComponentProps &newProps, const RN::IComponentProps &) noexcept {
              winrt::get_self<LineSceneView>(view.UserData())
                  ->UpdateProps(newProps ? newProps.as<LineSceneProps>() : nullptr);
            });
        auto compBuilder = builder.as<winrt::Microsoft::ReactNative::Composition::IReactCompositionViewComponentBuilder>();
        compBuilder.SetViewComponentViewInitializer([](const RN::ComponentView &view) noexcept {
          auto userData =
              winrt::make_self<LineSceneView>(view.as<Experimental::IInternalComponentView>().CompositionContext());
          userData->Initialize(view);
          view.UserData(*userData);
        });
        compBuilder.SetViewFeatures(winrt::Microsoft::ReactNative::Composition::ComponentViewFeatures::Default &
                                    ~winrt::Microsoft::ReactNative::Composition::ComponentViewFeatures::Background);
      });
}

} // namespace WindowsCanvas
