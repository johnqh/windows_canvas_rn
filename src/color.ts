/**
 * CSS colours, as a canvas reads them, to one packed number `0xRRGGBBAA`.
 *
 * Packed as a double rather than a 32-bit integer — it exceeds `Int32` once red
 * passes 0x7f — which the native side reads back exactly.
 *
 * Every CSS Color 4 form a browser canvas accepts: `#rgb[a]`, `#rrggbb[aa]`,
 * `rgb[a]()`, `hsl[a]()`, `hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()`,
 * `color(srgb | srgb-linear | display-p3 …)`, the 148 named colours,
 * `transparent` and `currentcolor` (black: a recording has no element to
 * inherit from). Wide-gamut colours are converted to sRGB and clipped.
 *
 * `tryParseColor` answers `null` for anything else, and the recorder then
 * ignores the assignment — which is what a canvas does with a value it cannot
 * read.
 */

const NAMED: Record<string, number> = {
  aliceblue: 0xf0f8ff,
  antiquewhite: 0xfaebd7,
  aqua: 0x00ffff,
  aquamarine: 0x7fffd4,
  azure: 0xf0ffff,
  beige: 0xf5f5dc,
  bisque: 0xffe4c4,
  black: 0x000000,
  blanchedalmond: 0xffebcd,
  blue: 0x0000ff,
  blueviolet: 0x8a2be2,
  brown: 0xa52a2a,
  burlywood: 0xdeb887,
  cadetblue: 0x5f9ea0,
  chartreuse: 0x7fff00,
  chocolate: 0xd2691e,
  coral: 0xff7f50,
  cornflowerblue: 0x6495ed,
  cornsilk: 0xfff8dc,
  crimson: 0xdc143c,
  cyan: 0x00ffff,
  darkblue: 0x00008b,
  darkcyan: 0x008b8b,
  darkgoldenrod: 0xb8860b,
  darkgray: 0xa9a9a9,
  darkgreen: 0x006400,
  darkgrey: 0xa9a9a9,
  darkkhaki: 0xbdb76b,
  darkmagenta: 0x8b008b,
  darkolivegreen: 0x556b2f,
  darkorange: 0xff8c00,
  darkorchid: 0x9932cc,
  darkred: 0x8b0000,
  darksalmon: 0xe9967a,
  darkseagreen: 0x8fbc8f,
  darkslateblue: 0x483d8b,
  darkslategray: 0x2f4f4f,
  darkslategrey: 0x2f4f4f,
  darkturquoise: 0x00ced1,
  darkviolet: 0x9400d3,
  deeppink: 0xff1493,
  deepskyblue: 0x00bfff,
  dimgray: 0x696969,
  dimgrey: 0x696969,
  dodgerblue: 0x1e90ff,
  firebrick: 0xb22222,
  floralwhite: 0xfffaf0,
  forestgreen: 0x228b22,
  fuchsia: 0xff00ff,
  gainsboro: 0xdcdcdc,
  ghostwhite: 0xf8f8ff,
  gold: 0xffd700,
  goldenrod: 0xdaa520,
  gray: 0x808080,
  green: 0x008000,
  greenyellow: 0xadff2f,
  grey: 0x808080,
  honeydew: 0xf0fff0,
  hotpink: 0xff69b4,
  indianred: 0xcd5c5c,
  indigo: 0x4b0082,
  ivory: 0xfffff0,
  khaki: 0xf0e68c,
  lavender: 0xe6e6fa,
  lavenderblush: 0xfff0f5,
  lawngreen: 0x7cfc00,
  lemonchiffon: 0xfffacd,
  lightblue: 0xadd8e6,
  lightcoral: 0xf08080,
  lightcyan: 0xe0ffff,
  lightgoldenrodyellow: 0xfafad2,
  lightgray: 0xd3d3d3,
  lightgreen: 0x90ee90,
  lightgrey: 0xd3d3d3,
  lightpink: 0xffb6c1,
  lightsalmon: 0xffa07a,
  lightseagreen: 0x20b2aa,
  lightskyblue: 0x87cefa,
  lightslategray: 0x778899,
  lightslategrey: 0x778899,
  lightsteelblue: 0xb0c4de,
  lightyellow: 0xffffe0,
  lime: 0x00ff00,
  limegreen: 0x32cd32,
  linen: 0xfaf0e6,
  magenta: 0xff00ff,
  maroon: 0x800000,
  mediumaquamarine: 0x66cdaa,
  mediumblue: 0x0000cd,
  mediumorchid: 0xba55d3,
  mediumpurple: 0x9370db,
  mediumseagreen: 0x3cb371,
  mediumslateblue: 0x7b68ee,
  mediumspringgreen: 0x00fa9a,
  mediumturquoise: 0x48d1cc,
  mediumvioletred: 0xc71585,
  midnightblue: 0x191970,
  mintcream: 0xf5fffa,
  mistyrose: 0xffe4e1,
  moccasin: 0xffe4b5,
  navajowhite: 0xffdead,
  navy: 0x000080,
  oldlace: 0xfdf5e6,
  olive: 0x808000,
  olivedrab: 0x6b8e23,
  orange: 0xffa500,
  orangered: 0xff4500,
  orchid: 0xda70d6,
  palegoldenrod: 0xeee8aa,
  palegreen: 0x98fb98,
  paleturquoise: 0xafeeee,
  palevioletred: 0xdb7093,
  papayawhip: 0xffefd5,
  peachpuff: 0xffdab9,
  peru: 0xcd853f,
  pink: 0xffc0cb,
  plum: 0xdda0dd,
  powderblue: 0xb0e0e6,
  purple: 0x800080,
  rebeccapurple: 0x663399,
  red: 0xff0000,
  rosybrown: 0xbc8f8f,
  royalblue: 0x4169e1,
  saddlebrown: 0x8b4513,
  salmon: 0xfa8072,
  sandybrown: 0xf4a460,
  seagreen: 0x2e8b57,
  seashell: 0xfff5ee,
  sienna: 0xa0522d,
  silver: 0xc0c0c0,
  skyblue: 0x87ceeb,
  slateblue: 0x6a5acd,
  slategray: 0x708090,
  slategrey: 0x708090,
  snow: 0xfffafa,
  springgreen: 0x00ff7f,
  steelblue: 0x4682b4,
  tan: 0xd2b48c,
  teal: 0x008080,
  thistle: 0xd8bfd8,
  tomato: 0xff6347,
  turquoise: 0x40e0d0,
  violet: 0xee82ee,
  wheat: 0xf5deb3,
  white: 0xffffff,
  whitesmoke: 0xf5f5f5,
  yellow: 0xffff00,
  yellowgreen: 0x9acd32,
};

