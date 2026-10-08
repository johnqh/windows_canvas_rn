/**
 * Paths: the context's current path and `Path2D`, built by one class.
 *
 * Segments are stored as the format writes them (`Segment` tags followed by
 * coordinates), so a path goes into an op by copying. The context's builder
 * maps each point through the transform in force when it is added, as a canvas
 * does; a `Path2D` stores its own coordinates and is transformed when it is
 * used. Arcs, ellipses and rounded corners are cubic curves of at most a
 * quarter turn each — under a hundredth of a pixel off at any radius drawn on
 * a screen, and exact under any affine transform.
 *
 * The algorithms are the canvas spec's: `arcTo`'s tangent arc, `roundRect`'s
 * radius normalisation and scaling, `ellipse`'s sweep, and the subpath rules
 * that decide when a segment starts a new subpath.
 */
import { Segment } from './format.ts';
import type { Matrix, MatrixInit } from './matrix.ts';
import {
  applyMatrix,
  IDENTITY,
  invertMatrix,
  matrixFromInit,
} from './matrix.ts';

export type Point = { x: number; y: number };

/** A DOMException-like error, as a canvas throws them. */
export function domError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

const finite = (...values: number[]) => values.every(Number.isFinite);

const ARITY: Record<number, number> = {
  [Segment.Move]: 2,
  [Segment.Line]: 2,
  [Segment.Quad]: 4,
  [Segment.Cubic]: 6,
  [Segment.Close]: 0,
};

export class PathBuilder {
  data: number[] = [];
  segments = 0;
  /** In output space. */
  current: Point | null = null;
  private subpathStart: Point | null = null;
  /** The last subpath was closed: the next segment opens one at its start. */
  private closed = false;

  constructor(private readonly matrix: () => Matrix = () => IDENTITY) {}

  clear(): void {
    this.data = [];
    this.segments = 0;
    this.current = null;
    this.subpathStart = null;
    this.closed = false;
  }

  private map(x: number, y: number): Point {
    return applyMatrix(this.matrix(), x, y);
  }

  /** The current point in input space, or null when the transform is singular. */
  private currentInput(): Point | null {
    if (!this.current) return null;
    const inverse = invertMatrix(this.matrix());
    return inverse
      ? applyMatrix(inverse, this.current.x, this.current.y)
      : null;
  }

  moveTo(x: number, y: number): void {
    if (!finite(x, y)) return;
    this.moveToOutput(this.map(x, y));
  }

  private moveToOutput(point: Point): void {
    this.data.push(Segment.Move, point.x, point.y);
    this.segments += 1;
    this.current = point;
    this.subpathStart = point;
    this.closed = false;
  }

  /**
   * Opens a subpath where the canvas would before a segment that needs one: at
   * `(x, y)` when there is no current point, at the closed subpath's start
   * after `closePath`. Answers whether the caller's segment is still to be
   * added — a `lineTo` with no current point is only a `moveTo`.
   */
  private ensureSubpath(x: number, y: number): boolean {
    if (!this.current) {
      this.moveTo(x, y);
      return false;
    }
    if (this.closed) this.moveToOutput(this.current);
    return true;
  }

