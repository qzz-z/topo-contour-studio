'use strict';
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { prepareTerrain } = require('./dem');
const { extractContours } = require('./contour');
const { renderPoster, renderArt } = require('./render');
const { makeTint } = require('./tint');
const { svgToPdf } = require('./pdf');

const DEFAULTS = {
  interval: 200,
  indexEvery: 5,
  smooth: 2.2,
  simplify: 0.75,
  highlight: null,
  labels: true,
  tint: true
};

function clamp(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

function normalizeOptions(input = {}) {
  return {
    interval: clamp(input.interval, 20, 1000, DEFAULTS.interval),
    indexEvery: clamp(input.indexEvery, 1, 10, DEFAULTS.indexEvery),
    smooth: clamp(input.smooth, 0, 6, DEFAULTS.smooth),
    simplify: clamp(input.simplify, 0.15, 2, DEFAULTS.simplify),
    highlight: input.highlight === '' || input.highlight == null ? null : clamp(input.highlight, 0, 9000, null),
    labels: input.labels !== false && input.labels !== 'false',
    tint: input.tint !== false && input.tint !== 'false'
  };
}

function buildScene(dem, options = {}) {
  const opts = normalizeOptions(options);
  const terrain = prepareTerrain(dem, {
    interval: opts.interval,
    indexEvery: opts.indexEvery,
    smooth: opts.smooth,
    highlight: opts.highlight == null ? undefined : opts.highlight
  });
  const contours = extractContours(terrain.z, terrain.width, terrain.height, terrain.levels, { epsilon: opts.simplify });
  let polylines = 0;
  for (const lines of contours.values()) polylines += lines.length;
  return {
    dem,
    terrain,
    contours,
    options: opts,
    stats: {
      width: terrain.width,
      height: terrain.height,
      min: Math.round(terrain.min),
      max: Math.round(terrain.max),
      interval: terrain.interval,
      indexInterval: terrain.interval * terrain.indexEvery,
      levels: terrain.levels.length,
      polylines,
      highlight: terrain.highlightLevel
    }
  };
}

async function makePoster({ dem, terrain, contours, style, options = {} }) {
  const opts = normalizeOptions(options);
  const tintData = opts.tint ? (await makeTint(terrain, style)).toString('base64') : null;
  const poster = renderPoster({
    meta: dem,
    terrain,
    contours,
    style,
    options: {
      artWidth: options.artWidth || 237,
      showLabels: opts.labels,
      tintData
    }
  });
  return { poster, tintData, options: opts };
}

function svgPixels(svg, opts = {}) {
  const vb = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  if (!vb) throw new Error('SVG has no viewBox');
  const vbW = Number(vb[1]), vbH = Number(vb[2]);
  const pxW = opts.width ? Math.round(opts.width) : Math.round(vbW / 25.4 * (opts.dpi || 300));
  const pxH = Math.round(pxW * vbH / vbW);
  const raster = svg.replace(/width="[^"]+" height="[^"]+"/, `width="${pxW}" height="${pxH}"`);
  return { raster, width: pxW, height: pxH };
}

async function svgToPngBuffer(svg, opts = {}) {
  const { raster, width, height } = svgPixels(svg, opts);
  const buffer = await sharp(Buffer.from(raster), { density: 72, limitInputPixels: 1e9 })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .withMetadata({ density: opts.dpi || 300 })
    .toBuffer();
  return { buffer, width, height };
}

async function svgToPngFile(svg, file, opts = {}) {
  const { buffer, width, height } = await svgToPngBuffer(svg, opts);
  fs.writeFileSync(file, buffer);
  return { width, height, size: buffer.length };
}

async function writeArtifacts({ dem, terrain, contours, style, options = {} }, outDir, prefix, formats = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const { poster } = await makePoster({ dem, terrain, contours, style, options });
  const files = [];
  const add = (name, label, size) => files.push({ name, label, size, url: `/downloads/${path.basename(outDir)}/${encodeURIComponent(name)}` });

  const svgName = `${prefix}_poster.svg`;
  fs.writeFileSync(path.join(outDir, svgName), poster.svg);
  add(svgName, '主海报 · SVG 矢量', Buffer.byteLength(poster.svg));

  if (formats.png !== false) {
    const pngName = `${prefix}_poster.png`;
    const dims = await svgToPngFile(poster.svg, path.join(outDir, pngName), {});
    add(pngName, `主海报 · PNG ${dims.width}×${dims.height} / 300 dpi`, dims.size);
  }
  if (formats.pdf !== false) {
    try {
      const pdfName = `${prefix}_poster.pdf`;
      const size = await svgToPdf(poster.svg, path.join(outDir, pdfName));
      add(pdfName, '主海报 · PDF A3 矢量', size);
    } catch (err) {
      console.warn('[pdf] skipped:', err.message);
    }
  }
  if (formats.art !== false) {
    for (const mode of ['color', 'ink']) {
      for (const tone of ['ink', 'light']) {
        if (tone === 'light' && !style.dark) continue;
        const artName = `${prefix}_art_${mode}_${tone}`;
        const art = renderArt({ terrain, contours, style, mode, tone });
        fs.writeFileSync(path.join(outDir, `${artName}.svg`), art.svg);
        add(`${artName}.svg`, `透明线稿 · ${mode === 'ink' ? '单色' : '彩色'} ${tone === 'light' ? '浅色' : '深色'} / SVG`, Buffer.byteLength(art.svg));
        if (formats.png !== false) {
          const png = await svgToPngBuffer(art.svg, {});
          fs.writeFileSync(path.join(outDir, `${artName}.png`), png.buffer);
          add(`${artName}.png`, `透明线稿 · ${mode === 'ink' ? '单色' : '彩色'} ${tone === 'light' ? '浅色' : '深色'} / PNG`, png.buffer.length);
        }
      }
    }
  }

  const metaName = `${prefix}_meta.json`;
  const meta = {
    title: dem.title, latin: dem.latin, style: style.name,
    bounds: dem.bounds, focus: dem.focus,
    options, art: poster.art, kmSpan: poster.kmSpan, labels: poster.labels.length,
    generatedAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(outDir, metaName), JSON.stringify(meta, null, 2));
  add(metaName, '生成参数 · JSON', Buffer.byteLength(JSON.stringify(meta, null, 2)));
  return { files, poster, meta };
}

function applyMeta(dem, overrides = {}) {
  return {
    ...dem,
    title: overrides.title || dem.title,
    latin: overrides.latin || dem.latin,
    range: overrides.range || dem.range,
    caption: overrides.caption || dem.caption,
    sourceShort: overrides.sourceShort || dem.sourceShort
  };
}

module.exports = {
  DEFAULTS,
  normalizeOptions,
  buildScene,
  makePoster,
  svgToPngBuffer,
  svgToPngFile,
  writeArtifacts,
  applyMeta
};
