#include "CanvasImages.h"

#include <algorithm>
#include <fstream>
#include <thread>

#include <shlwapi.h>
#include <wincrypt.h>

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Storage.h>
#include <winrt/Windows.Storage.Streams.h>
#include <winrt/Windows.Web.Http.h>

#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "shlwapi.lib")
#pragma comment(lib, "windowscodecs.lib")

namespace WindowsCanvas {

namespace {

bool StartsWith(const std::string &text, const char *prefix) {
  return text.rfind(prefix, 0) == 0;
}

std::vector<uint8_t> Base64(const std::string &text) {
  DWORD size = 0;
  if (!CryptStringToBinaryA(text.c_str(), static_cast<DWORD>(text.size()), CRYPT_STRING_BASE64, nullptr,
                            &size, nullptr, nullptr)) {
    return {};
  }
  std::vector<uint8_t> bytes(size);
  if (!CryptStringToBinaryA(text.c_str(), static_cast<DWORD>(text.size()), CRYPT_STRING_BASE64,
                            bytes.data(), &size, nullptr, nullptr)) {
    return {};
  }
  bytes.resize(size);
  return bytes;
}

std::string PercentDecode(const std::string &text) {
  std::string out;
  for (size_t i = 0; i < text.size(); ++i) {
    if (text[i] == '%' && i + 2 < text.size()) {
      out += static_cast<char>(std::stoi(text.substr(i + 1, 2), nullptr, 16));
      i += 2;
    } else {
      out += text[i];
    }
  }
  return out;
}

std::vector<uint8_t> ReadFileBytes(const std::wstring &path) {
  std::ifstream file(path, std::ios::binary);
  if (!file) return {};
  return std::vector<uint8_t>(std::istreambuf_iterator<char>(file), {});
}

std::vector<uint8_t> BufferBytes(const winrt::Windows::Storage::Streams::IBuffer &buffer) {
  std::vector<uint8_t> bytes(buffer.Length());
  if (!bytes.empty()) memcpy(bytes.data(), buffer.data(), bytes.size());
  return bytes;
}

/** The exe's folder: where a packaged Win32 app's `ms-appx:///` files sit. */
std::wstring AppDirectory() {
  wchar_t path[MAX_PATH]{};
  GetModuleFileNameW(nullptr, path, MAX_PATH);
  std::wstring directory = path;
  return directory.substr(0, directory.find_last_of(L"\\/") + 1);
}

std::vector<uint8_t> Fetch(const std::string &source) {
  using namespace winrt::Windows::Foundation;
  if (StartsWith(source, "data:")) {
    const auto comma = source.find(',');
    if (comma == std::string::npos) return {};
    const auto header = source.substr(0, comma);
    const auto body = source.substr(comma + 1);
    if (header.find(";base64") != std::string::npos) return Base64(body);
    const auto decoded = PercentDecode(body);
    return std::vector<uint8_t>(decoded.begin(), decoded.end());
  }
  if (StartsWith(source, "http://") || StartsWith(source, "https://")) {
    winrt::Windows::Web::Http::HttpClient client;
    return BufferBytes(client.GetBufferAsync(Uri(winrt::to_hstring(source))).get());
  }
  if (StartsWith(source, "ms-appx:") || StartsWith(source, "ms-appdata:")) {
    try {
      auto file = winrt::Windows::Storage::StorageFile::GetFileFromApplicationUriAsync(
                      Uri(winrt::to_hstring(source)))
                      .get();
      return BufferBytes(winrt::Windows::Storage::FileIO::ReadBufferAsync(file).get());
    } catch (...) {
      // Not packaged, or not found there: try beside the exe.
      auto relative = Wide(PercentDecode(source.substr(source.find(":///") + 4)));
      std::replace(relative.begin(), relative.end(), L'/', L'\\');
      return ReadFileBytes(AppDirectory() + relative);
    }
  }
  std::string path = source;
  if (StartsWith(path, "file:///")) path = PercentDecode(path.substr(8));
  else if (StartsWith(path, "file://")) path = PercentDecode(path.substr(7));
  auto wide = Wide(path);
  std::replace(wide.begin(), wide.end(), L'/', L'\\');
  return ReadFileBytes(wide);
}

winrt::com_ptr<IWICBitmapSource> Decode(const std::vector<uint8_t> &bytes) {
  auto factory = WicFactory();
  if (!factory || bytes.empty()) return nullptr;
  winrt::com_ptr<IStream> stream;
  stream.attach(SHCreateMemStream(bytes.data(), static_cast<UINT>(bytes.size())));
  winrt::com_ptr<IWICBitmapDecoder> decoder;
  winrt::com_ptr<IWICBitmapFrameDecode> frame;
  winrt::com_ptr<IWICFormatConverter> converter;
  winrt::com_ptr<IWICBitmap> bitmap;
  if (!stream ||
      FAILED(factory->CreateDecoderFromStream(stream.get(), nullptr, WICDecodeMetadataCacheOnDemand,
                                              decoder.put())) ||
      FAILED(decoder->GetFrame(0, frame.put())) || FAILED(factory->CreateFormatConverter(converter.put())) ||
      FAILED(converter->Initialize(frame.get(), GUID_WICPixelFormat32bppPBGRA, WICBitmapDitherTypeNone,
                                   nullptr, 0, WICBitmapPaletteTypeMedianCut)) ||
      // Decoded now, into memory any thread may read.
      FAILED(factory->CreateBitmapFromSource(converter.get(), WICBitmapCacheOnLoad, bitmap.put()))) {
    return nullptr;
  }
  return bitmap.as<IWICBitmapSource>();
}

} // namespace

winrt::com_ptr<IWICImagingFactory> WicFactory() noexcept {
  winrt::com_ptr<IWICImagingFactory> factory;
  CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(factory.put()));
  return factory;
}