  lineTo(x: number, y: number): void {
    if (!finite(x, y)) return;
    if (!this.ensureSubpath(x, y)) return;
    const point = this.map(x, y);
    this.data.push(Segment.Line, point.x, point.y);
    this.segments += 1;
    this.current = point;
  }

  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    if (!finite(cpx, cpy, x, y)) return;
    this.ensureSubpath(cpx, cpy);
    const c = this.map(cpx, cpy);
    const p = this.map(x, y);
    this.data.push(Segment.Quad, c.x, c.y, p.x, p.y);
    this.segments += 1;
    this.current = p;
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
    const c1 = this.map(cp1x, cp1y);
    const c2 = this.map(cp2x, cp2y);
    const p = this.map(x, y);
    this.data.push(Segment.Cubic, c1.x, c1.y, c2.x, c2.y, p.x, p.y);
    this.segments += 1;
    this.current = p;
  }

  closePath(): void {
    if (!this.current || this.closed) return;
    this.data.push(Segment.Close);
    this.segments += 1;
    this.current = this.subpathStart;
    this.closed = true;
  }

  rect(x: number, y: number, w: number, h: number): void {
    if (!finite(x, y, w, h)) return;
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
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
    if (radiusX < 0 || radiusY < 0) {
      throw domError('IndexSizeError', 'The radius provided is negative.');
    }
    const full = Math.PI * 2;
    // The spec's sweep: a full turn when asked for one or more, otherwise the
    // way round the stated direction goes, never more than a turn.
    let sweep = endAngle - startAngle;
    if (!counterclockwise && sweep >= full) sweep = full;
    else if (counterclockwise && -sweep >= full) sweep = -full;
    else if (!counterclockwise) sweep = ((sweep % full) + full) % full;
    else sweep = -(((-sweep % full) + full) % full);

    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const at = (angle: number): Point => {
      const px = radiusX * Math.cos(angle);
      const py = radiusY * Math.sin(angle);
      return { x: x + px * cos - py * sin, y: y + px * sin + py * cos };
    };
    const tangent = (angle: number): Point => {
      const px = -radiusX * Math.sin(angle);
      const py = radiusY * Math.cos(angle);
      return { x: px * cos - py * sin, y: px * sin + py * cos };
    };

    // Joined to whatever came before, as a canvas does.
    const start = at(startAngle);
    if (this.current) this.lineTo(start.x, start.y);
    else this.moveTo(start.x, start.y);
    if (sweep === 0) return;

    const pieces = Math.max(
      1,
      Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9)
    );
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

  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void {
    if (!finite(x1, y1, x2, y2, radius)) return;
    if (radius < 0) {
      throw domError('IndexSizeError', 'The radius provided is negative.');
    }
    if (!this.ensureSubpath(x1, y1)) return;
    const p0 = this.currentInput();
    if (!p0) return;
    const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
    const p1 = { x: x1, y: y1 };
    const p2 = { x: x2, y: y2 };
    const v1 = { x: p0.x - x1, y: p0.y - y1 };
    const v2 = { x: x2 - x1, y: y2 - y1 };
    const cross = v1.x * v2.y - v1.y * v2.x;
    if (same(p0, p1) || same(p1, p2) || radius === 0 || cross === 0) {
      this.lineTo(x1, y1);
      return;
    }
    const l1 = Math.hypot(v1.x, v1.y);
    const l2 = Math.hypot(v2.x, v2.y);
    const u1 = { x: v1.x / l1, y: v1.y / l1 };
    const u2 = { x: v2.x / l2, y: v2.y / l2 };
    const angle = Math.acos(
      Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y))
    );
    const tangentDistance = radius / Math.tan(angle / 2);
    const t1 = {
      x: x1 + u1.x * tangentDistance,
      y: y1 + u1.y * tangentDistance,
    };
    const t2 = {
      x: x1 + u2.x * tangentDistance,
      y: y1 + u2.y * tangentDistance,
    };
    const bisector = { x: u1.x + u2.x, y: u1.y + u2.y };
    const bl = Math.hypot(bisector.x, bisector.y);
    const centreDistance = radius / Math.sin(angle / 2);
    const centre = {
      x: x1 + (bisector.x / bl) * centreDistance,
      y: y1 + (bisector.y / bl) * centreDistance,
    };
    const a1 = Math.atan2(t1.y - centre.y, t1.x - centre.x);
    const a2 = Math.atan2(t2.y - centre.y, t2.x - centre.x);
    // The short way round, from the first tangent point to the second.
    const counterclockwise =
      (((a2 - a1) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) > Math.PI;
    this.ellipse(
      centre.x,
      centre.y,
      radius,
      radius,
      0,
      a1,
      a2,
      counterclockwise
    );
  }

  roundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    radii: RoundRectRadii = 0
  ): void {
    if (!finite(x, y, w, h)) return;
    let [ul, ur, lr, ll] = cornerRadii(radii);
    if (w < 0) {
      x += w;
      w = -w;
      [ul, ur] = [ur, ul];
      [ll, lr] = [lr, ll];
    }
    if (h < 0) {
      y += h;
      h = -h;
      [ul, ll] = [ll, ul];
      [ur, lr] = [lr, ur];
    }
    // Radii that would overlap are scaled down together.
    const ratios = [
      w / (ul.x + ur.x),
      h / (ur.y + lr.y),
      w / (lr.x + ll.x),
      h / (ul.y + ll.y),
    ].filter(ratio => Number.isFinite(ratio));
    const scale = Math.min(1, ...ratios);
    const s = (c: Point) => ({ x: c.x * scale, y: c.y * scale });
    [ul, ur, lr, ll] = [s(ul), s(ur), s(lr), s(ll)];

    const half = Math.PI / 2;
    this.moveTo(x + ul.x, y);
    this.lineTo(x + w - ur.x, y);
    if (ur.x > 0 && ur.y > 0)
      this.ellipse(x + w - ur.x, y + ur.y, ur.x, ur.y, 0, -half, 0);
    this.lineTo(x + w, y + h - lr.y);
    if (lr.x > 0 && lr.y > 0)
      this.ellipse(x + w - lr.x, y + h - lr.y, lr.x, lr.y, 0, 0, half);
    this.lineTo(x + ll.x, y + h);
    if (ll.x > 0 && ll.y > 0)
      this.ellipse(x + ll.x, y + h - ll.y, ll.x, ll.y, 0, half, Math.PI);
    this.lineTo(x, y + ul.y);
    if (ul.x > 0 && ul.y > 0)
      this.ellipse(x + ul.x, y + ul.y, ul.x, ul.y, 0, Math.PI, 3 * half);
    this.closePath();
    this.moveTo(x, y);
  }

  /** Appends `path`, mapped by `transform` and then by this builder's transform. */
  addPathData(data: readonly number[], transform: Matrix): void {
    const m = this.matrix();
    eachSegment(data, (tag, points) => {
      const mapped: number[] = [];
      for (let i = 0; i < points.length; i += 2) {
        const inner = applyMatrix(transform, points[i]!, points[i + 1]!);
        const outer = applyMatrix(m, inner.x, inner.y);
        mapped.push(outer.x, outer.y);
      }
      if (tag === Segment.Close) {
        this.closePath();
        return;
      }
      if (tag === Segment.Move) {
        this.moveToOutput({ x: mapped[0]!, y: mapped[1]! });
        return;
      }
      if (!this.current) {
        this.moveToOutput({ x: mapped[0]!, y: mapped[1]! });
      } else if (this.closed) {
        this.moveToOutput(this.current);
      }
      this.data.push(tag, ...mapped);
      this.segments += 1;
      this.current = {
        x: mapped[mapped.length - 2]!,
        y: mapped[mapped.length - 1]!,
      };
    });
  }
}

