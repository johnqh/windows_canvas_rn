/**
 * Image sources and pixel data.
 *
 * A recording cannot hold an image object, so an image is written as a
 * string the native view knows how to load — a URI (`file:`, `ms-appx:`,
 * `http(s):`, `data:`, or a plain path), raw RGBA pixels (`rgba;W;H;base64`),
 * or another recording (`picture;` and its JSON), drawn as an image — plus the
 * size `drawImage` needs to place it. Native images load asynchronously; a
 * picture that draws one before it has loaded is drawn again when it has.
 */
import type { Picture } from './format.ts';

export type ImageRef = { source: string; width: number; height: number };

/** An image `drawImage` and `createPattern` accept. */
export type CanvasImageSourceLike =
  /** React Native's resolved asset source, or any URI with its size. */
  | { uri: string; width: number; height: number }
  /** An `HTMLImageElement`-like object. */
  | {
      src: string;
      naturalWidth?: number;
      naturalHeight?: number;
      width?: number;
      height?: number;
    }
  /** `ImageData` or anything shaped like it. */
  | { width: number; height: number; data: ArrayLike<number> }
  /** Another recording: a `PictureRecorder`, or what `finish()` returned. */
  | { finish(): Picture }
  | Picture;

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64, without `btoa`: Hermes does not have one everywhere. */
export function encodeBase64(bytes: ArrayLike<number>): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      ALPHABET[(n >> 18) & 63]! +
      ALPHABET[(n >> 12) & 63]! +
      ALPHABET[(n >> 6) & 63]! +
      ALPHABET[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + '==';
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out +=
      ALPHABET[(n >> 18) & 63]! +
      ALPHABET[(n >> 12) & 63]! +
      ALPHABET[(n >> 6) & 63]! +
      '=';
  }
  return out;
}

/** `rgba;W;H;base64` — straight (not premultiplied) RGBA, as `ImageData` holds it. */
export function pixelSource(
  width: number,
  height: number,
  data: ArrayLike<number>
): string {
  return `rgba;${width};${height};${encodeBase64(data)}`;
}

function isPicture(value: unknown): value is Picture {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as Picture).ops) &&
    Array.isArray((value as Picture).strings)
  );
}

/** What to write for an image, or null for something that is not one. */
export function imageRef(image: unknown): ImageRef | null {
  if (typeof image !== 'object' || image === null) return null;
  const value = image as Record<string, unknown>;
  if (typeof value.finish === 'function') {
    return imageRef((value.finish as () => Picture)());
  }
  if (isPicture(image)) {
    return {
      source: `picture;${JSON.stringify({
        width: image.width,
        height: image.height,
        ops: image.ops,
        strings: image.strings,
      })}`,
      width: image.width,
      height: image.height,
    };
  }
  const width = Number(value.naturalWidth ?? value.width);
  const height = Number(value.naturalHeight ?? value.height);
  if (!(width >= 0) || !(height >= 0)) return null;
  if (typeof value.uri === 'string')
    return { source: value.uri, width, height };
  if (typeof value.src === 'string')
    return { source: value.src, width, height };
  const data = value.data as ArrayLike<number> | undefined;
  if (data && typeof data.length === 'number') {
    if (data.length !== width * height * 4) return null;
    return { source: pixelSource(width, height, data), width, height };
  }
  return null;
}

/** The canvas `ImageData`: straight RGBA, row by row. */
export class ImageData {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
  readonly colorSpace = 'srgb';

  constructor(width: number, height: number);
  constructor(data: Uint8ClampedArray, width: number, height?: number);
  constructor(
    first: number | Uint8ClampedArray,
    second: number,
    third?: number
  ) {
    if (typeof first === 'number') {
      if (!(first > 0) || !(second > 0)) {
        throw rangeError('The source width and height must be positive.');
      }
      this.width = Math.floor(first);
      this.height = Math.floor(second);
      this.data = new Uint8ClampedArray(this.width * this.height * 4);
      return;
    }
    const width = Math.floor(second);
    if (!(width > 0) || first.length % (4 * width) !== 0) {
      throw rangeError('The data length is not a multiple of 4 × width.');
    }
    const height = first.length / (4 * width);
    if (third !== undefined && Math.floor(third) !== height) {
      throw rangeError('The data length does not match width × height.');
    }
    this.width = width;
    this.height = height;
    this.data = first;
  }
}

function rangeError(message: string): Error {
  const error = new Error(message);
  error.name = 'IndexSizeError';
  return error;
}
