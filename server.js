'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');
const busboy = require('busboy');
const archiver = require('archiver');
const { loadPreset, loadHgt } = require('./src/lib/dem');
const { styles } = require('./src/styles');
const { buildScene, makePoster, svgToPngBuffer, writeArtifacts, applyMeta, DEFAULTS, normalizeOptions } = require('./src/lib/pipeline');

const ROOT = __dirname;
const WEB = path.join(ROOT, 'web');
const DATA = path.join(ROOT, 'data');
const OUTPUT = process.env.TOPO_OUTPUT_DIR ? path.resolve(process.env.TOPO_OUTPUT_DIR) : path.join(ROOT, 'output', 'studio');
const UPLOADS = process.env.TOPO_UPLOAD_DIR ? path.resolve(process.env.TOPO_UPLOAD_DIR) : path.join(ROOT, 'uploads');
const OUTPUT_LABEL = process.env.TOPO_OUTPUT_LABEL || 'output/studio';
const PORT = Number(process.env.PORT || 4318);
const HOST = process.env.HOST || '127.0.0.1';

for (const dir of [OUTPUT, UPLOADS]) fs.mkdirSync(dir, { recursive: true });

const sceneCache = new Map();
const previewCache = new Map();
const uploadInfo = new Map();

function json(res, status, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function fail(res, status, message) {
  json(res, status, { error: message });
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeJoin(base, ...parts) {
  const target = path.resolve(base, ...parts);
  const root = path.resolve(base);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('非法路径');
  return target;
}

function tileFromName(file) {
  const m = path.basename(file).match(/([NS])(\d{2})([EW])(\d{3})/i);
  if (!m) return null;
  const lat0 = (m[1].toUpperCase() === 'N' ? 1 : -1) * Number(m[2]);
  const lon0 = (m[3].toUpperCase() === 'E' ? 1 : -1) * Number(m[4]);
  return { lat0, lon0, south: lat0, north: lat0 + 1, west: lon0, east: lon0 + 1 };
}

function inspectHgt(file) {
  const tile = tileFromName(file);
  let buf;
  try {
    const raw = fs.readFileSync(file);
    buf = /\.gz$/i.test(file) ? zlib.gunzipSync(raw) : raw;
  } catch (err) {
    throw new Error('无法读取 DEM 文件：' + err.message);
  }
  const n = Math.sqrt(buf.length / 2);
  if (!Number.isInteger(n)) throw new Error('不是有效的 HGT 文件（字节数不是 2×N²）');
  let max = -Infinity, mx = 0, my = 0;
  for (let i = 0; i < n * n; i++) {
    const v = buf.readInt16BE(i * 2);
    if (v > max) { max = v; mx = i % n; my = Math.floor(i / n); }
  }
  if (!tile) throw new Error('文件名中缺少经纬度，请使用 N30E103 这类文件名');
  const lat = tile.north - (my / (n - 1));
  const lon = tile.west + (mx / (n - 1));
  const halfLon = 0.24, halfLat = 0.21;
  const m = 0.006;
  const bounds = {
    west: Math.max(tile.west + m, lon - halfLon),
    east: Math.min(tile.east - m, lon + halfLon),
    south: Math.max(tile.south + m, lat - halfLat),
    north: Math.min(tile.north - m, lat + halfLat)
  };
  return { tile, focus: { lat, lon }, bounds, max, size: n };
}

function parseBounds(params) {
  const b = {
    west: Number(params.west), east: Number(params.east),
    south: Number(params.south), north: Number(params.north)
  };
  if (![b.west, b.east, b.south, b.north].every(Number.isFinite)) return null;
  return b;
}

function validateBounds(b) {
  if (!b) throw new Error('请填写完整的裁切范围（西、东、南、北）');
  if (b.east <= b.west) throw new Error('东边界必须大于西边界');
  if (b.north <= b.south) throw new Error('北边界必须大于南边界');
  const xSpan = b.east - b.west, ySpan = b.north - b.south;
  if (xSpan < 0.02 || ySpan < 0.02) throw new Error('裁切范围太小（至少 0.02°）');
  if (xSpan > 2.5 || ySpan > 2.5) throw new Error('裁切范围太大（最大 2.5°）');
  return b;
}

function getDem(params) {
  if (params.token) {
    const token = path.basename(String(params.token));
    const file = fs.existsSync(path.join(UPLOADS, token)) ? path.join(UPLOADS, token) : null;
    if (!file) throw new Error('上传的 DEM 已失效，请重新上传');
    const bounds = validateBounds(parseBounds(params));
    const info = uploadInfo.get(token);
    if (info && info.tile) {
      const t = info.tile, m = 0.002;
      if (bounds.west < t.west + m || bounds.east > t.east - m || bounds.south < t.south + m || bounds.north > t.north - m) {
        throw new Error('裁切范围超出了该 DEM 瓦片；请把经纬度限制在 ' + t.west + '–' + t.east + 'E / ' + t.south + '–' + t.north + 'N 内');
      }
    }
    const focus = params.focusLat && params.focusLon
      ? { lat: Number(params.focusLat), lon: Number(params.focusLon) }
      : info ? info.focus : { lat: (bounds.north + bounds.south) / 2, lon: (bounds.east + bounds.west) / 2 };
    const dem = loadHgt(file, {
      bounds, width: 900, focus,
      title: params.title || info?.title || '自定义山地',
      latin: params.latin || 'CUSTOM TERRAIN',
      range: params.range || '自定义区域',
      sourceShort: params.sourceShort || 'SRTM 1″  ·  30 M DEM',
      caption: params.caption || undefined
    });
    return applyMeta(dem, params);
  }
  const preset = params.preset || 'gongga';
  const dem = loadPreset(preset, DATA);
  return applyMeta(dem, params);
}

function sceneKey(params) {
  return [params.token || params.preset || 'gongga', params.west, params.east, params.south, params.north,
    params.interval || DEFAULTS.interval, params.indexEvery || DEFAULTS.indexEvery,
    params.smooth ?? DEFAULTS.smooth, params.simplify ?? DEFAULTS.simplify, params.highlight ?? '',
    params.title || '', params.latin || '', params.range || '', params.caption || ''].join('|');
}

function getScene(params) {
  const key = sceneKey(params);
  const hit = sceneCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.scene;
  const dem = getDem(params);
  const scene = buildScene(dem, params);
  sceneCache.set(key, { at: Date.now(), scene });
  while (sceneCache.size > 8) sceneCache.delete(sceneCache.keys().next().value);
  return scene;
}

function previewKey(params) {
  return [sceneKey(params), params.style || 'atlas', params.title || '', params.latin || '', params.range || '',
    params.labels !== 'false', params.tint !== 'false', params.width || 900].join('|');
}

async function makePreview(params) {
  const key = previewKey(params);
  const hit = previewCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
  const scene = getScene(params);
  const style = styles[params.style] || styles.atlas;
  const width = Math.max(500, Math.min(1200, Number(params.width) || 900));
  const { poster } = await makePoster({
    dem: scene.dem, terrain: scene.terrain, contours: scene.contours, style,
    options: { ...params, labels: params.labels !== 'false', tint: params.tint !== 'false' }
  });
  const png = await svgToPngBuffer(poster.svg, { width });
  const { z, ...safeMeta } = scene.dem;
  const value = {
    image: `data:image/png;base64,${png.buffer.toString('base64')}`,
    width: png.width, height: png.height,
    stats: scene.stats,
    labels: poster.labels.length,
    style: style.name,
    styleLabel: style.label,
    title: scene.dem.title,
    meta: safeMeta
  };
  previewCache.set(key, { at: Date.now(), value });
  while (previewCache.size > 24) previewCache.delete(previewCache.keys().next().value);
  return value;
}

function listFiles(dir, prefix = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(p, path.join(prefix, entry.name)));
    else out.push(path.join(prefix, entry.name).replace(/\\/g, '/'));
  }
  return out;
}

