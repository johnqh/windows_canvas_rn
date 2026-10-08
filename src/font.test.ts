import { describe, expect, it } from 'vitest';
import { DEFAULT_FONT, parseFont } from './font.ts';

describe('parseFont', () => {
  it('reads the canvas default', () => {
    expect(parseFont('10px sans-serif')).toEqual(DEFAULT_FONT);
  });

  it('reads weight, style and the first family, mapping generics to Windows faces', () => {
    expect(parseFont('bold 17px sans-serif')).toEqual({
      family: 'Segoe UI',
      size: 17,
      weight: 700,
      italic: false,
    });
    expect(parseFont('italic 600 12px "Times New Roman", serif')).toEqual({
      family: 'Times New Roman',
      size: 12,
      weight: 600,
      italic: true,
    });
    expect(parseFont('bold 9px system-ui, sans-serif').family).toBe('Segoe UI');
    expect(parseFont('11px monospace').family).toBe('Consolas');
    expect(parseFont('12px Arial').family).toBe('Arial');
  });

  it('converts units and ignores a line height', () => {
    expect(parseFont('12pt serif').size).toBe(16);
    expect(parseFont('14px/1.5 sans-serif').size).toBe(14);
    expect(parseFont('.5em serif').size).toBe(8);
  });

  it('falls back to the default for something it cannot read', () => {
    expect(parseFont('nonsense')).toEqual(DEFAULT_FONT);
  });
});