export type RoundRectRadius = number | { x?: number; y?: number };
export type RoundRectRadii = RoundRectRadius | readonly RoundRectRadius[];

/** The spec's normalisation: upper-left, upper-right, lower-right, lower-left. */
function cornerRadii(radii: RoundRectRadii): [Point, Point, Point, Point] {
  const list = Array.isArray(radii) ? radii : [radii as RoundRectRadius];
  if (list.length < 1 || list.length > 4) {
    throw new RangeError(`${list.length} radii provided; expected 1 to 4.`);
  }
  const points = list.map(radius => {
    const point =
      typeof radius === 'number'
        ? { x: radius, y: radius }
        : { x: radius.x ?? 0, y: radius.y ?? 0 };
    if (!finite(point.x, point.y)) return { x: 0, y: 0 };
    if (point.x < 0 || point.y < 0) {
      throw new RangeError('A radius provided is negative.');
    }
    return point;
  });
  const [a, b = a!, c = a!, d] = points as [Point, Point?, Point?, Point?];
  switch (points.length) {
    case 1:
      return [a, a, a, a];
    case 2:
      return [a, b, a, b];
    case 3:
      return [a, b, c, b];
    default:
      return [a, b, c, d!];
  }
}

/** Calls `visit` for every segment of `data`. */
export function eachSegment(
  data: readonly number[],
  visit: (tag: number, points: number[]) => void
): void {
  let i = 0;
  while (i < data.length) {
    const tag = data[i]!;
    const arity = ARITY[tag] ?? 0;
    visit(tag, data.slice(i + 1, i + 1 + arity) as number[]);
    i += 1 + arity;
  }
}

