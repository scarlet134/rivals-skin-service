// SPDX-License-Identifier: GPL-3.0-or-later
// DDNet 0.6 atlas layout: https://wiki.ddnet.org/wiki/Skin_Creation
// Lighting and grayscale normalization follow DDNet's skin conventions.
import sharp from 'sharp';
sharp.cache({ memory: 24, files: 0, items: 48 });
sharp.concurrency(1);
const MAX_PIXELS = 2048 * 1024;

function color(code) {
  const h = ((code >>> 16) & 255) / 255;
  const s = ((code >>> 8) & 255) / 255;
  const l = 0.5 + (code & 255) / 510;
  const a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map(n => {
    const k = (n + h * 12) % 12;
    return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  });
}

async function recolor(buffer, code, body = false) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const freq = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    const grey = Math.trunc((data[i] + data[i + 1] + data[i + 2]) / 3);
    data[i] = data[i + 1] = data[i + 2] = grey;
    if (data[i + 3] > 128) freq[grey]++;
  }
  let weight = 0;
  for (let i = 1; i < 256; i++) if (freq[i] > freq[weight]) weight = i;
  const rgb = color(code);
  for (let i = 0; i < data.length; i += 4) {
    let g = data[i];
    if (body) g = g <= weight
      ? (weight === 0 ? 0 : Math.trunc(g * 192 / weight))
      : (weight === 255 ? 192 : Math.trunc((g - weight) * 63 / (255 - weight) + 192));
    for (let c = 0; c < 3; c++) data[i + c] = Math.trunc(g * rgb[c] / 255);
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

export async function renderSkin(source, { custom = false, body = 0, feet = 0 } = {}) {
  const meta = await sharp(source, { limitInputPixels: MAX_PIXELS }).metadata();
  if (meta.format !== 'png' || !meta.width || !meta.height || meta.width !== meta.height * 2 || meta.width < 128)
    throw new Error('Expected a DDNet 0.6 PNG skin atlas with aspect ratio 2:1');
  // Fixed intermediate resolution bounds memory/CPU even for very large skin files.
  const atlas = await sharp(source, { limitInputPixels: MAX_PIXELS }).resize(768, 384).ensureAlpha().png().toBuffer();
  const cut = (left, top, width, height) => sharp(atlas).extract({ left, top, width, height }).png().toBuffer();
  let [bodyImg, bodyOutline, foot, footOutline, eyes] = await Promise.all([
    cut(0, 0, 288, 288), cut(288, 0, 288, 288),
    cut(576, 96, 192, 96), cut(576, 192, 192, 96), cut(192, 288, 96, 96),
  ]);
  if (custom) {
    [bodyImg, foot, eyes] = await Promise.all([
      recolor(bodyImg, body, true), recolor(foot, feet), recolor(eyes, body),
    ]);
  }
  [foot, footOutline, eyes] = await Promise.all([
    sharp(foot).resize(288, 144).png().toBuffer(),
    sharp(footOutline).resize(288, 144).png().toBuffer(),
    sharp(eyes).resize(115, 115).png().toBuffer(),
  ]);
  const rightEye = await sharp(eyes).flop().png().toBuffer();
  const layer = (input, left, top) => ({ input, left, top });
  // Facing slightly right, neutral expression. No nickname/map is baked into the image.
  const tee = await sharp({ create: { width: 384, height: 384, channels: 4, background: '#00000000' } })
    .composite([
      layer(bodyOutline, 48, 26),
      layer(footOutline, 17, 179), layer(footOutline, 79, 179),
      layer(foot, 17, 179), layer(bodyImg, 48, 26),
      layer(eyes, 150, 100), layer(rightEye, 190, 100), layer(foot, 79, 179),
    ]).png().toBuffer();
  // Trim invisible atlas margins, then retain 10% breathing room around the actual tee.
  const cropped = await sharp(tee).trim({ threshold: 1 }).png().toBuffer();
  return sharp(cropped).resize(448, 448, { fit: 'contain', background: '#00000000' })
    .extend({ top: 32, bottom: 32, left: 32, right: 32, background: '#00000000' })
    .png({ compressionLevel: 9 }).toBuffer();
}
