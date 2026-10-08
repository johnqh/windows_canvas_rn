# windows_canvas_rn

The whole `CanvasRenderingContext2D` API as a recording context
(`src/recorder.ts`), and a React Native Windows Composition view that replays
the recording with Direct2D, DirectWrite and Direct2D effects (`windows/`). See
README.md for the API, its one limit (`getImageData` cannot read back) and the
Windows setup.

## Commands

- `bun run verify` — format, typecheck, lint, tests, build. Before any push.
- `bun run test:unit` — vitest, node environment.

## Rules

- **The recorder resolves canvas state; the replay keeps only four things.**
  Points are transformed, alpha folded into colours, arcs turned into cubics,
  text anchored, before an op is written. The replay's only state is what a
  canvas applies to every op — composite, shadow, filter, smoothing — set by
  `Set…` ops written on change. A new feature is a format change: bump
  `FORMAT_VERSION` in `src/format.ts` and `windows/PictureFormat.h` together;
  `format.test.ts` compares them, and `decode.ts` is the reference reader the
  C++ mirrors.
- **The API is the spec's, edges included.** `recorder.test.ts` lists every
  member of `CanvasRenderingContext2D` and fails if one is missing; invalid
  values are ignored and the spec's throws throw. Check a behaviour against
  the HTML spec before changing it.
- **A layer composites source-over.** Anything that must replace pixels —
  `clearRect` under a clip, every composite but source-over — goes through an
  effect graph against a copy of the target and is written back with a clip
  mask (`Replayer::ReplaceThroughClip`), never inside a pushed layer.
- **`src/` is published and is what Metro loads** (`react-native` points at
  it): React Native's codegen Babel plugin reads the prop types in
  `WindowsCanvasPictureNativeComponent.ts`, which compiled JavaScript no longer
  has. Relative imports carry `.ts`/`.tsx` extensions so Metro finds the file
  exactly; `rewriteRelativeImportExtensions` turns them into `.js` in `dist`,
  which is what Node and vitest load.
- **`src/core.ts` must not import React Native**, directly or through anything
  it re-exports: it is the entry for tests and workers.
- **None of the native code can be compiled on a Mac.** It follows the
  patterns of react-native-svg's Windows Fabric `SvgView` and the
  `MoosiacNativeSlider` in mail_box_components_rn, which do build against React
  Native Windows 0.81; check a change against those before assuming an API.
- **One draw per transaction.** Props, layout and mounting all call
  `Invalidate`, which posts a single draw to the UI dispatcher. Drawing inside
  each callback is the react-native-svg bug this package exists to avoid.
- **Native sources are listed in `windows/WindowsCanvas.targets`**, which apps
  import. Add a file there, not in an app project.
