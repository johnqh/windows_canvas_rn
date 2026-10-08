/**
 * A canvas 2D context that records instead of drawing.
 *
 * Code written against `CanvasRenderingContext2D` — a renderer that already
 * draws to a browser canvas or a Skia canvas — draws into this unchanged, and
 * `finish()` hands back a `Picture` that `CanvasPicture` replays with Direct2D
 * on Windows. It is the role an `SkPicture` plays for Skia, for the one
 * React Native platform Skia does not run on.
 *
 * Platform-free: no React Native import, so it records in a test or a worker.
 *
 * **What is resolved here, and why.** Canvas state — the transform, the alpha,
 * the line style, the save/restore stack — lives in the recorder; each drawing
 * call writes an op with that state already applied (points transformed, alpha
 * folded into the colour). The native replay therefore keeps no state and
 * cannot disagree with the canvas about it. Two consequences worth knowing:
 *
 * - A stroke's width and dashes are scaled by the transform's area scale,
 *   `sqrt(|det|)`. Exact for uniform scales, rotations and translations, which
 *   is what drawing code uses; a non-uniform scale strokes with the average
 *   width rather than a stretched pen.
 * - Text keeps its transform and is laid out natively, so it is measured by
 *   `measureText` with whatever measurer the recorder was given.
 *
 * **Not supported**: gradients and patterns (drawn in opaque black),
 * `drawImage`, `arcTo`, `roundRect`, shadows, composite operations, filters,
 * and `strokeText`, which fills. Each is a no-op or the stated fallback, never
 * a throw — drawing code should keep going.
 */
import { parseColor, withAlpha } from './color.ts';
import { DEFAULT_FONT, parseFont } from './font.ts';
import type { FontSpec } from './font.ts';
import {
  FillRule,
  FORMAT_VERSION,
  LineCap,
  LineJoin,
  Op,
  Segment,
  TextAlign,
  TextBaseline,
} from './format.ts';
import type { Picture } from './format.ts';
import { approximateMeasurer } from './measure.ts';
import type { TextMeasurer } from './measure.ts';

/** The affine transform, in canvas order: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Matrix = {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
};

const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

type State = {
  matrix: Matrix;
  fillStyle: string | object;
  strokeStyle: string | object;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  miterLimit: number;
  font: string;
  globalAlpha: number;
  lineDash: number[];
  lineDashOffset: number;
  textAlign: string;
  textBaseline: string;
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
    font: '10px sans-serif',
    globalAlpha: 1,
    lineDash: [],
    lineDashOffset: 0,
    textAlign: 'start',
    textBaseline: 'alphabetic',
    clips: 0,
  };
}

function multiply(m: Matrix, n: Matrix): Matrix {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

function finite(...values: number[]): boolean {
  return values.every(Number.isFinite);
}

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
const ALIGNS: Record<string, number> = {
  start: TextAlign.Start,
  left: TextAlign.Start,
  center: TextAlign.Center,
  end: TextAlign.End,
  right: TextAlign.End,
};
const BASELINES: Record<string, number> = {
  alphabetic: TextBaseline.Alphabetic,
  top: TextBaseline.Top,
  hanging: TextBaseline.Top,
  middle: TextBaseline.Middle,
  bottom: TextBaseline.Bottom,
  ideographic: TextBaseline.Bottom,
};

export type TextMetricsResult = {
  readonly width: number;
  readonly actualBoundingBoxAscent: number;
  readonly actualBoundingBoxDescent: number;
  readonly fontBoundingBoxAscent: number;
  readonly fontBoundingBoxDescent: number;
};

export type RecorderOptions = {
  /** How `measureText` is answered. Defaults to an approximation. */
  measureText?: TextMeasurer;
};

export class PictureRecorder {
  readonly canvas: { width: number; height: number };

  private state = initialState();
  private readonly stack: State[] = [];
  private readonly ops: number[] = [FORMAT_VERSION];
  private readonly strings: string[] = [];
  private readonly stringIndex = new Map<string, number>();
  private readonly measure: TextMeasurer;

  // The current path, in device px, as segments ready to copy into an op.
  private path: number[] = [];
  private segments = 0;
  /** The current point and the open subpath's start, device px. */
  private current: { x: number; y: number } | null = null;
  private subpathStart: { x: number; y: number } | null = null;
  /** The last subpath was closed: the next segment opens a new one at its start. */
  private closed = false;

