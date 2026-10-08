/**
 * A canvas 2D context that records instead of drawing.
 *
 * Implements `CanvasRenderingContext2D` — every drawing, path, text, image,
 * transform, compositing, shadow and filter member of it — so code written for
 * a browser canvas or a Skia canvas draws into it unchanged, and `finish()`
 * hands back a `Picture` that `CanvasPicture` replays with Direct2D on
 * Windows. It plays the part an `SkPicture` plays for Skia.
 *
 * Platform-free: no React Native import, so it records in a test or a worker.
 *
 * **The one thing a recording cannot do is read pixels back.** There are no
 * pixels until the native view draws the picture, so `getImageData` answers
 * transparent pixels of the requested size (and warns once). Everything else
 * behaves as the canvas spec says, including the values it rejects: an
 * unreadable colour, font or filter leaves the property as it was, and the
 * calls that throw in a browser (`addColorStop` with a bad offset, a negative
 * radius) throw here.
 */
import { alphaOfColor, serializeColor, tryParseColor } from './color.ts';
import { parseFilter } from './filter.ts';
import { DEFAULT_FONT, STRETCH, tryParseFont } from './font.ts';
import type { FontSpec } from './font.ts';
import {
  Composite,
  FillRule,
  Filter,
  FORMAT_VERSION,
  Kerning,
  LineCap,
  LineJoin,
  Op,
  SmoothingQuality,
  TextRendering,
  VariantCaps,
} from './format.ts';
import type { Picture } from './format.ts';
import { ImageData, imageRef } from './image.ts';
import type { CanvasImageSourceLike } from './image.ts';
import type { Matrix, MatrixInit } from './matrix.ts';
import {
  applyMatrix,
  IDENTITY,
  invertMatrix,
  isFiniteMatrix,
  matrixFromInit,
  multiply,
} from './matrix.ts';
import { approximateMeasurer, DEFAULT_TEXT_STYLE } from './measure.ts';
import type { TextMeasurer, TextStyle } from './measure.ts';
import {
  acceptStyle,
  CanvasGradient,
  CanvasPattern,
  createConicGradient,
  createLinearGradient,
  createPattern,
  createRadialGradient,
  writePaint,
} from './paint.ts';
import {
  countSegments,
  domError,
  Path2D,
  PathBuilder,
  pointInPath,
  pointInStroke,
  transformPath,
} from './path.ts';
import type { RoundRectRadii } from './path.ts';

export type { Matrix } from './matrix.ts';

type Style = string | CanvasGradient | CanvasPattern;
type CanvasFillRule = 'nonzero' | 'evenodd';

const COMPOSITES: Record<string, number> = {
  'source-over': Composite.SourceOver,
  'source-in': Composite.SourceIn,
  'source-out': Composite.SourceOut,
  'source-atop': Composite.SourceAtop,
  'destination-over': Composite.DestinationOver,
  'destination-in': Composite.DestinationIn,
  'destination-out': Composite.DestinationOut,
  'destination-atop': Composite.DestinationAtop,
  lighter: Composite.Lighter,
  copy: Composite.Copy,
  xor: Composite.Xor,
  multiply: Composite.Multiply,
  screen: Composite.Screen,
  overlay: Composite.Overlay,
  darken: Composite.Darken,
  lighten: Composite.Lighten,
  'color-dodge': Composite.ColorDodge,
  'color-burn': Composite.ColorBurn,
  'hard-light': Composite.HardLight,
  'soft-light': Composite.SoftLight,
  difference: Composite.Difference,
  exclusion: Composite.Exclusion,
  hue: Composite.Hue,
  saturation: Composite.Saturation,
  color: Composite.Color,
  luminosity: Composite.Luminosity,
};
const CAPS: Record<string, number> = {
  butt: LineCap.Butt,
  round: LineCap.Round,
  square: LineCap.Square,
};
const JOINS: Record<string, number> = {
  miter: LineJoin.Miter,
  round: LineJoin.Round,
  bevel: LineJoin.Bevel,
};
const ALIGNS = new Set(['start', 'end', 'left', 'right', 'center']);
const BASELINES = new Set([
  'top',
  'hanging',
  'middle',
  'alphabetic',
  'ideographic',
  'bottom',
]);
const KERNINGS: Record<string, number> = {
  auto: Kerning.Auto,
  normal: Kerning.Normal,
  none: Kerning.None,
};
const VARIANT_CAPS: Record<string, number> = {
  normal: VariantCaps.Normal,
  'small-caps': VariantCaps.SmallCaps,
  'all-small-caps': VariantCaps.AllSmallCaps,
  'petite-caps': VariantCaps.PetiteCaps,
  'all-petite-caps': VariantCaps.AllPetiteCaps,
  unicase: VariantCaps.Unicase,
  'titling-caps': VariantCaps.TitlingCaps,
};
const RENDERINGS: Record<string, number> = {
  auto: TextRendering.Auto,
  optimizeSpeed: TextRendering.OptimizeSpeed,
  optimizeLegibility: TextRendering.OptimizeLegibility,
  geometricPrecision: TextRendering.GeometricPrecision,
};
const QUALITIES: Record<string, number> = {
  low: SmoothingQuality.Low,
  medium: SmoothingQuality.Medium,
  high: SmoothingQuality.High,
};

