# windows_canvas_rn

A canvas 2D recording context (`src/recorder.ts`) and a React Native Windows
Composition view that replays the recording with Direct2D and DirectWrite
(`windows/WindowsCanvas.cpp`). See README.md for the API and the Windows setup.

## Commands

- `bun run verify` — format, typecheck, lint, tests, build. Before any push.
- `bun run test:unit` — vitest, node environment.

## Rules

- **The recorder resolves all canvas state; the replay keeps none.** Points
  are transformed, alpha folded into colours, arcs turned into cubics before an
  op is written. A feature that needs state on the native side is a format
  change — bump `FORMAT_VERSION` in `src/format.ts` and
  `windows/PictureFormat.h` together; `format.test.ts` compares them.
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
