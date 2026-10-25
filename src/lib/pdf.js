'use strict';
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const SVGtoPDF = require('svg-to-pdfkit');

const FONTS = {
  serif: 'C:/Windows/Fonts/STSONG.TTF',
  sans: 'C:/Windows/Fonts/simhei.ttf',
  mono: 'C:/Windows/Fonts/CascadiaMono.ttf',
  georgia: 'C:/Windows/Fonts/georgia.ttf',
  georgiaBold: 'C:/Windows/Fonts/georgiab.ttf'
};

function svgToPdf(svg, file) {
  const fitted = svg.replace(/<svg([^>]*)width="[^"]+" height="[^"]+"/, '<svg$1width="841.89" height="1190.55"');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [841.89, 1190.55], margin: 0, compress: true, info: { Title: 'Elevation Contour Study', Creator: 'Topo Contour Studio' } });
    const stream = fs.createWriteStream(file);
    doc.pipe(stream);
    doc.registerFont('NSerif', FONTS.serif);
    doc.registerFont('NSans', FONTS.sans);
    doc.registerFont('NMono', FONTS.mono);
    doc.registerFont('NGeorgia', FONTS.georgia);
    doc.registerFont('NGeorgia-Bold', FONTS.georgiaBold);
    const fontCallback = (family, bold, italic, options) => {
      const f = String(family).toLowerCase();
      if (f.includes('mono') || f.includes('cascadia')) return 'NMono';
      if (f.includes('georgia') || f.includes('times')) return bold ? 'NGeorgia-Bold' : 'NGeorgia';
      if (f.includes('sans')) return 'NSans';
      if (f.includes('serif')) {
        if (bold) options.fauxBold = true;
        return 'NSerif';
      }
      return 'NSans';
    };
    try {
      SVGtoPDF(doc, fitted, 0, 0, {
        assumePt: true,
        fontCallback,
        warningCallback: (msg) => { if (!/font/i.test(msg)) console.warn('[pdf]', msg); }
      });
      doc.end();
      stream.on('finish', () => resolve(fs.statSync(file).size));
      stream.on('error', reject);
    } catch (err) { reject(err); }
  });
}

module.exports = { svgToPdf };
