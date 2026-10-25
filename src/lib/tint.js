'use strict';
const sharp = require('sharp');

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rampAt(ramp, t) {
  const x = Math.max(0, Math.min(1, t)) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(x));
  const f = x - i;
  const a = hexToRgb(ramp[i]), b = hexToRgb(ramp[i + 1]);
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

async function makeTint(terrain, style, opts = {}) {
  const { width: w, height: h, z } = terrain;
  const paper = hexToRgb(style.paper);
  const strength = opts.strength ?? (style.dark ? 0.2 : 0.105);
  const shadeStrength = opts.shadeStrength ?? (style.dark ? 0.09 : 0.085);
  const buf = Buffer.alloc(w * h * 3);
  const cellX = 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = z[y * w + x];
      const t = (v - terrain.min) / Math.max(1, terrain.max - terrain.min);
      const elev = rampAt(style.ramp, Math.pow(t, 0.92));
      // NW light hillshade from a smoothed local gradient.
      const xl = Math.max(0, x - 1), xr = Math.min(w - 1, x + 1);
      const yu = Math.max(0, y - 1), yd = Math.min(h - 1, y + 1);
      const dx = (z[y * w + xr] - z[y * w + xl]) / (xr - xl + 1e-6);
      const dy = (z[yd * w + x] - z[yu * w + x]) / (yd - yu + 1e-6);
      const shade = Math.max(-1, Math.min(1, (-dx * 0.8 - dy * 0.6) / 38));
      const relief = 1 + shade * shadeStrength;
      const i = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) {
        let color = paper[c] * (1 - strength) + elev[c] * strength;
        color *= relief;
        buf[i + c] = Math.max(0, Math.min(255, Math.round(color)));
      }
    }
  }
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

module.exports = { makeTint, hexToRgb };
