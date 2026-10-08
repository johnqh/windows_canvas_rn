import { describe, expect, it, vi } from 'vitest';
import { parseColor } from './color.ts';
import { decodePicture } from './decode.ts';
import type { DecodedOp } from './decode.ts';
import { Composite, Filter, FORMAT_VERSION, Repetition } from './format.ts';
import { ImageData } from './image.ts';
import { approximateMeasurer } from './measure.ts';
import type { TextMeasure } from './measure.ts';
import { Path2D } from './path.ts';
import { PictureRecorder } from './recorder.ts';

const close = (actual: number[], expected: number[]) => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, 6));
};

const ops = (ctx: PictureRecorder) => decodePicture(ctx.finish());
const drawing = (ctx: PictureRecorder) =>
  ops(ctx).filter(op => !op.op.startsWith('Set'));
const only = <K extends DecodedOp['op']>(ctx: PictureRecorder, op: K) =>
  ops(ctx).filter((o): o is Extract<DecodedOp, { op: K }> => o.op === op);

/**
 * Every member of `CanvasRenderingContext2D` in the HTML spec, apart from
 * `canvas`'s element-only members. The recorder must have each.
 */
const CANVAS_2D_MEMBERS = [
  // CanvasState
  'save',
  'restore',
  'reset',
  'isContextLost',
  // CanvasTransform
  'scale',
  'rotate',
  'translate',
  'transform',
  'getTransform',
  'setTransform',
  'resetTransform',
  // CanvasCompositing
  'globalAlpha',
  'globalCompositeOperation',
  // CanvasImageSmoothing
  'imageSmoothingEnabled',
  'imageSmoothingQuality',
  // CanvasFillStrokeStyles
  'strokeStyle',
  'fillStyle',
  'createLinearGradient',
  'createRadialGradient',
  'createConicGradient',
  'createPattern',
  // CanvasShadowStyles
  'shadowOffsetX',
  'shadowOffsetY',
  'shadowBlur',
  'shadowColor',
  // CanvasFilters
  'filter',
  // CanvasRect
  'clearRect',
  'fillRect',
  'strokeRect',
  // CanvasDrawPath
  'beginPath',
  'fill',
  'stroke',
  'clip',
  'isPointInPath',
  'isPointInStroke',
  // CanvasUserInterface
  'drawFocusIfNeeded',
  'scrollPathIntoView',
  // CanvasText
  'fillText',
  'strokeText',
  'measureText',
  // CanvasDrawImage
  'drawImage',
  // CanvasImageData
  'createImageData',
  'getImageData',
  'putImageData',
  // CanvasPathDrawingStyles
  'lineWidth',
  'lineCap',
  'lineJoin',
  'miterLimit',
  'setLineDash',
  'getLineDash',
  'lineDashOffset',
  // CanvasTextDrawingStyles
  'font',
  'textAlign',
  'textBaseline',
  'direction',
  'letterSpacing',
  'fontKerning',
  'fontStretch',
  'fontVariantCaps',
  'textRendering',
  'wordSpacing',
  // CanvasPath
  'closePath',
  'moveTo',
  'lineTo',
  'quadraticCurveTo',
  'bezierCurveTo',
  'arcTo',
  'rect',
  'roundRect',
  'arc',
  'ellipse',
  // CanvasRenderingContext2D
  'canvas',
  'getContextAttributes',
];

