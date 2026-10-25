'use strict';
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const styles = [
  ['atlas', '01  ATLAS / 暖白 · 松墨'],
  ['bone', '02  BONE / 骨白 · 单色'],
  ['nocturne', '03  NOCTURNE / 夜墨 · 青线'],
  ['cobalt', '04  COBALT / 钴蓝 · 图纸']
];
const W = 1640, margin = 42, gap = 36, imgW = Math.floor((W - margin * 2 - gap) / 2);
const imgH = Math.round(imgW * 420 / 297);
const header = 118;
const rowGap = 62;
const H = header + imgH * 2 + rowGap + 58 + margin;

(async () => {
  const composites = [];
  const labels = [];
  for (let i = 0; i < styles.length; i++) {
    const [name, caption] = styles[i];
    const file = path.join('output', `gongga_${name}_poster.png`);
    if (!fs.existsSync(file)) throw new Error(`Missing ${file}; run the generator first.`);
    const col = i % 2, row = Math.floor(i / 2);
    const left = margin + col * (imgW + gap);
    const top = header + row * (imgH + rowGap);
    const buf = await sharp(file).resize({ width: imgW }).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
    const meta = await sharp(buf).metadata();
    composites.push({ input: buf, left, top });
    labels.push({ left, top: top + (meta.height || imgH) + 26, text: caption });
  }
  const labelSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <text x="${margin}" y="52" font-family="Georgia, 'Noto Serif SC', serif" font-size="25" letter-spacing="4.5" fill="#20382D">ELEVATION CONTOUR STUDY</text>
    <text x="${margin}" y="82" font-family="'Noto Sans SC', 'Microsoft YaHei', sans-serif" font-size="15.5" letter-spacing="1.4" fill="#6C7A6B">贡嘎山 · 四种版面配色 / A3 · 300 DPI · SVG + PNG + PDF</text>
    <line x1="${margin}" y1="98" x2="${W - margin}" y2="98" stroke="#BEB5A3" stroke-width="1"/>
    ${labels.map(l => `<text x="${l.left}" y="${l.top}" font-family="'Cascadia Mono', Consolas, monospace" font-size="14" letter-spacing="1.2" fill="#4A6153">${l.text}</text>`).join('')}
    <line x1="${margin}" y1="${H - 30}" x2="${W - margin}" y2="${H - 30}" stroke="#BEB5A3" stroke-width="1"/>
    <text x="${margin}" y="${H - 12}" font-family="'Cascadia Mono', Consolas, monospace" font-size="10" letter-spacing="1.4" fill="#7C8779">TOPO CONTOUR STUDIO  /  SRTM 1″  /  MINYA KONKA</text>
    <text x="${W - margin}" y="${H - 12}" text-anchor="end" font-family="'Cascadia Mono', Consolas, monospace" font-size="10" letter-spacing="1.4" fill="#7C8779">2026  /  PLATE 01</text>
  </svg>`;
  await sharp({ create: { width: W, height: H, channels: 3, background: '#EEE8DC' } })
    .composite([...composites, { input: Buffer.from(labelSvg), left: 0, top: 0 }])
    .png({ compressionLevel: 9 })
    .withMetadata({ density: 150 })
    .toFile('output/contact_sheet.png');
  console.log(`[contact] output/contact_sheet.png  ${W}×${H}`);
})();
