// Runs inside a Web Worker. Takes one image file plus settings,
// returns the compressed bytes. Nothing here touches the network.

import decodePng from '@jsquash/png/decode.js';
import encodeJpeg from '@jsquash/jpeg/encode.js';
import encodeWebp from '@jsquash/webp/encode.js';
import optimisePng from '@jsquash/oxipng/optimise.js';
import resize from '@jsquash/resize';
import initQuant, {
  ImageQuantizer,
  encode_palette_to_png,
} from 'libimagequant-wasm/wasm/libimagequant_wasm.js';
import quantWasmUrl from 'libimagequant-wasm/wasm/libimagequant_wasm_bg.wasm?url';

// One place to tune how hard each format is squeezed.
const TUNING = {
  jpg: { lossy: 80, lossless: 92 },
  webp: { lossy: 80, method: 6, losslessMethod: 4 },
  png: { level: 2, maxColours: 256, minQuality: 40, targetQuality: 90 },
};

const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

self.onmessage = async ({ data }) => {
  const { id, run, file, settings } = data;
  try {
    const result = await compress(file, settings);
    self.postMessage({ id, run, ok: true, ...result }, [result.buffer]);
  } catch (err) {
    self.postMessage({ id, run, ok: false, error: err?.message || String(err) });
  }
};

async function compress(file, settings) {
  const source = await sniff(file);
  if (source === 'svg') throw new Error("SVG is already a vector, so there's nothing to compress.");

  const format = outputFormat(source, settings.format);
  const image = await decode(file, source);
  const srcWidth = image.width;
  const srcHeight = image.height;

  const target = targetSize(srcWidth, srcHeight, settings);
  const working = target
    ? await resize(image, { ...target, method: 'lanczos3', premultiply: true, linearRGB: true })
    : image;

  let bytes;
  if (format === 'png' && source === 'png' && settings.mode === 'lossless' && !target) {
    // Truly lossless: optimise the original file rather than re-encoding pixels.
    bytes = await optimisePng(await file.arrayBuffer(), { level: TUNING.png.level, optimiseAlpha: true });
  } else {
    bytes = await encode(working, format, settings.mode);
  }

  // If nothing changed shape or format and the result is no smaller, keep the original.
  const kept = format === source && !target && bytes.byteLength >= file.size;
  const buffer = kept ? await file.arrayBuffer() : toArrayBuffer(bytes);
  const thumb = await thumbnail(working);

  return {
    buffer,
    thumb,
    ext: format,
    mime: MIME[format],
    width: working.width,
    height: working.height,
    srcWidth,
    srcHeight,
    kept,
  };
}

// ---------- format detection ----------

async function sniff(file) {
  const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const ascii = (start, end) => String.fromCharCode(...head.slice(start, end));

  if (head[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(0, 4) === 'GIF8') return 'gif';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand.startsWith('avi')) return 'avif';
    return 'heic';
  }
  if (ascii(0, 2) === 'BM') return 'bmp';
  if (ascii(0, 32).trimStart().startsWith('<')) return 'svg';
  return 'other';
}

function outputFormat(source, choice) {
  if (choice !== 'original') return choice;
  if (source === 'png' || source === 'jpg' || source === 'webp') return source;
  // Formats we can read but not write: photos go to JPG, everything else to PNG.
  return source === 'avif' || source === 'heic' ? 'jpg' : 'png';
}

// ---------- decode ----------

async function decode(file, source) {
  if (source === 'png') {
    try {
      return await decodePng(await file.arrayBuffer());
    } catch {
      // Fall through to the browser decoder.
    }
  }

  let bitmap;
  try {
    // from-image applies the EXIF rotation, so phone photos come out the right way up.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image', premultiplyAlpha: 'none' });
  } catch {
    if (source === 'heic') throw new Error("This browser can't read HEIC. Open this page in Safari, or convert them first.");
    if (source === 'other') throw new Error("This doesn't look like an image this browser can read.");
    throw new Error(`This ${source.toUpperCase()} looks damaged or incomplete, so it couldn't be read.`);
  }

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

// ---------- resize ----------

function targetSize(width, height, settings) {
  const max = Math.floor(Number(settings.maxWidth));
  if (!max || max < 1) return null;
  const measured = settings.longEdge ? Math.max(width, height) : width;
  if (measured <= max) return null; // never enlarge
  const scale = max / measured;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

// ---------- encode ----------

async function encode(image, format, mode) {
  if (format === 'jpg') {
    flattenOnWhite(image);
    return encodeJpeg(image, { quality: TUNING.jpg[mode] });
  }

  if (format === 'webp') {
    return mode === 'lossy'
      ? encodeWebp(image, { quality: TUNING.webp.lossy, method: TUNING.webp.method })
      : encodeWebp(image, { lossless: 1, quality: 75, method: TUNING.webp.losslessMethod });
  }

  // PNG
  if (mode === 'lossy') {
    const indexed = await quantise(image);
    if (indexed) return optimisePng(indexed, { level: TUNING.png.level, optimiseAlpha: true });
    // Quantising wasn't possible within the quality floor, so fall back to lossless.
  }
  return optimisePng(image, { level: TUNING.png.level, optimiseAlpha: true });
}

// JPG has no transparency, so blend any see-through pixels onto white.
function flattenOnWhite(image) {
  const d = image.data;
  for (let i = 3; i < d.length; i += 4) {
    const a = d[i];
    if (a === 255) continue;
    const k = a / 255;
    d[i - 3] = d[i - 3] * k + 255 * (1 - k);
    d[i - 2] = d[i - 2] * k + 255 * (1 - k);
    d[i - 1] = d[i - 1] * k + 255 * (1 - k);
    d[i] = 255;
  }
}

// Lossy PNG: reduce to a 256 colour palette (the pngquant approach).
let quantReady;
async function quantise(image) {
  quantReady ??= initQuant({ module_or_path: quantWasmUrl });
  await quantReady;

  const { width, height, data } = image;
  const quantizer = new ImageQuantizer();
  try {
    quantizer.setMaxColors(TUNING.png.maxColours);
    quantizer.setQuality(TUNING.png.minQuality, TUNING.png.targetQuality);
    quantizer.setSpeed(4);
    const result = quantizer.quantizeImage(data, width, height);
    try {
      result.setDithering(1.0);
      const indices = result.getPaletteIndices(data, width, height);
      return encode_palette_to_png(indices, result.getPalette(), width, height);
    } finally {
      result.free();
    }
  } catch {
    return null;
  } finally {
    quantizer.free();
  }
}

// A small preview for the list, so the page isn't decoding hundreds of full-size images.
async function thumbnail(image) {
  try {
    const scale = Math.min(1, 96 / Math.min(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const bitmap = await createImageBitmap(image, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    return await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
  } catch {
    return null;
  }
}

function toArrayBuffer(bytes) {
  if (bytes instanceof ArrayBuffer) return bytes;
  // Copy out of WASM memory into a standalone buffer we can transfer.
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
