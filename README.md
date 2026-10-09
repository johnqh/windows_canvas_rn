# @sudobility/windows_canvas_rn

The HTML canvas 2D API for React Native Windows: draw with
`CanvasRenderingContext2D`, show the result with Direct2D.

React Native Skia has no Windows target, and react-native-svg's Windows
renderer redraws its whole document once per element that changes — a drawing
of a few thousand shapes costs seconds of UI-thread time. This package records
canvas calls into a compact picture in JavaScript and replays it natively in a
single Direct2D pass, with text laid out by DirectWrite and effects run as
Direct2D effect graphs. It plays the part an `SkPicture` plays for Skia.

```tsx
import { CanvasPicture, createRecorder } from '@sudobility/windows_canvas_rn';

const ctx = createRecorder(width, height); // a CanvasRenderingContext2D
const sky = ctx.createLinearGradient(0, 0, 0, height);
sky.addColorStop(0, '#87ceeb');
sky.addColorStop(1, 'white');
ctx.fillStyle = sky;
ctx.fillRect(0, 0, width, height);
ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
ctx.shadowBlur = 8;
ctx.fillStyle = 'tomato';
ctx.beginPath();
ctx.roundRect(20, 20, 120, 60, 12);
ctx.fill();
ctx.font = 'bold 16px sans-serif';
ctx.textAlign = 'center';
ctx.textBaseline = 'middle';
ctx.fillStyle = 'white';
ctx.fillText('Hello', 80, 50);

<CanvasPicture picture={ctx.finish()} style={{ width, height }} />;
```

Code already written against a browser canvas or a Skia canvas draws into the
recorder unchanged. `@sudobility/windows_canvas_rn/core` has everything but the
view — the recorder, `Path2D`, `ImageData`, `decodePicture` — without React
Native, for tests and workers.

## Coverage

Every member of `CanvasRenderingContext2D` is implemented, and a test fails if
one goes missing:

| Area | Members |
| --- | --- |
| State | `save`, `restore`, `reset`, `isContextLost`, `getContextAttributes`, `canvas` |
| Transforms | `scale`, `rotate`, `translate`, `transform`, `setTransform` (numbers or a matrix), `getTransform`, `resetTransform` |
| Compositing | `globalAlpha`, `globalCompositeOperation` — all 26 operations, Porter-Duff and blend modes |
| Styles | colours (every CSS Color 4 form), `createLinearGradient`, `createRadialGradient`, `createConicGradient`, `createPattern` (all four repetitions, `setTransform`) |
| Shadows | `shadowColor`, `shadowBlur`, `shadowOffsetX`, `shadowOffsetY` |
| Filters | `filter`: `blur`, `brightness`, `contrast`, `drop-shadow`, `grayscale`, `hue-rotate`, `invert`, `opacity`, `saturate`, `sepia` |
| Rectangles | `clearRect`, `fillRect`, `strokeRect` |
| Paths | `beginPath`, `closePath`, `moveTo`, `lineTo`, `quadraticCurveTo`, `bezierCurveTo`, `arc`, `arcTo`, `ellipse`, `rect`, `roundRect`, and `Path2D` (including SVG path data and `addPath`) |
| Drawing paths | `fill` and `clip` (both fill rules), `stroke`, `isPointInPath`, `isPointInStroke` |
| Line styles | `lineWidth`, `lineCap`, `lineJoin`, `miterLimit`, `setLineDash`, `getLineDash`, `lineDashOffset` |
| Text | `fillText`, `strokeText` (real glyph outlines), `measureText` (full `TextMetrics`), `font`, `textAlign`, `textBaseline`, `direction`, `letterSpacing`, `wordSpacing`, `fontKerning`, `fontStretch`, `fontVariantCaps`, `textRendering` |
| Images | `drawImage` (all three forms), `createImageData`, `putImageData`, `imageSmoothingEnabled`, `imageSmoothingQuality` |
| Focus | `drawFocusIfNeeded`, `scrollPathIntoView` (no-ops: a picture has no focus or scroll) |

It also behaves as a canvas does at the edges: an unreadable colour, font or
filter leaves the property as it was; the calls that throw in a browser
(`addColorStop` with an offset outside 0–1, a negative radius, `drawImage` with
something that is not an image) throw here; `fillText`'s `maxWidth` squeezes
the text; `roundRect` scales radii that would overlap.

### The one limit

**`getImageData` cannot read pixels back.** A recording has no pixels until
the native view draws it, so it answers transparent pixels of the requested
size and warns once. Everything that writes pixels, `putImageData` included, is
supported.

### Approximations

- A radial gradient whose start circle has a radius and is not concentric with
  its end circle is drawn about the larger circle from the smaller's centre.
  Exact for a zero start radius and for concentric circles, which is nearly
  every use.
- A conic gradient is computed per pixel over the view, since Direct2D has no
  conic brush: correct, and slower than the others.
- `isPointInStroke` treats joins and caps as round and dashes as solid.
- The `hanging` baseline is 80% of the em ascent; DirectWrite reports none.

## Images

