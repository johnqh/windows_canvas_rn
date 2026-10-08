import { describe, expect, it } from 'vitest';
import { parseColor } from './color.ts';
import { FORMAT_VERSION, Op, Segment } from './format.ts';
import type { Picture } from './format.ts';
import { PictureRecorder } from './recorder.ts';

/** A test-side reading of the format — what windows/WindowsCanvas.cpp does. */
type Seg = { kind: keyof typeof Segment; points: number[] };
type Decoded =
  | { op: 'Fill'; color: number; rule: number; path: Seg[] }
  | {
      op: 'Stroke';
      color: number;
      width: number;
      cap: number;
      join: number;
      miter: number;
      dashes: number[];
      dashOffset: number;
      path: Seg[];
    }
  | {
      op: 'Text';
      color: number;
      text: string;
      family: string;
      size: number;
      weight: number;
      italic: boolean;
      align: number;
      baseline: number;
      matrix: number[];
      x: number;
      y: number;
    }
  | { op: 'ClearRect'; rect: number[] }
  | { op: 'Clip'; rule: number; path: Seg[] }
  | { op: 'PopClip'; count: number };

const SEGMENT_NAMES = Object.fromEntries(
  Object.entries(Segment).map(([name, value]) => [value, name])
) as Record<number, keyof typeof Segment>;
const ARITY = { Move: 2, Line: 2, Quad: 4, Cubic: 6, Close: 0 };

function decode(picture: Picture): Decoded[] {
  const ops = picture.ops;
  let at = 0;
  const next = () => {
    if (at >= ops.length) throw new Error('read past the end');
    return ops[at++]!;
  };
  const take = (count: number) => Array.from({ length: count }, next);
  const path = (): Seg[] =>
    Array.from({ length: next() }, () => {
      const kind = SEGMENT_NAMES[next()]!;
      return { kind, points: take(ARITY[kind]) };
    });
  expect(next()).toBe(FORMAT_VERSION);
  const out: Decoded[] = [];
  while (at < ops.length) {
    const op = next();
    switch (op) {
      case Op.Fill:
        out.push({ op: 'Fill', color: next(), rule: next(), path: path() });
        break;
      case Op.Stroke: {
        const color = next();
        const width = next();
        const cap = next();
        const join = next();
        const miter = next();
        const dashes = take(next());
        const dashOffset = next();
        out.push({
          op: 'Stroke',
          color,
          width,
          cap,
          join,
          miter,
          dashes,
          dashOffset,
          path: path(),
        });
        break;
      }
      case Op.Text:
        out.push({
          op: 'Text',
          color: next(),
          text: picture.strings[next()]!,
          family: picture.strings[next()]!,
          size: next(),
          weight: next(),
          italic: next() === 1,
          align: next(),
          baseline: next(),
          matrix: take(6),
          x: next(),
          y: next(),
        });
        break;
      case Op.ClearRect:
        out.push({ op: 'ClearRect', rect: take(4) });
        break;
      case Op.Clip:
        out.push({ op: 'Clip', rule: next(), path: path() });
        break;
      case Op.PopClip:
        out.push({ op: 'PopClip', count: next() });
        break;
      default:
        throw new Error(`unknown op ${op}`);
    }
  }
  return out;
}

const close = (actual: number[], expected: number[]) => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, 6));
};