type State = {
  matrix: Matrix;
  fillStyle: Style;
  strokeStyle: Style;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  miterLimit: number;
  lineDash: number[];
  lineDashOffset: number;
  font: string;
  fontSpec: FontSpec;
  textAlign: string;
  textBaseline: string;
  direction: string;
  letterSpacing: string;
  wordSpacing: string;
  fontKerning: string;
  fontStretch: string;
  fontVariantCaps: string;
  textRendering: string;
  globalAlpha: number;
  globalCompositeOperation: string;
  shadowColor: number;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  filter: string;
  filterPrimitives: number[];
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: string;
  /** Clips pushed at this save level, popped by the matching restore. */
  clips: number;
};

function initialState(): State {
  return {
    matrix: { ...IDENTITY },
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    miterLimit: 10,
    lineDash: [],
    lineDashOffset: 0,
    font: '10px sans-serif',
    fontSpec: DEFAULT_FONT,
    textAlign: 'start',
    textBaseline: 'alphabetic',
    direction: 'inherit',
    letterSpacing: '0px',
    wordSpacing: '0px',
    fontKerning: 'auto',
    fontStretch: 'normal',
    fontVariantCaps: 'normal',
    textRendering: 'auto',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    shadowColor: 0x00000000,
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    filter: 'none',
    filterPrimitives: [],
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'low',
    clips: 0,
  };
}

function finite(...values: number[]): boolean {
  return values.every(Number.isFinite);
}

/** A CSS length for `letterSpacing`/`wordSpacing`, in px; null if unreadable. */
function spacing(value: string, fontSize: number): number | null {
  const match = String(value)
    .trim()
    .toLowerCase()
    .match(/^([+-]?(?:\d+\.?\d*|\.\d+))(px|em|rem|pt)?$/);
  if (!match) return null;
  const n = Number(match[1]);
  switch (match[2]) {
    case undefined:
      return n === 0 ? 0 : null;
    case 'px':
      return n;
    case 'em':
      return n * fontSize;
    case 'rem':
      return n * 16;
    case 'pt':
      return (n * 4) / 3;
    default:
      return null;
  }
}

/** How many primitives a filter list holds (a drop shadow takes four arguments). */
function primitiveCount(primitives: readonly number[]): number {
  let count = 0;
  for (let i = 0; i < primitives.length; count += 1) {
    i += primitives[i] === Filter.DropShadow ? 5 : 2;
  }
  return count;
}

export type TextMetricsResult = {
  readonly width: number;
  readonly actualBoundingBoxLeft: number;
  readonly actualBoundingBoxRight: number;
  readonly actualBoundingBoxAscent: number;
  readonly actualBoundingBoxDescent: number;
  readonly fontBoundingBoxAscent: number;
  readonly fontBoundingBoxDescent: number;
  readonly emHeightAscent: number;
  readonly emHeightDescent: number;
  readonly hangingBaseline: number;
  readonly alphabeticBaseline: number;
  readonly ideographicBaseline: number;
};

export type RecorderOptions = {
  /** How text is measured and anchored. Defaults to an approximation. */
  measureText?: TextMeasurer;
};

let warnedReadback = false;

export class PictureRecorder {
  readonly canvas: { width: number; height: number };

  private state = initialState();
  private stack: State[] = [];
  private ops: number[] = [FORMAT_VERSION];
  private strings: string[] = [];
  private stringIndex = new Map<string, number>();
  private readonly measure: TextMeasurer;
  /** The current path, mapped by the transform in force as each point is added. */
  private readonly path = new PathBuilder(() => this.state.matrix);

  // What the picture's state ops last said, so each is written on change only.
  private emittedComposite: number = Composite.SourceOver;
  private emittedShadow = '0,0,0,0';
  private emittedFilter = '';
  private emittedSmoothing = '1,0';

  constructor(width: number, height: number, options: RecorderOptions = {}) {
    this.canvas = { width, height };
    this.measure = options.measureText ?? approximateMeasurer;
  }

  // ---- the context ---------------------------------------------------------

  getContextAttributes() {
    return {
      alpha: true,
      colorSpace: 'srgb' as const,
      desynchronized: false,
      willReadFrequently: false,
    };
  }

  isContextLost(): boolean {
    return false;
  }

