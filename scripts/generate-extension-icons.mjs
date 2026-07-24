import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const sizes = [16, 32, 48, 128];
const output = resolve("apps/extension/static/icons");
mkdirSync(output, { recursive: true });

for (const size of sizes) {
  const scale = 4;
  const canvasSize = size * scale;
  const pixels = new Uint8Array(canvasSize * canvasSize * 4);
  const center = (canvasSize - 1) / 2;
  const radius = canvasSize * 0.44;

  for (let y = 0; y < canvasSize; y += 1) {
    for (let x = 0; x < canvasSize; x += 1) {
      const dx = x - center;
      const dy = y - center;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const index = (y * canvasSize + x) * 4;
      const edge = Math.max(0, Math.min(1, radius - distance + 1));
      if (edge <= 0) continue;

      const diagonal = Math.max(0, Math.min(1, (x + y) / (canvasSize * 1.45)));
      const r = Math.round(42 + 198 * diagonal);
      const g = Math.round(184 - 105 * diagonal);
      const b = Math.round(255 - 8 * diagonal);
      const highlight = Math.max(0, 1 - Math.sqrt((x - canvasSize * 0.34) ** 2 + (y - canvasSize * 0.25) ** 2) / (canvasSize * 0.42));
      pixels[index] = Math.min(255, r + Math.round(highlight * 55));
      pixels[index + 1] = Math.min(255, g + Math.round(highlight * 48));
      pixels[index + 2] = Math.min(255, b + Math.round(highlight * 18));
      pixels[index + 3] = Math.round(edge * 255);
    }
  }

  drawN(pixels, canvasSize, scale);
  const downsampled = downsample(pixels, canvasSize, size, scale);
  writeFileSync(resolve(output, `icon-${size}.png`), encodePng(size, size, downsampled));
}

function drawN(pixels, size, scale) {
  const left = Math.round(size * 0.31);
  const right = Math.round(size * 0.69);
  const top = Math.round(size * 0.27);
  const bottom = Math.round(size * 0.73);
  const thickness = Math.max(scale * 2.3, size * 0.075);
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left - thickness; x <= right + thickness; x += 1) {
      const onLeft = Math.abs(x - left) <= thickness;
      const onRight = Math.abs(x - right) <= thickness;
      const progress = (y - top) / Math.max(1, bottom - top);
      const diagonalX = left + progress * (right - left);
      const onDiagonal = Math.abs(x - diagonalX) <= thickness * 0.9;
      if (!onLeft && !onRight && !onDiagonal) continue;
      const index = (y * size + x) * 4;
      if (index < 0 || index + 3 >= pixels.length) continue;
      pixels[index] = 250;
      pixels[index + 1] = 253;
      pixels[index + 2] = 255;
      pixels[index + 3] = Math.max(pixels[index + 3], 245);
    }
  }
}

function downsample(source, sourceSize, targetSize, scale) {
  const target = new Uint8Array(targetSize * targetSize * 4);
  const samples = scale * scale;
  for (let y = 0; y < targetSize; y += 1) {
    for (let x = 0; x < targetSize; x += 1) {
      const totals = [0, 0, 0, 0];
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const sourceIndex = (((y * scale + sy) * sourceSize) + (x * scale + sx)) * 4;
          for (let channel = 0; channel < 4; channel += 1) totals[channel] += source[sourceIndex + channel];
        }
      }
      const targetIndex = (y * targetSize + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) target[targetIndex + channel] = Math.round(totals[channel] / samples);
    }
  }
  return target;
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    rows[rowStart] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(rows, rowStart + 1);
  }
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBuffer.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return result;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
