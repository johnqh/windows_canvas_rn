import { describe, expect, it } from 'vitest';
import {
  parseColor,
  serializeColor,
  tryParseColor,
  withAlpha,
} from './color.ts';

const hex = (value: number | null) =>
  value === null ? null : value.toString(16).padStart(8, '0');

describe('tryParseColor', () => {
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
    ['hsl(120, 100%, 50%)', '00ff00ff'],
    ['hsla(240deg 100% 50% / 0.5)', '0000ff80'],
    ['hsl(0.5turn 100% 50%)', '00ffffff'],
    ['hwb(0 0% 0%)', 'ff0000ff'],
    ['hwb(0 50% 50%)', '808080ff'],
    ['lab(100 0 0)', 'ffffffff'],
    ['lch(0% 0 0)', '000000ff'],
    ['oklab(1 0 0)', 'ffffffff'],
    ['oklch(0.628 0.2577 29.23)', 'ff0000ff'],
    ['color(srgb 1 0 0)', 'ff0000ff'],
    ['color(srgb-linear 1 1 1)', 'ffffffff'],
    ['color(display-p3 1 1 1)', 'ffffffff'],
    ['rebeccapurple', '663399ff'],
    ['White', 'ffffffff'],
    ['transparent', '00000000'],
    ['currentColor', '000000ff'],
  ])('reads %s', (input, expected) => {
    expect(hex(tryParseColor(input))).toBe(expected);
  });

  it('clips a colour outside sRGB', () => {
    expect(hex(tryParseColor('color(display-p3 1 0 0)'))).toBe('ff0000ff');
  });

  it.each([
    'chartreuse-ish',
    '#12345',
    'rgb(1, 2)',
    'hsl(red, 1, 2)',
    'color(xyz 1 2 3)',
    '',
  ])('rejects %j', input => {
    expect(tryParseColor(input)).toBeNull();
  });

  it('rejects a non-string', () => {
    expect(tryParseColor({ gradient: true })).toBeNull();
    expect(parseColor({})).toBe(0x000000ff);
  });

  it('exceeds Int32 without losing precision', () => {
    expect(parseColor('#ffffff')).toBe(0xffffffff);
  });
});

describe('serializeColor', () => {
  it('writes opaque colours as #rrggbb and others as rgba(), as a canvas reads them back', () => {
    expect(serializeColor(parseColor('RED'))).toBe('#ff0000');
    expect(serializeColor(parseColor('rgba(0, 0, 255, 0.5)'))).toBe(
      'rgba(0, 0, 255, 0.502)'
    );
    expect(serializeColor(parseColor('transparent'))).toBe('rgba(0, 0, 0, 0)');
  });
});

describe('withAlpha', () => {
  it('multiplies the alpha byte and leaves the colour alone', () => {
    expect(hex(withAlpha(parseColor('#336699'), 0.5))).toBe('33669980');
    expect(withAlpha(parseColor('#336699'), 1)).toBe(parseColor('#336699'));
    expect(hex(withAlpha(parseColor('#336699'), 0))).toBe('33669900');
  });
});