  /** Back to a blank canvas and the default state, as `reset()` does. */
  reset(): void {
    this.state = initialState();
    this.stack = [];
    this.ops = [FORMAT_VERSION];
    this.strings = [];
    this.stringIndex = new Map();
    this.path.clear();
    this.emittedComposite = Composite.SourceOver;
    this.emittedShadow = '0,0,0,0';
    this.emittedFilter = '';
    this.emittedSmoothing = '1,0';
  }

  /** The recording so far. The recorder can go on drawing afterwards. */
  finish(): Picture {
    return {
      width: this.canvas.width,
      height: this.canvas.height,
      ops: [...this.ops],
      strings: [...this.strings],
    };
  }

  // ---- state ---------------------------------------------------------------

  save(): void {
    this.stack.push(this.state);
    this.state = {
      ...this.state,
      matrix: { ...this.state.matrix },
      lineDash: [...this.state.lineDash],
      clips: 0,
    };
  }

  restore(): void {
    const previous = this.stack.pop();
    if (!previous) return;
    if (this.state.clips > 0) this.ops.push(Op.PopClip, this.state.clips);
    this.state = previous;
  }

  // ---- transform -----------------------------------------------------------

  scale(x: number, y: number): void {
    this.transform(x, 0, 0, y, 0, 0);
  }

  rotate(angle: number): void {
    if (!Number.isFinite(angle)) return;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    this.transform(cos, sin, -sin, cos, 0, 0);
  }

  translate(x: number, y: number): void {
    this.transform(1, 0, 0, 1, x, y);
  }

  transform(
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number
  ): void {
    if (!finite(a, b, c, d, e, f)) return;
    this.state.matrix = multiply(this.state.matrix, { a, b, c, d, e, f });
  }

  getTransform(): Matrix {
    return { ...this.state.matrix };
  }

  /** Absolute: replaces the current transform. Six numbers, or a matrix. */
  setTransform(
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number
  ): void;
  setTransform(transform?: MatrixInit): void;
  setTransform(
    a?: number | MatrixInit,
    b?: number,
    c?: number,
    d?: number,
    e?: number,
    f?: number
  ): void {
    const m =
      typeof a === 'number'
        ? { a, b: b!, c: c!, d: d!, e: e!, f: f! }
        : matrixFromInit(a);
    if (isFiniteMatrix(m)) this.state.matrix = m;
  }

  resetTransform(): void {
    this.state.matrix = { ...IDENTITY };
  }

  // ---- compositing ---------------------------------------------------------

  get globalAlpha(): number {
    return this.state.globalAlpha;
  }
  set globalAlpha(value: number) {
    if (Number.isFinite(value) && value >= 0 && value <= 1)
      this.state.globalAlpha = value;
  }
  get globalCompositeOperation(): string {
    return this.state.globalCompositeOperation;
  }
  set globalCompositeOperation(value: string) {
    if (value in COMPOSITES) this.state.globalCompositeOperation = value;
  }

  // ---- image smoothing -----------------------------------------------------

  get imageSmoothingEnabled(): boolean {
    return this.state.imageSmoothingEnabled;
  }
  set imageSmoothingEnabled(value: boolean) {
    this.state.imageSmoothingEnabled = !!value;
  }
  get imageSmoothingQuality(): string {
    return this.state.imageSmoothingQuality;
  }
  set imageSmoothingQuality(value: string) {
    if (value in QUALITIES) this.state.imageSmoothingQuality = value;
  }

  // ---- colours and styles --------------------------------------------------

  get fillStyle(): string | object {
    return this.readStyle(this.state.fillStyle);
  }
  set fillStyle(value: string | object) {
    const accepted = acceptStyle(value);
    if (accepted !== null) this.state.fillStyle = accepted;
  }
  get strokeStyle(): string | object {
    return this.readStyle(this.state.strokeStyle);
  }
  set strokeStyle(value: string | object) {
    const accepted = acceptStyle(value);
    if (accepted !== null) this.state.strokeStyle = accepted;
  }

  private readStyle(style: Style): string | object {
    return typeof style === 'string'
      ? serializeColor(tryParseColor(style) ?? 0x000000ff)
      : style;
  }

  createLinearGradient(x0: number, y0: number, x1: number, y1: number) {
    return createLinearGradient(x0, y0, x1, y1);
  }
  createRadialGradient(
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number
  ) {
    return createRadialGradient(x0, y0, r0, x1, y1, r1);
  }
  createConicGradient(startAngle: number, x: number, y: number) {
    return createConicGradient(startAngle, x, y);
  }
  createPattern(image: CanvasImageSourceLike, repetition: string | null) {
    return createPattern(image, repetition);
  }

  // ---- shadows -------------------------------------------------------------

