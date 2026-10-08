/**
 * Text measured by DirectWrite, on Windows.
 *
 * `WindowsCanvas.measureText` (windows/WindowsCanvas.cpp) lays the text out
 * with the same DirectWrite layout the picture view draws with, so text
 * anchored by its measured width and baselines lands where it is drawn. A
 * synchronous call, cached, since drawing code measures and anchors the same
 * strings every frame. Elsewhere, or where the module is not compiled in, the
 * approximation.
 */
import { NativeModules, Platform } from 'react-native';
import { approximateMeasurer, cachedMeasurer } from './measure.ts';
import type { TextMeasure, TextMeasurer } from './measure.ts';

type WindowsCanvasModule = {
  measureText?: (
    family: string,
    size: number,
    weight: number,
    style: number,
    stretch: number,
    letterSpacing: number,
    wordSpacing: number,
    kerning: number,
    variantCaps: number,
    rtl: boolean,
    text: string
  ) => TextMeasure;
};

let resolved: TextMeasurer | null = null;

/** The best measurer this platform has; resolved once. */
export function defaultTextMeasurer(): TextMeasurer {
  if (resolved) return resolved;
  const module = (NativeModules as Record<string, unknown>).WindowsCanvas as
    | WindowsCanvasModule
    | undefined;
  const measure = module?.measureText;
  resolved =
    Platform.OS === 'windows' && measure
      ? cachedMeasurer((font, text, style) => {
          try {
            return measure(
              font.family,
              font.size,
              font.weight,
              font.style,
              font.stretch,
              style.letterSpacing,
              style.wordSpacing,
              style.kerning,
              style.variantCaps,
              style.rtl,
              text
            );
          } catch {
            return approximateMeasurer(font, text, style);
          }
        })
      : approximateMeasurer;
  return resolved;
}
