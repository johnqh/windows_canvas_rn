// `WindowsLineScene`: a Fabric Composition view that draws a 3D scene of
// coloured line segments with Direct3D 11 — see src/line-scene.ts for the
// props and their conventions (three.js's: column-major, right-handed, the
// camera looking down -z).
//
// Registered by WindowsCanvas::RegisterWindowsCanvas; an app calls nothing
// else.
#pragma once

#include <winrt/Microsoft.ReactNative.h>

namespace WindowsCanvas {

void RegisterLineScene(winrt::Microsoft::ReactNative::IReactPackageBuilder const &packageBuilder) noexcept;

} // namespace WindowsCanvas