  constructor(width: number, height: number, options: RecorderOptions = {}) {
    this.canvas = { width, height };
    this.measure = options.measureText ?? approximateMeasurer;
  }

  // ---- state ---------------------------------------------------------------

  get fillStyle(): string | object {
    return this.state.fillStyle;
  }
  set fillStyle(value: string | object) {
    this.state.fillStyle = value;
  }
  get strokeStyle(): string | object {
    return this.state.strokeStyle;
  }
  set strokeStyle(value: string | object) {
    this.state.strokeStyle = value;
  }
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
  get font(): string {
    return this.state.font;
  }
  set font(value: string) {
    this.state.font = value;
  }
  get globalAlpha(): number {
    return this.state.globalAlpha;
  }
  set globalAlpha(value: number) {
    if (Number.isFinite(value) && value >= 0 && value <= 1)
      this.state.globalAlpha = value;
  }
  get lineDashOffset(): number {
    return this.state.lineDashOffset;
  }
  set lineDashOffset(value: number) {
    if (Number.isFinite(value)) this.state.lineDashOffset = value;
  }
  get textAlign(): string {
    return this.state.textAlign;
  }
  set textAlign(value: string) {
    if (value in ALIGNS) this.state.textAlign = value;
  }
  get textBaseline(): string {
    return this.state.textBaseline;
  }
  set textBaseline(value: string) {
    if (value in BASELINES) this.state.textBaseline = value;
  }

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

  setLineDash(segments: number[]): void {
    if (segments.some(value => !Number.isFinite(value) || value < 0)) return;
    // A canvas repeats an odd-length list to make it even.
    this.state.lineDash =
      segments.length % 2 === 1 ? [...segments, ...segments] : [...segments];
  }

  getLineDash(): number[] {
    return [...this.state.lineDash];
  }

  // ---- transform -----------------------------------------------------------

  translate(x: number, y: number): void {
    this.transform(1, 0, 0, 1, x, y);
  }

  scale(x: number, y: number): void {
    this.transform(x, 0, 0, y, 0, 0);
  }

  rotate(angle: number): void {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    this.transform(cos, sin, -sin, cos, 0, 0);
  }

  transform(a: number, b: number, c: number, d: number, e: number, f: number) {
    if (!finite(a, b, c, d, e, f)) return;
    this.state.matrix = multiply(this.state.matrix, { a, b, c, d, e, f });
  }

  /** Absolute: replaces the current transform rather than composing with it. */
  setTransform(
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number
  ): void {
    if (!finite(a, b, c, d, e, f)) return;
    this.state.matrix = { a, b, c, d, e, f };
  }

  resetTransform(): void {
    this.state.matrix = { ...IDENTITY };
  }

  getTransform(): Matrix {
    return { ...this.state.matrix };
  }

  // ---- paths ---------------------------------------------------------------

  beginPath(): void {
    this.path = [];
    this.segments = 0;
    this.current = null;
    this.subpathStart = null;
    this.closed = false;
  }

  moveTo(x: number, y: number): void {
    if (!finite(x, y)) return;
    const point = this.point(x, y);
    this.path.push(Segment.Move, point.x, point.y);
    this.segments += 1;
    this.current = point;
    this.subpathStart = point;
    this.closed = false;
  }

