/**
 * A picture read back into structured ops — what the native replay reads, op
 * for op, written out in TypeScript. For debugging a picture and for tests;
 * nothing on the drawing path uses it.
 */
import { FORMAT_VERSION, Op, Paint, Segment } from './format.ts';
import type { Picture } from './format.ts';

export type DecodedSegment = { kind: keyof typeof Segment; points: number[] };

export type DecodedPaint =
  | { kind: 'Solid'; alpha: number; color: number }
  | {
      kind: 'Linear' | 'Radial' | 'Conic';
      alpha: number;
      geometry: number[];
      matrix: number[];
      stops: [number, number][];
    }
  | {
      kind: 'Pattern';
      alpha: number;
      image: string;
      repetition: number;
      imageWidth: number;
      imageHeight: number;
      matrix: number[];
    };

export type DecodedStroke = {
  width: number;
  cap: number;
  join: number;
  miterLimit: number;
  dashes: number[];
  dashOffset: number;
};

export type DecodedOp =
  | { op: 'Fill'; rule: number; paint: DecodedPaint; path: DecodedSegment[] }
  | {
      op: 'Stroke';
      paint: DecodedPaint;
      stroke: DecodedStroke;
      matrix: number[];
      path: DecodedSegment[];
    }
  | {
      op: 'Text';
      mode: number;
      paint: DecodedPaint;
      stroke: DecodedStroke | null;
      text: string;
      family: string;
      size: number;
      weight: number;
      style: number;
      stretch: number;
      rtl: boolean;
      letterSpacing: number;
      wordSpacing: number;
      kerning: number;
      variantCaps: number;
      rendering: number;
      matrix: number[];
      x: number;
      y: number;
    }
  | { op: 'Clear'; path: DecodedSegment[] }
  | { op: 'Clip'; rule: number; path: DecodedSegment[] }
  | { op: 'PopClip'; count: number }
  | {
      op: 'Image';
      image: string;
      alpha: number;
      imageWidth: number;
      imageHeight: number;
      source: number[];
      destination: number[];
      matrix: number[];
    }
  | { op: 'PutImage'; image: string; dx: number; dy: number; dirty: number[] }
  | { op: 'SetComposite'; composite: number }
  | {
      op: 'SetShadow';
      color: number;
      blur: number;
      offsetX: number;
      offsetY: number;
    }
  | { op: 'SetFilter'; primitives: number[][] }
  | { op: 'SetSmoothing'; enabled: boolean; quality: number };

const SEGMENT_NAMES = Object.fromEntries(
  Object.entries(Segment).map(([name, value]) => [value, name])
) as Record<number, keyof typeof Segment>;
const ARITY: Record<keyof typeof Segment, number> = {
  Move: 2,
  Line: 2,
  Quad: 4,
  Cubic: 6,
  Close: 0,
};
const PAINT_NAMES = Object.fromEntries(
  Object.entries(Paint).map(([name, value]) => [value, name])
) as Record<number, keyof typeof Paint>;