  get shadowColor(): string {
    return serializeColor(this.state.shadowColor);
  }
  set shadowColor(value: string) {
    const color = tryParseColor(value);
    if (color !== null) this.state.shadowColor = color;
  }
  get shadowBlur(): number {
    return this.state.shadowBlur;
  }
  set shadowBlur(value: number) {
    if (Number.isFinite(value) && value >= 0) this.state.shadowBlur = value;
  }
  get shadowOffsetX(): number {
    return this.state.shadowOffsetX;
  }
  set shadowOffsetX(value: number) {
    if (Number.isFinite(value)) this.state.shadowOffsetX = value;
  }
  get shadowOffsetY(): number {
    return this.state.shadowOffsetY;
  }
  set shadowOffsetY(value: number) {
    if (Number.isFinite(value)) this.state.shadowOffsetY = value;
  }

  // ---- filters -------------------------------------------------------------

  get filter(): string {
    return this.state.filter;
  }
  set filter(value: string) {
    const primitives = parseFilter(String(value));
    if (primitives === null) return;
    this.state.filter = String(value);
    this.state.filterPrimitives = primitives;
  }

  // ---- rectangles ----------------------------------------------------------

  clearRect(x: number, y: number, w: number, h: number): void {
    if (!finite(x, y, w, h) || w === 0 || h === 0) return;
    const rect = this.rectPath(x, y, w, h);
    this.ops.push(Op.Clear, countSegments(rect), ...rect);
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    if (!finite(x, y, w, h) || w === 0 || h === 0) return;
    this.writeFill(this.rectPath(x, y, w, h), FillRule.NonZero);
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    if (!finite(x, y, w, h) || (w === 0 && h === 0)) return;
    // Already in the stroke's own space.
    const builder = new PathBuilder();
    builder.rect(x, y, w, h);
    this.writeStroke(builder.data, false);
  }

  /** A rectangle mapped by the current transform, for ops in device space. */
  private rectPath(x: number, y: number, w: number, h: number): number[] {
    const builder = new PathBuilder(() => this.state.matrix);
    builder.rect(x, y, w, h);
    return builder.data;
  }

  // ---- line styles ---------------------------------------------------------

  get lineWidth(): number {
    return this.state.lineWidth;
  }
  set lineWidth(value: number) {
    if (Number.isFinite(value) && value > 0) this.state.lineWidth = value;
  }
  get lineCap(): string {
    return this.state.lineCap;
  }
  set lineCap(value: string) {
    if (value in CAPS) this.state.lineCap = value;
  }
  get lineJoin(): string {
    return this.state.lineJoin;
  }
  set lineJoin(value: string) {
    if (value in JOINS) this.state.lineJoin = value;
  }
  get miterLimit(): number {
    return this.state.miterLimit;
  }
  set miterLimit(value: number) {
    if (Number.isFinite(value) && value > 0) this.state.miterLimit = value;
  }
  get lineDashOffset(): number {
    return this.state.lineDashOffset;
  }
  set lineDashOffset(value: number) {
    if (Number.isFinite(value)) this.state.lineDashOffset = value;
  }
  setLineDash(segments: number[]): void {
    if (segments.some(value => !Number.isFinite(value) || value < 0)) return;
    // A canvas repeats an odd-length list to make it even.
    this.state.lineDash =
      segments.length % 2 === 1 ? [...segments, ...segments] : [...segments];
  }
  getLineDash(): number[] {
    return [...this.state.lineDash];
  }

  // ---- text styles ---------------------------------------------------------

  get font(): string {
    return this.state.font;
  }
  set font(value: string) {
    const spec = tryParseFont(String(value));
    if (!spec) return;
    this.state.font = String(value).trim();
    this.state.fontSpec = spec;
    // The shorthand resets the longhands it covers.
    this.state.fontStretch =
      Object.keys(STRETCH).find(key => STRETCH[key] === spec.stretch) ??
      'normal';
    this.state.fontVariantCaps = spec.smallCaps ? 'small-caps' : 'normal';
  }
  get textAlign(): string {
    return this.state.textAlign;
  }
  set textAlign(value: string) {
    if (ALIGNS.has(value)) this.state.textAlign = value;
  }
  get textBaseline(): string {
    return this.state.textBaseline;
  }
  set textBaseline(value: string) {
    if (BASELINES.has(value)) this.state.textBaseline = value;
  }
  get direction(): string {
    return this.state.direction;
  }
  set direction(value: string) {
    if (['ltr', 'rtl', 'inherit'].includes(value)) this.state.direction = value;
  }
  get letterSpacing(): string {
    return this.state.letterSpacing;
  }
  set letterSpacing(value: string) {
    if (spacing(value, 10) !== null) this.state.letterSpacing = value;
  }
  get wordSpacing(): string {
    return this.state.wordSpacing;
  }
  set wordSpacing(value: string) {
    if (spacing(value, 10) !== null) this.state.wordSpacing = value;
  }
  get fontKerning(): string {
    return this.state.fontKerning;
  }
  set fontKerning(value: string) {
    if (value in KERNINGS) this.state.fontKerning = value;
  }
  get fontStretch(): string {
    return this.state.fontStretch;
  }
  set fontStretch(value: string) {
    if (value in STRETCH) this.state.fontStretch = value;
  }
  get fontVariantCaps(): string {
    return this.state.fontVariantCaps;
  }
  set fontVariantCaps(value: string) {
    if (value in VARIANT_CAPS) this.state.fontVariantCaps = value;
  }
  get textRendering(): string {
    return this.state.textRendering;
  }
  set textRendering(value: string) {
    if (value in RENDERINGS) this.state.textRendering = value;
  }

