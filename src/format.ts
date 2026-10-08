/**
 * The picture format: what the recorder writes and the native view replays.
 *
 * A picture is one flat array of numbers plus a table of strings, because a
 * Fabric prop crosses to native as a JSON-like value and a flat array of
 * numbers is the cheapest such value to read on the other side. Everything the
 * native view would otherwise have to work out — the transform, the global
 * alpha, the colour, which way an arc turns — is resolved here, so the replay
 * in `windows/WindowsCanvasPicture.cpp` is a loop over opcodes and nothing
 * more.
 *
 * **Coordinates are device-independent pixels of the view**, with every point
 * already transformed. Text is the exception: it carries its transform, since
 * a font cannot be pre-transformed the way a point can.
 *
 * The C++ side mirrors these numbers in `windows/PictureFormat.h`. Change one
 * and change the other: `format.test.ts` reads that header and fails if they
 * disagree.
 */

/** Bumped whenever the layout of any op changes. The first entry of every picture. */
export const FORMAT_VERSION = 1;

export const Op = {
  /** color, fillRule, path */
  Fill: 1,
  /** color, width, cap, join, miterLimit, dashCount, ...dashes, dashOffset, path */
  Stroke: 2,
  /** color, text, family, size, weight, italic, align, baseline, a, b, c, d, e, f, x, y */
  Text: 3,
  /** x, y, width, height — device px, axis-aligned */
  ClearRect: 4,
  /** fillRule, path — intersects the clip until the matching PopClip */
  Clip: 5,
  /** count */
  PopClip: 6,
} as const;

/** A path is `segmentCount` followed by that many segments. */
export const Segment = {
  /** x, y */
  Move: 0,
  /** x, y */
  Line: 1,
  /** cx, cy, x, y */
  Quad: 2,
  /** c1x, c1y, c2x, c2y, x, y */
  Cubic: 3,
  Close: 4,
} as const;

export const FillRule = { NonZero: 0, EvenOdd: 1 } as const;
export const LineCap = { Butt: 0, Round: 1, Square: 2 } as const;
export const LineJoin = { Miter: 0, Round: 1, Bevel: 2 } as const;
export const TextAlign = { Start: 0, Center: 1, End: 2 } as const;
export const TextBaseline = {
  Alphabetic: 0,
  Top: 1,
  Middle: 2,
  Bottom: 3,
} as const;

/** What a recording produces and `CanvasPicture` draws. */
export type Picture = {
  /** The size the picture was recorded for, in DIPs. Informational. */
  readonly width: number;
  readonly height: number;
  readonly ops: readonly number[];
  readonly strings: readonly string[];
};

export const EMPTY_PICTURE: Picture = {
  width: 0,
  height: 0,
  ops: [FORMAT_VERSION],
  strings: [],
};