async function handleUpload(req, res) {
  const bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: 80 * 1024 * 1024 } });
  let saved = null, original = null, truncated = false;
  let pending = Promise.resolve();
  bb.on('file', (name, file, info) => {
    original = info.filename || 'upload.hgt';
    const safeBase = path.basename(original).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 90);
    const ext = /\.hgt\.gz$/i.test(original) ? '.hgt.gz' : '.hgt';
    const token = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${safeBase.endsWith(ext) ? safeBase : safeBase + ext}`;
    const target = path.join(UPLOADS, token);
    const ws = fs.createWriteStream(target);
    saved = { token, file: target, original };
    pending = new Promise((resolve, reject) => {
      file.on('limit', () => { truncated = true; });
      ws.on('finish', resolve);
      ws.on('error', reject);
      file.on('error', reject);
      file.pipe(ws);
    });
  });
  bb.on('finish', async () => {
    try {
      await pending;
      if (!saved) throw new Error('没有收到文件');
      if (truncated) throw new Error('文件超过 80 MB 限制');
      const info = inspectHgt(saved.file);
      const title = '自定义山地';
      uploadInfo.set(saved.token, { ...info, title, file: saved.file, original: saved.original });
      json(res, 200, {
        token: saved.token, filename: saved.original, ...info,
        defaults: {
          title, latin: 'CUSTOM TERRAIN', range: '自定义区域',
          west: info.bounds.west, east: info.bounds.east,
          south: info.bounds.south, north: info.bounds.north,
          focusLat: info.focus.lat, focusLon: info.focus.lon
        }
      });
    } catch (err) {
      if (saved) { try { fs.unlinkSync(saved.file); } catch (e) {} }
      fail(res, 400, err.message);
    }
  });
  bb.on('error', err => fail(res, 400, err.message));
  req.pipe(bb);
}

function metaPayload() {
  const ids = ['gongga', 'matterhorn', 'yulong', 'fuji', 'montblanc', 'grossglockner', 'meili', 'namcha'];
  const presets = [];
  for (const id of ids) {
    const file = path.join(DATA, id + '.json');
    if (!fs.existsSync(file)) continue;
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    presets.push({
      id, title: d.title, latin: d.latin, range: d.range, caption: d.caption,
      bounds: d.bounds, focus: d.focus, min: Math.round(d.min), max: Math.round(d.max),
      source: d.source, thumb: '/thumbs/' + id + '.png'
    });
  }
  const preset = presets.find(p => p.id === 'gongga') || presets[0];
  return {
    app: 'Topo Contour Studio',
    version: '1.2.0',
    defaults: DEFAULTS,
    paths: { output: OUTPUT, uploads: UPLOADS, outputLabel: OUTPUT_LABEL },
    preset,
    presets,
    styles: Object.values(styles).map(s => ({
      name: s.name, label: s.label, paper: s.paper, ink: s.ink, accent: s.accent, dark: !!s.dark
    }))
  };
}

async function handleGenerate(req, res) {
  const raw = await readBody(req, 4 * 1024 * 1024);
  let params;
  try { params = JSON.parse(raw || '{}'); } catch (e) { return fail(res, 400, 'JSON 格式错误'); }
  const scene = getScene(params);
  const styleNames = params.allStyles ? Object.keys(styles) : [params.style || 'atlas'];
  const jobId = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14) + '-' + crypto.randomBytes(2).toString('hex');
  const outDir = path.join(OUTPUT, jobId);
  fs.mkdirSync(outDir, { recursive: true });
  const started = Date.now();
  const files = [];
  const base = params.token ? 'custom' : (params.preset || 'gongga');
  for (let i = 0; i < styleNames.length; i++) {
    const style = styles[styleNames[i]] || styles.atlas;
    const prefix = `${base}_${style.name}`;
    const result = await writeArtifacts({
      dem: scene.dem, terrain: scene.terrain, contours: scene.contours, style,
      options: { ...params, labels: params.labels !== false, tint: params.tint !== false }
    }, outDir, prefix, {
      png: params.png !== false,
      pdf: params.pdf !== false,
      art: params.art !== false && (i === 0 || !params.allStyles)
    });
    files.push(...result.files);
  }
  const elapsed = Date.now() - started;
  json(res, 200, {
    jobId, files, stats: scene.stats, elapsed,
    title: scene.dem.title,
    zipUrl: `/api/zip/${jobId}`
  });
}

function handleZip(req, res, jobId) {
  if (!/^[A-Za-z0-9._-]+$/.test(jobId)) return fail(res, 400, '非法任务');
  const dir = path.join(OUTPUT, jobId);
  if (!fs.existsSync(dir)) return fail(res, 404, '任务不存在');
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="topo-${jobId}.zip"`
  });
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', err => { try { res.destroy(); } catch (e) {} console.error(err); });
  archive.pipe(res);
  for (const rel of listFiles(dir)) {
    if (/\.zip$/i.test(rel)) continue;
    archive.file(path.join(dir, rel), { name: rel });
  }
  archive.finalize();
}

