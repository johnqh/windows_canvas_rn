/**
 * `measureText`, which a recorder cannot answer by itself.
 *
 * Drawing code lays text out with it — centring a label, sizing a box — so a
 * wrong answer is a misplaced label rather than a missing one. On Windows the
 * native module measures with the same DirectWrite text layout the replay
 * draws with (see `native-measurer.ts`); elsewhere, and in tests, the
 * approximation stands in.
 */
import type { FontSpec } from './font.ts';

export type TextMeasure = {
  width: number;
  /** Above the baseline, px. */
  ascent: number;
  /** Below the baseline, px. */
  descent: number;
};

export type TextMeasurer = (font: FontSpec, text: string) => TextMeasure;

/** An average Latin glyph is a little over half the font size wide. */
export const approximateMeasurer: TextMeasurer = (font, text) => ({
  width: text.length * font.size * 0.56,
  ascent: font.size * 0.8,
  descent: font.size * 0.2,
});

/**
 * Remembers answers by font and text.
 *
 * A synchronous native call costs a bridge crossing; drawing code measures the
 * same few strings — bar numbers, labels — on every frame.
 */
export function cachedMeasurer(
  measure: TextMeasurer,
  limit = 4096
): TextMeasurer {
  const answers = new Map<string, TextMeasure>();
  return (font, text) => {
    const key = `${font.family}|${font.size}|${font.weight}|${
      font.italic ? 1 : 0
    }|${text}`;
    const known = answers.get(key);
    if (known) return known;
    const answer = measure(font, text);
    if (answers.size >= limit) answers.clear();
    answers.set(key, answer);
    return answer;
  };
}
