'use strict';

const fs = require('fs');
const { polylineLength } = require('./contour');
const TITLE_FONT_PATH = process.env.TOPO_TITLE_FONT || 'C:/Windows/Fonts/NotoSerifSC-VF.ttf';
let titleFontCache;
function getTitleFont() {
  if (titleFontCache !== undefined) return titleFontCache;
  try {
    const fontkit = require('fontkit');
    const base = fontkit.openSync(TITLE_FONT_PATH);
    titleFontCache = typeof base.getVariation === 'function' ? base.getVariation({ wght: 700 }) : base;
  } catch (err) { titleFontCache = null; }
  return titleFontCache;
}
function titlePath(text, size, x, baseline, tracking, fill) {
  const font = getTitleFont();
  if (!font) return `<text x="${x}" y="${baseline}" font-family="${SERIF}" font-size="${nf(size, 2)}" font-weight="bold" letter-spacing="${nf(tracking, 2)}" fill="${fill}">${escapeXml(text)}</text>`;
  const scale = size / font.unitsPerEm;
  let cursor = x;
  let d = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const glyph = font.glyphForCodePoint(cp);
    if (glyph && glyph.path && glyph.path.commands.length) {
      for (const cmd of glyph.path.commands) {
        const a = cmd.args;
        const X = v => nf(cursor + v * scale);
        const Y = v => nf(baseline - v * scale);
        if (cmd.command === 'moveTo') d += `M${X(a[0])} ${Y(a[1])}`;
        else if (cmd.command === 'lineTo') d += `L${X(a[0])} ${Y(a[1])}`;
        else if (cmd.command === 'quadraticCurveTo') d += `Q${X(a[0])} ${Y(a[1])} ${X(a[2])} ${Y(a[3])}`;
        else if (cmd.command === 'bezierCurveTo') d += `C${X(a[0])} ${Y(a[1])} ${X(a[2])} ${Y(a[3])} ${X(a[4])} ${Y(a[5])}`;
        else if (cmd.command === 'closePath') d += 'Z';
      }
    }
    cursor += (glyph ? glyph.advanceWidth : size / scale * 0.5) * scale + tracking;
  }
  if (!d) return `<text x="${x}" y="${baseline}" font-family="${SERIF}" font-size="${nf(size, 2)}" font-weight="bold" letter-spacing="${nf(tracking, 2)}" fill="${fill}">${escapeXml(text)}</text>`;
  return `<path d="${d}" fill="${fill}" fill-rule="nonzero"/>`;
}

const SERIF = "'Noto Serif SC','Source Han Serif SC','Songti SC',serif";
const SANS = "'Noto Sans SC','MiSans','Source Han Sans SC','Microsoft YaHei',sans-serif";
const MONO = "'Cascadia Mono','Consolas','SFMono-Regular',monospace";
const LATIN = "Georgia,'Times New Roman',serif";

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}
function fmt(n) { return Math.round(n).toLocaleString('en-US'); }
function nf(n, d = 2) { return Number(n).toFixed(d); }

function dms(value, isLat) {
  const dir = value >= 0 ? (isLat ? 'N' : 'E') : (isLat ? 'S' : 'W');
  let abs = Math.abs(value);
  let d = Math.floor(abs);
  let mFloat = (abs - d) * 60;
  let m = Math.floor(mFloat);
  let s = Math.round((mFloat - m) * 60);
  if (s === 60) { s = 0; m += 1; }
  if (m === 60) { m = 0; d += 1; }
  return `${String(d).padStart(2, '0')}°${String(m).padStart(2, '0')}′${String(s).padStart(2, '0')}″${dir}`;
}
function dmsShort(value, isLat) {
  const dir = value >= 0 ? (isLat ? 'N' : 'E') : (isLat ? 'S' : 'W');
  const abs = Math.abs(value);
  const d = Math.floor(abs);
  const m = Math.round((abs - d) * 60);
  return `${String(d).padStart(2, '0')}°${String(m).padStart(2, '0')}′${dir}`;
}

