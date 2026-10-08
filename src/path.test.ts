import { describe, expect, it } from 'vitest';
import { Segment } from './format.ts';
import {
  eachSegment,
  Path2D,
  PathBuilder,
  pointInPath,
  pointInStroke,
} from './path.ts';

type Seg = { kind: string; points: number[] };
const SEGMENTS = Object.fromEntries(
  Object.entries(Segment).map(([k, v]) => [v, k])
);

function segments(data: readonly number[]): Seg[] {
  const out: Seg[] = [];
  eachSegment(data, (tag, points) =>
    out.push({ kind: SEGMENTS[tag]!, points })
  );
  return out;
}

const close = (actual: number[], expected: number[]) => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, 6));
};

/** The end point of the last segment. */
const end = (data: readonly number[]) => {
  const all = segments(data);
  const points = all[all.length - 1]!.points;
  return points.slice(-2);
};

describe('PathBuilder', () => {
  it('opens subpaths where a canvas would', () => {
    const path = new PathBuilder();
    path.lineTo(5, 5); // no current point: only a moveTo
    path.lineTo(10, 5);
    path.closePath();
    path.lineTo(10, 10); // after closePath: a new subpath at the old start
    expect(segments(path.data).map(s => s.kind)).toEqual([
      'Move',
      'Line',
      'Close',
      'Move',
      'Line',
    ]);
    close(segments(path.data)[3]!.points, [5, 5]);
  });

  it('maps each point by the transform in force when it is added', () => {
    let m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const path = new PathBuilder(() => m);
    path.moveTo(0, 0);
    m = { ...m, e: 50 };
    path.lineTo(0, 0);
    close(segments(path.data)[1]!.points, [50, 0]);
  });

  it('draws arcs as quarter-turn cubics through the right points', () => {
    const path = new PathBuilder();
    path.arc(50, 50, 10, 0, Math.PI * 2);
    const all = segments(path.data);
    expect(all.map(s => s.kind)).toEqual([
      'Move',
      'Cubic',
      'Cubic',
      'Cubic',
      'Cubic',
    ]);
    close(all[0]!.points, [60, 50]);
    // Clockwise on screen: a quarter turn from 0 lands at the bottom.
    close(all[1]!.points.slice(4), [50, 60]);
    close(all[4]!.points.slice(4), [60, 50]);
  });

  it('follows the spec for which way an arc goes and how far', () => {
    const quarters = (start: number, end: number, ccw: boolean) => {
      const path = new PathBuilder();
      path.arc(0, 0, 10, start, end, ccw);
      return segments(path.data).filter(s => s.kind === 'Cubic').length;
    };
    expect(quarters(0, Math.PI / 2, true)).toBe(3); // the long way round
    expect(quarters(0, -Math.PI / 2, false)).toBe(3);
    expect(quarters(0, 5 * Math.PI, false)).toBe(4); // capped at a full turn
    expect(quarters(0, -2 * Math.PI, false)).toBe(0); // the same angle: no arc
    expect(quarters(0, 0, false)).toBe(0);
  });

  it('throws on a negative radius, as a canvas does', () => {
    const path = new PathBuilder();
    expect(() => path.arc(0, 0, -1, 0, 1)).toThrow(/negative/);
    expect(() => path.ellipse(0, 0, 1, -1, 0, 0, 1)).toThrow(/negative/);
    expect(() => path.arcTo(0, 0, 1, 1, -1)).toThrow(/negative/);
  });

  it('joins an arc to the path before it with a line', () => {
    const path = new PathBuilder();
    path.moveTo(0, 0);
    path.arc(50, 50, 10, Math.PI, Math.PI * 1.5);
    const all = segments(path.data);
    expect(all[1]!.kind).toBe('Line');
    close(all[1]!.points, [40, 50]);
  });

  it('draws arcTo as a line to the first tangent point and an arc to the second', () => {
    const path = new PathBuilder();
    path.moveTo(0, 0);
    path.arcTo(100, 0, 100, 100, 20);
    const all = segments(path.data);
    expect(all[1]!.kind).toBe('Line');
    close(all[1]!.points, [80, 0]);
    close(end(path.data), [100, 20]);
  });

  it('draws arcTo as a line when the points are collinear or the radius is 0', () => {
    const path = new PathBuilder();
    path.moveTo(0, 0);
    path.arcTo(50, 0, 100, 0, 10);
    path.arcTo(60, 60, 70, 70, 0);
    expect(segments(path.data).map(s => s.kind)).toEqual([
      'Move',
      'Line',
      'Line',
    ]);
  });

  it('draws roundRect with the spec radii forms, scaling radii that would overlap', () => {
    const path = new PathBuilder();
    path.roundRect(0, 0, 100, 50, [10, 20]);
    const all = segments(path.data);
    close(all[0]!.points, [10, 0]); // upper-left radius 10
    close(all[1]!.points, [80, 0]); // upper-right radius 20
    expect(all.filter(s => s.kind === 'Close')).toHaveLength(1);
    // Ends with a moveTo back to the rectangle's origin.
    close(all[all.length - 1]!.points, [0, 0]);

    const squeezed = new PathBuilder();
    squeezed.roundRect(0, 0, 100, 40, 50); // 2 × 50 > 40: scaled to 20
    close(segments(squeezed.data)[0]!.points, [20, 0]);
  });

  it('flips roundRect for a negative size and validates its radii', () => {
    const path = new PathBuilder();
    path.roundRect(100, 0, -100, 50, [10, 0, 0, 0]);
    // The 10 radius belonged to the upper-left as written, which after the
    // flip is the upper-right.
    close(segments(path.data)[0]!.points, [0, 0]);
    expect(() => path.roundRect(0, 0, 1, 1, [1, 2, 3, 4, 5])).toThrow(
      RangeError
    );
    expect(() => path.roundRect(0, 0, 1, 1, -1)).toThrow(RangeError);
  });
});

