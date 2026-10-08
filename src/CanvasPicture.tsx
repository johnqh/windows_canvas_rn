/**
 * Draws a recorded `Picture`, on Windows.
 *
 * One native view per picture, drawn in a single Direct2D pass whenever the
 * picture changes: there is no element per shape for React to reconcile or
 * for the renderer to redraw one at a time. Memoised on the picture object,
 * so a parent re-render with the same picture costs nothing.
 *
 * The picture is drawn from the view's top-left at one unit per DIP; size the
 * view with `style`. Windows only — there is no native view elsewhere.
 */
import { memo } from 'react';
import type { ViewProps } from 'react-native';
import NativeCanvasPicture from './WindowsCanvasPictureNativeComponent.ts';
import { EMPTY_PICTURE } from './format.ts';
import type { Picture } from './format.ts';

export type CanvasPictureProps = ViewProps & {
  picture: Picture | null;
};

export const CanvasPicture = memo(function CanvasPicture({
  picture,
  ...props
}: CanvasPictureProps) {
  const shown = picture ?? EMPTY_PICTURE;
  return (
    <NativeCanvasPicture
      pointerEvents='none'
      {...props}
      ops={shown.ops}
      strings={shown.strings}
    />
  );
});