ImageCache &ImageCache::Shared() noexcept {
  static ImageCache cache;
  return cache;
}

winrt::com_ptr<IWICBitmap> ImageCache::DecodeRgba(const std::string &source) noexcept {
  // rgba;W;H;base64
  const auto a = source.find(';');
  const auto b = source.find(';', a + 1);
  const auto c = source.find(';', b + 1);
  if (a == std::string::npos || b == std::string::npos || c == std::string::npos) return nullptr;
  const UINT width = static_cast<UINT>(std::stoul(source.substr(a + 1, b - a - 1)));
  const UINT height = static_cast<UINT>(std::stoul(source.substr(b + 1, c - b - 1)));
  auto pixels = Base64(source.substr(c + 1));
  if (width == 0 || height == 0 || pixels.size() != static_cast<size_t>(width) * height * 4) return nullptr;
  // Straight RGBA → premultiplied BGRA.
  for (size_t i = 0; i < pixels.size(); i += 4) {
    const uint8_t r = pixels[i], g = pixels[i + 1], b2 = pixels[i + 2], alpha = pixels[i + 3];
    pixels[i] = static_cast<uint8_t>((b2 * alpha + 127) / 255);
    pixels[i + 1] = static_cast<uint8_t>((g * alpha + 127) / 255);
    pixels[i + 2] = static_cast<uint8_t>((r * alpha + 127) / 255);
  }
  auto factory = WicFactory();
  winrt::com_ptr<IWICBitmap> bitmap;
  if (!factory || FAILED(factory->CreateBitmapFromMemory(width, height, GUID_WICPixelFormat32bppPBGRA,
                                                         width * 4, static_cast<UINT>(pixels.size()),
                                                         pixels.data(), bitmap.put()))) {
    return nullptr;
  }
  return bitmap;
}

winrt::com_ptr<IWICBitmapSource> ImageCache::Get(const std::string &source,
                                                 std::function<void()> onReady) noexcept {
  if (StartsWith(source, "rgba;")) {
    auto pixels = DecodeRgba(source);
    return pixels ? pixels.as<IWICBitmapSource>() : nullptr;
  }
  std::lock_guard lock(m_mutex);
  auto [entry, created] = m_entries.try_emplace(source);
  switch (entry->second.state) {
    case State::Ready:
      return entry->second.bitmap;
    case State::Failed:
      return nullptr;
    case State::Loading:
      if (onReady) entry->second.waiting.push_back(std::move(onReady));
      if (created) {
        std::thread([this, source]() { Load(source); }).detach();
      }
      return nullptr;
  }
  return nullptr;
}

void ImageCache::Load(std::string source) noexcept {
  winrt::init_apartment(winrt::apartment_type::multi_threaded);
  winrt::com_ptr<IWICBitmapSource> bitmap;
  try {
    bitmap = Decode(Fetch(source));
  } catch (...) {
    bitmap = nullptr;
  }
  std::vector<std::function<void()>> waiting;
  {
    std::lock_guard lock(m_mutex);
    auto &entry = m_entries[source];
    entry.state = bitmap ? State::Ready : State::Failed;
    entry.bitmap = bitmap;
    waiting.swap(entry.waiting);
  }
  // A failure is news too: the picture stops waiting and draws without it.
  for (auto &callback : waiting) callback();
  winrt::uninit_apartment();
}

} // namespace WindowsCanvas
