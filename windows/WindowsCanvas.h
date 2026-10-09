// @sudobility/windows_canvas_rn — the native half.
//
// `WindowsCanvasPicture`, a Fabric Composition view that replays a picture
// recorded by src/recorder.ts with Direct2D (shapes) and DirectWrite (text),
// and `WindowsCanvas`, a module whose synchronous `measureText` lays text out
// with the same DirectWrite formats the view draws with. `RegisterWindowsCanvas`
// also registers `WindowsLineScene` (LineScene.h), a 3D line scene drawn with
// Direct3D 11.
//
// A consumer compiles windows/WindowsCanvas.cpp into its own React Native
// Windows (Composition) project and, in its IReactPackageProvider:
//
//   AddAttributedModules(packageBuilder, true);   // picks up the module
//   WindowsCanvas::RegisterWindowsCanvas(packageBuilder);
//
// See README.md for the project-file lines.
#pragma once

#include <winrt/Microsoft.ReactNative.h>

namespace WindowsCanvas {

void RegisterWindowsCanvas(
    winrt::Microsoft::ReactNative::IReactPackageBuilder const &packageBuilder) noexcept;

} // namespace WindowsCanvas