  lineTo(x: number, y: number): void {
    if (!finite(x, y)) return;
    if (!this.ensureSubpath(x, y)) return;
    const point = this.point(x, y);
    this.path.push(Segment.Line, point.x, point.y);
    this.segments += 1;
    this.current = point;
  }

  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    if (!finite(cpx, cpy, x, y)) return;
    this.ensureSubpath(cpx, cpy);
    const control = this.point(cpx, cpy);
    const point = this.point(x, y);
    this.path.push(Segment.Quad, control.x, control.y, point.x, point.y);
    this.segments += 1;
    this.current = point;
  }

  bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number
  ): void {
    if (!finite(cp1x, cp1y, cp2x, cp2y, x, y)) return;
    this.ensureSubpath(cp1x, cp1y);
    const c1 = this.point(cp1x, cp1y);
    const c2 = this.point(cp2x, cp2y);
    const point = this.point(x, y);
    this.path.push(Segment.Cubic, c1.x, c1.y, c2.x, c2.y, point.x, point.y);
    this.segments += 1;
    this.current = point;
  }

  closePath(): void {
    if (!this.current || this.closed) return;
    this.path.push(Segment.Close);
    this.segments += 1;
    this.current = this.subpathStart;
    this.closed = true;
  }

  rect(x: number, y: number, width: number, height: number): void {
    if (!finite(x, y, width, height)) return;
    this.moveTo(x, y);
    this.lineTo(x + width, y);
    this.lineTo(x + width, y + height);
    this.lineTo(x, y + height);
    this.closePath();
  }

  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise = false
  ): void {
    this.ellipse(
      x,
      y,
      radius,
      radius,
      0,
      startAngle,
      endAngle,
      counterclockwise
    );
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
    if (!finite(x, y, radiusX, radiusY, rotation, startAngle, endAngle)) return;
    if (radiusX < 0 || radiusY < 0) return;
    const full = Math.PI * 2;
    // The canvas spec's sweep: a full turn at most, in the stated direction.
    let sweep = endAngle - startAngle;
    if (!counterclockwise && sweep >= full) sweep = full;
    else if (counterclockwise && sweep <= -full) sweep = -full;
    else {
      if (!counterclockwise && sweep < 0) sweep = (sweep % full) + full;
      if (counterclockwise && sweep > 0) sweep = (sweep % full) - full;
    }
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const at = (angle: number) => {
      const px = radiusX * Math.cos(angle);
      const py = radiusY * Math.sin(angle);
      return { x: x + px * cos - py * sin, y: y + px * sin + py * cos };
    };
    const tangent = (angle: number) => {
      const px = -radiusX * Math.sin(angle);
      const py = radiusY * Math.cos(angle);
      return { x: px * cos - py * sin, y: px * sin + py * cos };
    };

    // Joined to whatever came before, as a canvas does — including a closed
    // subpath, whose start is then the current point.
    const start = at(startAngle);
    if (this.current) this.lineTo(start.x, start.y);
    else this.moveTo(start.x, start.y);
    if (sweep === 0) return;

    // Cubic segments of at most a quarter turn: the standard approximation,
    // well under a hundredth of a pixel off at any radius drawn on a screen.
    const pieces = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
    const step = sweep / pieces;
    const k = (4 / 3) * Math.tan(step / 4);
    let angle = startAngle;
    for (let i = 0; i < pieces; i += 1) {
      const next = angle + step;
      const p0 = at(angle);
      const p1 = at(next);
      const t0 = tangent(angle);
      const t1 = tangent(next);
      this.bezierCurveTo(
        p0.x + k * t0.x,
        p0.y + k * t0.y,
        p1.x - k * t1.x,
        p1.y - k * t1.y,
        p1.x,
        p1.y
      );
      angle = next;
    }
  }

  // ---- drawing -------------------------------------------------------------

  fill(fillRule: 'nonzero' | 'evenodd' = 'nonzero'): void {
    if (this.segments === 0) return;
    this.ops.push(
      Op.Fill,
      this.color(this.state.fillStyle),
      fillRule === 'evenodd' ? FillRule.EvenOdd : FillRule.NonZero,
      this.segments,
      ...this.path
    );
  }

  stroke(): void {
    if (this.segments === 0) return;
    this.pushStroke(this.segments, this.path);
  }

  clip(fillRule: 'nonzero' | 'evenodd' = 'nonzero'): void {
    this.ops.push(
      Op.Clip,
      fillRule === 'evenodd' ? FillRule.EvenOdd : FillRule.NonZero,
      this.segments,
      ...this.path
    );
    this.state.clips += 1;
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    if (!finite(x, y, width, height) || width === 0 || height === 0) return;
    const path = this.rectPath(x, y, width, height);
    this.ops.push(
      Op.Fill,
      this.color(this.state.fillStyle),
      FillRule.NonZero,
      5,
      ...path
    );
  }

  strokeRect(x: number, y: number, width: number, height: number): void {
    if (!finite(x, y, width, height)) return;
    this.pushStroke(5, this.rectPath(x, y, width, height));
  }

  clearRect(x: number, y: number, width: number, height: number): void {
    if (!finite(x, y, width, height)) return;
    const corners = [
      this.point(x, y),
      this.point(x + width, y),
      this.point(x, y + height),
      this.point(x + width, y + height),
    ];
    const xs = corners.map(point => point.x);
    const ys = corners.map(point => point.y);
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    this.ops.push(
      Op.ClearRect,
      left,
      top,
      Math.max(...xs) - left,
      Math.max(...ys) - top
    );
  }

  fillText(text: string, x: number, y: number, maxWidth?: number): void {
    if (!text || !finite(x, y)) return;
    const font = this.fontSpec();
    let matrix = this.state.matrix;
    if (maxWidth !== undefined && Number.isFinite(maxWidth) && maxWidth >= 0) {
      const width = this.measure(font, text).width;
      if (width > maxWidth && width > 0) {
        // A canvas squeezes the text horizontally about its anchor.
        const squeeze = maxWidth / width;
        matrix = multiply(matrix, {
          a: squeeze,
          b: 0,
          c: 0,
          d: 1,
          e: x - x * squeeze,
          f: 0,
        });
      }
    }
    this.ops.push(
      Op.Text,
      this.color(this.state.fillStyle),
      this.string(text),
      this.string(font.family),
      font.size,
      font.weight,
      font.italic ? 1 : 0,
      ALIGNS[this.state.textAlign] ?? TextAlign.Start,
      BASELINES[this.state.textBaseline] ?? TextBaseline.Alphabetic,
      matrix.a,
      matrix.b,
      matrix.c,
      matrix.d,
      matrix.e,
      matrix.f,
      x,
      y
    );
  }

  /** Filled, not outlined: DirectWrite strokes glyphs only through geometry. */
  strokeText(text: string, x: number, y: number, maxWidth?: number): void {
    const fill = this.state.fillStyle;
    this.state.fillStyle = this.state.strokeStyle;
    this.fillText(text, x, y, maxWidth);
    this.state.fillStyle = fill;
  }

  measureText(text: string): TextMetricsResult {
    const font = this.fontSpec();
    const { width, ascent, descent } = this.measure(font, text);
    return {
      width,
      actualBoundingBoxAscent: ascent,
      actualBoundingBoxDescent: descent,
      fontBoundingBoxAscent: ascent,
      fontBoundingBoxDescent: descent,
    };
  }

  /** The recording so far. The recorder can go on drawing afterwards. */
  finish(): Picture {
    // Clips still pushed at the outermost level are popped by the replay.
    return {
      width: this.canvas.width,
      height: this.canvas.height,
      ops: [...this.ops],
      strings: [...this.strings],
    };
  }

  // ---- internals -----------------------------------------------------------

  private point(x: number, y: number): { x: number; y: number } {
    const m = this.state.matrix;
    return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
  }

  /**
   * Opens a subpath where the canvas would, before a segment that needs one:
   * at `(x, y)` when there is no current point, at the closed subpath's start
   * after `closePath`. Answers whether the caller's segment should still be
   * added — a `lineTo` with no current point is only a `moveTo`.
   */
  private ensureSubpath(x: number, y: number): boolean {
    if (!this.current) {
      this.moveTo(x, y);
      return false;
    }
    if (this.closed) {
      const start = this.current;
      this.path.push(Segment.Move, start.x, start.y);
      this.segments += 1;
      this.subpathStart = start;
      this.closed = false;
    }
    return true;
  }

  private rectPath(x: number, y: number, width: number, height: number) {
    const a = this.point(x, y);
    const b = this.point(x + width, y);
    const c = this.point(x + width, y + height);
    const d = this.point(x, y + height);
    return [
      Segment.Move,
      a.x,
      a.y,
      Segment.Line,
      b.x,
      b.y,
      Segment.Line,
      c.x,
      c.y,
      Segment.Line,
      d.x,
      d.y,
      Segment.Close,
    ];
  }

  /** How much the transform scales lengths: the root of its area scale. */
  private lengthScale(): number {
    const m = this.state.matrix;
    return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
  }

  private pushStroke(segments: number, path: readonly number[]): void {
    const scale = this.lengthScale();
    const width = this.state.lineWidth * scale;
    if (width <= 0) return;
    const dashes = this.state.lineDash.every(value => value === 0)
      ? []
      : this.state.lineDash.map(value => value * scale);
    this.ops.push(
      Op.Stroke,
      this.color(this.state.strokeStyle),
      width,
      CAPS[this.state.lineCap] ?? LineCap.Butt,
      JOINS[this.state.lineJoin] ?? LineJoin.Miter,
      this.state.miterLimit,
      dashes.length,
      ...dashes,
      this.state.lineDashOffset * scale,
      segments,
      ...path
    );
  }

  private color(style: string | object): number {
    return withAlpha(parseColor(style), this.state.globalAlpha);
  }

  private fontSpec(): FontSpec {
    return this.state.font ? parseFont(this.state.font) : DEFAULT_FONT;
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
