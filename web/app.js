'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const fmt = (n) => Math.round(n).toLocaleString('en-US');

const state = {
  mode: 'preset',
  preset: 'gongga',
  token: null,
  filename: null,
  title: '贡嘎山',
  latin: 'MINYA KONKA',
  range: '横断山脉 · 中国',
  bounds: null,
  focus: null,
  style: 'atlas',
  interval: 200,
  indexEvery: 5,
  smooth: 2.2,
  simplify: 0.75,
  labels: true,
  tint: true,
  highlight: null,
  png: true,
  pdf: true,
  art: true,
  allStyles: false
};

let meta = null;
let previewTimer = null;
let previewSeq = 0;
let previewAbort = null;
let lastPreview = null;
let generating = false;
let progressTimer = null;

const els = {};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  cacheEls();
  bindEvents();
  try {
    meta = await fetch('/api/meta').then(r => r.json());
    renderPresetOptions(meta.presets || [meta.preset]);
    applyPreset(meta.preset);
    if (meta.paths?.outputLabel) document.getElementById('outputPath').textContent = meta.paths.outputLabel;
    renderStyles(meta.styles);
    syncControls();
    refreshPreview();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  } catch (err) {
    toast('无法连接到本地生成器，请确认 server.js 正在运行。', true);
    setStatus('OFFLINE');
  }
}

function cacheEls() {
  els.title = $('#titleInput'); els.latin = $('#latinInput'); els.range = $('#rangeInput');
  els.styleGrid = $('#styleGrid'); els.interval = $('#intervalRange'); els.intervalOut = $('#intervalOut');
  els.smooth = $('#smoothRange'); els.smoothOut = $('#smoothOut');
  els.labels = $('#labelsToggle'); els.tint = $('#tintToggle');
  els.png = $('#pngToggle'); els.pdf = $('#pdfToggle'); els.art = $('#artToggle'); els.allStyles = $('#allStylesToggle');
  els.preview = $('#previewImg'); els.loading = $('#previewLoading'); els.status = $('#statusText');
  els.stageTitle = $('#stageTitle'); els.stageLatin = $('#stageLatin');
  els.presetSelect = $('#presetSelect'); els.presetTitle = $('#presetTitle'); els.presetBadge = $('#presetBadge'); els.presetMeta = $('#presetMeta'); els.presetRange = $('#presetRange');
  els.customBox = $('#customBox'); els.uploadName = $('#uploadName'); els.uploadBtn = $('#uploadBtn'); els.fileInput = $('#fileInput'); els.presetThumb = $('#presetThumb');
  els.downloads = $('#downloads'); els.fileList = $('#fileList'); els.zipBtn = $('#zipBtn');
  els.generateBtn = $('#generateBtn'); els.toast = $('#toast'); els.dockSummary = $('#dockSummary'); els.randomBtn = $('#randomBtn');
  els.helpModal = $('#helpModal');
}

