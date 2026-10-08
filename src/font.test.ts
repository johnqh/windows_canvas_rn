import { describe, expect, it } from 'vitest';
import { DEFAULT_FONT, parseFont, tryParseFont } from './font.ts';

describe('tryParseFont', () => {
  it('reads the canvas default', () => {
    expect(tryParseFont('10px sans-serif')).toEqual(DEFAULT_FONT);
  });

  it('reads style, small-caps, weight and stretch in any order', () => {
    expect(tryParseFont('italic small-caps 600 condensed 12px serif')).toEqual({
      family: 'Times New Roman',
      size: 12,
      weight: 600,
      style: 1,
      stretch: 3,
      smallCaps: true,
    });
    expect(tryParseFont('bold oblique 10deg 9px monospace')).toMatchObject({
      weight: 700,
      style: 2,
      family: 'Consolas',
    });
  });

  it('keeps the whole family list, quoted names included, generics resolved', () => {
    expect(tryParseFont('12px "Fira Sans", Arial, sans-serif')?.family).toBe(
      'Fira Sans,Arial,Segoe UI'
    );
    expect(tryParseFont("12px 'Times New Roman'")?.family).toBe(
      'Times New Roman'
    );
  });

  it('converts units, keywords and relative sizes as a canvas does', () => {
    expect(tryParseFont('12pt serif')?.size).toBe(16);
    expect(tryParseFont('1in serif')?.size).toBe(96);
    expect(tryParseFont('2em serif')?.size).toBe(20);
    expect(tryParseFont('150% serif')?.size).toBe(15);
    expect(tryParseFont('1rem serif')?.size).toBe(16);
    expect(tryParseFont('medium serif')?.size).toBe(16);
    expect(tryParseFont('14px/1.5 sans-serif')?.size).toBe(14);
    expect(tryParseFont('14px / 20px sans-serif')?.size).toBe(14);
  });

  it('reads the system font keywords', () => {
    expect(tryParseFont('menu')).toMatchObject({
      family: 'Segoe UI',
      size: 12,
    });
  });

  it.each(['nonsense', '12 serif', '12px', 'bold', '12px "unclosed'])(
    'rejects %j',
    input => {
      expect(tryParseFont(input)).toBeNull();
      expect(parseFont(input)).toEqual(DEFAULT_FONT);
    }
  );
});
