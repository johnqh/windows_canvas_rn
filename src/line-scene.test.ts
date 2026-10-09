import { describe, expect, it } from 'vitest';
import {
  IDENTITY_MATRIX,
  packLineBatches,
  packLineSceneCamera,
  packLineSceneFog,
} from './line-scene.ts';

const square = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0]);
const line = [0, 0, 0, 0, 1, 0];

describe('packLineBatches', () => {
  it('concatenates vertices and counts points per batch', () => {
    const packed = packLineBatches([
      { vertices: square, color: '#ff0000' },
      { vertices: line, color: 0x00ff0080 },
    ]);
    expect(packed.vertices).toEqual([...square, ...line]);
    expect(packed.vertexCounts).toEqual([4, 2]);
    expect(packed.colors).toEqual([0xff0000ff, 0x00ff0080]);
  });

  it('writes the identity for a batch with no matrix', () => {
    const translate = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1];
    const packed = packLineBatches([
      { vertices: line, color: 'white' },
      { vertices: line, matrix: translate, color: 'white' },
    ]);
    expect(packed.transforms).toEqual([...IDENTITY_MATRIX, ...translate]);
  });

  it('drops a trailing partial vertex', () => {
    const packed = packLineBatches([
      { vertices: [0, 0, 0, 1, 1], color: 'black' },
    ]);
    expect(packed.vertices).toEqual([0, 0, 0]);
    expect(packed.vertexCounts).toEqual([1]);
  });

  it('keeps the vertex array when only a colour changes', () => {
    const first = packLineBatches([{ vertices: square, color: 'red' }]);
    const second = packLineBatches(
      [{ vertices: square, color: 'blue' }],
      first
    );
    expect(second.vertices).toBe(first.vertices);
    expect(second.vertexCounts).toBe(first.vertexCounts);
    expect(second.transforms).toBe(first.transforms);
    expect(second.colors).not.toBe(first.colors);
  });

  it('keeps the vertex array when identical geometry is rebuilt', () => {
    const first = packLineBatches([{ vertices: square, color: 'red' }]);
    const second = packLineBatches(
      [{ vertices: new Float32Array(square), color: 'red' }],
      first
    );
    expect(second.vertices).toBe(first.vertices);
    expect(second.colors).toBe(first.colors);
  });

  it('replaces the vertex array when the geometry changes', () => {
    const first = packLineBatches([{ vertices: square, color: 'red' }]);
    const second = packLineBatches([{ vertices: line, color: 'red' }], first);
    expect(second.vertices).not.toBe(first.vertices);
    expect(second.vertices).toEqual(line);
  });
});

describe('packLineSceneCamera', () => {
  it('puts the lens before the view matrix', () => {
    expect(
      packLineSceneCamera({
        view: IDENTITY_MATRIX,
        fovDeg: 70,
        near: 0.05,
        far: 100,
      })
    ).toEqual([70, 0.05, 100, ...IDENTITY_MATRIX]);
  });
});

describe('packLineSceneFog', () => {
  it('is empty without fog', () => {
    expect(packLineSceneFog(undefined)).toEqual([]);
    expect(packLineSceneFog({ near: 8, far: 30 })).toEqual([8, 30]);
  });
});