function bindEvents() {
  els.title.addEventListener('input', () => { state.title = els.title.value; els.stageTitle.textContent = state.title || '未命名'; schedulePreview(); });
  els.latin.addEventListener('input', () => { state.latin = els.latin.value; els.stageLatin.textContent = state.latin || 'CUSTOM TERRAIN'; schedulePreview(); });
  els.range.addEventListener('input', () => { state.range = els.range.value; schedulePreview(); });

  els.interval.addEventListener('input', () => {
    state.interval = Number(els.interval.value);
    state.highlight = null;
    els.intervalOut.textContent = `${state.interval} m`;
    schedulePreview();
  });
  els.smooth.addEventListener('input', () => {
    state.smooth = Number(els.smooth.value);
    els.smoothOut.textContent = state.smooth.toFixed(1);
    schedulePreview();
  });
  els.labels.addEventListener('change', () => { state.labels = els.labels.checked; schedulePreview(); });
  els.tint.addEventListener('change', () => { state.tint = els.tint.checked; schedulePreview(); });

  els.png.addEventListener('change', () => { state.png = els.png.checked; syncDock(); });
  els.pdf.addEventListener('change', () => { state.pdf = els.pdf.checked; syncDock(); });
  els.art.addEventListener('change', () => { state.art = els.art.checked; syncDock(); });
  els.allStyles.addEventListener('change', () => { state.allStyles = els.allStyles.checked; syncDock(); });

  els.presetSelect.addEventListener('change', () => { if (els.presetSelect.value) selectPreset(els.presetSelect.value); });
  $('#resetBtn').addEventListener('click', resetAll);
  $('#refreshBtn').addEventListener('click', () => refreshPreview(true));
  $('#downloadPreviewBtn').addEventListener('click', downloadPreview);
  els.generateBtn.addEventListener('click', generate);
  els.randomBtn.addEventListener('click', randomizeParams);
  $('#uploadBtn').addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => { if (els.fileInput.files[0]) uploadFile(els.fileInput.files[0]); });
  $('#clearUpload').addEventListener('click', clearUpload);
  ['west','east','south','north'].forEach(k => {
    document.getElementById(`${k}Input`).addEventListener('input', () => {
      state.bounds = readBounds();
      schedulePreview();
    });
  });
  $('#helpBtn').addEventListener('click', () => { els.helpModal.hidden = false; });
  $$('[data-close]').forEach(el => el.addEventListener('click', () => { els.helpModal.hidden = true; }));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') els.helpModal.hidden = true;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); generate(); }
    if (e.key.toLowerCase() === 'r' && !e.metaKey && !e.ctrlKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) { e.preventDefault(); randomizeParams(); }
  });

  const upload = els.uploadBtn;
  ['dragenter','dragover'].forEach(ev => upload.addEventListener(ev, e => { e.preventDefault(); upload.classList.add('dragover'); }));
  ['dragleave','drop'].forEach(ev => upload.addEventListener(ev, e => { e.preventDefault(); upload.classList.remove('dragover'); }));
  upload.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) uploadFile(f); });
}

function renderPresetOptions(presets) {
  els.presetSelect.innerHTML = '<option value="" disabled>自定义 DEM</option>' + presets.map(p =>
    `<option value="${p.id}">${p.title} · ${p.range}</option>`).join('');
}

function selectPreset(id) {
  const p = (meta?.presets || []).find(x => x.id === id);
  if (!p) return;
  applyPreset(p);
  schedulePreview(80);
}

function applyPreset(p) {
  state.mode = 'preset';
  state.token = null;
  state.preset = p.id || state.preset;
  state.title = p.title;
  state.latin = p.latin;
  state.range = p.range;
  state.bounds = { ...p.bounds };
  state.focus = { ...p.focus };
  state.highlight = null;
  els.title.value = state.title;
  els.latin.value = state.latin;
  els.range.value = state.range;
  els.stageTitle.textContent = state.title;
  els.stageLatin.textContent = state.latin;
  els.presetTitle.textContent = p.title;
  els.presetBadge.textContent = 'BUILT-IN';
  els.presetMeta.textContent = `${p.latin} · ${p.range}`;
  els.presetRange.textContent = `${fmt(p.min)} — ${fmt(p.max)} M`;
  if (p.id && meta?.presets?.some(x => x.id === p.id)) els.presetSelect.value = p.id;
  els.presetThumb.innerHTML = `<img alt="${escapeHtml(p.title)} 地形缩略图" src="${p.thumb || '/thumbs/' + p.id + '.png'}">`;
  els.customBox.hidden = true;
  els.uploadBtn.style.display = '';
}

