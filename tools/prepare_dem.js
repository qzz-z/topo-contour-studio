'use strict';
/**
 * Rebuild data/gongga.bin.gz and data/gongga.json from two SRTM 1" tiles.
 * The source tiles are downloaded on first run and cached in data/.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DATA = path.resolve('data');
const TILE_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/skadi';

function parseHgt(buf) {
  const size = Math.sqrt(buf.length / 2);
  if (!Number.isInteger(size)) throw new Error('HGT size is not square');
  const z = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) z[i] = buf.readInt16BE(i * 2);
  return { z, width: size, height: size };
}

function sampleBilinear(src, sw, sh, x, y) {
  x = Math.max(0, Math.min(sw - 1, x));
  y = Math.max(0, Math.min(sh - 1, y));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
  const tx = x - x0, ty = y - y0;
  const a = src[y0 * sw + x0], b = src[y0 * sw + x1];
  const c = src[y1 * sw + x0], d = src[y1 * sw + x1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

async function ensureTile(name) {
  fs.mkdirSync(DATA, { recursive: true });
  const file = path.join(DATA, `${name}.hgt.gz`);
  if (fs.existsSync(file)) return file;
  const url = `${TILE_BASE}/${name.slice(0, 3)}/${name}.hgt.gz`;
  console.log(`[download] ${url}`);
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(240000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(file, buf);
      return file;
    } catch (err) {
      if (attempt === 4) throw err;
      console.warn(`[download] ${err.message}; retrying`);
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

async function main() {
  const files = {};
  for (const name of ['N29E101', 'N29E102']) {
    files[name] = await ensureTile(name);
  }
  const tiles = {
    101: parseHgt(zlib.gunzipSync(fs.readFileSync(files.N29E101))),
    102: parseHgt(zlib.gunzipSync(fs.readFileSync(files.N29E102)))
  };
  tiles[101].lon0 = 101; tiles[101].lat0 = 29;
  tiles[102].lon0 = 102; tiles[102].lat0 = 29;

  function sampleTile(tile, lat, lon) {
    const x = (lon - tile.lon0) * 3600;
    const y = (tile.lat0 + 1 - lat) * 3600;
    return sampleBilinear(tile.z, tile.width, tile.height, x, y);
  }

  function sample(lat, lon) {
    // Feather the 102E tile join by 0.012 deg; mirror-pad at the very edge.
    const f = 0.012;
    if (lon <= 102 - f) return sampleTile(tiles[101], lat, lon);
    if (lon >= 102 + f) return sampleTile(tiles[102], lat, lon);
    const t = (lon - (102 - f)) / (2 * f);
    const w = t * t * (3 - 2 * t);
    return sampleTile(tiles[101], lat, lon) * (1 - w) + sampleTile(tiles[102], lat, lon) * w;
  }

  const lonW = 101.60, lonE = 102.04, latS = 29.41, latN = 29.79;
  const targetW = 900;
  const targetH = Math.round(targetW * (latN - latS) /
    ((lonE - lonW) * Math.cos((latN + latS) / 2 * Math.PI / 180)));
  const out = new Int16Array(targetW * targetH);
  for (let y = 0; y < targetH; y++) {
    const lat = latN + (y / (targetH - 1)) * (latS - latN);
    for (let x = 0; x < targetW; x++) {
      const lon = lonW + (x / (targetW - 1)) * (lonE - lonW);
      out[y * targetW + x] = Math.round(sample(lat, lon));
    }
  }
  let min = Infinity, max = -Infinity;
  for (const v of out) { if (v < min) min = v; if (v > max) max = v; }
  console.log({ targetW, targetH, min, max, aspect: (targetW / targetH).toFixed(4) });

  const packed = zlib.gzipSync(Buffer.from(out.buffer, out.byteOffset, out.byteLength), { level: 9 });
  fs.writeFileSync(path.join(DATA, 'gongga.bin.gz'), packed);
  const meta = {
    name: 'gongga',
    title: '贡嘎山',
    latin: 'MINYA KONKA',
    range: '横断山脉 · 中国',
    caption: '横断山脉主峰。冰川、刃脊与峡谷，',
    sourceShort: 'SRTM 1″  ·  30 M DEM',
    focus: { lat: 29.595, lon: 101.879 },
    lat: 29.595,
    lon: 101.879,
    bounds: { west: lonW, east: lonE, south: latS, north: latN },
    width: targetW,
    height: targetH,
    min,
    max,
    source: 'SRTM 1 arc-second · N29E101 + N29E102 · resampled to 900 px',
    sourceUrl: 'https://s3.amazonaws.com/elevation-tiles-prod/skadi/N29/N29E101.hgt.gz'
  };
  fs.writeFileSync(path.join(DATA, 'gongga.json'), JSON.stringify(meta, null, 2));
  console.log('wrote', packed.length, 'bytes');
}

main().catch(err => { console.error(err); process.exit(1); });