describe('PictureRecorder', () => {
  it('starts every picture with the format version and reports its size', () => {
    const picture = new PictureRecorder(300, 200).finish();
    expect(picture).toEqual({
      width: 300,
      height: 200,
      ops: [FORMAT_VERSION],
      strings: [],
    });
  });

  it('records points already transformed', () => {
    const ctx = new PictureRecorder(100, 100);
    ctx.translate(10, 20);
    ctx.scale(2, 2);
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(1, 1, 5, 5);
    const [fill] = decode(ctx.finish());
    expect(fill).toMatchObject({ op: 'Fill', color: parseColor('#ff0000') });
    const path = (fill as { path: Seg[] }).path;
    expect(path.map(s => s.kind)).toEqual([
      'Move',
      'Line',
      'Line',
      'Line',
      'Close',
    ]);
    close(path[0]!.points, [12, 22]);
    close(path[2]!.points, [22, 32]);
  });

  it('uses the transform in force when each point was added, as a canvas does', () => {
    const ctx = new PictureRecorder(100, 100);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.translate(50, 0);
    ctx.lineTo(0, 0);
    ctx.stroke();
    const [stroke] = decode(ctx.finish());
    const path = (stroke as { path: Seg[] }).path;
    close(path[1]!.points, [50, 0]);
  });

  it('opens subpaths where a canvas would', () => {
    const ctx = new PictureRecorder(100, 100);
    ctx.beginPath();
    ctx.lineTo(5, 5); // no current point: only a moveTo
    ctx.lineTo(10, 5);
    ctx.closePath();
    ctx.lineTo(10, 10); // after closePath: a new subpath at the old start
    ctx.fill();
    const [fill] = decode(ctx.finish());
    const path = (fill as { path: Seg[] }).path;
    expect(path.map(s => s.kind)).toEqual([
      'Move',
      'Line',
      'Close',
      'Move',
      'Line',
    ]);
    close(path[3]!.points, [5, 5]);
  });

  it('draws arcs as quarter-turn cubics through the right points', () => {
    const ctx = new PictureRecorder(100, 100);
    ctx.beginPath();
    ctx.arc(50, 50, 10, 0, Math.PI * 2);
    ctx.fill();
    const path = (decode(ctx.finish())[0] as { path: Seg[] }).path;
    expect(path.map(s => s.kind)).toEqual([
      'Move',
      'Cubic',
      'Cubic',
      'Cubic',
      'Cubic',
    ]);
    close(path[0]!.points, [60, 50]);
    // Clockwise on screen: a quarter turn from 0 lands at the bottom.
    close(path[1]!.points.slice(4), [50, 60]);
    close(path[4]!.points.slice(4), [60, 50]);
  });

  it('turns an arc the short way back when told to go counterclockwise', () => {
    const ctx = new PictureRecorder(100, 100);
    ctx.beginPath();
    ctx.arc(0, 0, 10, 0, Math.PI / 2, true);
    ctx.stroke();
    const path = (decode(ctx.finish())[0] as { path: Seg[] }).path;
    // 0 → π/2 counterclockwise is three quarters of a turn.
    expect(path.filter(s => s.kind === 'Cubic')).toHaveLength(3);
    close(path.at(-1)!.points.slice(4), [0, 10]);
  });

  it('joins an arc to the path before it with a line', () => {
    const ctx = new PictureRecorder(100, 100);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(50, 50, 10, Math.PI, Math.PI * 1.5);
    ctx.stroke();
    const path = (decode(ctx.finish())[0] as { path: Seg[] }).path;
    expect(path[1]!.kind).toBe('Line');
    close(path[1]!.points, [40, 50]);
  });

  it('scales stroke widths and dashes by the transform, and repeats an odd dash list', () => {
    const ctx = new PictureRecorder(100, 100);
    ctx.scale(2, 2);
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'bevel';
    ctx.setLineDash([1, 2, 3]);
    ctx.lineDashOffset = 1;
    ctx.strokeRect(0, 0, 10, 10);
    const [stroke] = decode(ctx.finish());
    expect(stroke).toMatchObject({
      op: 'Stroke',
      width: 3,
      cap: 1,
      join: 2,
      miter: 10,
      dashes: [2, 4, 6, 2, 4, 6],
      dashOffset: 2,
    });
  });

  it('folds global alpha into the colour', () => {
    const ctx = new PictureRecorder(100, 100);
    ctx.fillStyle = 'rgba(255, 0, 0, 0.5)';
    ctx.globalAlpha = 0.5;
    ctx.fillRect(0, 0, 1, 1);
    const [fill] = decode(ctx.finish());
    expect((fill as { color: number }).color % 0x100).toBe(64);
  });

  it('restores state on restore, and pops the clips pushed since the save', () => {
    const ctx = new PictureRecorder(100, 100);
    ctx.fillStyle = 'red';
    ctx.save();
    ctx.fillStyle = 'blue';
    ctx.translate(10, 10);
    ctx.beginPath();
    ctx.rect(0, 0, 5, 5);
    ctx.clip();
    ctx.clip('evenodd');
    ctx.restore();
    expect(ctx.fillStyle).toBe('red');
    expect(ctx.getTransform()).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    ctx.restore(); // unbalanced: ignored
    const ops = decode(ctx.finish());
    expect(ops.map(op => op.op)).toEqual(['Clip', 'Clip', 'PopClip']);
    expect(ops[1]).toMatchObject({ rule: 1 });
    expect(ops[2]).toEqual({ op: 'PopClip', count: 2 });
  });

  it('records text with its transform, font and anchor, and shares strings', () => {
    const ctx = new PictureRecorder(100, 100);
    ctx.translate(5, 6);
    ctx.font = 'bold 17px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#123456';
    ctx.fillText('Piano', 10, 20);
    ctx.fillText('Piano', 30, 20);
    const picture = ctx.finish();
    const [text] = decode(picture);
    expect(text).toEqual({
      op: 'Text',
      color: parseColor('#123456'),
      text: 'Piano',
      family: 'Segoe UI',
      size: 17,
      weight: 700,
      italic: false,
      align: 1,
      baseline: 2,
      matrix: [1, 0, 0, 1, 5, 6],
      x: 10,
      y: 20,
    });
    expect(picture.strings).toEqual(['Piano', 'Segoe UI']);
  });

  it('squeezes text wider than maxWidth about its anchor', () => {
    const ctx = new PictureRecorder(100, 100, {
      measureText: () => ({ width: 100, ascent: 8, descent: 2 }),
    });
    ctx.fillText('wide', 10, 0, 50);
    const [text] = decode(ctx.finish());
    // x' = 0.5·x + 5: the anchor at x = 10 stays at 10.
    expect((text as { matrix: number[] }).matrix).toEqual([0.5, 0, 0, 1, 5, 0]);
  });

  it('answers measureText with the measurer it was given', () => {
    const seen: string[] = [];
    const ctx = new PictureRecorder(100, 100, {
      measureText: (font, text) => {
        seen.push(`${font.family}/${font.size}/${text}`);
        return { width: 42, ascent: 9, descent: 3 };
      },
    });
    ctx.font = '12px serif';
    expect(ctx.measureText('abc')).toMatchObject({
      width: 42,
      actualBoundingBoxAscent: 9,
      actualBoundingBoxDescent: 3,
    });
    expect(seen).toEqual(['Times New Roman/12/abc']);
  });

  it('clears the device-space bounds of a transformed rectangle', () => {
    const ctx = new PictureRecorder(100, 100);
    ctx.translate(50, 50);
    ctx.rotate(Math.PI / 2);
    ctx.clearRect(0, 0, 10, 20);
    const [clear] = decode(ctx.finish());
    close((clear as { rect: number[] }).rect, [30, 50, 20, 10]);
  });

  it('ignores what a canvas ignores rather than recording garbage', () => {
    const ctx = new PictureRecorder(100, 100);
    ctx.lineWidth = -1;
    ctx.lineWidth = Number.NaN;
    ctx.globalAlpha = 2;
    ctx.setLineDash([1, -1]);
    ctx.lineCap = 'nonsense';
    expect(ctx.lineWidth).toBe(1);
    expect(ctx.globalAlpha).toBe(1);
    expect(ctx.getLineDash()).toEqual([]);
    expect(ctx.lineCap).toBe('butt');
    ctx.beginPath();
    ctx.moveTo(Number.NaN, 0);
    ctx.fill(); // empty path: nothing
    ctx.fillRect(0, 0, 0, 10); // empty rect: nothing
    ctx.fillText('', 0, 0);
    expect(decode(ctx.finish())).toEqual([]);
  });
});
