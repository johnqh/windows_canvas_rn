/**
 * The picture format: what the recorder writes and the native view replays.
 *
 * A picture is one flat array of numbers plus a table of strings, because a
 * Fabric prop crosses to native as a JSON-like value and a flat array of
 * numbers is the cheapest such value to read on the other side.
 *
 * **What is resolved before an op is written.** Points are transformed into
 * device space, arcs and rounded corners are cubic curves, colours are packed
 * with the global alpha folded in, text is anchored at the start of its
 * alphabetic baseline, and a stroke is a pen in its own space (`Stroke`). A
 * stroke block is `width, cap, join, miterLimit, dashCount, dashes…,
 * dashOffset`. What the replay keeps as state is only what a canvas
 * applies to *every* drawing op and would be wasteful to repeat — the
 * composite operation, the shadow, the filter and image smoothing — and the
 * recorder writes a `Set…` op only when one of those changes.
 *
 * **Coordinates are device-independent pixels of the view.** Paths are already
 * transformed; text, images and paints carry the transform (`a b c d e f`)
 * that maps their own space into the view's.
 *
 * The C++ side mirrors these numbers in `windows/PictureFormat.h`, and
 * `format.test.ts` fails if they disagree.
 */

/** Bumped whenever the layout of any op changes. The first entry of every picture. */
export const FORMAT_VERSION = 2;

export const Op = {
  /** fillRule, paint, path */
  Fill: 1,
  /**
   * paint, stroke, a, b, c, d, e, f, path — the path in the stroke's own
   * space, mapped into the view's by `a…f`, so the pen is `width` wide there
   * whatever the transform does to it.
   */
  Stroke: 2,
  /**
   * mode (0 fill, 1 stroke), paint, [stroke when mode is 1], text, family,
   * size, weight, style, stretch, rtl, letterSpacing, wordSpacing, kerning,
   * variantCaps, rendering, a, b, c, d, e, f, x, y — `x, y` is where the
   * text's alphabetic baseline starts, in the text's own space.
   */
  Text: 3,
  /** path — cleared to transparent, through the clip */
  Clear: 4,
  /** fillRule, path — intersects the clip until the matching PopClip */
  Clip: 5,
  /** count */
  PopClip: 6,
  /**
   * image, alpha, imageWidth, imageHeight, sx, sy, sw, sh, dx, dy, dw, dh,
   * a, b, c, d, e, f — the source rectangle is in units of the size the image
   * was placed with (`imageWidth × imageHeight`, an asset's logical size),
   * whatever its pixel count.
   */
  Image: 7,
  /** image, dx, dy, dirtyX, dirtyY, dirtyW, dirtyH — device px, raw pixels */
  PutImage: 8,
  /** composite */
  SetComposite: 9,
  /** color, blur, offsetX, offsetY — device px; a transparent colour is none */
  SetShadow: 10,
  /** count, then that many filter primitives */
  SetFilter: 11,
  /** enabled, quality */
  SetSmoothing: 12,
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

/**
 * A paint is `kind, alpha`, then:
 * - Solid: color
 * - Linear: x0, y0, x1, y1, a, b, c, d, e, f, stops
 * - Radial: x0, y0, r0, x1, y1, r1, a, b, c, d, e, f, stops
 * - Conic: angle, x, y, a, b, c, d, e, f, stops
 * - Pattern: image, repetition, imageWidth, imageHeight, a, b, c, d, e, f —
 *   one tile is `imageWidth × imageHeight` in the pattern's space
 *
 * where stops are `count` then `offset, color` pairs, and `a…f` maps the
 * paint's own space into the view's. Solid colours carry their alpha in the
 * colour, and `alpha` is then 1.
 */
export const Paint = {
  Solid: 0,
  Linear: 1,
  Radial: 2,
  Conic: 3,
  Pattern: 4,
} as const;

export const Repetition = {
  Repeat: 0,
  RepeatX: 1,
  RepeatY: 2,
  NoRepeat: 3,
} as const;

export const FillRule = { NonZero: 0, EvenOdd: 1 } as const;
export const LineCap = { Butt: 0, Round: 1, Square: 2 } as const;
export const LineJoin = { Miter: 0, Round: 1, Bevel: 2 } as const;
export const FontStyle = { Normal: 0, Italic: 1, Oblique: 2 } as const;
export const Kerning = { Auto: 0, Normal: 1, None: 2 } as const;
export const VariantCaps = {
  Normal: 0,
  SmallCaps: 1,
  AllSmallCaps: 2,
  PetiteCaps: 3,
  AllPetiteCaps: 4,
  Unicase: 5,
  TitlingCaps: 6,
} as const;
export const TextRendering = {
  Auto: 0,
  OptimizeSpeed: 1,
  OptimizeLegibility: 2,
  GeometricPrecision: 3,
} as const;
export const SmoothingQuality = { Low: 0, Medium: 1, High: 2 } as const;

/** `globalCompositeOperation`, in the order the canvas spec lists them. */
export const Composite = {
  SourceOver: 0,
  SourceIn: 1,
  SourceOut: 2,
  SourceAtop: 3,
  DestinationOver: 4,
  DestinationIn: 5,
  DestinationOut: 6,
  DestinationAtop: 7,
  Lighter: 8,
  Copy: 9,
  Xor: 10,
  Multiply: 11,
  Screen: 12,
  Overlay: 13,
  Darken: 14,
  Lighten: 15,
  ColorDodge: 16,
  ColorBurn: 17,
  HardLight: 18,
  SoftLight: 19,
  Difference: 20,
  Exclusion: 21,
  Hue: 22,
  Saturation: 23,
  Color: 24,
  Luminosity: 25,
} as const;

/**
 * A filter primitive is `kind` then its arguments: one number for each of the
 * first nine (px for blur, degrees for hue-rotate, an amount for the rest),
 * and `offsetX, offsetY, blur, color` for a drop shadow.
 */
export const Filter = {
  Blur: 1,
  Brightness: 2,
  Contrast: 3,
  Grayscale: 4,
  HueRotate: 5,
  Invert: 6,
  Opacity: 7,
  Saturate: 8,
  Sepia: 9,
  DropShadow: 10,
} as const;

/** What a recording produces and `CanvasPicture` draws. */
export type Picture = {
  /** The size the picture was recorded for, in DIPs. Informational. */
  readonly width: number;
  readonly height: number;
  readonly ops: readonly number[];
  /** Texts, font families and image sources, referred to by index. */
  readonly strings: readonly string[];
};

export const EMPTY_PICTURE: Picture = {
  width: 0,
  height: 0,
  ops: [FORMAT_VERSION],
  strings: [],
};
