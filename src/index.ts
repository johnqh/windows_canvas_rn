export * from './core.ts';
export { defaultTextMeasurer } from './native-measurer.ts';
export { CanvasPicture } from './CanvasPicture.tsx';
export type { CanvasPictureProps } from './CanvasPicture.tsx';
export { LineScene } from './LineScene.tsx';
export type { LineSceneProps } from './LineScene.tsx';

import { PictureRecorder } from './recorder.ts';
import { defaultTextMeasurer } from './native-measurer.ts';

/** A recorder measuring text with the best measurer this platform has. */
export function createRecorder(width: number, height: number) {
  return new PictureRecorder(width, height, {
    measureText: defaultTextMeasurer(),
  });
}
