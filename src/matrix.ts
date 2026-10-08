/** 2D affine transforms, in canvas order: x' = a·x + c·y + e, y' = b·x + d·y + f. */

export type Matrix = {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
};

export const IDENTITY: Readonly<Matrix> = Object.freeze({
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  e: 0,
  f: 0,
});

/** `m · n`: n applied first, then m — `transform()`'s composition. */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

export function applyMatrix(
  m: Matrix,
  x: number,
  y: number
): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

export function invertMatrix(m: Matrix): Matrix | null {
  const det = m.a * m.d - m.b * m.c;
  if (det === 0 || !Number.isFinite(det)) return null;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

export function isFiniteMatrix(m: Matrix): boolean {
  return [m.a, m.b, m.c, m.d, m.e, m.f].every(Number.isFinite);
}

/** A `DOMMatrix2DInit`: `a…f`, or their `m11…m42` aliases. */
export type MatrixInit = Partial<Matrix> & {
  m11?: number;
  m12?: number;
  m21?: number;
  m22?: number;
  m41?: number;
  m42?: number;
};

export function matrixFromInit(init: MatrixInit | undefined): Matrix {
  if (!init) return { ...IDENTITY };
  return {
    a: init.a ?? init.m11 ?? 1,
    b: init.b ?? init.m12 ?? 0,
    c: init.c ?? init.m21 ?? 0,
    d: init.d ?? init.m22 ?? 1,
    e: init.e ?? init.m41 ?? 0,
    f: init.f ?? init.m42 ?? 0,
  };
}

export function matrixValues(
  m: Matrix
): [number, number, number, number, number, number] {
  return [m.a, m.b, m.c, m.d, m.e, m.f];
}
