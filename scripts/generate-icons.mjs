import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ICON_SVG = `<svg width="512" height="512" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="64" height="64" rx="16" fill="#2563EB" />
  <path d="M18 24H44M44 24L36 16M44 24L36 32" stroke="#FFFFFF" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" />
  <path d="M46 40H20M20 40L28 32M20 40L28 48" stroke="#FFFFFF" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" />
</svg>
`;

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, {level: 9});
  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function roundedRectSdf(px, py, size, radius) {
  const half = size / 2;
  const cx = Math.abs(px - half) - (half - radius);
  const cy = Math.abs(py - half) - (half - radius);
  const ox = Math.max(cx, 0);
  const oy = Math.max(cy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(cx, cy), 0) - radius;
}

function renderRelayLogoRgba(size, options = {rounded: true, circle: false, transparentBg: false}) {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = size / 64;
  const strokeHalf = (4.5 / 2) * scale;
  const sub = 4; // 4x4 supersampling

  const segments = [
    [18 * scale, 24 * scale, 44 * scale, 24 * scale],
    [44 * scale, 24 * scale, 36 * scale, 16 * scale],
    [44 * scale, 24 * scale, 36 * scale, 32 * scale],
    [46 * scale, 40 * scale, 20 * scale, 40 * scale],
    [20 * scale, 40 * scale, 28 * scale, 32 * scale],
    [20 * scale, 40 * scale, 28 * scale, 48 * scale],
  ];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rAcc = 0;
      let gAcc = 0;
      let bAcc = 0;
      let aAcc = 0;

      for (let sy = 0; sy < sub; sy++) {
        for (let sx = 0; sx < sub; sx++) {
          const px = x + (sx + 0.5) / sub;
          const py = y + (sy + 0.5) / sub;

          let bgAlpha = 1;
          if (!options.transparentBg) {
            if (options.circle) {
              const d = Math.hypot(px - size / 2, py - size / 2) - size / 2;
              bgAlpha = d <= 0 ? 1 : 0;
            } else if (options.rounded) {
              const d = roundedRectSdf(px, py, size, 16 * scale);
              bgAlpha = d <= 0 ? 1 : 0;
            }
          } else {
            bgAlpha = 0;
          }

          let minD = Infinity;
          for (const s of segments) {
            const d = distToSegment(px, py, s[0], s[1], s[2], s[3]);
            if (d < minD) minD = d;
          }
          const fgAlpha = minD <= strokeHalf ? 1 : 0;

          if (options.transparentBg) {
            rAcc += 255 * fgAlpha;
            gAcc += 255 * fgAlpha;
            bAcc += 255 * fgAlpha;
            aAcc += 255 * fgAlpha;
          } else if (bgAlpha > 0) {
            const br = 37;
            const bg = 99;
            const bb = 235;
            rAcc += br * (1 - fgAlpha) + 255 * fgAlpha;
            gAcc += bg * (1 - fgAlpha) + 255 * fgAlpha;
            bAcc += bb * (1 - fgAlpha) + 255 * fgAlpha;
            aAcc += 255;
          }
        }
      }

      const samples = sub * sub;
      const idx = (y * size + x) * 4;
      rgba[idx] = Math.round(rAcc / samples);
      rgba[idx + 1] = Math.round(gAcc / samples);
      rgba[idx + 2] = Math.round(bAcc / samples);
      rgba[idx + 3] = Math.round(aAcc / samples);
    }
  }
  return rgba;
}

function buildIcoFromPngs(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // ICO
  header.writeUInt16LE(count, 4);

  const dirEntries = [];
  let offset = 6 + count * 16;

  for (const {size, png} of entries) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    dirEntries.push(entry);
    offset += png.length;
  }

  return Buffer.concat([header, ...dirEntries, ...entries.map((e) => e.png)]);
}

function writePngFile(filePath, size, options) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  const rgba = renderRelayLogoRgba(size, options);
  const png = encodePng(size, size, rgba);
  fs.writeFileSync(filePath, png);
  return png;
}

// 1. Public web SVG favicon
fs.mkdirSync('public', {recursive: true});
fs.writeFileSync(path.join('public', 'icon.svg'), ICON_SVG);

// 2. Windows / Electron PNG + multi-size ICO
writePngFile(path.join('build', 'icon.png'), 512, {rounded: true, circle: false, transparentBg: false});
const icoSizes = [16, 32, 48, 64, 256];
const icoEntries = icoSizes.map((size) => ({
  size,
  png: encodePng(size, size, renderRelayLogoRgba(size, {rounded: true, circle: false, transparentBg: false})),
}));
fs.writeFileSync(path.join('build', 'icon.ico'), buildIcoFromPngs(icoEntries));

// 3. Android launcher icons if android/ res folder exists
const androidRes = path.join('android', 'app', 'src', 'main', 'res');
if (fs.existsSync(androidRes)) {
  const densities = [
    ['mipmap-mdpi', 48, 108],
    ['mipmap-hdpi', 72, 162],
    ['mipmap-xhdpi', 96, 216],
    ['mipmap-xxhdpi', 144, 324],
    ['mipmap-xxxhdpi', 192, 432],
  ];

  for (const [folder, legacySize, adaptiveSize] of densities) {
    const dir = path.join(androidRes, folder);
    writePngFile(path.join(dir, 'ic_launcher.png'), legacySize, {
      rounded: true,
      circle: false,
      transparentBg: false,
    });
    writePngFile(path.join(dir, 'ic_launcher_round.png'), legacySize, {
      rounded: false,
      circle: true,
      transparentBg: false,
    });
    writePngFile(path.join(dir, 'ic_launcher_foreground.png'), adaptiveSize, {
      rounded: false,
      circle: false,
      transparentBg: true,
    });
  }

  const bgXmlPath = path.join(androidRes, 'values', 'ic_launcher_background.xml');
  if (fs.existsSync(bgXmlPath)) {
    fs.writeFileSync(
      bgXmlPath,
      `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#2563EB</color>\n</resources>\n`,
    );
  }
}

console.log('Generated Relay icons for web, Windows (.ico/.png), and Android.');
