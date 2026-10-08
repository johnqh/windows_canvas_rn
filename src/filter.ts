/**
 * The canvas `filter` property: a CSS filter list, read into primitives the
 * native view chains as Direct2D effects.
 *
 * Lengths are device pixels, unaffected by the transform, as a canvas treats
 * them. `url(…)` refers to an SVG filter in a document a recording does not
 * have, so a list containing one draws unfiltered. An unreadable list is
 * `null`, and the recorder ignores the assignment, as a canvas does.
 */
import { tryParseColor } from './color.ts';
import { Filter } from './format.ts';

const LENGTH_UNITS: Record<string, number> = {
  px: 1,
  pt: 4 / 3,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  em: 10,
  rem: 16,
};

function length(text: string): number | null {
  const match = text.match(/^([+-]?(?:\d+\.?\d*|\.\d+))([a-z]*)$/);
  if (!match) return null;
  const unit = match[2]
    ? LENGTH_UNITS[match[2]]
    : Number(match[1]) === 0
      ? 1
      : undefined;
  return unit === undefined ? null : Number(match[1]) * unit;
}

/** A number or percentage, as an amount (100% = 1). */
function amount(text: string | undefined, fallback: number): number | null {
  if (text === undefined || text === '') return fallback;
  const match = text.match(/^([+-]?(?:\d+\.?\d*|\.\d+))(%?)$/);
  if (!match) return null;
  const value = Number(match[1]) / (match[2] ? 100 : 1);
  return value < 0 ? null : value;
}

function angle(text: string | undefined): number | null {
  if (text === undefined || text === '') return 0;
  const match = text.match(/^([+-]?(?:\d+\.?\d*|\.\d+))(deg|rad|grad|turn)?$/);
  if (!match) return null;
  const value = Number(match[1]);
  switch (match[2]) {
    case 'rad':
      return (value * 180) / Math.PI;
    case 'grad':
      return value * 0.9;
    case 'turn':
      return value * 360;
    case 'deg':
      return value;
    default:
      return value === 0 ? 0 : null;
  }
}

/** Splits `a(b c) d(e)` into functions, respecting nested parentheses. */
function functions(list: string): { name: string; body: string }[] | null {
  const out: { name: string; body: string }[] = [];
  let i = 0;
  while (i < list.length) {
    while (i < list.length && /\s/.test(list[i]!)) i += 1;
    if (i >= list.length) break;
    const match = /^([a-z-]+)\(/.exec(list.slice(i));
    if (!match) return null;
    let depth = 1;
    let j = i + match[0].length;
    for (; j < list.length && depth > 0; j += 1) {
      if (list[j] === '(') depth += 1;
      else if (list[j] === ')') depth -= 1;
    }
    if (depth !== 0) return null;
    out.push({
      name: match[1]!,
      body: list.slice(i + match[0].length, j - 1).trim(),
    });
    i = j;
  }
  return out;
}

/** Splits on whitespace outside parentheses. */
function words(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (/\s/.test(char) && depth === 0) {
      if (current) out.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current) out.push(current);
  return out;
}

/** The primitives for a filter list; `[]` for none; `null` if unreadable. */
export function parseFilter(value: string): number[] | null {
  const text = value.trim().toLowerCase();
  if (text === 'none' || text === '') return [];
  const list = functions(text);
  if (!list) return null;
  const out: number[] = [];
  for (const { name, body } of list) {
    switch (name) {
      case 'url':
        // An SVG filter there is no document to look up: draw unfiltered.
        return [];
      case 'blur': {
        const px = body === '' ? 0 : length(body);
        if (px === null || px < 0) return null;
        out.push(Filter.Blur, px);
        break;
      }
      case 'hue-rotate': {
        const deg = angle(body);
        if (deg === null) return null;
        out.push(Filter.HueRotate, deg);
        break;
      }
      case 'brightness':
      case 'contrast':
      case 'saturate':
      case 'grayscale':
      case 'invert':
      case 'opacity':
      case 'sepia': {
        const value = amount(body, 1);
        if (value === null) return null;
        const clamped = ['grayscale', 'invert', 'opacity', 'sepia'].includes(
          name
        )
          ? Math.min(1, value)
          : value;
        const kind = {
          brightness: Filter.Brightness,
          contrast: Filter.Contrast,
          saturate: Filter.Saturate,
          grayscale: Filter.Grayscale,
          invert: Filter.Invert,
          opacity: Filter.Opacity,
          sepia: Filter.Sepia,
        }[name];
        out.push(kind, clamped);
        break;
      }
      case 'drop-shadow': {
        let color: number | null = null;
        const lengths: number[] = [];
        for (const word of words(body)) {
          const px = length(word);
          if (px !== null) {
            if (lengths.length >= 3) return null;
            lengths.push(px);
            continue;
          }
          const parsed = tryParseColor(word);
          if (parsed === null || color !== null) return null;
          color = parsed;
        }
        if (lengths.length < 2 || lengths.length > 3) return null;
        const blur = lengths[2] ?? 0;
        if (blur < 0) return null;
        out.push(
          Filter.DropShadow,
          lengths[0]!,
          lengths[1]!,
          blur,
          color ?? 0x000000ff
        );
        break;
      }
      default:
        return null;
    }
  }
  return out;
}
