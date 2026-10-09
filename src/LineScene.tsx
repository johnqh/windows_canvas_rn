/**
 * Draws a 3D scene of coloured line segments on the GPU, on Windows.
 *
 * Direct3D 11, on the device the Composition surface is drawn with: one line
 * list per batch, a perspective camera, a depth buffer, 4× multisampling and
 * linear fog toward the background colour. Redrawn once per change, never on
 * a frame loop — a still scene costs nothing.
 *
 * Batches are packed against the previous render's (see `packLineBatches`),
 * so a change of colour or camera sends only that prop: the vertices go to
 * the GPU when the geometry changes and not otherwise.
 *
 * Windows only — there is no native view elsewhere.
 */
import { memo, useMemo, useRef } from 'react';
import type { ViewProps } from 'react-native';
import NativeLineScene from './WindowsLineSceneNativeComponent.ts';
import { parseColor, TRANSPARENT } from './color.ts';
import {
  packLineBatches,
  packLineSceneCamera,
  packLineSceneFog,
} from './line-scene.ts';
import type {
  LineBatch,
  LineSceneCamera,
  LineSceneFog,
  PackedLineBatches,
} from './line-scene.ts';

export type LineSceneProps = ViewProps & {
  batches: readonly LineBatch[];
  camera: LineSceneCamera;
  /** Linear fog toward `background`. Omitted: none. */
  fog?: LineSceneFog;
  /** A CSS colour or `0xRRGGBBAA`. Default: transparent. */
  background?: string | number;
};

export const LineScene = memo(function LineScene({
  batches,
  camera,
  fog,
  background,
  ...props
}: LineSceneProps) {
  const previous = useRef<PackedLineBatches | undefined>(undefined);
  const packed = useMemo(() => {
    const next = packLineBatches(batches, previous.current);
    previous.current = next;
    return next;
  }, [batches]);
  const packedCamera = useMemo(() => packLineSceneCamera(camera), [camera]);
  const fogNear = fog?.near;
  const fogFar = fog?.far;
  const packedFog = useMemo(
    () =>
      packLineSceneFog(
        fogNear === undefined || fogFar === undefined
          ? undefined
          : { near: fogNear, far: fogFar }
      ),
    [fogNear, fogFar]
  );
  const packedBackground =
    background === undefined
      ? TRANSPARENT
      : typeof background === 'number'
        ? background
        : parseColor(background);

  return (
    <NativeLineScene
      pointerEvents='none'
      {...props}
      vertices={packed.vertices}
      vertexCounts={packed.vertexCounts}
      transforms={packed.transforms}
      colors={packed.colors}
      camera={packedCamera}
      fog={packedFog}
      background={packedBackground}
    />
  );
});