function pathData(points, project, closed, tension = 1.0) {
  const p = points.map(([x, y]) => project(x, y));
  if (p.length < 2) return '';
  const n = p.length;
  let d = `M${nf(p[0][0])} ${nf(p[0][1])}`;
  const end = closed ? n - 1 : n - 2;
  for (let i = 0; i <= end; i++) {
    const p0 = p[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const p1 = p[i];
    const p2 = p[(i + 1) % n];
    const p3 = p[closed ? (i + 2) % n : Math.min(n - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6 * tension;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6 * tension;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6 * tension;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6 * tension;
    d += `C${nf(c1x)} ${nf(c1y)} ${nf(c2x)} ${nf(c2y)} ${nf(p2[0])} ${nf(p2[1])}`;
  }
  if (closed) d += 'Z';
  return d;
}

function pathDataBspline(points, project, closed) {
  const p = points.map(([x, y]) => project(x, y));
  if (p.length < 3) return '';
  const n = p.length;
  const at = i => closed ? p[(i + n) % n] : p[Math.max(0, Math.min(n - 1, i))];
  const segs = closed ? n : n - 1;
  const b0 = (a, b, c) => [(a[0] + 4 * b[0] + c[0]) / 6, (a[1] + 4 * b[1] + c[1]) / 6];
  const start = b0(at(0), at(0), at(1));
  let d = `M${nf(start[0])} ${nf(start[1])}`;
  for (let i = 0; i < segs; i++) {
    const p1 = at(i), p2 = at(i + 1);
    const c1 = [(2 * p1[0] + p2[0]) / 3, (2 * p1[1] + p2[1]) / 3];
    const c2 = [(p1[0] + 2 * p2[0]) / 3, (p1[1] + 2 * p2[1]) / 3];
    const end = b0(p1, p2, at(i + 2));
    d += `C${nf(c1[0])} ${nf(c1[1])} ${nf(c2[0])} ${nf(c2[1])} ${nf(end[0])} ${nf(end[1])}`;
  }
  if (closed) d += 'Z';
  return d;
}

function isClosed(line) {
  return Math.hypot(line[0][0] - line[line.length - 1][0], line[0][1] - line[line.length - 1][1]) < 1e-5;
}

function colorForLevel(level, terrain, style, mode = 'ink', allowAccent = true) {
  if (allowAccent && level === terrain.highlightLevel) return style.accent;
  if (mode === 'ink') return style.ink;
  const t = (level - terrain.min) / Math.max(1, terrain.max - terrain.min);
  const idx = Math.max(0, Math.min(style.ramp.length - 1, Math.floor(t * style.ramp.length)));
  return style.ramp[idx];
}

function contourGroup(contours, terrain, project, style, opts = {}) {
  const mode = opts.mode || 'ink';
  const useAccent = opts.accent !== false;
  const scale = opts.scale || 1;
  let out = '';
  for (const level of terrain.levels) {
    const paths = contours.get(level) || [];
    if (!paths.length) continue;
    const major = terrain.indexLevels.has(level);
    const accent = useAccent && level === terrain.highlightLevel;
    let d = '';
    for (const line of paths) d += pathDataBspline(line, project, isClosed(line));
    if (!d) continue;
    const width = accent ? 0.38 : major ? 0.235 : 0.135;
    const opacity = accent ? 1 : major ? 0.96 : 0.78;
    out += `<path d="${d}" fill="none" stroke="${colorForLevel(level, terrain, style, mode, useAccent)}" stroke-width="${nf(width * scale, 3)}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}"/>`;
  }
  return out;
}

function labelCandidates(contours, terrain, project, art, widthPx, heightPx) {
  const mmPerPx = art.w / widthPx;
  const labels = [];
  const levels = terrain.levels.filter(v => terrain.indexLevels.has(v));
  if (terrain.highlightLevel && !levels.includes(terrain.highlightLevel)) levels.push(terrain.highlightLevel);
  levels.sort((a, b) => a - b);
  for (const level of levels) {
    const paths = (contours.get(level) || []).slice(0, 8);
    let best = null;
    for (const line of paths) {
      const total = polylineLength(line);
      if (total * mmPerPx < 14) continue;
      for (const frac of [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74]) {
        const target = total * frac;
        let acc = 0, idx = 0;
        for (let i = 1; i < line.length; i++) {
          acc += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
          if (acc >= target) { idx = i; break; }
        }
        if (idx < 2 || idx > line.length - 3) continue;
        const a = line[idx - 2], b = line[idx + 2];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        let angle = Math.atan2(dy, dx) * 180 / Math.PI;
        if (angle > 90) angle -= 180;
        if (angle < -90) angle += 180;
        if (Math.abs(angle) > 38) continue;
        const px = line[idx][0], py = line[idx][1];
        const [ux, uy] = project(px, py);
        const cx = art.x + art.w / 2, cy = art.y + art.h / 2;
        const distance = Math.hypot(ux - cx, uy - cy);
        const score = distance + Math.abs(angle) * 0.24;
        const edge = Math.min(ux - art.x, art.x + art.w - ux, uy - art.y, art.y + art.h - uy);
        if (edge < 10) continue;
        if (!best || score < best.score) best = { ux, uy, angle, score, length: total * mmPerPx, level };
      }
    }
    if (best) labels.push(best);
  }
  // Keep labels apart; favour central ones.
  const kept = [];
  for (const cand of labels.sort((a, b) => a.score - b.score)) {
    if (kept.every(k => Math.hypot(k.ux - cand.ux, k.uy - cand.uy) > 19)) kept.push(cand);
  }
  for (const k of kept) k.ux = Math.max(art.x + 9, Math.min(art.x + art.w - 9, k.ux));
  return kept;
}

function renderLabels(labels, style, opts = {}) {
  const size = opts.size || 2.7;
  const halo = opts.halo ?? style.paper;
  let out = '';
  for (const l of labels) {
    const text = fmt(l.level);
    const transform = `translate(${nf(l.ux)} ${nf(l.uy)}) rotate(${nf(l.angle, 1)})`;
    out += `<g transform="${transform}">`;
    out += `<text x="0" y="0" dy=".35em" text-anchor="middle" font-family="${MONO}" font-size="${size}" letter-spacing=".12" fill="${halo}" stroke="${halo}" stroke-width=".8" paint-order="stroke" stroke-linejoin="round">${text}</text>`;
    out += `<text x="0" y="0" dy=".35em" text-anchor="middle" font-family="${MONO}" font-size="${size}" letter-spacing=".12" fill="${style.ink}">${text}</text>`;
    out += '</g>';
  }
  return out;
}

function findMaxCell(z, width, height) {
  let max = -Infinity, index = 0;
  for (let i = 0; i < z.length; i++) if (z[i] > max) { max = z[i]; index = i; }
  return { x: index % width, y: Math.floor(index / width), value: max };
}

function frameTicks(art, style) {
  let out = '';
  const tick = 2.2;
  for (let i = 1; i < 4; i++) {
    const x = art.x + art.w * i / 4;
    const y = art.y + art.h * i / 4;
    out += `<path d="M${nf(x)} ${nf(art.y - tick)}V${nf(art.y)}M${nf(x)} ${nf(art.y + art.h)}V${nf(art.y + art.h + tick)}" stroke="${style.rule}" stroke-width=".16" opacity=".7"/>`;
    out += `<path d="M${nf(art.x - tick)} ${nf(y)}H${nf(art.x)}M${nf(art.x + art.w)} ${nf(y)}H${nf(art.x + art.w + tick)}" stroke="${style.rule}" stroke-width=".16" opacity=".7"/>`;
  }
  return out;
}

function renderPoster({ meta, terrain, contours, style, options = {} }) {
  const width = 297, height = 420;
  const margin = 14;
  const artAreaW = options.artWidth || 237;
  let artW = artAreaW;
  let artH = artW * terrain.height / terrain.width;
  const maxH = 242;
  if (artH > maxH) { artH = maxH; artW = artH * terrain.width / terrain.height; }
  const art = { x: (width - artW) / 2, y: 92, w: artW, h: artH };
  const project = (x, y) => [art.x + (x / (terrain.width - 1)) * art.w, art.y + (y / (terrain.height - 1)) * art.h];

  const centerLat = (meta.bounds.north + meta.bounds.south) / 2;
  const kmSpan = (meta.bounds.east - meta.bounds.west) * 111.32 * Math.cos(centerLat * Math.PI / 180);
  const focus = meta.focus || { lat: centerLat, lon: (meta.bounds.east + meta.bounds.west) / 2 };
  const indexInterval = terrain.interval * terrain.indexEvery;
  const title = meta.title || '无名山地';
  const titleSize = Math.min(38, 165 / (Math.max(2, title.length) * 1.03));
  const latinSize = 3.5;
  const minTxt = fmt(terrain.min), maxTxt = fmt(terrain.max);
  let labels = options.showLabels === false ? [] : labelCandidates(contours, terrain, project, art, terrain.width, terrain.height);
  const maxCell = findMaxCell(terrain.z, terrain.width, terrain.height);
  const summit = project(maxCell.x, maxCell.y);
  labels = labels.filter(l => Math.hypot(l.ux - summit[0], l.uy - summit[1]) > 12);

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}">`;
  svg += `<defs><clipPath id="artClip"><rect x="${nf(art.x)}" y="${nf(art.y)}" width="${nf(art.w)}" height="${nf(art.h)}"/></clipPath>`;
  svg += `<linearGradient id="elev" x1="0" y1="1" x2="0" y2="0">`;
  for (let i = 0; i < style.ramp.length; i++) svg += `<stop offset="${nf(i / (style.ramp.length - 1), 3)}" stop-color="${style.ramp[i]}"/>`;
  svg += `</linearGradient>`;
  if (options.paperTexture) {
    svg += `<filter id="paper" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="3" seed="7"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope=".055"/></feComponentTransfer></filter>`;
  }
  svg += `</defs>`;
  svg += `<rect width="${width}" height="${height}" fill="${style.paper}"/>`;
  if (options.paperTexture) svg += `<rect width="${width}" height="${height}" filter="url(#paper)" opacity=".55"/>`;

  // Fine keyline
  svg += `<rect x="${margin}" y="${margin}" width="${width - margin * 2}" height="${height - margin * 2}" fill="none" stroke="${style.rule}" stroke-width=".18" opacity=".8"/>`;

  // Top identity block
  svg += `<rect x="20" y="18.1" width="2.4" height="2.4" fill="${style.accent}"/>`;
  svg += `<text x="25.2" y="20.2" font-family="${SANS}" font-size="2.05" letter-spacing=".62" fill="${style.muted}">ELEVATION CONTOUR STUDY · PLATE 01</text>`;
  svg += `<text x="277" y="20.2" text-anchor="end" font-family="${MONO}" font-size="2.05" letter-spacing=".28" fill="${style.muted}">${dms(focus.lat, true)}  /  ${dms(focus.lon, false)}</text>`;
  svg += `<line x1="20" y1="25.8" x2="277" y2="25.8" stroke="${style.rule}" stroke-width=".18" opacity=".75"/>`;

  // Title
  svg += titlePath(title, titleSize, 19, 64, 1.1, style.ink);
  svg += `<text x="21" y="75.4" font-family="${SANS}" font-size="${latinSize}" font-weight="500" letter-spacing="1.65" fill="${style.inkSoft}">${escapeXml(meta.latin || '')}</text>`;
  svg += `<text x="21" y="82.3" font-family="${SANS}" font-size="2.25" letter-spacing=".16" fill="${style.muted}">${escapeXml(meta.range || '')}  /  海拔等高线图谱</text>`;
  svg += `<text x="277" y="55.0" text-anchor="end" font-family="${SANS}" font-size="2.35" letter-spacing=".08" fill="${style.muted}">${escapeXml(meta.caption || '山脊、沟谷与高程，')}</text>`;
  svg += `<text x="277" y="60.4" text-anchor="end" font-family="${SANS}" font-size="2.35" letter-spacing=".08" fill="${style.muted}">在 ${nf(kmSpan, 1)} 公里的剖面里层层折叠。</text>`;
  svg += `<text x="277" y="75.1" text-anchor="end" font-family="${MONO}" font-size="1.95" letter-spacing=".12" fill="${style.muted}">${dmsShort(meta.bounds.south, true)} — ${dmsShort(meta.bounds.north, true)}</text>`;
  svg += `<text x="277" y="80.2" text-anchor="end" font-family="${MONO}" font-size="1.95" letter-spacing=".12" fill="${style.muted}">${dmsShort(meta.bounds.west, false)} — ${dmsShort(meta.bounds.east, false)}</text>`;

  // Artwork
  svg += `<g clip-path="url(#artClip)">`;
  if (options.tintData) svg += `<image x="${nf(art.x)}" y="${nf(art.y)}" width="${nf(art.w)}" height="${nf(art.h)}" preserveAspectRatio="none" opacity=".92" xlink:href="data:image/png;base64,${options.tintData}"/>`;
  svg += contourGroup(contours, terrain, project, style, { mode: 'ink' });
  if (options.showSummit !== false) {
    svg += `<g opacity=".95"><circle cx="${nf(summit[0])}" cy="${nf(summit[1])}" r="1.5" fill="none" stroke="${style.accent}" stroke-width=".2"/><circle cx="${nf(summit[0])}" cy="${nf(summit[1])}" r=".48" fill="${style.accent}"/></g>`;
  }
  svg += renderLabels(labels, style);
  svg += `</g>`;
  svg += `<rect x="${nf(art.x)}" y="${nf(art.y)}" width="${nf(art.w)}" height="${nf(art.h)}" fill="none" stroke="${style.rule}" stroke-width=".22" opacity=".9"/>`;
  if (options.showTicks !== false) svg += frameTicks(art, style);

  // Compass in right margin
  if (options.showCompass !== false) {
    const cx = 281, cy = 108;
    svg += `<g stroke="${style.muted}" fill="none" stroke-width=".17">`;
    svg += `<path d="M${cx} ${cy + 4.5}V${cy - 2.5}"/><path d="M${cx} ${cy - 8}L${cx - 2.1} ${cy + .6}L${cx} ${cy - 1}L${cx + 2.1} ${cy + .6}Z" fill="${style.ink}" stroke="none"/>`;
    svg += `</g><text x="${cx}" y="${cy - 9.8}" text-anchor="middle" font-family="${MONO}" font-size="1.85" fill="${style.ink}">N</text>`;
  }

  // Footer rule
  svg += `<line x1="20" y1="345.5" x2="277" y2="345.5" stroke="${style.rule}" stroke-width=".18" opacity=".8"/>`;

  svg += `<text x="21" y="354.6" font-family="${SANS}" font-size="2.05" letter-spacing=".5" fill="${style.muted}">ELEVATION RANGE / 海拔范围</text>`;
  svg += `<text x="20" y="369.3" font-family="${LATIN}" font-size="9.7" letter-spacing=".15" fill="${style.ink}">${minTxt}<tspan fill="${style.muted}" font-size="5.2">  —  </tspan>${maxTxt}<tspan font-family="${SANS}" font-size="5.0" fill="${style.inkSoft}"> M</tspan></text>`;

  // Field notes + scale
  svg += `<text x="277" y="354.6" text-anchor="end" font-family="${SANS}" font-size="2.05" letter-spacing=".5" fill="${style.muted}">FIELD NOTES / 图注</text>`;
  svg += `<text x="277" y="360.8" text-anchor="end" font-family="${MONO}" font-size="2.1" fill="${style.footerInk}">${escapeXml(meta.sourceShort || 'DEM  ·  30 M GRID')}</text>`;
  svg += `<text x="277" y="366.4" text-anchor="end" font-family="${MONO}" font-size="2.1" fill="${style.footerInk}">CONTOUR ${terrain.interval} M  /  INDEX ${indexInterval} M</text>`;
  if (options.showScale !== false) {
    const km = kmSpan < 35 ? 5 : kmSpan < 90 ? 10 : 20;
    const barW = Math.min(64, km / kmSpan * art.w);
    const x1 = 277 - barW, y = 369.4, bh = 1.9;
    svg += `<g>`;
    for (let i = 0; i < 2; i++) {
      svg += `<rect x="${nf(x1 + barW * i / 2)}" y="${y}" width="${nf(barW / 2)}" height="${bh}" fill="${i % 2 === 0 ? style.ink : 'none'}" stroke="${style.ink}" stroke-width=".14"/>`;
    }
    svg += `<text x="${nf(x1)}" y="378.0" text-anchor="middle" font-family="${MONO}" font-size="1.9" fill="${style.muted}">0</text>`;
    svg += `<text x="${nf(x1 + barW / 2)}" y="378.4" text-anchor="middle" font-family="${MONO}" font-size="1.9" fill="${style.muted}">${km / 2}</text>`;
    svg += `<text x="${nf(x1 + barW)}" y="378.0" text-anchor="end" font-family="${MONO}" font-size="1.9" fill="${style.muted}">${km} KM</text>`;
    svg += `</g>`;
  }

  // Elevation profile across the massif
  if (options.showProfile !== false) {
    const focusLat = focus.lat;
    const row = Math.max(0, Math.min(terrain.height - 1, Math.round((meta.bounds.north - focusLat) / (meta.bounds.north - meta.bounds.south) * (terrain.height - 1))));
    const raw = [];
    for (let x = 0; x < terrain.width; x++) raw.push(terrain.z[row * terrain.width + x]);
    const smooth = raw.map((_, i) => {
      let sum = 0, n = 0;
      for (let k = -4; k <= 4; k++) { const j = i + k; if (j >= 0 && j < raw.length) { sum += raw[j]; n++; } }
      return sum / n;
    });
    const px0 = 21, px1 = 277, pyTop = 383.4, pyBot = 396;
    const pt = v => pyBot - (v - terrain.min) / Math.max(1, terrain.max - terrain.min) * (pyBot - pyTop);
    let profileD = `M${px0} ${pyBot}`;
    for (let i = 0; i < smooth.length; i++) {
      const x = px0 + (i / (smooth.length - 1)) * (px1 - px0);
      profileD += `L${nf(x)} ${nf(pt(smooth[i]))}`;
    }
    profileD += `L${px1} ${pyBot}Z`;
    svg += `<path d="${profileD}" fill="${style.accent}" opacity=".11"/>`;
    svg += `<path d="${profileD.replace(/Z$/, '')}" fill="none" stroke="${style.ink}" stroke-width=".32" opacity=".9" stroke-linejoin="round"/>`;
    const fx = px0 + (focus.lon - meta.bounds.west) / (meta.bounds.east - meta.bounds.west) * (px1 - px0);
    svg += `<line x1="${nf(fx)}" y1="${pyTop - 1.2}" x2="${nf(fx)}" y2="${pyBot + .4}" stroke="${style.accent}" stroke-width=".18" opacity=".8"/>`;
    svg += `<text x="21" y="381.0" font-family="${SANS}" font-size="1.9" letter-spacing=".4" fill="${style.muted}">E—W ELEVATION PROFILE / 东西向海拔剖面</text>`;
  }

  // Bottom metadata
  svg += `<line x1="20" y1="398" x2="277" y2="398" stroke="${style.rule}" stroke-width=".14" opacity=".55"/>`;
  svg += `<text x="21" y="404" font-family="${MONO}" font-size="1.88" letter-spacing=".15" fill="${style.muted}">${dms(meta.bounds.south, true)} — ${dms(meta.bounds.north, true)}   ·   ${dms(meta.bounds.west, false)} — ${dms(meta.bounds.east, false)}</text>`;
  svg += `<text x="277" y="404" text-anchor="end" font-family="${MONO}" font-size="1.88" letter-spacing=".15" fill="${style.muted}">CONTOUR ATLAS  /  2026  /  PLATE 01</text>`;

  svg += `</svg>`;
  return { svg, art, labels, kmSpan };
}

function renderArt({ terrain, contours, style, mode = 'ramp', tone = 'ink' }) {
  const artW = 240;
  const artH = artW * terrain.height / terrain.width;
  const project = (x, y) => [x / (terrain.width - 1) * artW, y / (terrain.height - 1) * artH];
  const palette = tone === 'light' ? { ...style, ink: '#FFFFFF', accent: style.accent, ramp: ['#AFBDB4', '#C6D3CA', '#DDE6DF', '#EFF4F0', '#FFFFFF'] } : style;
  const lineMode = mode === 'ink' ? 'ink' : 'ramp';
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${artW}mm" height="${nf(artH)}mm" viewBox="0 0 ${artW} ${nf(artH)}">`;
  svg += contourGroup(contours, terrain, project, palette, { mode: lineMode, accent: mode !== 'ink' });
  svg += `</svg>`;
  return { svg, width: artW, height: artH };
}

module.exports = { renderPoster, renderArt, dms, dmsShort, fmt, pathData, pathDataBspline, escapeXml };

