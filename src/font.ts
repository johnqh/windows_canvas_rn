/**
 * The CSS `font` shorthand, as a canvas reads it, resolved to a family
 * DirectWrite can open.
 *
 * `[style] [variant] [weight] size[/line-height] family[, family…]`. Only the
 * first family is kept: DirectWrite falls back per glyph on its own, so a
 * fallback list buys nothing. The generic families map to the Windows faces a
 * browser on Windows would pick.
 */

export type FontSpec = {
  family: string;
  /** px */
  size: number;
  /** 100–900 */
  weight: number;
  italic: boolean;
};

const GENERIC: Record<string, string> = {
  'sans-serif': 'Segoe UI',
  'system-ui': 'Segoe UI',
  '-apple-system': 'Segoe UI',
  blinkmacsystemfont: 'Segoe UI',
  'ui-sans-serif': 'Segoe UI',
  serif: 'Times New Roman',
  'ui-serif': 'Times New Roman',
  monospace: 'Consolas',
  'ui-monospace': 'Consolas',
  cursive: 'Comic Sans MS',
  fantasy: 'Impact',
};

const WEIGHTS: Record<string, number> = {
  normal: 400,
  bold: 700,
  bolder: 700,
  lighter: 300,
};

/** The canvas default, `10px sans-serif`. */
export const DEFAULT_FONT: FontSpec = {
  family: 'Segoe UI',
  size: 10,
  weight: 400,
  italic: false,
};

export function resolveFamily(family: string): string {
  const name = family.trim().replace(/^["']|["']$/g, '');
  return GENERIC[name.toLowerCase()] ?? (name || DEFAULT_FONT.family);
}

const cache = new Map<string, FontSpec>();

export function parseFont(font: string): FontSpec {
  const cached = cache.get(font);
  if (cached) return cached;
  // The size is the first token ending in a length unit; the families follow.
  const match = font.match(
    /^\s*(.*?)\s*(\d*\.?\d+)(px|pt|em|rem)(?:\s*\/\s*\S+)?\s+(.+?)\s*$/i
  );
  let spec = DEFAULT_FONT;
  if (match) {
    const [, prefix = '', amount = '10', unit = 'px', families = ''] = match;
    const scale = { px: 1, pt: 4 / 3, em: 16, rem: 16 }[
      unit.toLowerCase() as 'px'
    ];
    let weight = 400;
    let italic = false;
    for (const token of prefix.toLowerCase().split(/\s+/)) {
      if (token === 'italic' || token === 'oblique') italic = true;
      else if (WEIGHTS[token] !== undefined) weight = WEIGHTS[token]!;
      else if (/^[1-9]00$/.test(token)) weight = Number(token);
    }
    spec = {
      family: resolveFamily(families.split(',')[0] ?? ''),
      size: Number(amount) * (scale ?? 1),
      weight,
      italic,
    };
  }
  if (cache.size > 256) cache.clear();
  cache.set(font, spec);
  return spec;
}
