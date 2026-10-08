/**
 * Everything that needs no React Native: the recorder, the format and the
 * parsers. `@sudobility/windows_canvas_rn/core` — for tests, workers and any
 * code that records a picture without drawing it.
 */
export { PictureRecorder } from './recorder.ts';
export type { Matrix, RecorderOptions, TextMetricsResult } from './recorder.ts';
export {
  EMPTY_PICTURE,
  FORMAT_VERSION,
  FillRule,
  LineCap,
  LineJoin,
  Op,
  Segment,
  TextAlign,
  TextBaseline,
} from './format.ts';
export type { Picture } from './format.ts';
export { parseColor, withAlpha } from './color.ts';
export { DEFAULT_FONT, parseFont, resolveFamily } from './font.ts';
export type { FontSpec } from './font.ts';
export { approximateMeasurer, cachedMeasurer } from './measure.ts';
export type { TextMeasure, TextMeasurer } from './measure.ts';