describe('Path2D', () => {
  it('copies another path and adds one under a transform', () => {
    const a = new Path2D();
    a.rect(0, 0, 10, 10);
    const b = new Path2D(a);
    b.addPath(a, { e: 100 });
    const all = segments(b.builder.data);
    expect(all.filter(s => s.kind === 'Move')).toHaveLength(2);
    close(all[5]!.points, [100, 0]);
  });

  it('reads SVG path data, relative and absolute', () => {
    const path = new Path2D('M10 10 h20 v20 H10 Z m5 5 l10 0');
    expect(segments(path.builder.data).map(s => s.kind)).toEqual([
      'Move',
      'Line',
      'Line',
      'Line',
      'Close',
      'Move',
      'Line',
    ]);
    close(segments(path.builder.data)[2]!.points, [30, 30]);
    close(segments(path.builder.data)[5]!.points, [15, 15]);
  });

  it('reads smooth curves and arcs', () => {
    const curves = new Path2D(
      'M0 0 C10 0 20 10 20 20 S30 40 40 40 Q50 40 50 50 T60 60'
    );
    expect(segments(curves.builder.data).map(s => s.kind)).toEqual([
      'Move',
      'Cubic',
      'Cubic',
      'Quad',
      'Quad',
    ]);
    // S reflects the previous second control point (20,10) about (20,20).
    close(segments(curves.builder.data)[2]!.points.slice(0, 2), [20, 30]);

    const arc = new Path2D('M0 0 A10 10 0 0 1 20 0');
    close(end(arc.builder.data), [20, 0]);
    // Flags written together with what follows.
    const packed = new Path2D('M0 0a10 10 0 0120 0');
    close(end(packed.builder.data), [20, 0]);
  });

  it('keeps what parsed before an error, as a browser does', () => {
    const path = new Path2D('M0 0 L10 10 L oops 20 20');
    expect(segments(path.builder.data).map(s => s.kind)).toEqual([
      'Move',
      'Line',
    ]);
  });
});

describe('hit testing', () => {
  const square = new PathBuilder();
  square.rect(0, 0, 10, 10);
  square.rect(2, 2, 6, 6);

  it('tests a point against the fill rule', () => {
    expect(pointInPath(square.data, 5, 5, false)).toBe(true); // nonzero: same winding
    expect(pointInPath(square.data, 5, 5, true)).toBe(false); // evenodd: a hole
    expect(pointInPath(square.data, 1, 1, true)).toBe(true);
    expect(pointInPath(square.data, 20, 5, false)).toBe(false);
  });

  it('tests a point against the stroke width', () => {
    expect(pointInStroke(square.data, 10.4, 5, 1)).toBe(true);
    expect(pointInStroke(square.data, 11, 5, 1)).toBe(false);
    expect(pointInStroke(square.data, 11, 5, 3)).toBe(true);
  });
});
