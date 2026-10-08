import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FillRule,
  FORMAT_VERSION,
  LineCap,
  LineJoin,
  Op,
  Segment,
  TextAlign,
  TextBaseline,
} from './format.ts';

const header = readFileSync(
  new URL('../windows/PictureFormat.h', import.meta.url),
  'utf8'
);

/** `namespace Name { constexpr int Key = 1; … }` → { Key: 1 } */
function namespaceValues(name: string): Record<string, number> {
  const body = header.match(
    new RegExp(`namespace ${name} \\{([\\s\\S]*?)\\}`)
  )?.[1];
  if (!body) throw new Error(`no namespace ${name} in PictureFormat.h`);
  const values: Record<string, number> = {};
  for (const [, key, value] of body.matchAll(/constexpr int (\w+) = (\d+);/g))
    values[key!] = Number(value);
  return values;
}

describe('the picture format agrees with the native replay', () => {
  it('has the same version', () => {
    expect(header).toContain(`constexpr int kVersion = ${FORMAT_VERSION};`);
  });

  it.each([
    ['Op', Op],
    ['Segment', Segment],
    ['FillRule', FillRule],
    ['LineCap', LineCap],
    ['LineJoin', LineJoin],
    ['TextAlign', TextAlign],
    ['TextBaseline', TextBaseline],
  ] as const)('has the same %s values', (name, values) => {
    expect(namespaceValues(name)).toEqual(values);
  });
});