function renderStyles(styles) {
  els.styleGrid.innerHTML = styles.map((s, i) => `
    <button class="style-card ${i === 0 ? 'active' : ''}" data-style="${s.name}" aria-pressed="${i === 0}"
      style="--swatch-paper:${s.paper};--swatch-ink:${s.ink};--swatch-accent:${s.accent}">
      <span class="swatch-art">
        <svg viewBox="0 0 120 46" preserveAspectRatio="none" aria-hidden="true">
          <path d="M-8 35 C 12 27, 20 41, 37 33 S 62 18, 78 27 S 103 40, 128 25" fill="none" stroke="currentColor" stroke-width="1.15" opacity=".9"/>
          <path d="M-8 41 C 14 35, 22 45, 41 38 S 68 26, 84 33 S 106 43, 128 33" fill="none" stroke="currentColor" stroke-width=".62" opacity=".55"/>
          <path d="M17 29 C 28 15, 39 13, 48 20 S 61 31, 72 25 S 82 12, 92 13" fill="none" stroke="var(--swatch-accent)" stroke-width="1.1"/>
          <circle cx="91" cy="12.5" r="2.1" fill="var(--swatch-accent)"/>
        </svg>
      </span>
      <span class="style-name">${s.label}</span>
      <span class="style-code">${s.name.toUpperCase()}</span>
      <span class="check"></span>
    </button>`).join('');
  $$('.style-card').forEach(btn => btn.addEventListener('click', () => {
    state.style = btn.dataset.style;
    activateStyle(state.style);
    schedulePreview();
  }));
}

function activateStyle(name) {
  $$('.style-card').forEach(b => {
    const active = b.dataset.style === name;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function syncControls() {
  els.interval.value = state.interval;
  els.intervalOut.textContent = `${state.interval} m`;
  els.smooth.value = state.smooth;
  els.smoothOut.textContent = state.smooth.toFixed(1);
  els.labels.checked = state.labels;
  els.tint.checked = state.tint;
  els.png.checked = state.png;
  els.pdf.checked = state.pdf;
  els.art.checked = state.art;
  els.allStyles.checked = state.allStyles;
  activateStyle(state.style);
  syncDock();
}

function syncDock() {
  if (!els.dockSummary) return;
  const parts = [];
  if (state.png) parts.push('PNG');
  if (state.pdf) parts.push('PDF');
  if (state.art) parts.push('透明线稿');
  if (state.allStyles) parts.push('×4 配色');
  els.dockSummary.textContent = parts.length ? parts.join(' · ') : '未选择格式';
  const hint = document.querySelector('.generate-dock .hint');
  if (hint) hint.textContent = state.allStyles ? '四套配色 · 约 2–4 分钟' : 'A3 · 300 dpi · 约 30–60 秒';
}

function readBounds() {
  const val = id => Number(document.getElementById(`${id}Input`).value);
  return { west: val('west'), east: val('east'), south: val('south'), north: val('north') };
}

function fillBounds(b) {
  if (!b) return;
  const r = v => Number(v).toFixed(4);
  document.getElementById('westInput').value = r(b.west);
  document.getElementById('eastInput').value = r(b.east);
  document.getElementById('southInput').value = r(b.south);
  document.getElementById('northInput').value = r(b.north);
}

function queryParams() {
  const p = new URLSearchParams();
  if (state.mode === 'custom' && state.token) {
    p.set('token', state.token);
    const b = state.bounds || readBounds();
    p.set('west', b.west); p.set('east', b.east); p.set('south', b.south); p.set('north', b.north);
    if (state.focus) { p.set('focusLat', state.focus.lat); p.set('focusLon', state.focus.lon); }
  } else {
    p.set('preset', state.preset);
  }
  p.set('style', state.style);
  p.set('interval', state.interval);
  p.set('indexEvery', state.indexEvery);
  p.set('smooth', state.smooth);
  p.set('simplify', state.simplify);
  p.set('labels', state.labels);
  p.set('tint', state.tint);
  if (state.highlight != null) p.set('highlight', state.highlight);
  p.set('width', 900);
  p.set('title', state.title);
  p.set('latin', state.latin);
  p.set('range', state.range);
  return p;
}

function schedulePreview(delay = 320) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, delay);
}

async function refreshPreview(force = false) {
  if (generating) return;
  const seq = ++previewSeq;
  if (previewAbort) previewAbort.abort();
  previewAbort = new AbortController();
  els.loading.classList.add('show');
  setStatus('RENDERING');
  const t0 = performance.now();
  try {
    const res = await fetch(`/api/preview?${queryParams().toString()}`, { signal: previewAbort.signal });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '预览失败');
    if (seq !== previewSeq || generating) return;
    lastPreview = data;
    const img = new Image();
    img.onload = () => {
      els.preview.src = data.image;
      els.preview.classList.add('loaded');
    };
    img.src = data.image;
    updateStats(data);
    if (!generating) setStatus(`READY · ${((performance.now() - t0) / 1000).toFixed(1)} S`);
    document.querySelector('.preview-paper').style.setProperty('--paper', data.style === 'nocturne' ? '#101b22' : data.style === 'cobalt' ? '#17386b' : '#f3eee3');
  } catch (err) {
    if (err.name === 'AbortError') return;
    setStatus('ERROR');
    toast(err.message, true);
  } finally {
    if (seq === previewSeq && !generating) els.loading.classList.remove('show');
  }
}

