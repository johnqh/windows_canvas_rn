/**
 * `CanvasGradient` and `CanvasPattern`, and how a style becomes a paint.
 *
 * A gradient's stops can still change after it has been assigned to
 * `fillStyle` — a canvas reads them when it fills — so a paint is written when
 * something is drawn with it, with the transform in force at that moment, as
 * a canvas resolves it.
 */
import { tryParseColor, withAlpha } from './color.ts';
import { Paint, Repetition } from './format.ts';
import type { ImageRef } from './image.ts';
import { imageRef } from './image.ts';
import type { Matrix, MatrixInit } from './matrix.ts';
import {
  IDENTITY,
  matrixFromInit,
  multiply,
  isFiniteMatrix,
} from './matrix.ts';
import { domError } from './path.ts';

type GradientShape =
  | { kind: 'linear'; x0: number; y0: number; x1: number; y1: number }
  | {
      kind: 'radial';
      x0: number;
      y0: number;
      r0: number;
      x1: number;
      y1: number;
      r1: number;
    }
  | { kind: 'conic'; angle: number; x: number; y: number };

export class CanvasGradient {
  /** @internal */
  readonly stops: [number, number][] = [];

  /** @internal */
  constructor(readonly shape: GradientShape) {}

  addColorStop(offset: number, color: string): void {
    if (!(offset >= 0 && offset <= 1)) {
      throw domError('IndexSizeError', `The offset ${offset} is outside 0–1.`);
    }
    const parsed = tryParseColor(color);
    if (parsed === null) {
      throw domError(
        'SyntaxError',
        `"${color}" could not be parsed as a color.`
      );
    }
    // Stops at one offset keep their order: insert after any equal offsets.
    let index = this.stops.length;
    while (index > 0 && this.stops[index - 1]![0] > offset) index -= 1;
    this.stops.splice(index, 0, [offset, parsed]);
  }
}

const REPETITIONS: Record<string, number> = {
  '': Repetition.Repeat,
  repeat: Repetition.Repeat,
  'repeat-x': Repetition.RepeatX,
  'repeat-y': Repetition.RepeatY,
  'no-repeat': Repetition.NoRepeat,
};

export class CanvasPattern {
  /** @internal */
  matrix: Matrix = { ...IDENTITY };

  /** @internal */
  constructor(
    readonly image: ImageRef,
    readonly repetition: number
  ) {}

  setTransform(transform?: MatrixInit): void {
    const m = matrixFromInit(transform);
    if (isFiniteMatrix(m)) this.matrix = m;
  }
}

export function createPattern(
  image: unknown,
  repetition: string | null
): CanvasPattern | null {
  const mode = REPETITIONS[repetition ?? ''];
  if (mode === undefined) {
    throw domError('SyntaxError', `"${repetition}" is not a valid repetition.`);
  }
  const ref = imageRef(image);
  if (!ref) {
    throw new TypeError('The image argument is not a supported image source.');
  }
  // A canvas returns null for an image with no pixels.
  if (ref.width === 0 || ref.height === 0) return null;
  return new CanvasPattern(ref, mode);
}

export function createLinearGradient(
  x0: number,
  y0: number,
  x1: number,
  y1: number
): CanvasGradient {
  requireFinite(x0, y0, x1, y1);
  return new CanvasGradient({ kind: 'linear', x0, y0, x1, y1 });
}

export function createRadialGradient(
  x0: number,
  y0: number,
  r0: number,
  x1: number,
  y1: number,
  r1: number
): CanvasGradient {
  requireFinite(x0, y0, r0, x1, y1, r1);
  if (r0 < 0 || r1 < 0) {
    throw domError('IndexSizeError', 'The radius provided is negative.');
  }
  return new CanvasGradient({ kind: 'radial', x0, y0, r0, x1, y1, r1 });
}

export function createConicGradient(
  angle: number,
  x: number,
  y: number
): CanvasGradient {
  requireFinite(angle, x, y);
  return new CanvasGradient({ kind: 'conic', angle, x, y });
}

function requireFinite(...values: number[]): void {
  if (!values.every(Number.isFinite)) {
    throw new TypeError('The provided value is non-finite.');
  }
}

/** A valid style value, or null to ignore the assignment. */
export function acceptStyle(
  value: unknown
): string | CanvasGradient | CanvasPattern | null {
  if (value instanceof CanvasGradient || value instanceof CanvasPattern) {
    return value;
  }
  return typeof value === 'string' && tryParseColor(value) !== null
    ? value
    : null;
}

/**
 * The paint for `style` with the transform `ctm` and global alpha, appended to
 * `out`; image sources are interned with `intern`. Answers false for a paint
 * that draws nothing — a gradient with no stops, or one a canvas leaves
 * unpainted — so the caller can skip the op.
 */
export function writePaint(
  out: number[],
  style: string | CanvasGradient | CanvasPattern,
  ctm: Matrix,
  globalAlpha: number,
  intern: (value: string) => number
): boolean {
  if (typeof style === 'string') {
    const color = withAlpha(tryParseColor(style) ?? 0x000000ff, globalAlpha);
    out.push(Paint.Solid, 1, color);
    return true;
  }
  const m = [ctm.a, ctm.b, ctm.c, ctm.d, ctm.e, ctm.f];
  if (style instanceof CanvasPattern) {
    const total = multiply(ctm, style.matrix);
    out.push(
      Paint.Pattern,
      globalAlpha,
      intern(style.image.source),
      style.repetition,
      style.image.width,
      style.image.height,
      total.a,
      total.b,
      total.c,
      total.d,
      total.e,
      total.f
    );
    return true;
  }
  const { shape, stops } = style;
  if (stops.length === 0) return false;
  const stopValues = [stops.length, ...stops.flat()];
  switch (shape.kind) {
    case 'linear':
      if (shape.x0 === shape.x1 && shape.y0 === shape.y1) return false;
      out.push(
        Paint.Linear,
        globalAlpha,
        shape.x0,
        shape.y0,
        shape.x1,
        shape.y1,
        ...m,
        ...stopValues
      );
      return true;
    case 'radial':
      if (
        shape.x0 === shape.x1 &&
        shape.y0 === shape.y1 &&
        shape.r0 === shape.r1
      ) {
        return false;
      }
      out.push(
        Paint.Radial,
        globalAlpha,
        shape.x0,
        shape.y0,
        shape.r0,
        shape.x1,
        shape.y1,
        shape.r1,
        ...m,
        ...stopValues
      );
      return true;
    case 'conic':
      out.push(
        Paint.Conic,
        globalAlpha,
        shape.angle,
        shape.x,
        shape.y,
        ...m,
        ...stopValues
      );
      return true;
  }
}
