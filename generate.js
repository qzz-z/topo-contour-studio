const fs = require('fs');
const path = require('path');
try { fs.mkdirSync(path.resolve('.cache'), { recursive: true }); process.env.XDG_CACHE_HOME = path.resolve('.cache'); } catch (e) {}
const sharp = require('sharp');
const { loadPreset, loadHgt, prepareTerrain } = require('./src/lib/dem');
const { extractContours } = require('./src/lib/contour');
const { renderPoster, renderArt } = require('./src/lib/render');
const { makeTint } = require('./src/lib/tint');
const { svgToPdf } = require('./src/lib/pdf');
const { styles, layout } = require('./src/styles');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next == null || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

async function svgToPng(svg, file, opts = {}) {
  const vb = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  if (!vb) throw new Error('SVG has no viewBox');
  const vbW = Number(vb[1]), vbH = Number(vb[2]);
  const pxW = opts.width ? Math.round(opts.width) : Math.round(vbW / 25.4 * (opts.dpi || 300));
  const pxH = Math.round(pxW * vbH / vbW);
  const raster = svg.replace(/width="[^"]+" height="[^"]+"/, `width="${pxW}" height="${pxH}"`);
  await sharp(Buffer.from(raster), { density: 72, limitInputPixels: 1e9 })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .withMetadata({ density: opts.dpi || 300 })
    .toFile(file);
  return { width: pxW, height: pxH };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const preset = args.preset || 'gongga';
  const outDir = path.resolve(args.out || 'output');
  ensureDir(outDir);
  const interval = Number(args.interval || 200);
  const indexEvery = Number(args.indexEvery || 5);
  const smooth = Number(args.smooth ?? 2.2);
  const simplify = Number(args.simplify ?? 0.75);
  const artWidth = Number(args.artWidth || layout.art.w);

  let dem;
  if (args.hgt) {
    const b = args.bounds ? JSON.parse(args.bounds) : (args.west ? {
      west: Number(args.west), east: Number(args.east), south: Number(args.south), north: Number(args.north)
    } : undefined);
    dem = loadHgt(path.resolve(args.hgt), {
      bounds: b,
      width: Number(args.grid || 900),
      title: args.title || '自定义山地',
      latin: args.latin || 'CUSTOM TERRAIN',
      range: args.range || '自定义区域',
      focus: args.lat && args.lon ? { lat: Number(args.lat), lon: Number(args.lon) } : undefined,
      sourceShort: args.sourceShort || 'SRTM 1″  ·  30 M DEM',
      caption: args.caption || undefined
    });
  } else {
    dem = loadPreset(preset, path.resolve('data'));
  }

  const terrain = prepareTerrain(dem, { interval, indexEvery, smooth, highlight: args.highlight ? Number(args.highlight) : undefined });
  console.log(`[terrain] ${terrain.width}×${terrain.height}  ${Math.round(terrain.min)}–${Math.round(terrain.max)} m  ${terrain.levels.length} levels`);
  console.time('[contours]');
  const contours = extractContours(terrain.z, terrain.width, terrain.height, terrain.levels, { epsilon: simplify });
  console.timeEnd('[contours]');
  const count = [...contours.values()].reduce((n, a) => n + a.length, 0);
  console.log(`[contours] ${count} polylines`);

  const styleNames = args.style && args.style !== 'all' ? args.style.split(',') : Object.keys(styles);
  const base = args.name || (args.hgt ? 'custom' : preset);
  const previewWidth = args.preview ? Number(args.preview) : 0;

  for (const styleName of styleNames) {
    const style = styles[styleName] || styles.atlas;
    const prefix = `${base}_${styleName}`;
    const tintData = args.tint === 'false' ? null : (await makeTint(terrain, style)).toString('base64');
    const poster = renderPoster({ meta: dem, terrain, contours, style, options: { artWidth, showLabels: args.labels !== 'false', tintData } });
    const posterSvg = path.join(outDir, `${prefix}_poster.svg`);
    fs.writeFileSync(posterSvg, poster.svg);
    const dims = await svgToPng(poster.svg, path.join(outDir, `${prefix}_poster.png`), previewWidth ? { width: previewWidth } : {});
    console.log(`[poster] ${posterSvg}  ${dims.width}×${dims.height}`);
    if (args.pdf !== 'false') {
      try {
        const pdfPath = path.join(outDir, `${prefix}_poster.pdf`);
        const size = await svgToPdf(poster.svg, pdfPath);
        console.log(`[pdf] ${pdfPath}  ${Math.round(size / 1024)} KB`);
      } catch (err) { console.warn('[pdf] skipped:', err.message); }
    }

    if (args.art !== 'false') {
      for (const mode of ['color', 'ink']) {
        for (const tone of ['ink', 'light']) {
          if (tone === 'light' && !style.dark) continue;
          const art = renderArt({ terrain, contours, style, mode, tone });
          const suffix = `${mode}_${tone}`;
          fs.writeFileSync(path.join(outDir, `${prefix}_art_${suffix}.svg`), art.svg);
          const artPx = previewWidth ? Math.round(previewWidth * art.width / 297) : 0;
          const d = await svgToPng(art.svg, path.join(outDir, `${prefix}_art_${suffix}.png`), artPx ? { width: artPx } : {});
          console.log(`[art] ${prefix}_art_${suffix}.png  ${d.width}×${d.height}`);
        }
      }
    }

    fs.writeFileSync(path.join(outDir, `${prefix}_meta.json`), JSON.stringify({
      preset, style: styleName, interval, indexEvery, title: dem.title, latin: dem.latin,
      bounds: dem.bounds, focus: dem.focus, min: terrain.min, max: terrain.max,
      art: poster.art, kmSpan: poster.kmSpan, labels: poster.labels.length
    }, null, 2));
  }
}

main().catch(err => { console.error(err); process.exit(1); });