export const BLACK = 0x000000ff;
export const TRANSPARENT = 0x00000000;

/** sRGB channels 0–1 and alpha 0–1, clipped, packed. */
function pack(r: number, g: number, b: number, a: number): number {
  const byte = (value: number) =>
    Math.round(
      Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 255
    );
  return byte(r) * 0x1000000 + byte(g) * 0x10000 + byte(b) * 0x100 + byte(a);
}

const encodeSrgb = (c: number) =>
  Math.abs(c) <= 0.0031308
    ? 12.92 * c
    : Math.sign(c) * (1.055 * Math.pow(Math.abs(c), 1 / 2.4) - 0.055);
const decodeSrgb = (c: number) =>
  Math.abs(c) <= 0.04045
    ? c / 12.92
    : Math.sign(c) * Math.pow((Math.abs(c) + 0.055) / 1.055, 2.4);

type Vec3 = [number, number, number];
const mul = (m: readonly number[], [x, y, z]: Vec3): Vec3 => [
  m[0]! * x + m[1]! * y + m[2]! * z,
  m[3]! * x + m[4]! * y + m[5]! * z,
  m[6]! * x + m[7]! * y + m[8]! * z,
];

const D50_TO_D65 = [
  0.9554734527042182, -0.023098536874261423, 0.0632593086610217,
  -0.028369706963208136, 1.0099954580058226, 0.021041398966943008,
  0.012314001688319899, -0.020507696433477912, 1.3303659366080753,
];
const XYZ_D65_TO_LINEAR_SRGB = [
  3.2409699419045226, -1.537383177570094, -0.4986107602930034,
  -0.9692436362808796, 1.8759675015077202, 0.04155505740717559,
  0.05563007969699366, -0.20397695888897652, 1.0569715142428786,
];
const LINEAR_P3_TO_XYZ_D65 = [
  0.4865709486482162, 0.26566769316909306, 0.1982172852343625,
  0.2289745640697488, 0.6917385218365064, 0.079286914093745, 0,
  0.04511338185890264, 1.043944368900976,
];
const D50_WHITE: Vec3 = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];

function linearToPacked([r, g, b]: Vec3, alpha: number): number {
  return pack(encodeSrgb(r), encodeSrgb(g), encodeSrgb(b), alpha);
}