function updateStats(data) {
  const s = data.stats;
  const b = data.meta.bounds;
  const latMid = (b.north + b.south) / 2;
  const kmX = (b.east - b.west) * 111.32 * Math.cos(latMid * Math.PI / 180);
  const kmY = (b.north - b.south) * 111.32;
  const stats = $$('.stat b');
  if (stats[0]) stats[0].innerHTML = `${fmt(s.min)} — ${fmt(s.max)} <i>M</i>`;
  if (stats[1]) stats[1].innerHTML = `${s.interval} <i>M</i>`;
  if (stats[2]) stats[2].innerHTML = `${kmX.toFixed(1)} × ${kmY.toFixed(1)} <i>KM</i>`;
  if (stats[3]) stats[3].textContent = fmt(s.polylines);
  els.stageTitle.textContent = data.title || state.title || '未命名';
  if (state.mode === 'preset') {
    els.presetRange.textContent = `${fmt(s.min)} — ${fmt(s.max)} M`;
  } else {
    els.presetRange.textContent = `${fmt(s.min)} — ${fmt(s.max)} M · CUSTOM`;
  }
}

function setStatus(text) {
  if (els.status) els.status.textContent = text;
}

async function uploadFile(file) {
  if (!file) return;
  if (!/\.(hgt|gz)$/i.test(file.name)) return toast('请选择 .hgt 或 .hgt.gz 文件', true);
  if (file.size > 80 * 1024 * 1024) return toast('文件超过 80 MB，请先裁切', true);
  const old = els.uploadBtn.innerHTML;
  els.uploadBtn.innerHTML = '<span class="upload-icon">…</span><span><b>正在读取 DEM</b><small>解析瓦片与最高点</small></span>';
  els.uploadBtn.disabled = true;
  try {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/upload', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '上传失败');
    state.mode = 'custom';
    state.token = data.token;
    state.filename = data.filename;
    state.title = data.defaults.title;
    state.latin = data.defaults.latin;
    state.range = '自定义区域';
    state.bounds = { west: data.bounds.west, east: data.bounds.east, south: data.bounds.south, north: data.bounds.north };
    state.highlight = null;
    state.focus = data.focus;
    els.title.value = state.title;
    els.latin.value = state.latin;
    els.range.value = state.range;
    els.stageTitle.textContent = state.title;
    els.stageLatin.textContent = state.latin;
    els.presetTitle.textContent = '自定义山地';
    els.presetBadge.textContent = 'CUSTOM';
    els.presetMeta.textContent = file.name;
    els.presetRange.textContent = '等待裁切';
    els.presetSelect.value = '';
    els.presetThumb.innerHTML = '<div class="custom-thumb"><span>YOUR<br>TERRAIN</span></div>';
    fillBounds(state.bounds);
    els.uploadName.textContent = file.name;
    els.customBox.hidden = false;
    els.uploadBtn.style.display = 'none';
    schedulePreview(80);
    toast('DEM 已载入，已按最高点建议裁切范围');
  } catch (err) {
    toast(err.message, true);
  } finally {
    els.uploadBtn.innerHTML = old;
    els.uploadBtn.disabled = false;
    els.fileInput.value = '';
  }
}