/** The path's points mapped by `m`, segment structure unchanged. */
export function transformPath(data: readonly number[], m: Matrix): number[] {
  const out: number[] = [];
  eachSegment(data, (tag, points) => {
    out.push(tag);
    for (let i = 0; i < points.length; i += 2) {
      const p = applyMatrix(m, points[i]!, points[i + 1]!);
      out.push(p.x, p.y);
    }
  });
  return out;
}

export function countSegments(data: readonly number[]): number {
  let count = 0;
  eachSegment(data, () => {
    count += 1;
  });
  return count;
}

/** Subpaths as polylines, curves flattened finely enough for hit-testing. */
export function flatten(
  data: readonly number[]
): { points: Point[]; closed: boolean }[] {
  const subpaths: { points: Point[]; closed: boolean }[] = [];
  let current: { points: Point[]; closed: boolean } | null = null;
  let last: Point = { x: 0, y: 0 };
  const STEPS = 16;
  eachSegment(data, (tag, p) => {
    if (tag === Segment.Move) {
      current = { points: [{ x: p[0]!, y: p[1]! }], closed: false };
      subpaths.push(current);
      last = { x: p[0]!, y: p[1]! };
      return;
    }
    if (!current) return;
    const path = current as { points: Point[]; closed: boolean };
    if (tag === Segment.Close) {
      path.closed = true;
      last = path.points[0]!;
      return;
    }
    if (tag === Segment.Line) {
      last = { x: p[0]!, y: p[1]! };
      path.points.push(last);
      return;
    }
    const from = last;
    for (let s = 1; s <= STEPS; s += 1) {
      const t = s / STEPS;
      const u = 1 - t;
      if (tag === Segment.Quad) {
        path.points.push({
          x: u * u * from.x + 2 * u * t * p[0]! + t * t * p[2]!,
          y: u * u * from.y + 2 * u * t * p[1]! + t * t * p[3]!,
        });
      } else {
        path.points.push({
          x:
            u * u * u * from.x +
            3 * u * u * t * p[0]! +
            3 * u * t * t * p[2]! +
            t * t * t * p[4]!,
          y:
            u * u * u * from.y +
            3 * u * u * t * p[1]! +
            3 * u * t * t * p[3]! +
            t * t * t * p[5]!,
        });
      }
    }
    last = path.points[path.points.length - 1]!;
  });
  return subpaths;
}

/** The spec's `isPointInPath`: every subpath implicitly closed. */
export function pointInPath(
  data: readonly number[],
  x: number,
  y: number,
  evenOdd: boolean
): boolean {
  let winding = 0;
  let crossings = 0;
  for (const { points } of flatten(data)) {
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i]!;
      const b = points[(i + 1) % points.length]!;
      if (a.y <= y !== b.y <= y) {
        const at = a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
        if (x < at) {
          crossings += 1;
          winding += b.y > a.y ? 1 : -1;
        }
      }
    }
  }
  return evenOdd ? crossings % 2 === 1 : winding !== 0;
}

