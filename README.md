# @sudobility/windows_canvas_rn

A canvas for React Native Windows: draw with the canvas 2D API, show the result
with Direct2D.

React Native Skia has no Windows target, and react-native-svg's Windows
renderer redraws its whole document once per element that changes — a drawing
of a few thousand shapes costs seconds of UI-thread time. This package records
canvas calls into a compact picture in JavaScript and replays it natively in a
single Direct2D pass, with text laid out by DirectWrite. It plays the part an
`SkPicture` plays for Skia.

```ts
import { CanvasPicture, createRecorder } from '@sudobility/windows_canvas_rn';

const ctx = createRecorder(width, height); // a CanvasRenderingContext2D subset
ctx.fillStyle = '#1565c0';
ctx.beginPath();
ctx.arc(40, 40, 20, 0, Math.PI * 2);
ctx.fill();
ctx.font = 'bold 14px sans-serif';
ctx.fillText('Hello', 70, 45);
const picture = ctx.finish();

<CanvasPicture picture={picture} style={{ width, height }} />;
```

Code already written against a browser canvas or a Skia canvas draws into the
recorder unchanged. `@sudobility/windows_canvas_rn/core` has the recorder
without React Native, for tests and workers.

## What is supported

Paths (`moveTo`, `lineTo`, `quadraticCurveTo`, `bezierCurveTo`, `arc`,
`ellipse`, `rect`, `closePath`), `fill` (nonzero and evenodd), `stroke` (width,
caps, joins, miter limit, dashes), `fillRect`, `strokeRect`, `clearRect`,
`clip`, `fillText` (with `maxWidth`, `textAlign`, `textBaseline`),
`measureText`, the full transform API, `save`/`restore`, `globalAlpha`, and CSS
colours (`#hex`, `rgb()`/`rgba()`, common names).

Not supported: gradients and patterns (drawn opaque black), `drawImage`,
`arcTo`, `roundRect`, shadows, composite operations and filters; `strokeText`
fills. None of them throw.

Two behaviours to know:

- **Stroke widths and dashes scale by `sqrt(|det|)` of the transform**, which
  is exact for uniform scales and rotations; a non-uniform scale strokes with
  the average width.
- **Text is measured natively on Windows** by a synchronous `measureText` that
  uses the same DirectWrite formats the view draws with, cached per font and
  string. Elsewhere it is an approximation. Generic families map to Windows
  faces (`sans-serif` → Segoe UI, `serif` → Times New Roman, `monospace` →
  Consolas).

## Windows setup

The view is a Fabric **Composition** component (React Native Windows new
architecture). Compile the native source into your app's project, as with any
manually linked module:

```xml
<!-- MyApp.vcxproj -->
<PropertyGroup>
  <WindowsCanvasRNDir>$(MSBuildThisFileDirectory)..\..\node_modules\@sudobility\windows_canvas_rn\windows\</WindowsCanvasRNDir>
</PropertyGroup>
<!-- in the ClCompile ItemDefinitionGroup's AdditionalIncludeDirectories: $(WindowsCanvasRNDir); -->
<ItemGroup>
  <ClInclude Include="$(WindowsCanvasRNDir)WindowsCanvas.h" />
  <ClInclude Include="$(WindowsCanvasRNDir)PictureFormat.h" />
  <ClCompile Include="$(WindowsCanvasRNDir)WindowsCanvas.cpp">
    <PrecompiledHeader>NotUsing</PrecompiledHeader>
  </ClCompile>
</ItemGroup>
```

and register it in your `IReactPackageProvider`:

```cpp
#include "WindowsCanvas.h"

void CreatePackage(IReactPackageBuilder const &packageBuilder) noexcept {
  AddAttributedModules(packageBuilder, true); // the measureText module
  WindowsCanvas::RegisterWindowsCanvas(packageBuilder);
}
```

It links `d2d1.lib` and `dwrite.lib` itself. Only the JavaScript recorder runs
on other platforms; `CanvasPicture` has no native view outside Windows.

## Development

```sh
bun install
bun run verify   # format, typecheck, lint, tests, build
```

The picture format is defined twice — `src/format.ts` and
`windows/PictureFormat.h` — and `src/format.test.ts` fails if they disagree.
Bump `FORMAT_VERSION` in both when an op's layout changes; the native view
draws nothing for a picture of another version.
