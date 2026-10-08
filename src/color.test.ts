import { describe, expect, it } from 'vitest';
import { parseColor, withAlpha } from './color.ts';

const hex = (value: number) => value.toString(16).padStart(8, '0');

describe('parseColor', () => {
  it.each([
    ['#000', '000000ff'],
    ['#fff', 'ffffffff'],
    ['#1565c0', '1565c0ff'],
    ['#1565C080', '1565c080'],
    ['#f008', 'ff000088'],
    ['rgb(255, 0, 0)', 'ff0000ff'],
    ['rgba(0, 0, 255, 0.5)', '0000ff80'],
    ['rgb(0 128 0 / 50%)', '00800080'],
    ['rgb(100%, 0%, 0%)', 'ff0000ff'],
    ['white', 'ffffffff'],
    ['transparent', '00000000'],
    ['  Black ', '000000ff'],
  ])('reads %s', (input, expected) => {
    expect(hex(parseColor(input))).toBe(expected);
  });

  it('draws what it cannot read in opaque black', () => {
    expect(hex(parseColor('chartreuse-ish'))).toBe('000000ff');
    expect(hex(parseColor({ gradient: true }))).toBe('000000ff');
    expect(hex(parseColor('#12345'))).toBe('000000ff');
  });

  it('exceeds Int32 without losing precision', () => {
    expect(parseColor('#ffffff')).toBe(0xffffffff);
  });
});

describe('withAlpha', () => {
  it('multiplies the alpha byte and leaves the colour alone', () => {
    expect(hex(withAlpha(parseColor('#336699'), 0.5))).toBe('33669980');
    expect(withAlpha(parseColor('#336699'), 1)).toBe(parseColor('#336699'));
    expect(hex(withAlpha(parseColor('#336699'), 0))).toBe('33669900');
  });
});