function clearUpload() {
  if (!meta) return;
  applyPreset(meta.preset);
  syncControls();
  schedulePreview(80);
  toast('已恢复内置贡嘎山地形');
}

function resetAll() {
  if (!meta) return;
  Object.assign(state, {
    mode: 'preset', token: null, filename: null, style: 'atlas', interval: 200, indexEvery: 5,
    smooth: 2.2, simplify: 0.75, labels: true, tint: true, highlight: null, png: true, pdf: true, art: true, allStyles: false
  });
  applyPreset(meta.preset);
  $$('.style-card').forEach(b => { b.classList.toggle('active', b.dataset.style === 'atlas'); b.setAttribute('aria-pressed', b.dataset.style === 'atlas' ? 'true' : 'false'); });
  syncControls();
  schedulePreview(80);
}

function payload() {
  const p = {
    style: state.style, interval: state.interval, indexEvery: state.indexEvery,
    smooth: state.smooth, simplify: state.simplify, labels: state.labels, tint: state.tint, highlight: state.highlight,
    png: state.png, pdf: state.pdf, art: state.art, allStyles: state.allStyles,
    title: state.title, latin: state.latin, range: state.range
  };
  if (state.mode === 'custom' && state.token) {
    Object.assign(p, {
      token: state.token, west: state.bounds.west, east: state.bounds.east,
      south: state.bounds.south, north: state.bounds.north,
      focusLat: state.focus.lat, focusLon: state.focus.lon
    });
  } else p.preset = state.preset;
  return p;
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function weightedPick(items, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r <= 0) return items[i]; }
  return items[items.length - 1];
}

function randomizeParams() {
  if (generating || !meta) return;
  const pool = (meta.presets || []).filter(p => p.id !== state.preset);
  const next = pool.length ? pick(pool) : (meta.presets || [meta.preset])[0];
  if (next) applyPreset(next);
  const s = null;
  const min = next?.min ?? lastPreview?.stats?.min ?? meta.preset?.min ?? 2000;
  const max = next?.max ?? lastPreview?.stats?.max ?? meta.preset?.max ?? 7000;
  const range = Math.max(1, max - min);
  const all = [50, 100, 150, 200, 250, 300, 350, 400];
  let candidates = all.filter(i => range / i >= 16 && range / i <= 50);
  if (!candidates.length) candidates = all.filter(i => range / i >= 12 && range / i <= 60);
  if (!candidates.length) candidates = [200];
  const weights = { 50: .35, 100: 1, 150: 2, 200: 2.4, 250: 1.6, 300: .9, 350: .45, 400: .3 };
  const interval = weightedPick(candidates, candidates.map(i => weights[i] || 1));
  const baseSmooth = interval <= 100 ? 1.5 : interval <= 200 ? 2.0 : 2.4;
  const smooth = Math.min(3.4, Math.max(.8, Math.round((baseSmooth + Math.random() * .7) * 10) / 10));
  const idxPool = [4, 5, 6].filter(e => interval * e >= 500 && interval * e <= 1500);
  const indexEvery = idxPool.length ? pick(idxPool) : 5;
  const stylePool = meta.styles.filter(x => x.name !== state.style);
  const style = stylePool.length ? pick(stylePool) : meta.styles[0];
  let highlight = Math.floor((min + range * (.7 + Math.random() * .15)) / interval) * interval;
  if (highlight <= min + interval || highlight >= max - interval) highlight = null;
  state.style = style.name;
  state.interval = interval;
  state.indexEvery = indexEvery;
  state.smooth = smooth;
  state.labels = Math.random() < .86;
  state.tint = Math.random() < .84;
  state.highlight = highlight;
  syncControls();
  schedulePreview(80);
  const parts = [next?.title || state.title, style.label, `${interval} m`, `平滑 ${smooth.toFixed(1)}`];
  if (highlight) parts.push(`强调 ${fmt(highlight)} m`);
  if (!state.labels) parts.push('无标注');
  toast('随机生成 · ' + parts.join(' · '));
  els.randomBtn.classList.add('rolling');
  setTimeout(() => els.randomBtn.classList.remove('rolling'), 600);
}