describe('PictureRecorder', () => {
  it('has every member of CanvasRenderingContext2D', () => {
    const ctx = new PictureRecorder(10, 10);
    const missing = CANVAS_2D_MEMBERS.filter(name => !(name in ctx));
    expect(missing).toEqual([]);
  });

  it('starts every picture with the format version and reports its size', () => {
    expect(new PictureRecorder(300, 200).finish()).toEqual({
      width: 300,
      height: 200,
      ops: [FORMAT_VERSION],
      strings: [],
    });
  });

  describe('state', () => {
    it('restores state on restore, and pops the clips pushed since the save', () => {
      const ctx = new PictureRecorder(100, 100);
      ctx.fillStyle = 'red';
      ctx.save();
      ctx.fillStyle = 'blue';
      ctx.translate(10, 10);
      ctx.beginPath();
      ctx.rect(0, 0, 5, 5);
      ctx.clip();
      ctx.clip('evenodd');
      ctx.restore();
      expect(ctx.fillStyle).toBe('#ff0000');
      expect(ctx.getTransform()).toEqual({
        a: 1,
        b: 0,
        c: 0,
        d: 1,
        e: 0,
        f: 0,
      });
      ctx.restore(); // unbalanced: ignored
      const all = ops(ctx);
      expect(all.map(op => op.op)).toEqual(['Clip', 'Clip', 'PopClip']);
      expect(all[1]).toMatchObject({ rule: 1 });
      expect(all[2]).toEqual({ op: 'PopClip', count: 2 });
    });

    it('ignores what a canvas ignores', () => {
      const ctx = new PictureRecorder(100, 100);
      ctx.lineWidth = -1;
      ctx.lineWidth = Number.NaN;
      ctx.globalAlpha = 2;
      ctx.setLineDash([1, -1]);
      ctx.lineCap = 'nonsense';
      ctx.fillStyle = 'not a colour';
      ctx.font = 'nonsense';
      ctx.filter = 'wobble(2)';
      ctx.globalCompositeOperation = 'nonsense';
      ctx.textAlign = 'middle';
      ctx.letterSpacing = 'wide';
      expect(ctx.lineWidth).toBe(1);
      expect(ctx.globalAlpha).toBe(1);
      expect(ctx.getLineDash()).toEqual([]);
      expect(ctx.lineCap).toBe('butt');
      expect(ctx.fillStyle).toBe('#000000');
      expect(ctx.font).toBe('10px sans-serif');
      expect(ctx.filter).toBe('none');
      expect(ctx.globalCompositeOperation).toBe('source-over');
      expect(ctx.textAlign).toBe('start');
      expect(ctx.letterSpacing).toBe('0px');
      ctx.beginPath();
      ctx.moveTo(Number.NaN, 0);
      ctx.fill(); // empty path: nothing
      ctx.fillRect(0, 0, 0, 10); // empty rect: nothing
      ctx.fillText('', 0, 0);
      ctx.fillText('x', 0, 0, 0); // maxWidth 0: nothing
      expect(drawing(ctx)).toEqual([]);
    });

    it('resets to a blank canvas', () => {
      const ctx = new PictureRecorder(10, 10);
      ctx.fillStyle = 'red';
      ctx.fillRect(0, 0, 1, 1);
      ctx.reset();
      expect(ctx.fillStyle).toBe('#000000');
      expect(ctx.finish().ops).toEqual([FORMAT_VERSION]);
    });

    it('answers the context questions a canvas answers', () => {
      const ctx = new PictureRecorder(10, 10);
      expect(ctx.isContextLost()).toBe(false);
      expect(ctx.getContextAttributes()).toMatchObject({
        alpha: true,
        colorSpace: 'srgb',
      });
      expect(ctx.canvas).toEqual({ width: 10, height: 10 });
      expect(() => ctx.drawFocusIfNeeded()).not.toThrow();
      expect(() => ctx.scrollPathIntoView()).not.toThrow();
    });
  });

  describe('transforms', () => {
    it('records fill points already transformed', () => {
      const ctx = new PictureRecorder(100, 100);
      ctx.translate(10, 20);
      ctx.scale(2, 2);
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(1, 1, 5, 5);
      const [fill] = only(ctx, 'Fill');
      expect(fill!.paint).toEqual({
        kind: 'Solid',
        alpha: 1,
        color: parseColor('#ff0000'),
      });
      close(fill!.path[0]!.points, [12, 22]);
      close(fill!.path[2]!.points, [22, 32]);
    });

    it('takes setTransform as six numbers or a matrix, and composes rotate', () => {
      const ctx = new PictureRecorder(10, 10);
      ctx.setTransform({ a: 2, d: 3, e: 4, f: 5 });
      expect(ctx.getTransform()).toEqual({
        a: 2,
        b: 0,
        c: 0,
        d: 3,
        e: 4,
        f: 5,
      });
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.rotate(Math.PI / 2);
      const m = ctx.getTransform();
      close([m.a, m.b, m.c, m.d], [0, 1, -1, 0]);
      ctx.resetTransform();
      expect(ctx.getTransform()).toEqual({
        a: 1,
        b: 0,
        c: 0,
        d: 1,
        e: 0,
        f: 0,
      });
    });
  });

  describe('strokes', () => {
    it('records a stroke in its own space with its transform, so the pen scales exactly', () => {
      const ctx = new PictureRecorder(100, 100);
      ctx.scale(2, 1); // non-uniform: the pen is an ellipse in device space
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'bevel';
      ctx.setLineDash([1, 2, 3]);
      ctx.lineDashOffset = 1;
      ctx.beginPath();
      ctx.moveTo(1, 1);
      ctx.lineTo(5, 1);
      ctx.stroke();
      const [stroke] = only(ctx, 'Stroke');
      expect(stroke!.stroke).toEqual({
        width: 3,
        cap: 1,
        join: 2,
        miterLimit: 10,
        dashes: [1, 2, 3, 1, 2, 3],
        dashOffset: 1,
      });
      expect(stroke!.matrix).toEqual([2, 0, 0, 1, 0, 0]);
      close(stroke!.path[1]!.points, [5, 1]);
    });

    it('strokes a path built under one transform with the pen of another, as a canvas does', () => {
      const ctx = new PictureRecorder(100, 100);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(10, 0);
      ctx.scale(4, 4);
      ctx.stroke();
      const [stroke] = only(ctx, 'Stroke');
      // The device path (0,0)–(10,0) mapped back into the stroke's space.
      close(stroke!.path[1]!.points, [2.5, 0]);
      expect(stroke!.matrix).toEqual([4, 0, 0, 4, 0, 0]);
    });

    it('draws nothing for a stroke under a singular transform', () => {
      const ctx = new PictureRecorder(10, 10);
      ctx.beginPath();
      ctx.rect(0, 0, 5, 5);
      ctx.scale(0, 1);
      ctx.stroke();
      expect(drawing(ctx)).toEqual([]);
    });

    it('strokes a zero-height rect as a line, and nothing for zero by zero', () => {
      const ctx = new PictureRecorder(10, 10);
      ctx.strokeRect(0, 0, 10, 0);
      ctx.strokeRect(0, 0, 0, 0);
      expect(only(ctx, 'Stroke')).toHaveLength(1);
    });
  });

  describe('paints', () => {
    it('folds global alpha into a colour', () => {
      const ctx = new PictureRecorder(100, 100);
      ctx.fillStyle = 'rgba(255, 0, 0, 0.5)';
      ctx.globalAlpha = 0.5;
      ctx.fillRect(0, 0, 1, 1);
      const [fill] = only(ctx, 'Fill');
      expect((fill!.paint as { color: number }).color % 0x100).toBe(64);
    });

    it('records gradients with their stops when they are used, and the transform then', () => {
      const ctx = new PictureRecorder(100, 100);
      const gradient = ctx.createLinearGradient(0, 0, 10, 0);
      gradient.addColorStop(1, 'blue');
      ctx.fillStyle = gradient;
      gradient.addColorStop(0, 'red'); // after assignment: still counts
      ctx.translate(5, 0);
      ctx.globalAlpha = 0.5;
      ctx.fillRect(0, 0, 10, 10);
      const [fill] = only(ctx, 'Fill');
      expect(fill!.paint).toEqual({
        kind: 'Linear',
        alpha: 0.5,
        geometry: [0, 0, 10, 0],
        matrix: [1, 0, 0, 1, 5, 0],
        stops: [
          [0, parseColor('red')],
          [1, parseColor('blue')],
        ],
      });
      expect(ctx.fillStyle).toBe(gradient);
    });

    it('records radial and conic gradients', () => {
      const ctx = new PictureRecorder(100, 100);
      const radial = ctx.createRadialGradient(1, 2, 3, 4, 5, 6);
      radial.addColorStop(0, 'white');
      ctx.fillStyle = radial;
      ctx.fillRect(0, 0, 1, 1);
      const conic = ctx.createConicGradient(Math.PI, 50, 50);
      conic.addColorStop(0.5, 'black');
      ctx.fillStyle = conic;
      ctx.fillRect(0, 0, 1, 1);
      const [first, second] = only(ctx, 'Fill');
      expect(first!.paint).toMatchObject({
        kind: 'Radial',
        geometry: [1, 2, 3, 4, 5, 6],
      });
      expect(second!.paint).toMatchObject({
        kind: 'Conic',
        geometry: [Math.PI, 50, 50],
      });
    });

    it('draws nothing with a gradient that has no stops or no extent', () => {
      const ctx = new PictureRecorder(10, 10);
      ctx.fillStyle = ctx.createLinearGradient(0, 0, 10, 0);
      ctx.fillRect(0, 0, 1, 1);
      const flat = ctx.createLinearGradient(5, 5, 5, 5);
      flat.addColorStop(0, 'red');
      ctx.fillStyle = flat;
      ctx.fillRect(0, 0, 1, 1);
      expect(drawing(ctx)).toEqual([]);
    });

    it('throws where a canvas throws on gradients', () => {
      const ctx = new PictureRecorder(10, 10);
      const gradient = ctx.createLinearGradient(0, 0, 1, 1);
      expect(() => gradient.addColorStop(1.5, 'red')).toThrow(/outside/);
      expect(() => gradient.addColorStop(0.5, 'nope')).toThrow(/parsed/);
      expect(() => ctx.createRadialGradient(0, 0, -1, 0, 0, 1)).toThrow(
        /negative/
      );
      expect(() => ctx.createLinearGradient(0, 0, NaN, 1)).toThrow(TypeError);
    });

    it('records patterns with their image, repetition and transform', () => {
      const ctx = new PictureRecorder(100, 100);
      const image = {
        uri: 'https://example.com/tile.png',
        width: 8,
        height: 4,
      };
      const pattern = ctx.createPattern(image, 'repeat-x')!;
      pattern.setTransform({ a: 2, d: 2 });
      ctx.fillStyle = pattern;
      ctx.translate(10, 0);
      ctx.fillRect(0, 0, 50, 50);
      const [fill] = only(ctx, 'Fill');
      expect(fill!.paint).toEqual({
        kind: 'Pattern',
        alpha: 1,
        image: 'https://example.com/tile.png',
        repetition: Repetition.RepeatX,
        imageWidth: 8,
        imageHeight: 4,
        matrix: [2, 0, 0, 2, 10, 0],
      });
      expect(() => ctx.createPattern(image, 'diagonal')).toThrow(/repetition/);
      expect(
        ctx.createPattern({ uri: 'x', width: 0, height: 0 }, null)
      ).toBeNull();
    });
  });

  describe('compositing, shadows, filters and smoothing', () => {
    it('writes each state op when it changes, and only then', () => {
      const ctx = new PictureRecorder(100, 100);
      ctx.fillRect(0, 0, 1, 1);
      ctx.globalCompositeOperation = 'multiply';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
      ctx.shadowBlur = 4;
      ctx.shadowOffsetX = 2;
      ctx.filter = 'blur(3px) drop-shadow(1px 2px red)';
      ctx.imageSmoothingEnabled = false;
      ctx.fillRect(0, 0, 1, 1);
      ctx.fillRect(0, 0, 1, 1);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillRect(0, 0, 1, 1);
      expect(ops(ctx).map(op => op.op)).toEqual([
        'Fill',
        'SetComposite',
        'SetShadow',
        'SetFilter',
        'SetSmoothing',
        'Fill',
        'Fill',
        'SetComposite',
        'Fill',
      ]);
      const all = ops(ctx);
      expect(all[1]).toEqual({
        op: 'SetComposite',
        composite: Composite.Multiply,
      });
      expect(all[2]).toEqual({
        op: 'SetShadow',
        color: parseColor('rgba(0, 0, 0, 0.5)'),
        blur: 4,
        offsetX: 2,
        offsetY: 0,
      });
      expect(all[3]).toEqual({
        op: 'SetFilter',
        primitives: [
          [Filter.Blur, 3],
          [Filter.DropShadow, 1, 2, 0, parseColor('red')],
        ],
      });
      expect(all[4]).toEqual({
        op: 'SetSmoothing',
        enabled: false,
        quality: 0,
      });
    });

    it('writes no shadow that would not show', () => {
      const ctx = new PictureRecorder(10, 10);
      ctx.shadowBlur = 10; // transparent shadow colour by default
      ctx.fillRect(0, 0, 1, 1);
      ctx.shadowColor = 'black'; // visible now
      ctx.shadowBlur = 0; // …but with nothing to offset or blur
      ctx.fillRect(0, 0, 1, 1);
      expect(only(ctx, 'SetShadow')).toEqual([]);
    });

    it('reads every composite operation', () => {
      const ctx = new PictureRecorder(10, 10);
      for (const name of [
        'source-in',
        'source-out',
        'source-atop',
        'destination-over',
        'destination-in',
        'destination-out',
        'destination-atop',
        'lighter',
        'copy',
        'xor',
        'multiply',
        'screen',
        'overlay',
        'darken',
        'lighten',
        'color-dodge',
        'color-burn',
        'hard-light',
        'soft-light',
        'difference',
        'exclusion',
        'hue',
        'saturation',
        'color',
        'luminosity',
      ]) {
        ctx.globalCompositeOperation = name;
        expect(ctx.globalCompositeOperation).toBe(name);
        ctx.fillRect(0, 0, 1, 1);
      }
      expect(only(ctx, 'SetComposite').map(op => op.composite)).toEqual(
        Array.from({ length: 25 }, (_, i) => i + 1)
      );
    });
  });

  describe('clearing', () => {
    it('clears the exact transformed rectangle, not its bounding box', () => {
      const ctx = new PictureRecorder(100, 100);
      ctx.translate(50, 50);
      ctx.rotate(Math.PI / 4);
      ctx.clearRect(0, 0, 10, 10);
      const [clear] = only(ctx, 'Clear');
      expect(clear!.path.map(s => s.kind)).toEqual([
        'Move',
        'Line',
        'Line',
        'Line',
        'Close',
      ]);
      close(clear!.path[1]!.points, [
        50 + 10 * Math.SQRT1_2,
        50 + 10 * Math.SQRT1_2,
      ]);
    });
  });

  describe('Path2D', () => {
    it('fills, strokes, clips and hit-tests a Path2D under the current transform', () => {
      const ctx = new PictureRecorder(100, 100);
      const path = new Path2D('M0 0 h10 v10 h-10 Z');
      ctx.translate(20, 0);
      ctx.fill(path, 'evenodd');
      ctx.stroke(path);
      ctx.clip(path);
      const all = ops(ctx);
      expect(all.map(op => op.op)).toEqual(['Fill', 'Stroke', 'Clip']);
      expect((all[0] as { rule: number }).rule).toBe(1);
      close(
        (all[0] as { path: { points: number[] }[] }).path[1]!.points,
        [30, 0]
      );
      expect(ctx.isPointInPath(path, 25, 5)).toBe(true);
      expect(ctx.isPointInPath(path, 5, 5)).toBe(false);
      expect(ctx.isPointInStroke(path, 20, 5)).toBe(true);
      // The current path is untouched by a Path2D.
      expect(ctx.isPointInPath(25, 5)).toBe(false);
    });

    it('hit-tests the current path in device space and the stroke in its own', () => {
      const ctx = new PictureRecorder(100, 100);
      ctx.scale(2, 2);
      ctx.beginPath();
      ctx.rect(0, 0, 10, 10);
      expect(ctx.isPointInPath(15, 15)).toBe(true);
      expect(ctx.isPointInPath(25, 15)).toBe(false);
      ctx.lineWidth = 2; // 4 device px wide
      expect(ctx.isPointInStroke(21.5, 10)).toBe(true);
      expect(ctx.isPointInStroke(22.5, 10)).toBe(false);
    });
  });

  describe('text', () => {
    const metrics: TextMeasure = {
      width: 40,
      inkLeft: -1,
      inkRight: 41,
      inkAscent: 9,
      inkDescent: 3,
      fontAscent: 11,
      fontDescent: 4,
      emAscent: 8,
      emDescent: 2,
      hanging: 6,
    };
    const fixed = () => metrics;

    it('records text with its transform, font and the start of its baseline', () => {
      const ctx = new PictureRecorder(100, 100, { measureText: fixed });
      ctx.translate(5, 6);
      ctx.font = 'italic bold 17px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#123456';
      ctx.fillText('Piano', 10, 20);
      ctx.fillText('Piano', 30, 20);
      const [text] = only(ctx, 'Text');
      expect(text).toEqual({
        op: 'Text',
        mode: 0,
        paint: { kind: 'Solid', alpha: 1, color: parseColor('#123456') },
        stroke: null,
        text: 'Piano',
        family: 'Segoe UI',
        size: 17,
        weight: 700,
        style: 1,
        stretch: 5,
        rtl: false,
        letterSpacing: 0,
        wordSpacing: 0,
        kerning: 0,
        variantCaps: 0,
        rendering: 0,
        matrix: [1, 0, 0, 1, 5, 6],
        // Centred: half the width left of 10. Middle: (8 - 2) / 2 below 20.
        x: -10,
        y: 23,
      });
      expect(ctx.finish().strings).toEqual(['Piano', 'Segoe UI']);
    });

    it('anchors every textBaseline and textAlign as a canvas does', () => {
      const ctx = new PictureRecorder(100, 100, { measureText: fixed });
      const anchor = (align: string, baseline: string, direction = 'ltr') => {
        ctx.reset();
        ctx.textAlign = align;
        ctx.textBaseline = baseline;
        ctx.direction = direction;
        ctx.fillText('x', 100, 100);
        const [text] = only(ctx, 'Text');
        return [text!.x, text!.y];
      };
      expect(anchor('left', 'alphabetic')).toEqual([100, 100]);
      expect(anchor('right', 'top')).toEqual([60, 108]);
      expect(anchor('end', 'hanging')).toEqual([60, 106]);
      expect(anchor('start', 'bottom', 'rtl')).toEqual([60, 98]);
      expect(anchor('end', 'ideographic', 'rtl')).toEqual([100, 98]);
    });

    it('records strokeText with its pen, and the text properties', () => {
      const ctx = new PictureRecorder(100, 100, { measureText: fixed });
      ctx.font = 'small-caps 10px serif';
      ctx.fontStretch = 'expanded';
      ctx.letterSpacing = '0.2em';
      ctx.wordSpacing = '3px';
      ctx.fontKerning = 'none';
      ctx.textRendering = 'geometricPrecision';
      ctx.direction = 'rtl';
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'red';
      ctx.strokeText('a b', 0, 0);
      const [text] = only(ctx, 'Text');
      expect(text).toMatchObject({
        mode: 1,
        paint: { kind: 'Solid', color: parseColor('red') },
        stroke: { width: 2 },
        family: 'Times New Roman',
        stretch: 7,
        rtl: true,
        letterSpacing: 2,
        wordSpacing: 3,
        kerning: 2,
        variantCaps: 1,
        rendering: 3,
      });
      expect(ctx.fontVariantCaps).toBe('small-caps');
    });

    it('squeezes text wider than maxWidth about its anchor', () => {
      const ctx = new PictureRecorder(100, 100, {
        measureText: () => ({ ...metrics, width: 100 }),
      });
      ctx.fillText('wide', 10, 0, 50);
      const [text] = only(ctx, 'Text');
      // x' = 0.5·x + 5: the anchor at x = 10 stays at 10.
      expect(text!.matrix).toEqual([0.5, 0, 0, 1, 5, 0]);
    });

    it('replaces ASCII whitespace with spaces, as the spec does', () => {
      const ctx = new PictureRecorder(100, 100, { measureText: fixed });
      ctx.fillText('a\tb\nc', 0, 0);
      expect(only(ctx, 'Text')[0]!.text).toBe('a b c');
    });

    it('builds TextMetrics relative to textAlign and textBaseline', () => {
      const ctx = new PictureRecorder(100, 100, { measureText: fixed });
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      expect(ctx.measureText('x')).toEqual({
        width: 40,
        actualBoundingBoxLeft: 21,
        actualBoundingBoxRight: 21,
        actualBoundingBoxAscent: 1,
        actualBoundingBoxDescent: 11,
        fontBoundingBoxAscent: 3,
        fontBoundingBoxDescent: 12,
        emHeightAscent: 0,
        emHeightDescent: 10,
        hangingBaseline: -2,
        alphabeticBaseline: -8,
        ideographicBaseline: -10,
      });
    });

    it('passes the font and text properties to the measurer', () => {
      const seen = vi.fn(approximateMeasurer);
      const ctx = new PictureRecorder(100, 100, { measureText: seen });
      ctx.font = '12px serif';
      ctx.letterSpacing = '1px';
      ctx.measureText('abc');
      expect(seen).toHaveBeenCalledWith(
        expect.objectContaining({ family: 'Times New Roman', size: 12 }),
        'abc',
        expect.objectContaining({ letterSpacing: 1 })
      );
    });
  });

  describe('images', () => {
    const image = { uri: 'file:///C:/art.png', width: 100, height: 50 };

    it('draws an image in each of the three forms', () => {
      const ctx = new PictureRecorder(100, 100);
      ctx.drawImage(image, 1, 2);
      ctx.drawImage(image, 1, 2, 30, 40);
      ctx.drawImage(image, 10, 10, 20, 20, 0, 0, 40, 40);
      const all = only(ctx, 'Image');
      expect(all.map(op => [op.source, op.destination])).toEqual([
        [
          [0, 0, 100, 50],
          [1, 2, 100, 50],
        ],
        [
          [0, 0, 100, 50],
          [1, 2, 30, 40],
        ],
        [
          [10, 10, 20, 20],
          [0, 0, 40, 40],
        ],
      ]);
      expect(all[0]).toMatchObject({
        image: 'file:///C:/art.png',
        imageWidth: 100,
        imageHeight: 50,
      });
    });

    it('flips negative sizes and clips the source to the image, the destination in proportion', () => {
      const ctx = new PictureRecorder(100, 100);
      ctx.drawImage(image, 90, -10, 20, 20, 0, 0, 40, 40);
      const [drawn] = only(ctx, 'Image');
      expect(drawn!.source).toEqual([90, 0, 10, 10]);
      expect(drawn!.destination).toEqual([0, 20, 20, 20]);
      ctx.drawImage(image, 50, 50, -10, -10);
      expect(only(ctx, 'Image')[1]!.destination).toEqual([40, 40, 10, 10]);
    });

    it('draws another recording as an image', () => {
      const inner = new PictureRecorder(20, 10);
      inner.fillRect(0, 0, 5, 5);
      const ctx = new PictureRecorder(100, 100);
      ctx.drawImage(inner, 0, 0);
      const [drawn] = only(ctx, 'Image');
      expect(drawn!.image.startsWith('picture;')).toBe(true);
      expect(JSON.parse(drawn!.image.slice(8))).toMatchObject({
        width: 20,
        height: 10,
      });
    });

    it('throws for something that is not an image, as a canvas does', () => {
      const ctx = new PictureRecorder(10, 10);
      expect(() => ctx.drawImage({} as never, 0, 0)).toThrow(TypeError);
    });

    it('puts raw pixels, clipped to the dirty rectangle', () => {
      const ctx = new PictureRecorder(10, 10);
      const data = ctx.createImageData(2, 1);
      data.data.set([255, 0, 0, 255, 0, 0, 255, 128]);
      ctx.putImageData(data, 3, 4);
      ctx.putImageData(data, 0, 0, 1, 0, 5, 5);
      const all = only(ctx, 'PutImage');
      expect(all[0]).toEqual({
        op: 'PutImage',
        image: 'rgba;2;1;/wAA/wAA/4A=',
        dx: 3,
        dy: 4,
        dirty: [0, 0, 2, 1],
      });
      expect(all[1]!.dirty).toEqual([1, 0, 1, 1]);
    });

    it('answers getImageData with transparent pixels and says so once', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const ctx = new PictureRecorder(10, 10);
      const data = ctx.getImageData(0, 0, 3, 2);
      ctx.getImageData(0, 0, 1, 1);
      expect(data).toBeInstanceOf(ImageData);
      expect([data.width, data.height]).toEqual([3, 2]);
      expect(data.data.every(byte => byte === 0)).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(() => ctx.getImageData(0, 0, 0, 1)).toThrow(/0/);
      warn.mockRestore();
    });
  });
});