`drawImage` and `createPattern` take:

- React Native's resolved asset source, `{ uri, width, height }` — from
  `Image.resolveAssetSource(require('./art.png'))` — or any URI with its size:
  `file:`, plain paths, `ms-appx:` (falling back to the exe's folder when the
  app is not packaged), `http(s):` (Metro's development assets included) and
  `data:`;
- an `HTMLImageElement`-like `{ src, naturalWidth, naturalHeight }`;
- `ImageData`, or anything shaped like it;
- another `PictureRecorder`, or a `Picture`, drawn as an image.

The size given is the size the image is placed with, so a `@2x` asset draws at
its logical size. Images load on a background thread, shared by every view; a
picture that draws one before it has loaded is drawn again when it has.

## Text

Text is measured natively on Windows, by a synchronous `measureText` that lays
it out with the same DirectWrite formats the view draws with (cached per font,
style and string), so text is anchored where it is drawn. Elsewhere it is an
approximation. The font's family list is honoured — the first installed family
is used — and generic families map to the faces a browser on Windows uses
(`sans-serif` → Segoe UI, `serif` → Times New Roman, `monospace` → Consolas).
Emoji keep their colours, and glyphs missing from the face come from the
system's font fallback.

## 3D lines

`LineScene` draws a 3D scene of coloured line segments on the GPU: Direct3D
11, on the same device the Composition surface is drawn with, with a depth
buffer, 4× multisampling where the device has it, and linear fog toward the
background colour. Redrawn once per change, never on a frame loop.

```tsx
import { LineScene } from '@sudobility/windows_canvas_rn';

<LineScene
  batches={[
    { vertices: grid, color: '#232a34' },
    { vertices: model, matrix: modelMatrix.elements, color: 'tomato' },
  ]}
  camera={{ view: camera.matrixWorldInverse.elements, fovDeg: 70, near: 0.05, far: 100 }}
  fog={{ near: 8, far: 30 }}
  background="#12161d"
  style={{ width, height }}
/>;
```

The conventions are three.js's, so a three scene goes over as it is:
matrices are column-major (`Matrix4.elements`), space is right-handed with y
up, and the camera looks down its own -z. Each pair of vertices is a
segment. The vertical field of view is fixed and the horizontal one follows
the view's aspect, as a `PerspectiveCamera`'s does.

Batches are packed against the previous render's (`packLineBatches` in
`core`), so a prop whose contents did not change stays the same array and
React leaves it out of the update: a colour or camera change sends a few
numbers, and the vertices go to the GPU only when the geometry changes.
Lines are one pixel wide — Direct3D has no line width, as WebGL has none in
practice.

## Windows setup

The view is a Fabric **Composition** component (React Native Windows new
architecture). Import the package's MSBuild targets into the app's `.vcxproj`
— it adds the include path and every source file, so later releases change no
app project:

```xml
<PropertyGroup>
  <WindowsCanvasRNDir>$(MSBuildThisFileDirectory)..\..\node_modules\@sudobility\windows_canvas_rn\windows\</WindowsCanvasRNDir>
</PropertyGroup>
<!-- after the C++ targets import -->
<Import Project="$(WindowsCanvasRNDir)WindowsCanvas.targets" />
```

and register it in the app's `IReactPackageProvider`:

```cpp
#include "WindowsCanvas.h"

void CreatePackage(IReactPackageBuilder const &packageBuilder) noexcept {
  AddAttributedModules(packageBuilder, true); // the measureText module
  WindowsCanvas::RegisterWindowsCanvas(packageBuilder);
}
```

It links what it uses (`d2d1`, `dwrite`, `dxguid`, `windowscodecs`, `crypt32`,
`shlwapi`, `d3d11`, `d3dcompiler`) itself. Only the JavaScript recorder runs on other platforms;
`CanvasPicture` and `LineScene` have no native view outside Windows.

## How it draws

The recorder resolves canvas state as it records: points are transformed,
arcs and rounded corners become cubic curves, colours carry the global alpha,
text is anchored at the start of its alphabetic baseline, and a stroke is
recorded in its own space with its transform, so the pen is exactly what a
canvas would use however the transform scales or skews it. The composite
operation, shadow, filter and smoothing are written as state ops only when
they change.

The view replays a picture into an offscreen bitmap on a device context of its
own, once per change, after React's mount transaction. Source-over drawing with
no shadow or filter goes straight to the bitmap, clipped by layers. Anything
else is recorded into a command list and run through a Direct2D effect graph —
the filter chain, the shadow, then a Composite or Blend effect against a copy
of the destination — and written back through the clip as a mask, since a
layer composites its content source-over and would undo a `copy`.

`decodePicture` reads a picture back into structured ops, op for op as the
native replay reads it.

## Development

```sh
bun install
bun run verify   # format, typecheck, lint, tests, build
```

The picture format is defined twice — `src/format.ts` and
`windows/PictureFormat.h` — and `src/format.test.ts` fails if they disagree.
Bump `FORMAT_VERSION` in both when an op's layout changes; the native view
draws nothing for a picture of another version.
