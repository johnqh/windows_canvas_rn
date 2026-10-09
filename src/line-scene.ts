/**
 * A 3D scene of coloured line segments, as the `WindowsLineScene` view takes
 * it: what `LineScene` hands the native view, and the packing that keeps an
 * unchanged prop the same array so React does not send it again.
 *
 * No React Native here — `core.ts` re-exports it.
 *
 * The view draws with Direct3D 11 on the device the Composition surface
 * already uses: a line list per batch, a perspective camera, a depth buffer
 * and linear fog. The conventions are three.js's (and WebGL's), so a scene
 * built with three can be handed over as it is: matrices are column-major
 * (`Matrix4.elements`), space is right-handed with y up, and the camera looks
 * down its own -z.
 */
import { parseColor } from './color.ts';

/** A column-major 4×4 matrix, laid out as three.js's `Matrix4.elements`. */
export type Matrix4Elements = ArrayLike<number>;

export interface LineBatch {
  /** x, y, z per vertex; each consecutive pair of vertices is one segment. */
  readonly vertices: ArrayLike<number>;
  /** The batch's own space to world. Omitted: the identity. */
  readonly matrix?: Matrix4Elements;
  /** A CSS colour, or a packed `0xRRGGBBAA`. */
  readonly color: string | number;
}

export interface LineSceneCamera {
  /** World to view — three's `camera.matrixWorldInverse`. */
  readonly view: Matrix4Elements;
  /**
   * Vertical field of view, in degrees. The horizontal one follows from the
   * view's aspect, as a `PerspectiveCamera`'s does, so resizing the view
   * shows more or less of the scene and never stretches it.
   */
  readonly fovDeg: number;
  readonly near: number;
  readonly far: number;
}

/**
 * Linear fog by distance from the eye: a line is as drawn up to `near` and
 * has faded completely into the background colour at `far`.
 */
export interface LineSceneFog {
  readonly near: number;
  readonly far: number;
}

/** The batches as the native view's flat props. */
export interface PackedLineBatches {
  /** Every batch's vertices, in order. */
  readonly vertices: readonly number[];
  /** How many of `vertices`' points each batch draws. */
  readonly vertexCounts: readonly number[];
  /** 16 numbers per batch. */
  readonly transforms: readonly number[];
  /** `0xRRGGBBAA` per batch. */
  readonly colors: readonly number[];
  /** The vertex arrays `vertices` was built from, by identity. */
  readonly sources: readonly ArrayLike<number>[];
}

export const IDENTITY_MATRIX: readonly number[] = [
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
];

function sameNumbers(
  a: readonly number[] | undefined,
  b: readonly number[]
): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameSources(
  a: readonly ArrayLike<number>[] | undefined,
  b: readonly LineBatch[]
): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]!.vertices) return false;
  return true;
}

/**
 * Packs `batches`, reusing each of `previous`'s arrays whose contents would
 * not change. The vertices are the large prop — thousands of numbers — and
 * the one that changes least: a colour changes on every note and the camera
 * on every step, while the geometry changes when the scene does. A prop that
 * is the same array is a prop React leaves out of the update, so it is never
 * read or uploaded again. Callers that rebuild identical geometry (a fresh
 * array with the same numbers) are caught by comparing contents.
 */
export function packLineBatches(
  batches: readonly LineBatch[],
  previous?: PackedLineBatches
): PackedLineBatches {
  let vertices: readonly number[];
  let vertexCounts: readonly number[];
  if (previous && sameSources(previous.sources, batches)) {
    vertices = previous.vertices;
    vertexCounts = previous.vertexCounts;
  } else {
    const flat: number[] = [];
    const counts: number[] = [];
    for (const batch of batches) {
      const count = Math.floor(batch.vertices.length / 3);
      for (let i = 0; i < count * 3; i++) flat.push(batch.vertices[i]!);
      counts.push(count);
    }
    vertices = sameNumbers(previous?.vertices, flat)
      ? previous!.vertices
      : flat;
    vertexCounts = sameNumbers(previous?.vertexCounts, counts)
      ? previous!.vertexCounts
      : counts;
  }

  const transforms: number[] = [];
  const colors: number[] = [];
  for (const batch of batches) {
    const matrix = batch.matrix ?? IDENTITY_MATRIX;
    for (let i = 0; i < 16; i++) transforms.push(matrix[i] ?? 0);
    colors.push(
      typeof batch.color === 'number' ? batch.color : parseColor(batch.color)
    );
  }

  return {
    vertices,
    vertexCounts,
    transforms: sameNumbers(previous?.transforms, transforms)
      ? previous!.transforms
      : transforms,
    colors: sameNumbers(previous?.colors, colors) ? previous!.colors : colors,
    sources: batches.map(batch => batch.vertices),
  };
}

/** `[fovDeg, near, far, ...view]` — the native `camera` prop. */
export function packLineSceneCamera(camera: LineSceneCamera): number[] {
  const packed = [camera.fovDeg, camera.near, camera.far];
  for (let i = 0; i < 16; i++) packed.push(camera.view[i] ?? 0);
  return packed;
}

/** `[near, far]`, or nothing for no fog — the native `fog` prop. */
export function packLineSceneFog(fog: LineSceneFog | undefined): number[] {
  return fog ? [fog.near, fog.far] : [];
}
