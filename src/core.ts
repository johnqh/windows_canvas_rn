/**
 * Everything that needs no React Native: the recorder, `Path2D`, gradients,
 * patterns, `ImageData`, the format and the parsers.
 * `@sudobility/windows_canvas_rn/core` — for tests, workers and any code that
 * records a picture without drawing it.
 */
export { PictureRecorder } from './recorder.ts';
export type { RecorderOptions, TextMetricsResult } from './recorder.ts';
export { Path2D } from './path.ts';
export type { RoundRectRadii } from './path.ts';
export { CanvasGradient, CanvasPattern } from './paint.ts';
export { ImageData, imageRef, encodeBase64 } from './image.ts';
export type { CanvasImageSourceLike, ImageRef } from './image.ts';
export type { Matrix, MatrixInit } from './matrix.ts';
export {
  Composite,
  EMPTY_PICTURE,
  FillRule,
  Filter,
  FontStyle,
  FORMAT_VERSION,
  Kerning,
  LineCap,
  LineJoin,
  Op,
  Paint,
  Repetition,
  Segment,
  SmoothingQuality,
  TextRendering,
  VariantCaps,
} from './format.ts';
export type { Picture } from './format.ts';
export {
  parseColor,
  serializeColor,
  tryParseColor,
  withAlpha,
} from './color.ts';
export { parseFilter } from './filter.ts';
export {
  DEFAULT_FONT,
  parseFont,
  resolveFamily,
  tryParseFont,
} from './font.ts';
export type { FontSpec } from './font.ts';
export {
  approximateMeasurer,
  cachedMeasurer,
  DEFAULT_TEXT_STYLE,
} from './measure.ts';
export type { TextMeasure, TextMeasurer, TextStyle } from './measure.ts';
export {
  IDENTITY_MATRIX,
  packLineBatches,
  packLineSceneCamera,
  packLineSceneFog,
} from './line-scene.ts';
export type {
  LineBatch,
  LineSceneCamera,
  LineSceneFog,
  Matrix4Elements,
  PackedLineBatches,
} from './line-scene.ts';
export { decodePicture } from './decode.ts';
export type {
  DecodedOp,
  DecodedPaint,
  DecodedSegment,
  DecodedStroke,
} from './decode.ts';
