/**
 * The CSS `font` shorthand, as a canvas parses it.
 *
 * `[style || small-caps || weight || stretch] size[/line-height] family-list`,
 * or one of the system font keywords. A value that does not parse is `null`,
 * and the recorder then ignores the assignment, as a canvas does.
 *
 * Relative sizes resolve as they do for a canvas with no element to inherit
 * from: `em` and `%` against the canvas default of 10px, `rem` against 16px.
 * The whole family list is kept — the native side draws with the first family
 * installed — with the generic families mapped to the faces a browser on
 * Windows uses.
 */
import { FontStyle } from './format.ts';

export type FontSpec = {
  /** Comma-separated, generics resolved; the native side takes the first installed. */
  family: string;
  /** px */
  size: number;
  /** 1–1000 */
  weight: number;
  style: number;
  /** DirectWrite's 1 (ultra-condensed) – 9 (ultra-expanded); 5 is normal. */
  stretch: number;
  /** The shorthand's `small-caps`. */
  smallCaps: boolean;
};

const GENERIC: Record<string, string> = {
  'sans-serif': 'Segoe UI',
  'system-ui': 'Segoe UI',
  '-apple-system': 'Segoe UI',
  blinkmacsystemfont: 'Segoe UI',
  'ui-sans-serif': 'Segoe UI',
  'ui-rounded': 'Segoe UI',
  serif: 'Times New Roman',
  'ui-serif': 'Times New Roman',
  monospace: 'Consolas',
  'ui-monospace': 'Consolas',
  cursive: 'Comic Sans MS',
  fantasy: 'Impact',
  math: 'Cambria Math',
  emoji: 'Segoe UI Emoji',
  fangsong: 'FangSong',
};

export const STRETCH: Record<string, number> = {
  'ultra-condensed': 1,
  'extra-condensed': 2,
  condensed: 3,
  'semi-condensed': 4,
  normal: 5,
  'semi-expanded': 6,
  expanded: 7,
  'extra-expanded': 8,
  'ultra-expanded': 9,
};

const SIZE_KEYWORDS: Record<string, number> = {
  'xx-small': 9,
  'x-small': 10,
  small: 13,
  medium: 16,
  large: 18,
  'x-large': 24,
  'xx-large': 32,
  'xxx-large': 48,
  // Relative to the canvas default of 10px, by CSS's 1.2 ratio.
  larger: 12,
  smaller: 10 / 1.2,
};

const UNITS: Record<string, number> = {
  px: 1,
  pt: 4 / 3,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  em: 10,
  rem: 16,
  ex: 5,
  ch: 5,
  '%': 0.1,
};

/** The canvas default, `10px sans-serif`. */
export const DEFAULT_FONT: FontSpec = {
  family: 'Segoe UI',
  size: 10,
  weight: 400,
  style: FontStyle.Normal,
  stretch: 5,
  smallCaps: false,
};

const SYSTEM_FONTS = new Set([
  'caption',
  'icon',
  'menu',
  'message-box',
  'small-caption',
  'status-bar',
]);

export function resolveFamily(family: string): string {
  const name = family.trim().replace(/^(["'])(.*)\1$/, '$2');
  return GENERIC[name.toLowerCase()] ?? name;
}

/** Splits a family list on commas outside quotes. */
function families(list: string): string[] | null {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const char of list) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      current += char;
      quote = char;
    } else if (char === ',') {
      out.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (quote) return null;
  out.push(current);
  const resolved = out.map(resolveFamily);
  return resolved.every(Boolean) ? resolved : null;
}

function size(text: string): number | null {
  const keyword = SIZE_KEYWORDS[text];
  if (keyword !== undefined) return keyword;
  const match = text.match(/^(\d*\.?\d+)([a-z%]*)$/);
  if (!match) return null;
  const unit = UNITS[match[2] || 'px'];
  if (unit === undefined || (match[2] === '' && Number(match[1]) !== 0)) {
    return null;
  }
  return Number(match[1]) * unit;
}

const cache = new Map<string, FontSpec | null>();

export function tryParseFont(font: string): FontSpec | null {
  if (cache.has(font)) return cache.get(font)!;
  const result = parse(font.trim());
  if (cache.size > 256) cache.clear();
  cache.set(font, result);
  return result;
}

/** `null` → the canvas default. */
export function parseFont(font: string): FontSpec {
  return tryParseFont(font) ?? DEFAULT_FONT;
}

function parse(font: string): FontSpec | null {
  if (SYSTEM_FONTS.has(font.toLowerCase())) {
    // What Windows uses for UI text: Segoe UI at 9pt.
    return { ...DEFAULT_FONT, size: 12 };
  }
  // Tokens up to the family list; the family list may contain spaces.
  const tokens = font.split(/\s+/);
  let style: number = FontStyle.Normal;
  let weight = 400;
  let stretch = 5;
  let smallCaps = false;
  let index = 0;
  for (; index < tokens.length; index += 1) {
    const raw = tokens[index]!;
    const word = raw.toLowerCase();
    if (word === 'normal') continue;
    if (word === 'italic') {
      style = FontStyle.Italic;
    } else if (word === 'oblique') {
      style = FontStyle.Oblique;
      // An optional angle after `oblique`.
      if (/^-?\d*\.?\d+deg$/.test(tokens[index + 1] ?? '')) index += 1;
    } else if (word === 'small-caps') {
      smallCaps = true;
    } else if (word === 'bold' || word === 'bolder') {
      weight = 700;
    } else if (word === 'lighter') {
      weight = 300;
    } else if (
      /^\d+(\.\d+)?$/.test(word) &&
      Number(word) >= 1 &&
      Number(word) <= 1000
    ) {
      weight = Number(word);
    } else if (STRETCH[word] !== undefined) {
      stretch = STRETCH[word]!;
    } else {
      break;
    }
  }
  const sizeToken = tokens[index]?.toLowerCase();
  if (sizeToken === undefined) return null;
  const [sizeText = '', lineHeight] = sizeToken.split('/');
  let rest = tokens.slice(index + 1);
  // `size / line-height` written with spaces.
  if (lineHeight === undefined && rest[0]?.startsWith('/')) {
    rest = rest[0] === '/' ? rest.slice(2) : rest.slice(1);
  }
  const px = size(sizeText);
  if (px === null) return null;
  const list = families(rest.join(' '));
  if (!list) return null;
  return {
    family: list.join(','),
    size: px,
    weight,
    style,
    stretch,
    smallCaps,
  };
}