function labToLinearSrgb(l: number, a: number, b: number): Vec3 {
  const kappa = 24389 / 27;
  const epsilon = 216 / 24389;
  const f1 = (l + 16) / 116;
  const f0 = a / 500 + f1;
  const f2 = f1 - b / 200;
  const xyz: Vec3 = [
    (f0 ** 3 > epsilon ? f0 ** 3 : (116 * f0 - 16) / kappa) * D50_WHITE[0],
    (l > kappa * epsilon ? ((l + 16) / 116) ** 3 : l / kappa) * D50_WHITE[1],
    (f2 ** 3 > epsilon ? f2 ** 3 : (116 * f2 - 16) / kappa) * D50_WHITE[2],
  ];
  return mul(XYZ_D65_TO_LINEAR_SRGB, mul(D50_TO_D65, xyz));
}

function oklabToLinearSrgb(l: number, a: number, b: number): Vec3 {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

function hslToRgb(h: number, s: number, l: number): Vec3 {
  const hue = (((h % 360) + 360) % 360) / 30;
  const amount = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + hue) % 12;
    return l - amount * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4)];
}

// ---- tokens ------------------------------------------------------------------

/** A number, with its unit if it had one; `none` reads as 0. */
type Token = { value: number; unit: string };

function token(text: string): Token | null {
  if (text === 'none') return { value: 0, unit: '' };
  const match = text.match(
    /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|deg|rad|grad|turn)?$/
  );
  if (!match) return null;
  return { value: Number(match[1]), unit: match[2] ?? '' };
}

/** A hue in degrees. */
function hue(t: Token): number | null {
  switch (t.unit) {
    case '':
    case 'deg':
      return t.value;
    case 'rad':
      return (t.value * 180) / Math.PI;
    case 'grad':
      return t.value * 0.9;
    case 'turn':
      return t.value * 360;
    default:
      return null;
  }
}

/** A number, or a percentage of `full`. */
function amount(t: Token, full: number): number | null {
  if (t.unit === '%') return (t.value / 100) * full;
  return t.unit === '' ? t.value : null;
}

function alphaOf(t: Token | undefined): number | null {
  if (!t) return 1;
  return amount(t, 1);
}

/** `fn(a b c / alpha)` or `fn(a, b, c, alpha)` → tokens and alpha. */
function args(
  body: string
): { values: Token[]; alpha: Token | undefined } | null {
  const [main, slash] = body.split('/');
  if (main === undefined) return null;
  const parts = main
    .trim()
    .split(/\s*,\s*|\s+/)
    .filter(Boolean);
  let alphaText = slash?.trim();
  if (alphaText === undefined && parts.length === 4) alphaText = parts.pop();
  const values = parts.map(token);
  if (values.some(v => v === null)) return null;
  const alpha = alphaText === undefined ? undefined : token(alphaText);
  if (alpha === null) return null;
  return { values: values as Token[], alpha };
}