/** Throws on a malformed picture: a decoder that guessed would hide the bug. */
export function decodePicture(picture: Picture): DecodedOp[] {
  const { ops, strings } = picture;
  let at = 0;
  const next = (): number => {
    if (at >= ops.length) throw new Error(`picture ends inside an op at ${at}`);
    return ops[at++]!;
  };
  const take = (count: number) => Array.from({ length: count }, next);
  const string = () => {
    const index = next();
    const value = strings[index];
    if (value === undefined) throw new Error(`no string ${index}`);
    return value;
  };
  const path = (): DecodedSegment[] =>
    Array.from({ length: next() }, () => {
      const tag = next();
      const kind = SEGMENT_NAMES[tag];
      if (!kind) throw new Error(`unknown segment ${tag}`);
      return { kind, points: take(ARITY[kind]) };
    });
  const stops = () =>
    Array.from({ length: next() }, () => [next(), next()] as [number, number]);
  const paint = (): DecodedPaint => {
    const tag = next();
    const kind = PAINT_NAMES[tag];
    const alpha = next();
    switch (kind) {
      case 'Solid':
        return { kind, alpha, color: next() };
      case 'Linear':
        return {
          kind,
          alpha,
          geometry: take(4),
          matrix: take(6),
          stops: stops(),
        };
      case 'Radial':
        return {
          kind,
          alpha,
          geometry: take(6),
          matrix: take(6),
          stops: stops(),
        };
      case 'Conic':
        return {
          kind,
          alpha,
          geometry: take(3),
          matrix: take(6),
          stops: stops(),
        };
      case 'Pattern':
        return {
          kind,
          alpha,
          image: string(),
          repetition: next(),
          imageWidth: next(),
          imageHeight: next(),
          matrix: take(6),
        };
      default:
        throw new Error(`unknown paint ${tag}`);
    }
  };
  const stroke = (): DecodedStroke => {
    const width = next();
    const cap = next();
    const join = next();
    const miterLimit = next();
    const dashes = take(next());
    return { width, cap, join, miterLimit, dashes, dashOffset: next() };
  };

  const version = next();
  if (version !== FORMAT_VERSION) {
    throw new Error(`format ${version}, expected ${FORMAT_VERSION}`);
  }
  const out: DecodedOp[] = [];
  while (at < ops.length) {
    const op = next();
    switch (op) {
      case Op.Fill: {
        const rule = next();
        out.push({ op: 'Fill', rule, paint: paint(), path: path() });
        break;
      }
      case Op.Stroke: {
        const p = paint();
        const s = stroke();
        out.push({
          op: 'Stroke',
          paint: p,
          stroke: s,
          matrix: take(6),
          path: path(),
        });
        break;
      }
      case Op.Text: {
        const mode = next();
        const p = paint();
        const s = mode === 1 ? stroke() : null;
        out.push({
          op: 'Text',
          mode,
          paint: p,
          stroke: s,
          text: string(),
          family: string(),
          size: next(),
          weight: next(),
          style: next(),
          stretch: next(),
          rtl: next() === 1,
          letterSpacing: next(),
          wordSpacing: next(),
          kerning: next(),
          variantCaps: next(),
          rendering: next(),
          matrix: take(6),
          x: next(),
          y: next(),
        });
        break;
      }
      case Op.Clear:
        out.push({ op: 'Clear', path: path() });
        break;
      case Op.Clip: {
        const rule = next();
        out.push({ op: 'Clip', rule, path: path() });
        break;
      }
      case Op.PopClip:
        out.push({ op: 'PopClip', count: next() });
        break;
      case Op.Image:
        out.push({
          op: 'Image',
          image: string(),
          alpha: next(),
          imageWidth: next(),
          imageHeight: next(),
          source: take(4),
          destination: take(4),
          matrix: take(6),
        });
        break;
      case Op.PutImage:
        out.push({
          op: 'PutImage',
          image: string(),
          dx: next(),
          dy: next(),
          dirty: take(4),
        });
        break;
      case Op.SetComposite:
        out.push({ op: 'SetComposite', composite: next() });
        break;
      case Op.SetShadow:
        out.push({
          op: 'SetShadow',
          color: next(),
          blur: next(),
          offsetX: next(),
          offsetY: next(),
        });
        break;
      case Op.SetFilter: {
        const count = next();
        const primitives: number[][] = [];
        for (let i = 0; i < count; i += 1) {
          const kind = next();
          primitives.push([kind, ...take(kind === 10 ? 4 : 1)]);
        }
        out.push({ op: 'SetFilter', primitives });
        break;
      }
      case Op.SetSmoothing:
        out.push({
          op: 'SetSmoothing',
          enabled: next() === 1,
          quality: next(),
        });
        break;
      default:
        throw new Error(`unknown op ${op} at ${at - 1}`);
    }
  }
  return out;
}
