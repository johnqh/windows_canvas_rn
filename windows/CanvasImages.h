// Images a picture refers to, decoded once and shared by every view.
#pragma once

#include "CanvasCommon.h"

#include <mutex>
#include <unordered_map>

namespace WindowsCanvas {

/**
 * Loads image sources into premultiplied BGRA WIC bitmaps, off the UI thread.
 *
 * `Get` answers a bitmap that is ready, and otherwise starts loading it and
 * calls `onReady` — on whatever thread finished — when it is, so the view
 * that asked can draw again. Raw RGBA (`rgba;W;H;base64`) is decoded on the
 * spot. A source that fails stays failed; it is not retried on every frame.
 */
class ImageCache {
 public:
  static ImageCache &Shared() noexcept;

  winrt::com_ptr<IWICBitmapSource> Get(const std::string &source, std::function<void()> onReady) noexcept;

  /** Raw straight RGBA → premultiplied BGRA, synchronously. */
  static winrt::com_ptr<IWICBitmap> DecodeRgba(const std::string &source) noexcept;

 private:
  enum class State { Loading, Ready, Failed };
  struct Entry {
    State state = State::Loading;
    winrt::com_ptr<IWICBitmapSource> bitmap;
    std::vector<std::function<void()>> waiting;
  };

  void Load(std::string source) noexcept;

  std::mutex m_mutex;
  std::unordered_map<std::string, Entry> m_entries;
};

winrt::com_ptr<IWICImagingFactory> WicFactory() noexcept;

} // namespace WindowsCanvas
