'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DATA = path.resolve('data');
const TILE_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/skadi';
const PRESETS = [
  { id:'matterhorn', tile:'N45E007', title:'马特洪峰', latin:'MATTERHORN', range:'阿尔卑斯山脉 · 瑞士', caption:'阿尔卑斯山脉的孤峰，', focus:{lat:45.976,lon:7.658}, widthKm:29, tiles:['N45E007','N46E007'] },
  { id:'yulong', tile:'N27E100', title:'玉龙雪山', latin:'JADE DRAGON', range:'横断山脉 · 中国', caption:'横断山脉的南端雪峰，', focus:{lat:27.100,lon:100.180}, widthKm:34, tiles:['N27E100','N26E100'] },
  { id:'fuji', tile:'N35E138', title:'富士山', latin:'MOUNT FUJI', range:'富士箱根伊豆 · 日本', caption:'火山锥与雪线，', focus:{lat:35.3606,lon:138.7274}, widthKm:34 },
  { id:'montblanc', tile:'N45E006', title:'勃朗峰', latin:'MONT BLANC', range:'阿尔卑斯山脉 · 法国/意大利', caption:'冰川环绕的花岗岩山体，', focus:{lat:45.832,lon:6.865}, widthKm:32, tiles:['N45E006','N46E006','N45E007','N46E007'] },
  { id:'grossglockner', tile:'N47E012', title:'大格洛克纳', latin:'GROSSGLOCKNER', range:'阿尔卑斯山脉 · 奥地利', caption:'阿尔卑斯东段的高峰，', focus:{lat:47.074,lon:12.694}, widthKm:30, tiles:['N47E012','N46E012'] },
  { id:'meili', tile:'N28E098', title:'梅里雪山', latin:'MEILI SNOW', range:'横断山脉 · 中国', caption:'澜沧江畔的雪山群，', focus:{lat:28.450,lon:98.700}, widthKm:34 },
  { id:'namcha', tile:'N29E095', title:'南迦巴瓦', latin:'NAMCHA BARWA', range:'喜马拉雅山脉 · 中国', caption:'雅鲁藏布江畔的刃脊，', focus:{lat:29.627,lon:95.055}, widthKm:34, tiles:['N29E095','N29E094'] }
];

function parseHgt(buf) {
  const size = Math.sqrt(buf.length / 2);
  if (!Number.isInteger(size)) throw new Error('HGT size is not square');
  const z = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) z[i] = buf.readInt16BE(i * 2);
  return { z, width: size, height: size };
}
function sampleBilinear(src, sw, sh, x, y) {
  x = Math.max(0, Math.min(sw - 1, x)); y = Math.max(0, Math.min(sh - 1, y));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
  const tx = x - x0, ty = y - y0;
  const a = src[y0 * sw + x0], b = src[y0 * sw + x1], c = src[y1 * sw + x0], d = src[y1 * sw + x1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}
async function ensureTile(name) {
  fs.mkdirSync(DATA, { recursive: true });
  const file = path.join(DATA, `${name}.hgt.gz`);
  if (fs.existsSync(file)) return file;
  const url = `${TILE_BASE}/${name.slice(0, 3)}/${name}.hgt.gz`;
  console.log('download', url);
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(240000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(file, buf);
      return file;
    } catch (e) {
      console.warn('retry', i + 1, e.message);
      await new Promise(r => setTimeout(r, 1200));
    }
  }
  throw new Error('download failed ' + name);
}
function tileBounds(name) {
  const m = name.match(/([NS])(\d{2})([EW])(\d{3})/i);
  const lat0 = (m[1].toUpperCase() === 'N' ? 1 : -1) * Number(m[2]);
  const lon0 = (m[3].toUpperCase() === 'E' ? 1 : -1) * Number(m[4]);
  return { south: lat0, north: lat0 + 1, west: lon0, east: lon0 + 1 };
}
async function main() {
  for (const p of PRESETS) {
    const tileNames = p.tiles || [p.tile];
    const tiles = [];
    for (const name of tileNames) {
      const file = await ensureTile(name);
      const raw = zlib.gunzipSync(fs.readFileSync(file));
      tiles.push({ name, ...tileBounds(name), ...parseHgt(raw) });
    }
    const tileFor = (lat, lon) => tiles.find(t => lat >= t.south && lat <= t.north && lon >= t.west && lon <= t.east) || tiles[0];
    const tb = {
      west: Math.min(...tiles.map(t => t.west)), east: Math.max(...tiles.map(t => t.east)),
      south: Math.min(...tiles.map(t => t.south)), north: Math.max(...tiles.map(t => t.north))
    };
    const sample = (lat, lon) => {
      const t = tileFor(lat, lon);
      const fx = (lon - t.west) * (t.width - 1);
      const fy = (t.north - lat) * (t.height - 1);
      return sampleBilinear(t.z, t.width, t.height, fx, fy);
    };
    const latHalf = (p.widthKm / 2) / 111.32;
    const lonHalf = (p.widthKm / 2) / (111.32 * Math.cos(p.focus.lat * Math.PI / 180));
    const m = 0.006;
    const bounds = {
      west: Math.max(tb.west + m, p.focus.lon - lonHalf),
      east: Math.min(tb.east - m, p.focus.lon + lonHalf),
      south: Math.max(tb.south + m, p.focus.lat - latHalf),
      north: Math.min(tb.north - m, p.focus.lat + latHalf)
    };
    const W = 900;
    const H = Math.round(W * (bounds.north - bounds.south) / ((bounds.east - bounds.west) * Math.cos((bounds.north + bounds.south) / 2 * Math.PI / 180)));
    const out = new Int16Array(W * H);
    for (let y = 0; y < H; y++) {
      const lat = bounds.north + (y / (H - 1)) * (bounds.south - bounds.north);
      for (let x = 0; x < W; x++) {
        const lon = bounds.west + (x / (W - 1)) * (bounds.east - bounds.west);
        out[y * W + x] = Math.round(sample(lat, lon));
      }
    }
    let min = Infinity, max = -Infinity;
    for (const v of out) { if (v < min) min = v; if (v > max) max = v; }
    const packed = zlib.gzipSync(Buffer.from(out.buffer, out.byteOffset, out.byteLength), { level: 9 });
    fs.writeFileSync(path.join(DATA, `${p.id}.bin.gz`), packed);
    const meta = {
      name: p.id, title: p.title, latin: p.latin, range: p.range, caption: p.caption,
      sourceShort: 'SRTM 1″  ·  30 M DEM',
      focus: p.focus, bounds, width: W, height: H, min, max,
      source: `SRTM 1 arc-second (${tileNames.join(' + ')}) · resampled to 900 px`,
      sourceUrl: `https://s3.amazonaws.com/elevation-tiles-prod/skadi/${p.tile.slice(0, 3)}/${p.tile}.hgt.gz`
    };
    fs.writeFileSync(path.join(DATA, `${p.id}.json`), JSON.stringify(meta, null, 2));
    console.log(p.id, W, H, min, max, (packed.length / 1024).toFixed(0) + 'KB');
  }
}
main().catch(e => { console.error(e); process.exit(1); });
