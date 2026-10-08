/**
 * Text measurement, which a recorder cannot do by itself.
 *
 * It is needed twice: to answer `measureText`, and to anchor every `fillText`
 * — the recorder turns `textAlign` and `textBaseline` into the point where the
 * text's alphabetic baseline starts, which takes the text's width and its
 * font's vertical metrics. On Windows the native module measures with the
 * same DirectWrite layout the view draws with (`native-measurer.ts`), so a
 * centred label is centred as drawn; elsewhere, and in tests, the
 * approximation stands in.
 */
import type { FontSpec } from './font.ts';

/** How text is laid out beyond its font: the canvas's text properties. */
export type TextStyle = {
  /** px added after every character. */
  letterSpacing: number;
  /** px added after every space. */
  wordSpacing: number;
  /** `Kerning` */
  kerning: number;
  /** `VariantCaps` — `fontVariantCaps`, or the shorthand's small-caps. */
  variantCaps: number;
  rtl: boolean;
};

export const DEFAULT_TEXT_STYLE: TextStyle = {
  letterSpacing: 0,
  wordSpacing: 0,
  kerning: 0,
  variantCaps: 0,
  rtl: false,
};

/**
 * Everything `TextMetrics` is built from, in px, measured from the start of
 * the text on its alphabetic baseline: x grows rightwards, and ascents and
 * descents are distances above and below the baseline.
 */
export type TextMeasure = {
  /** The advance: where the next text would start. */
  width: number;
  /** Ink extent, left and right edges. */
  inkLeft: number;
  inkRight: number;
  inkAscent: number;
  inkDescent: number;
  /** The font's ascent and descent at this size. */
  fontAscent: number;
  fontDescent: number;
  /** The em box: ascent + descent = font size. */
  emAscent: number;
  emDescent: number;
  /** The hanging baseline, above the alphabetic one. */
  hanging: number;
};

export type TextMeasurer = (
  font: FontSpec,
  text: string,
  style: TextStyle
) => TextMeasure;

/**
 * Proportions of Segoe UI, the face `sans-serif` resolves to: an average glyph
 * a little over half the size wide, ascent 1.079 and descent 0.251 of it.
 */
export const approximateMeasurer: TextMeasurer = (font, text, style) => {
  const characters = Array.from(text).length;
  const spaces = (text.match(/ /g) ?? []).length;
  const width =
    characters * font.size * 0.56 +
    characters * style.letterSpacing +
    spaces * style.wordSpacing;
  const emAscent = font.size * (1.079 / (1.079 + 0.251));
  return {
    width,
    inkLeft: 0,
    inkRight: width,
    inkAscent: font.size * 0.7,
    inkDescent: font.size * 0.05,
    fontAscent: font.size * 1.079,
    fontDescent: font.size * 0.251,
    emAscent,
    emDescent: font.size - emAscent,
    hanging: emAscent * 0.8,
  };
};

/**
 * Remembers answers by font, style and text.
 *
 * A synchronous native call costs a bridge crossing, and drawing code
 * measures — and anchors — the same few strings every frame.
 */
export function cachedMeasurer(
  measure: TextMeasurer,
  limit = 4096
): TextMeasurer {
  const answers = new Map<string, TextMeasure>();
  return (font, text, style) => {
    const key = [
      font.family,
      font.size,
      font.weight,
      font.style,
      font.stretch,
      style.letterSpacing,
      style.wordSpacing,
      style.kerning,
      style.variantCaps,
      style.rtl ? 1 : 0,
      text,
    ].join('|');
    const known = answers.get(key);
    if (known) return known;
    const answer = measure(font, text, style);
    if (answers.size >= limit) answers.clear();
    answers.set(key, answer);
    return answer;
  };
}
