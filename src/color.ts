/**
 * CSS colours to one packed number, `0xRRGGBBAA`.
 *
 * Packed as a double rather than a 32-bit integer — it exceeds `Int32` once red
 * passes 0x7f — which the native side reads back exactly. The recorder folds
 * `globalAlpha` into the alpha byte, so the replay has no alpha state of its
 * own.
 *
 * Covers what drawing code writes in practice: `#rgb`, `#rgba`, `#rrggbb`,
 * `#rrggbbaa`, `rgb()`/`rgba()` (comma or space separated, `/` alpha,
 * percentages), `transparent` and the CSS named colours most code uses.
 * Anything else — a gradient or pattern object, a colour it cannot read — is
 * opaque black, which is what a canvas does with a value it rejects only in
 * the sense that the previous colour would stay; black is the visible failure.
 */

const NAMED: Record<string, number> = {
  black: 0x000000ff,
  white: 0xffffffff,
  red: 0xff0000ff,
  green: 0x008000ff,
  lime: 0x00ff00ff,
  blue: 0x0000ffff,
  yellow: 0xffff00ff,
  cyan: 0x00ffffff,
  aqua: 0x00ffffff,
  magenta: 0xff00ffff,
  fuchsia: 0xff00ffff,
  gray: 0x808080ff,
  grey: 0x808080ff,
  silver: 0xc0c0c0ff,
  maroon: 0x800000ff,
  olive: 0x808000ff,
  navy: 0x000080ff,
  purple: 0x800080ff,
  teal: 0x008080ff,
  orange: 0xffa500ff,
  darkgray: 0xa9a9a9ff,
  darkgrey: 0xa9a9a9ff,
  lightgray: 0xd3d3d3ff,
  lightgrey: 0xd3d3d3ff,
  transparent: 0x00000000,
};

const BLACK = 0x000000ff;

function pack(r: number, g: number, b: number, a: number): number {
  const byte = (value: number) =>
    Math.max(0, Math.min(255, Math.round(Number.isFinite(value) ? value : 0)));
  return (
    byte(r) * 0x1000000 + byte(g) * 0x10000 + byte(b) * 0x100 + byte(a * 255)
  );
}

function channel(token: string): number {
  return token.endsWith('%')
    ? (parseFloat(token) / 100) * 255
    : parseFloat(token);
}

function alpha(token: string | undefined): number {
  if (token === undefined) return 1;
  const value = token.endsWith('%')
    ? parseFloat(token) / 100
    : parseFloat(token);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
}

function parseHex(hex: string): number | null {
  if (!/^[0-9a-f]+$/i.test(hex)) return null;
  const digit = (i: number) => parseInt(hex[i]! + hex[i]!, 16);
  const pair = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  switch (hex.length) {
    case 3:
      return pack(digit(0), digit(1), digit(2), 1);
    case 4:
      return pack(digit(0), digit(1), digit(2), digit(3) / 255);
    case 6:
      return pack(pair(0), pair(2), pair(4), 1);
    case 8:
      return pack(pair(0), pair(2), pair(4), pair(6) / 255);
    default:
      return null;
  }
}

const cache = new Map<string, number>();

/** `0xRRGGBBAA` for a CSS colour; opaque black for anything unreadable. */
export function parseColor(value: unknown): number {
  if (typeof value !== 'string') return BLACK;
  const cached = cache.get(value);
  if (cached !== undefined) return cached;
  const text = value.trim().toLowerCase();
  let result: number | null = null;
  if (text.startsWith('#')) {
    result = parseHex(text.slice(1));
  } else if (text.startsWith('rgb')) {
    const inner = text.slice(text.indexOf('(') + 1, text.lastIndexOf(')'));
    const [rgb, slashAlpha] = inner.split('/');
    const parts = rgb!
      .split(/[\s,]+/)
      .map(part => part.trim())
      .filter(Boolean);
    if (parts.length >= 3) {
      result = pack(
        channel(parts[0]!),
        channel(parts[1]!),
        channel(parts[2]!),
        alpha(slashAlpha?.trim() ?? parts[3])
      );
    }
  } else {
    result = NAMED[text] ?? null;
  }
  const resolved = result ?? BLACK;
  if (cache.size > 512) cache.clear();
  cache.set(value, resolved);
  return resolved;
}

/** The colour with its alpha multiplied by `factor` (0–1). */
export function withAlpha(color: number, factor: number): number {
  if (factor >= 1) return color;
  const a = color % 0x100;
  return color - a + Math.round(a * Math.max(0, factor));
}
