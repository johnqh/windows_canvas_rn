/**
 * `measureText` answered by DirectWrite, on Windows.
 *
 * `WindowsCanvas.measureText` (windows/WindowsCanvasModule.cpp) lays the text
 * out with the same DirectWrite text format the picture view draws it with, so
 * a label centred by its measured width is centred as drawn. A synchronous
 * call, cached, since drawing code measures the same strings every frame.
 * Elsewhere, or where the module is not compiled in, the approximation.
 */
import { NativeModules, Platform } from 'react-native';
import { approximateMeasurer, cachedMeasurer } from './measure.ts';
import type { TextMeasure, TextMeasurer } from './measure.ts';

type WindowsCanvasModule = {
  measureText?: (
    family: string,
    size: number,
    weight: number,
    italic: boolean,
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
      ? cachedMeasurer((font, text) => {
          try {
            return measure(
              font.family,
              font.size,
              font.weight,
              font.italic,
              text
            );
          } catch {
            return approximateMeasurer(font, text);
          }
        })
      : approximateMeasurer;
  return resolved;
}
