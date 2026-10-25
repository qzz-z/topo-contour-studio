'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function loadPreset(name, dataDir = path.join(__dirname, '..', '..', 'data')) {
  const metaPath = path.join(dataDir, `${name}.json`);
  const binPath = path.join(dataDir, `${name}.bin.gz`);
  if (!fs.existsSync(metaPath) || !fs.existsSync(binPath)) {
    throw new Error(`Preset "${name}" not found in ${dataDir}`);
  }
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const buf = zlib.gunzipSync(fs.readFileSync(binPath));
  const z = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
  return { ...meta, z };
}

function loadHgt(file, options) {
  const buf = file.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(file)) : fs.readFileSync(file);
  const n = Math.sqrt(buf.length / 2);
  if (!Number.isInteger(n)) throw new Error('HGT file is not a square grid');
  const z = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) z[i] = buf.readInt16BE(i * 2);
  const base = path.basename(file).replace(/\.hgt(\.gz)?$/i, '');
  const match = base.match(/([NS])(\d{2})([EW])(\d{3})/i);
  if (!match) throw new Error('Cannot infer coordinates from HGT filename (expected e.g. N29E101)');
  const lat0 = (match[1].toUpperCase() === 'N' ? 1 : -1) * Number(match[2]);
  const lon0 = (match[3].toUpperCase() === 'E' ? 1 : -1) * Number(match[4]);
  const bounds = options.bounds || {
    west: lon0, east: lon0 + 1, south: lat0, north: lat0 + 1
  };
  const width = options.width || 900;
  const height = Math.max(2, Math.round(width * (bounds.north - bounds.south) /
    ((bounds.east - bounds.west) * Math.cos((bounds.north + bounds.south) / 2 * Math.PI / 180))));
  const out = new Int16Array(width * height);
  for (let y = 0; y < height; y++) {
    const lat = bounds.north + (y / (height - 1)) * (bounds.south - bounds.north);
    const fy = (lat0 + 1 - lat) * (n - 1);
    for (let x = 0; x < width; x++) {
      const lon = bounds.west + (x / (width - 1)) * (bounds.east - bounds.west);
      const fx = (lon - lon0) * (n - 1);
      out[y * width + x] = Math.round(sampleBilinear(z, n, n, fx, fy));
    }
  }
  let min = Infinity, max = -Infinity;
  for (const v of out) { if (v < min) min = v; if (v > max) max = v; }
  return {
    ...options, z: out, width, height, min, max,
    bounds, source: options.source || 'SRTM 1 arc-second HGT',
    title: options.title || '无名山地', latin: options.latin || 'UNNAMED RANGE',
    range: options.range || '自定义区域', focus: options.focus || {
      lat: (bounds.north + bounds.south) / 2,
      lon: (bounds.east + bounds.west) / 2
    }
  };
}

function sampleBilinear(src, sw, sh, x, y) {
  x = Math.max(0, Math.min(sw - 1, x)); y = Math.max(0, Math.min(sh - 1, y));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
  const tx = x - x0, ty = y - y0;
  const a = src[y0 * sw + x0], b = src[y0 * sw + x1], c = src[y1 * sw + x0], d = src[y1 * sw + x1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

function median3(z, w, h) {
  const out = new Int16Array(z.length);
  const values = new Array(9);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let k = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = Math.max(0, Math.min(w - 1, x + dx));
      const yy = Math.max(0, Math.min(h - 1, y + dy));
      values[k++] = z[yy * w + xx];
    }
    values.sort((a, b) => a - b);
    out[y * w + x] = values[4];
  }
  return out;
}

function gaussianBlur(z, w, h, sigma) {
  if (!sigma) return z instanceof Float32Array ? z : Float32Array.from(z);
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(v); sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -radius; k <= radius; k++) acc += z[y * w + Math.max(0, Math.min(w - 1, x + k))] * kernel[k + radius];
    tmp[y * w + x] = acc;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -radius; k <= radius; k++) acc += tmp[Math.max(0, Math.min(h - 1, y + k)) * w + x] * kernel[k + radius];
    out[y * w + x] = acc;
  }
  return out;
}

function prepareTerrain(dem, options = {}) {
  const interval = options.interval || 100;
  const indexEvery = options.indexEvery || 8;
  let raw = dem.z instanceof Int16Array ? dem.z : Int16Array.from(dem.z);
  if (options.median !== false) raw = median3(raw, dem.width, dem.height);
  const z = gaussianBlur(raw, dem.width, dem.height, options.smooth ?? 0.9);
  let min = Infinity, max = -Infinity;
  for (const v of z) { if (v < min) min = v; if (v > max) max = v; }
  const first = Math.ceil(min / interval) * interval;
  const levels = [];
  for (let v = first; v <= max; v += interval) levels.push(v);
  const target = min + (max - min) * 0.75;
  const autoHighlight = Math.round(target / interval) * interval;
  const highlight = options.highlight != null ? options.highlight : Math.max(levels[0] || 0, Math.min(max - interval, autoHighlight));
  return {
    z, width: dem.width, height: dem.height, min, max, levels,
    interval, indexEvery, highlight,
    indexLevels: new Set(levels.filter(v => v % (interval * indexEvery) === 0)),
    highlightLevel: levels.includes(highlight) ? highlight : null
  };
}

module.exports = { loadPreset, loadHgt, prepareTerrain, gaussianBlur, median3, sampleBilinear };
