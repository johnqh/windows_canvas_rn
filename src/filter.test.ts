import { describe, expect, it } from 'vitest';
import { parseColor } from './color.ts';
import { Filter } from './format.ts';
import { parseFilter } from './filter.ts';

describe('parseFilter', () => {
  it('reads none as no filter', () => {
    expect(parseFilter('none')).toEqual([]);
  });

  it('reads every CSS filter function, with its default and clamp', () => {
    expect(
      parseFilter(
        'blur(4px) brightness(150%) contrast(2) grayscale() hue-rotate(0.5turn) invert(2) opacity(.5) saturate(3) sepia(50%)'
      )
    ).toEqual([
      Filter.Blur,
      4,
      Filter.Brightness,
      1.5,
      Filter.Contrast,
      2,
      Filter.Grayscale,
      1,
      Filter.HueRotate,
      180,
      Filter.Invert,
      1,
      Filter.Opacity,
      0.5,
      Filter.Saturate,
      3,
      Filter.Sepia,
      0.5,
    ]);
  });

  it('reads drop-shadow with its colour on either side', () => {
    expect(parseFilter('drop-shadow(2px 3px 4px red)')).toEqual([
      Filter.DropShadow,
      2,
      3,
      4,
      parseColor('red'),
    ]);
    expect(parseFilter('drop-shadow(rgb(0 0 255) 1px 1px)')).toEqual([
      Filter.DropShadow,
      1,
      1,
      0,
      parseColor('blue'),
    ]);
  });

  it('draws unfiltered for a url() it has no document to look up', () => {
    expect(parseFilter('url(#shadow) blur(2px)')).toEqual([]);
  });

  it.each([
    'blur(-1px)',
    'brightness(-1)',
    'blur(3)',
    'wobble(2)',
    'drop-shadow(1px)',
    'blur(2px',
  ])('rejects %j', input => {
    expect(parseFilter(input)).toBeNull();
  });
});