/**
 * The spec's `isPointInStroke`, within `width / 2` of the outline. Joins and
 * caps are treated as round and dashes as solid: a hit test, not a renderer.
 */
export function pointInStroke(
  data: readonly number[],
  x: number,
  y: number,
  width: number
): boolean {
  const reach = width / 2;
  for (const { points, closed } of flatten(data)) {
    const count = closed ? points.length : points.length - 1;
    if (
      points.length === 1 &&
      Math.hypot(points[0]!.x - x, points[0]!.y - y) <= reach
    ) {
      return true;
    }
    for (let i = 0; i < count; i += 1) {
      const a = points[i]!;
      const b = points[(i + 1) % points.length]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = dx * dx + dy * dy;
      const t =
        length === 0
          ? 0
          : Math.max(
              0,
              Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length)
            );
      if (Math.hypot(a.x + t * dx - x, a.y + t * dy - y) <= reach) return true;
    }
  }
  return false;
}

// ---- Path2D -------------------------------------------------------------------

export class Path2D {
  /** @internal */
  readonly builder = new PathBuilder();

  constructor(path?: Path2D | string) {
    if (path instanceof Path2D) {
      this.builder.addPathData(path.builder.data, IDENTITY);
    } else if (typeof path === 'string') {
      parseSvgPath(path, this);
    }
  }

  addPath(path: Path2D, transform?: MatrixInit): void {
    const m = matrixFromInit(transform);
    if (!finite(m.a, m.b, m.c, m.d, m.e, m.f)) return;
    this.builder.addPathData(path.builder.data, m);
  }

  moveTo(x: number, y: number): void {
    this.builder.moveTo(x, y);
  }
  lineTo(x: number, y: number): void {
    this.builder.lineTo(x, y);
  }
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    this.builder.quadraticCurveTo(cpx, cpy, x, y);
  }
  bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number
  ): void {
    this.builder.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
  }
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean
  ): void {
    this.builder.arc(x, y, radius, startAngle, endAngle, counterclockwise);
  }
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void {
    this.builder.arcTo(x1, y1, x2, y2, radius);
  }
  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean
  ): void {
    this.builder.ellipse(
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
  rect(x: number, y: number, w: number, h: number): void {
    this.builder.rect(x, y, w, h);
  }
  roundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    radii?: RoundRectRadii
  ): void {
    this.builder.roundRect(x, y, w, h, radii);
  }
  closePath(): void {
    this.builder.closePath();
  }
}

/**
 * SVG path data (`M`, `L`, `H`, `V`, `C`, `S`, `Q`, `T`, `A`, `Z`, absolute
 * and relative). Like a browser, it stops at the first error and keeps what
 * came before.
 */
