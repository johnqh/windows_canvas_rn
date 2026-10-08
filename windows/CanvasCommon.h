// What every native source file of the package includes. They are compiled
// without the consumer's precompiled header, so this is self-sufficient.
#pragma once

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <unknwn.h>

#include <d2d1_3.h>
#include <d2d1effects_2.h>
#include <dwrite_3.h>
#include <wincodec.h>

#include <functional>
#include <memory>
#include <string>
#include <vector>

#include <winrt/base.h>
#include <winrt/Microsoft.ReactNative.h>

namespace WindowsCanvas {

std::wstring Wide(const std::string &utf8);

/** 0xRRGGBBAA, straight alpha, as the format packs it. */
D2D1_COLOR_F UnpackColor(double packed) noexcept;

} // namespace WindowsCanvas