function serveFile(res, file, contentType, cache = true) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return fail(res, 404, '文件不存在');
  const stat = fs.statSync(file);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Cache-Control': cache ? 'public, max-age=3600' : 'no-store'
  });
  fs.createReadStream(file).pipe(res);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.pdf': 'application/pdf'
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  try {
    if (req.method === 'GET' && u.pathname === '/api/health') return json(res, 200, { ok: true, version: '1.2.0' });
    if (req.method === 'GET' && u.pathname === '/api/meta') return json(res, 200, metaPayload());
    if (req.method === 'GET' && u.pathname === '/api/preview') {
      const params = Object.fromEntries(u.searchParams.entries());
      const result = await makePreview(params);
      return json(res, 200, result);
    }
    if (req.method === 'POST' && u.pathname === '/api/generate') return await handleGenerate(req, res);
    if (req.method === 'POST' && u.pathname === '/api/upload') return await handleUpload(req, res);
    if (req.method === 'GET' && u.pathname.startsWith('/api/zip/')) return handleZip(req, res, u.pathname.split('/').pop());
    if (req.method === 'GET' && u.pathname.startsWith('/downloads/')) {
      const parts = u.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent);
      if (parts.length < 2) return fail(res, 400, '非法下载路径');
      const file = safeJoin(OUTPUT, ...parts);
      const ext = path.extname(file).toLowerCase();
      return serveFile(res, file, MIME[ext] || 'application/octet-stream', false);
    }
    if (req.method === 'GET') {
      let rel = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
      const file = safeJoin(WEB, rel);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return fail(res, 404, '页面不存在');
      return serveFile(res, file, MIME[path.extname(file).toLowerCase()] || 'text/plain', true);
    }
    fail(res, 404, '接口不存在');
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) fail(res, 400, err.message || '处理失败');
    else try { res.destroy(); } catch (e) {}
  }
});

function openBrowser(url) {
  try {
    const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (err) { console.warn('无法自动打开浏览器，请手动访问', url); }
}

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log('');
  console.log('  TOPO CONTOUR STUDIO');
  console.log('  海拔等高线生成器已启动');
  console.log(`  ${url}`);
  console.log('  按 Ctrl+C 停止');
  console.log('');
  if (process.env.TOPO_NO_OPEN !== '1' && !process.argv.includes('--no-open')) openBrowser(url);
});

server.on('error', async err => {
  if (err.code === 'EADDRINUSE') {
    const url = `http://${HOST}:${PORT}`;
    try {
      const r = await fetch(`${url}/api/health`);
      const data = await r.json();
      if (data.ok) {
        console.log(`已有实例在运行：${url}`);
        openBrowser(url);
        setTimeout(() => process.exit(0), 500);
        return;
      }
    } catch (e) {}
    console.error(`端口 ${PORT} 已被其他程序占用。请关闭占用程序，或设置 PORT 后重新启动。`);
  } else console.error(err);
  process.exit(1);
});