function parseFunction(name: string, body: string): number | null {
  if (name === 'color') {
    const space = body.trim().split(/\s+/)[0] ?? '';
    const parsed = args(body.trim().slice(space.length));
    if (!parsed || parsed.values.length !== 3) return null;
    const channels = parsed.values.map(v => amount(v, 1));
    const alpha = alphaOf(parsed.alpha);
    if (channels.some(c => c === null) || alpha === null) return null;
    const [r, g, b] = channels as Vec3;
    switch (space) {
      case 'srgb':
        return pack(r, g, b, alpha);
      case 'srgb-linear':
        return linearToPacked([r, g, b], alpha);
      case 'display-p3':
        return linearToPacked(
          mul(
            XYZ_D65_TO_LINEAR_SRGB,
            mul(LINEAR_P3_TO_XYZ_D65, [
              decodeSrgb(r),
              decodeSrgb(g),
              decodeSrgb(b),
            ])
          ),
          alpha
        );
      default:
        return null;
    }
  }

  const parsed = args(body);
  if (!parsed || parsed.values.length !== 3) return null;
  const [t0, t1, t2] = parsed.values as [Token, Token, Token];
  const alpha = alphaOf(parsed.alpha);
  if (alpha === null) return null;

  switch (name) {
    case 'rgb':
    case 'rgba': {
      const channels = [t0, t1, t2].map(t => amount(t, 255));
      if (channels.some(c => c === null)) return null;
      const [r, g, b] = channels as Vec3;
      return pack(r / 255, g / 255, b / 255, alpha);
    }
    case 'hsl':
    case 'hsla': {
      const h = hue(t0);
      const s = amount(t1, 100);
      const l = amount(t2, 100);
      if (h === null || s === null || l === null) return null;
      const [r, g, b] = hslToRgb(
        h,
        Math.max(0, Math.min(1, s / 100)),
        Math.max(0, Math.min(1, l / 100))
      );
      return pack(r, g, b, alpha);
    }
    case 'hwb': {
      const h = hue(t0);
      let w = amount(t1, 100);
      let bl = amount(t2, 100);
      if (h === null || w === null || bl === null) return null;
      w /= 100;
      bl /= 100;
      if (w + bl >= 1) {
        const gray = w / (w + bl);
        return pack(gray, gray, gray, alpha);
      }
      const [r, g, b] = hslToRgb(h, 1, 0.5).map(
        c => c * (1 - w! - bl!) + w!
      ) as Vec3;
      return pack(r, g, b, alpha);
    }
    case 'lab':
    case 'lch': {
      const l = amount(t0, 100);
      if (l === null) return null;
      if (name === 'lab') {
        const a = amount(t1, 125);
        const b = amount(t2, 125);
        if (a === null || b === null) return null;
        return linearToPacked(labToLinearSrgb(l, a, b), alpha);
      }
      const c = amount(t1, 150);
      const h = hue(t2);
      if (c === null || h === null) return null;
      const rad = (h * Math.PI) / 180;
      return linearToPacked(
        labToLinearSrgb(l, c * Math.cos(rad), c * Math.sin(rad)),
        alpha
      );
    }
    case 'oklab':
    case 'oklch': {
      const l = amount(t0, 1);
      if (l === null) return null;
      if (name === 'oklab') {
        const a = amount(t1, 0.4);
        const b = amount(t2, 0.4);
        if (a === null || b === null) return null;
        return linearToPacked(oklabToLinearSrgb(l, a, b), alpha);
      }
      const c = amount(t1, 0.4);
      const h = hue(t2);
      if (c === null || h === null) return null;
      const rad = (h * Math.PI) / 180;
      return linearToPacked(
        oklabToLinearSrgb(l, c * Math.cos(rad), c * Math.sin(rad)),
        alpha
      );
    }
    default:
      return null;
  }
}

function parseHex(hex: string): number | null {
  if (!/^[0-9a-f]+$/.test(hex)) return null;
  const digit = (i: number) => parseInt(hex[i]! + hex[i]!, 16) / 255;
  const pair = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
  switch (hex.length) {
    case 3:
      return pack(digit(0), digit(1), digit(2), 1);
    case 4:
      return pack(digit(0), digit(1), digit(2), digit(3));
    case 6:
      return pack(pair(0), pair(2), pair(4), 1);
    case 8:
      return pack(pair(0), pair(2), pair(4), pair(6));
    default:
      return null;
  }
}

const cache = new Map<string, number | null>();

/** `0xRRGGBBAA`, or `null` for a value a canvas would reject. */
export function tryParseColor(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const cached = cache.get(value);
  if (cached !== undefined) return cached;
  const text = value.trim().toLowerCase();
  let result: number | null = null;
  if (text.startsWith('#')) {
    result = parseHex(text.slice(1));
  } else if (text === 'transparent') {
    result = TRANSPARENT;
  } else if (text === 'currentcolor') {
    result = BLACK;
  } else if (NAMED[text] !== undefined) {
    result = NAMED[text]! * 0x100 + 0xff;
  } else {
    const match = text.match(/^([a-z-]+)\((.*)\)$/s);
    if (match) result = parseFunction(match[1]!, match[2]!);
  }
  if (cache.size > 1024) cache.clear();
  cache.set(value, result);
  return result;
}

/** `0xRRGGBBAA`; opaque black for anything unreadable. */
export function parseColor(value: unknown): number {
  return tryParseColor(value) ?? BLACK;
}

/** The colour with its alpha multiplied by `factor` (0–1). */
export function withAlpha(color: number, factor: number): number {
  if (factor >= 1) return color;
  const a = color % 0x100;
  return color - a + Math.round(a * Math.max(0, factor));
}

export function alphaOfColor(color: number): number {
  return (color % 0x100) / 255;
}

/**
 * What a canvas reads back: `#rrggbb` when opaque, `rgba(r, g, b, a)`
 * otherwise — the spec's serialization of a colour style.
 */
export function serializeColor(color: number): string {
  const r = Math.floor(color / 0x1000000) % 0x100;
  const g = Math.floor(color / 0x10000) % 0x100;
  const b = Math.floor(color / 0x100) % 0x100;
  const a = color % 0x100;
  if (a === 255) {
    return `#${[r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')}`;
  }
  const alpha = a === 0 ? '0' : String(Math.round((a / 255) * 1000) / 1000);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