  // ---- paths ---------------------------------------------------------------

  beginPath(): void {
    this.path.clear();
  }
  closePath(): void {
    this.path.closePath();
  }
  moveTo(x: number, y: number): void {
    this.path.moveTo(x, y);
  }
  lineTo(x: number, y: number): void {
    this.path.lineTo(x, y);
  }
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    this.path.quadraticCurveTo(cpx, cpy, x, y);
  }
  bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number
  ): void {
    this.path.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
  }
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void {
    this.path.arcTo(x1, y1, x2, y2, radius);
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.path.rect(x, y, w, h);
  }
  roundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    radii?: RoundRectRadii
  ): void {
    this.path.roundRect(x, y, w, h, radii);
  }
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise = false
  ): void {
    this.path.arc(x, y, radius, startAngle, endAngle, counterclockwise);
  }
  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
    counterclockwise = false
  ): void {
    this.path.ellipse(
      x,
      y,
      radiusX,
      radiusY,
      rotation,
      startAngle,
      endAngle,
      counterclockwise
    );
  }

  /** The current path, or a `Path2D` mapped by the current transform, in device px. */
  private devicePath(path?: Path2D): number[] {
    return path
      ? transformPath(path.builder.data, this.state.matrix)
      : this.path.data;
  }

  // ---- drawing paths -------------------------------------------------------

  fill(fillRule?: CanvasFillRule): void;
  fill(path: Path2D, fillRule?: CanvasFillRule): void;
  fill(a?: Path2D | CanvasFillRule, b?: CanvasFillRule): void {
    const path = a instanceof Path2D ? a : undefined;
    const evenOdd = (a instanceof Path2D ? b : a) === 'evenodd';
    const data = this.devicePath(path);
    if (data.length === 0) return;
    this.writeFill(data, evenOdd ? FillRule.EvenOdd : FillRule.NonZero);
  }

  stroke(path?: Path2D): void {
    const data = this.devicePath(path);
    if (data.length === 0) return;
    this.writeStroke(data, true);
  }

  clip(fillRule?: CanvasFillRule): void;
  clip(path: Path2D, fillRule?: CanvasFillRule): void;
  clip(a?: Path2D | CanvasFillRule, b?: CanvasFillRule): void {
    const path = a instanceof Path2D ? a : undefined;
    const evenOdd = (a instanceof Path2D ? b : a) === 'evenodd';
    const data = this.devicePath(path);
    this.ops.push(
      Op.Clip,
      evenOdd ? FillRule.EvenOdd : FillRule.NonZero,
      countSegments(data),
      ...data
    );
    this.state.clips += 1;
  }

  isPointInPath(x: number, y: number, fillRule?: CanvasFillRule): boolean;
  isPointInPath(
    path: Path2D,
    x: number,
    y: number,
    fillRule?: CanvasFillRule
  ): boolean;
  isPointInPath(
    a: Path2D | number,
    b: number,
    c?: number | CanvasFillRule,
    d?: CanvasFillRule
  ): boolean {
    const path = a instanceof Path2D ? a : undefined;
    const x = path ? b : (a as number);
    const y = path ? (c as number) : b;
    const rule = path ? d : (c as CanvasFillRule | undefined);
    if (!finite(x, y)) return false;
    return pointInPath(this.devicePath(path), x, y, rule === 'evenodd');
  }

  isPointInStroke(x: number, y: number): boolean;
  isPointInStroke(path: Path2D, x: number, y: number): boolean;
  isPointInStroke(a: Path2D | number, b: number, c?: number): boolean {
    const path = a instanceof Path2D ? a : undefined;
    const x = path ? b : (a as number);
    const y = path ? c! : b;
    if (!finite(x, y)) return false;
    // In the stroke's own space, where the pen is lineWidth wide.
    const inverse = invertMatrix(this.state.matrix);
    if (!inverse) return false;
    const local = applyMatrix(inverse, x, y);
    const data = transformPath(this.devicePath(path), inverse);
    return pointInStroke(data, local.x, local.y, this.state.lineWidth);
  }

  /** No focus ring or scrolling in a picture. */
  drawFocusIfNeeded(): void {}
  scrollPathIntoView(): void {}

  // ---- text ----------------------------------------------------------------

  fillText(text: string, x: number, y: number, maxWidth?: number): void {
    this.writeText(0, text, x, y, maxWidth);
  }

  strokeText(text: string, x: number, y: number, maxWidth?: number): void {
    this.writeText(1, text, x, y, maxWidth);
  }

  measureText(text: string): TextMetricsResult {
    const content = this.normalizeText(text);
    const m = this.measure(this.state.fontSpec, content, this.textStyle());
    const anchor = this.alignOffset(m.width);
    const b = this.baselineOffset(m);
    return {
      width: m.width,
      actualBoundingBoxLeft: anchor - m.inkLeft,
      actualBoundingBoxRight: m.inkRight - anchor,
      actualBoundingBoxAscent: m.inkAscent - b,
      actualBoundingBoxDescent: m.inkDescent + b,
      fontBoundingBoxAscent: m.fontAscent - b,
      fontBoundingBoxDescent: m.fontDescent + b,
      emHeightAscent: m.emAscent - b,
      emHeightDescent: m.emDescent + b,
      hangingBaseline: m.hanging - b,
      alphabeticBaseline: -b,
      ideographicBaseline: -m.emDescent - b,
    };
  }

  /** The spec replaces ASCII whitespace with spaces before laying text out. */
  private normalizeText(text: string): string {
    return String(text).replace(/[\t\n\f\r]/g, ' ');
  }

  private rtl(): boolean {
    return this.state.direction === 'rtl';
  }

  private textStyle(): TextStyle {
    const size = this.state.fontSpec.size;
    return {
      ...DEFAULT_TEXT_STYLE,
      letterSpacing: spacing(this.state.letterSpacing, size) ?? 0,
      wordSpacing: spacing(this.state.wordSpacing, size) ?? 0,
      kerning: KERNINGS[this.state.fontKerning] ?? Kerning.Auto,
      variantCaps: VARIANT_CAPS[this.state.fontVariantCaps] ?? 0,
      rtl: this.rtl(),
    };
  }

  /** How far right of the text's start the alignment point is. */
  private alignOffset(width: number): number {
    let align = this.state.textAlign;
    if (align === 'start') align = this.rtl() ? 'right' : 'left';
    if (align === 'end') align = this.rtl() ? 'left' : 'right';
    return align === 'right' ? width : align === 'center' ? width / 2 : 0;
  }

  /** How far below the `textBaseline` line the alphabetic baseline is. */
  private baselineOffset(m: {
    emAscent: number;
    emDescent: number;
    hanging: number;
  }): number {
    switch (this.state.textBaseline) {
      case 'top':
        return m.emAscent;
      case 'hanging':
        return m.hanging;
      case 'middle':
        return (m.emAscent - m.emDescent) / 2;
      case 'ideographic':
      case 'bottom':
        return -m.emDescent;
      default:
        return 0;
    }
  }

  private writeText(
    mode: 0 | 1,
    text: string,
    x: number,
    y: number,
    maxWidth?: number
  ): void {
    if (!finite(x, y)) return;
    if (maxWidth !== undefined && !(maxWidth > 0)) return;
    const content = this.normalizeText(text);
    if (!content) return;
    const font = this.state.fontSpec;
    const style = this.textStyle();
    const m = this.measure(font, content, style);
    let matrix = this.state.matrix;
    if (maxWidth !== undefined && m.width > maxWidth && m.width > 0) {
      // Squeezed horizontally about the anchor to fit, as a canvas does.
      const squeeze = maxWidth / m.width;
      matrix = multiply(matrix, {
        a: squeeze,
        b: 0,
        c: 0,
        d: 1,
        e: x - x * squeeze,
        f: 0,
      });
    }
    const out: number[] = [Op.Text, mode];
    const paintStyle =
      mode === 0 ? this.state.fillStyle : this.state.strokeStyle;
    if (!this.paint(out, paintStyle)) return;
    if (mode === 1) this.pushStroke(out);
    out.push(
      this.string(content),
      this.string(font.family),
      font.size,
      font.weight,
      font.style,
      STRETCH[this.state.fontStretch] ?? 5,
      style.rtl ? 1 : 0,
      style.letterSpacing,
      style.wordSpacing,
      style.kerning,
      style.variantCaps,
      RENDERINGS[this.state.textRendering] ?? TextRendering.Auto,
      matrix.a,
      matrix.b,
      matrix.c,
      matrix.d,
      matrix.e,
      matrix.f,
      x - this.alignOffset(m.width),
      y + this.baselineOffset(m)
    );
    this.syncState();
    this.ops.push(...out);
  }

  // ---- images --------------------------------------------------------------

  drawImage(image: CanvasImageSourceLike, dx: number, dy: number): void;
  drawImage(
    image: CanvasImageSourceLike,
    dx: number,
    dy: number,
    dw: number,
    dh: number
  ): void;
  drawImage(
    image: CanvasImageSourceLike,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number
  ): void;
  drawImage(image: CanvasImageSourceLike, ...args: number[]): void {
    const ref = imageRef(image);
    if (!ref) {
      throw new TypeError(
        'The image argument is not a supported image source.'
      );
    }
    let sx = 0;
    let sy = 0;
    let sw = ref.width;
    let sh = ref.height;
    let dx: number;
    let dy: number;
    let dw: number;
    let dh: number;
    if (args.length === 2) {
      [dx, dy] = args as [number, number];
      dw = ref.width;
      dh = ref.height;
    } else if (args.length === 4) {
      [dx, dy, dw, dh] = args as [number, number, number, number];
    } else if (args.length === 8) {
      [sx, sy, sw, sh, dx, dy, dw, dh] = args as [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
      ];
    } else {
      throw new TypeError(
        `drawImage takes 3, 5 or 9 arguments, not ${args.length + 1}.`
      );
    }
    if (!finite(sx, sy, sw, sh, dx, dy, dw, dh)) return;
    // Negative sizes flip a rectangle to the other side of its origin.
    if (sw < 0) [sx, sw] = [sx + sw, -sw];
    if (sh < 0) [sy, sh] = [sy + sh, -sh];
    if (dw < 0) [dx, dw] = [dx + dw, -dw];
    if (dh < 0) [dy, dh] = [dy + dh, -dh];
    if (sw === 0 || sh === 0 || dw === 0 || dh === 0) return;
    // Source outside the image draws nothing: clip it, and the destination in
    // proportion.
    const scaleX = dw / sw;
    const scaleY = dh / sh;
    const left = Math.max(sx, 0);
    const top = Math.max(sy, 0);
    const right = Math.min(sx + sw, ref.width);
    const bottom = Math.min(sy + sh, ref.height);
    if (right <= left || bottom <= top) return;
    dx += (left - sx) * scaleX;
    dy += (top - sy) * scaleY;
    dw = (right - left) * scaleX;
    dh = (bottom - top) * scaleY;
    const m = this.state.matrix;
    this.syncState();
    this.ops.push(
      Op.Image,
      this.string(ref.source),
      this.state.globalAlpha,
      ref.width,
      ref.height,
      left,
      top,
      right - left,
      bottom - top,
      dx,
      dy,
      dw,
      dh,
      m.a,
      m.b,
      m.c,
      m.d,
      m.e,
      m.f
    );
  }

  createImageData(width: number, height: number): ImageData;
  createImageData(imageData: ImageData): ImageData;
  createImageData(a: number | ImageData, b?: number): ImageData {
    if (typeof a === 'number') {
      if (!finite(a, b ?? NaN)) {
        throw new TypeError('The provided value is non-finite.');
      }
      if (a === 0 || b === 0) {
        throw domError('IndexSizeError', 'The source width or height is 0.');
      }
      return new ImageData(Math.abs(a), Math.abs(b!));
    }
    return new ImageData(a.width, a.height);
  }

  /**
   * Transparent pixels: a recording has nothing drawn to read back until the
   * native view draws it. Warns once, so the gap is not silent.
   */
  getImageData(sx: number, sy: number, sw: number, sh: number): ImageData {
    if (!finite(sx, sy, sw, sh)) {
      throw new TypeError('The provided value is non-finite.');
    }
    if (sw === 0 || sh === 0) {
      throw domError('IndexSizeError', 'The source width or height is 0.');
    }
    if (!warnedReadback) {
      warnedReadback = true;
      console.warn(
        'windows_canvas_rn: getImageData cannot read pixels from a recording; it returns transparent pixels.'
      );
    }
    return new ImageData(Math.abs(sw), Math.abs(sh));
  }

  putImageData(
    imageData: ImageData,
    dx: number,
    dy: number,
    dirtyX = 0,
    dirtyY = 0,
    dirtyWidth = imageData.width,
    dirtyHeight = imageData.height
  ): void {
    if (!finite(dx, dy, dirtyX, dirtyY, dirtyWidth, dirtyHeight)) return;
    // The spec's dirty-rectangle normalisation and clipping.
    if (dirtyWidth < 0)
      [dirtyX, dirtyWidth] = [dirtyX + dirtyWidth, -dirtyWidth];
    if (dirtyHeight < 0)
      [dirtyY, dirtyHeight] = [dirtyY + dirtyHeight, -dirtyHeight];
    if (dirtyX < 0) [dirtyWidth, dirtyX] = [dirtyWidth + dirtyX, 0];
    if (dirtyY < 0) [dirtyHeight, dirtyY] = [dirtyHeight + dirtyY, 0];
    dirtyWidth = Math.min(dirtyWidth, imageData.width - dirtyX);
    dirtyHeight = Math.min(dirtyHeight, imageData.height - dirtyY);
    if (dirtyWidth <= 0 || dirtyHeight <= 0) return;
    const ref = imageRef(imageData);
    if (!ref) return;
    this.ops.push(
      Op.PutImage,
      this.string(ref.source),
      Math.trunc(dx),
      Math.trunc(dy),
      Math.trunc(dirtyX),
      Math.trunc(dirtyY),
      Math.trunc(dirtyWidth),
      Math.trunc(dirtyHeight)
    );
  }

  // ---- internals -----------------------------------------------------------

  /** Writes the state ops the next drawing op depends on, where they changed. */
  private syncState(): void {
    const s = this.state;
    const composite = COMPOSITES[s.globalCompositeOperation] ?? 0;
    if (composite !== this.emittedComposite) {
      this.ops.push(Op.SetComposite, composite);
      this.emittedComposite = composite;
    }
    // A shadow is drawn only when it would show.
    const visible =
      alphaOfColor(s.shadowColor) > 0 &&
      (s.shadowBlur > 0 || s.shadowOffsetX !== 0 || s.shadowOffsetY !== 0);
    const shadow = visible
      ? [s.shadowColor, s.shadowBlur, s.shadowOffsetX, s.shadowOffsetY]
      : [0, 0, 0, 0];
    const shadowKey = shadow.join(',');
    if (shadowKey !== this.emittedShadow) {
      this.ops.push(Op.SetShadow, ...shadow);
      this.emittedShadow = shadowKey;
    }
    const filterKey = s.filterPrimitives.join(',');
    if (filterKey !== this.emittedFilter) {
      this.ops.push(
        Op.SetFilter,
        primitiveCount(s.filterPrimitives),
        ...s.filterPrimitives
      );
      this.emittedFilter = filterKey;
    }
    const smoothing = [
      s.imageSmoothingEnabled ? 1 : 0,
      QUALITIES[s.imageSmoothingQuality] ?? 0,
    ];
    const smoothingKey = smoothing.join(',');
    if (smoothingKey !== this.emittedSmoothing) {
      this.ops.push(Op.SetSmoothing, ...smoothing);
      this.emittedSmoothing = smoothingKey;
    }
  }

  private paint(out: number[], style: Style): boolean {
    return writePaint(
      out,
      style,
      this.state.matrix,
      this.state.globalAlpha,
      value => this.string(value)
    );
  }

  private writeFill(data: number[], rule: number): void {
    const out: number[] = [Op.Fill, rule];
    if (!this.paint(out, this.state.fillStyle)) return;
    out.push(countSegments(data), ...data);
    this.syncState();
    this.ops.push(...out);
  }

  /**
   * A stroke, recorded in the stroke's own space — a device-space path mapped
   * back by the transform in force now — with that transform alongside, so
   * the native view strokes with the pen a canvas would: `lineWidth` wide in
   * this space, however the transform scales or skews it.
   */
  private writeStroke(data: number[], deviceSpace: boolean): void {
    const m = this.state.matrix;
    let local = data;
    if (deviceSpace) {
      const inverse = invertMatrix(m);
      // A singular transform collapses the pen: nothing to draw.
      if (!inverse) return;
      local = transformPath(data, inverse);
    }
    const out: number[] = [Op.Stroke];
    if (!this.paint(out, this.state.strokeStyle)) return;
    this.pushStroke(out);
    out.push(m.a, m.b, m.c, m.d, m.e, m.f, countSegments(local), ...local);
    this.syncState();
    this.ops.push(...out);
  }

  /** width, cap, join, miterLimit, dashCount, dashes, dashOffset — stroke space. */
  private pushStroke(out: number[]): void {
    const s = this.state;
    const dashes = s.lineDash.every(value => value === 0) ? [] : s.lineDash;
    out.push(
      s.lineWidth,
      CAPS[s.lineCap] ?? LineCap.Butt,
      JOINS[s.lineJoin] ?? LineJoin.Miter,
      s.miterLimit,
      dashes.length,
      ...dashes,
      s.lineDashOffset
    );
  }

  private string(value: string): number {
    const known = this.stringIndex.get(value);
    if (known !== undefined) return known;
    const index = this.strings.length;
    this.strings.push(value);
    this.stringIndex.set(value, index);
    return index;
  }
}