function parseSvgPath(d: string, path: Path2D): void {
  const tokens =
    d.match(
      /[MmLlHhVvCcSsQqTtAaZz]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g
    ) ?? [];
  let i = 0;
  let command = '';
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  // The last control point, for S and T reflections.
  let lastControl: Point | null = null;
  let lastCommand = '';
  const isCommand = (t: string | undefined) => !!t && /^[A-Za-z]$/.test(t);
  const number = () => {
    const t = tokens[i];
    if (t === undefined || isCommand(t)) throw new Error('number expected');
    i += 1;
    return Number(t);
  };
  // A flag may be written run together with what follows ("a1 1 0 00 1 1").
  const flag = () => {
    const t = tokens[i];
    if (t === undefined || isCommand(t)) throw new Error('flag expected');
    if (t === '0' || t === '1') {
      i += 1;
      return t === '1';
    }
    if (/^[01]/.test(t)) {
      tokens[i] = t.slice(1);
      return t[0] === '1';
    }
    throw new Error('flag expected');
  };
  try {
    while (i < tokens.length) {
      if (isCommand(tokens[i])) {
        command = tokens[i]!;
        i += 1;
      } else if (!command) {
        return;
      }
      const relative = command === command.toLowerCase();
      const ox = relative ? x : 0;
      const oy = relative ? y : 0;
      switch (command.toUpperCase()) {
        case 'M': {
          x = ox + number();
          y = oy + number();
          path.moveTo(x, y);
          startX = x;
          startY = y;
          // Further pairs after a moveto are linetos.
          command = relative ? 'l' : 'L';
          lastControl = null;
          break;
        }
        case 'L':
          x = ox + number();
          y = oy + number();
          path.lineTo(x, y);
          lastControl = null;
          break;
        case 'H':
          x = ox + number();
          path.lineTo(x, y);
          lastControl = null;
          break;
        case 'V':
          y = oy + number();
          path.lineTo(x, y);
          lastControl = null;
          break;
        case 'C': {
          const c1x = ox + number();
          const c1y = oy + number();
          const c2x = ox + number();
          const c2y = oy + number();
          x = ox + number();
          y = oy + number();
          path.bezierCurveTo(c1x, c1y, c2x, c2y, x, y);
          lastControl = { x: c2x, y: c2y };
          break;
        }
        case 'S': {
          const reflect: boolean =
            /[CcSs]/.test(lastCommand) && lastControl !== null;
          const c1x: number = reflect ? 2 * x - lastControl!.x : x;
          const c1y: number = reflect ? 2 * y - lastControl!.y : y;
          const c2x = ox + number();
          const c2y = oy + number();
          x = ox + number();
          y = oy + number();
          path.bezierCurveTo(c1x, c1y, c2x, c2y, x, y);
          lastControl = { x: c2x, y: c2y };
          break;
        }
        case 'Q': {
          const cx = ox + number();
          const cy = oy + number();
          x = ox + number();
          y = oy + number();
          path.quadraticCurveTo(cx, cy, x, y);
          lastControl = { x: cx, y: cy };
          break;
        }
        case 'T': {
          const reflect: boolean =
            /[QqTt]/.test(lastCommand) && lastControl !== null;
          const cx: number = reflect ? 2 * x - lastControl!.x : x;
          const cy: number = reflect ? 2 * y - lastControl!.y : y;
          x = ox + number();
          y = oy + number();
          path.quadraticCurveTo(cx, cy, x, y);
          lastControl = { x: cx, y: cy };
          break;
        }
        case 'A': {
          const rx = Math.abs(number());
          const ry = Math.abs(number());
          const rotation = (number() * Math.PI) / 180;
          const large = flag();
          const sweep = flag();
          const ex = ox + number();
          const ey = oy + number();
          svgArc(path, x, y, rx, ry, rotation, large, sweep, ex, ey);
          x = ex;
          y = ey;
          lastControl = null;
          break;
        }
        case 'Z':
          path.closePath();
          x = startX;
          y = startY;
          lastControl = null;
          break;
        default:
          return;
      }
      lastCommand = command;
    }
  } catch {
    // Keep what parsed, as a browser does.
  }
}

/** SVG's endpoint arc, converted to centre form (SVG 1.1 appendix F.6). */
function svgArc(
  path: Path2D,
  x1: number,
  y1: number,
  rx: number,
  ry: number,
  phi: number,
  large: boolean,
  sweep: boolean,
  x2: number,
  y2: number
): void {
  if (x1 === x2 && y1 === y2) return;
  if (rx === 0 || ry === 0) {
    path.lineTo(x2, y2);
    return;
  }
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const numerator =
    rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let factor = Math.sqrt(Math.max(0, numerator / denominator));
  if (large === sweep) factor = -factor;
  const cxp = (factor * rx * y1p) / ry;
  const cyp = (-factor * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) =>
    Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const start = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle(
    (x1p - cxp) / rx,
    (y1p - cyp) / ry,
    (-x1p - cxp) / rx,
    (-y1p - cyp) / ry
  );
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  path.ellipse(cx, cy, rx, ry, phi, start, start + delta, !sweep);
}