async function generate() {
  if (generating) return;
  if (!state.png && !state.pdf && !state.art) return toast('请至少选择一种输出格式', true);
  if (previewAbort) previewAbort.abort();
  previewSeq++;
  generating = true;
  els.generateBtn.disabled = true;
  els.downloads.hidden = true;
  els.loading.classList.add('show');
  els.loading.querySelector('b').textContent = '正在生成成品';
  els.loading.querySelector('small').textContent = '300 DPI · VECTOR PDF';
  setStatus('GENERATING');
  const messages = ['追踪等高线', '排版与标注', '输出 300 dpi', '嵌入矢量字体'];
  let mi = 0;
  progressTimer = setInterval(() => {
    els.loading.querySelector('b').textContent = messages[mi++ % messages.length] + '…';
  }, 1800);
  try {
    const res = await fetch('/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload())
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '生成失败');
    renderFiles(data.files);
    els.zipBtn.href = data.zipUrl;
    els.downloads.hidden = false;
    setStatus(`DONE · ${(data.elapsed / 1000).toFixed(1)} S`);
    toast(`生成完成：${data.files.length} 个文件`);
    setTimeout(() => els.downloads.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 150);
  } catch (err) {
    setStatus('ERROR');
    toast(err.message, true);
  } finally {
    generating = false;
    els.generateBtn.disabled = false;
    clearInterval(progressTimer);
    els.loading.classList.remove('show');
    els.loading.querySelector('b').textContent = '正在追踪等高线';
    els.loading.querySelector('small').textContent = 'MARCHING SQUARES';
  }
}

function renderFiles(files) {
  const typeOrder = { png: 0, pdf: 1, svg: 2, json: 3 };
  const sorted = [...files].sort((a, b) => {
    const ext = f => f.name.split('.').pop().toLowerCase();
    const art = f => f.name.includes('_art_') ? 1 : 0;
    return art(a) - art(b) || (typeOrder[ext(a)] ?? 4) - (typeOrder[ext(b)] ?? 4);
  });
  els.fileList.innerHTML = sorted.map(f => {
    const ext = f.name.split('.').pop().toUpperCase();
    const type = ext === 'JSON' ? 'META' : ext;
    const size = f.size > 1024 * 1024 ? `${(f.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(f.size / 1024))} KB`;
    return `<a class="file-row" href="${f.url}" download>
      <span class="file-type">${type}</span>
      <span class="file-label" title="${escapeHtml(f.name)}">${escapeHtml(f.label)}</span>
      <span class="file-size">${size}</span>
      <span class="file-arrow">↓</span>
    </a>`;
  }).join('');
}

function downloadPreview() {
  if (!lastPreview) return toast('预览尚未生成', true);
  const a = document.createElement('a');
  a.href = lastPreview.image;
  a.download = `topo-preview-${state.style}.png`;
  a.click();
}

function toast(message, error = false) {
  els.toast.textContent = message;
  els.toast.classList.toggle('err', !!error);
  els.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove('show'), 3200);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}



