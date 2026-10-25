'use strict';

const styles = {
  atlas: {
    name: 'atlas',
    label: '暖白 · 松墨',
    paper: '#F3EEE3',
    paperDeep: '#EAE2D2',
    ink: '#20382D',
    inkSoft: '#4A6153',
    muted: '#7C8779',
    rule: '#BEB5A3',
    accent: '#B45B34',
    ramp: ['#7D8F7B', '#5E7664', '#405D4B', '#294636', '#183126'],
    footerInk: '#675F51',
    dark: false
  },
  bone: {
    name: 'bone',
    label: '骨白 · 单色',
    paper: '#F6F2E8',
    paperDeep: '#EDE7D9',
    ink: '#26251F',
    inkSoft: '#4E4B42',
    muted: '#8A8476',
    rule: '#C8C0AE',
    accent: '#9C5D3C',
    ramp: ['#8C877B', '#6E6A60', '#4F4C45', '#33322C', '#1D1C18'],
    footerInk: '#6A6559',
    dark: false
  },
  nocturne: {
    name: 'nocturne',
    label: '夜墨 · 青线',
    paper: '#101B22',
    paperDeep: '#0A1318',
    ink: '#C4DCD5',
    inkSoft: '#8EAAA4',
    muted: '#65817C',
    rule: '#354C4B',
    accent: '#E2A76F',
    ramp: ['#7D9B94', '#9CB8B1', '#BBD2CB', '#D8E6E1', '#F0F5F2'],
    footerInk: '#8FA6A0',
    dark: true
  },
  cobalt: {
    name: 'cobalt',
    label: '钴蓝 · 图纸',
    paper: '#17386B',
    paperDeep: '#0F2A53',
    ink: '#E7EEF7',
    inkSoft: '#B3C7DE',
    muted: '#819CBC',
    rule: '#3F5D88',
    accent: '#F0C27B',
    ramp: ['#8FA8C6', '#B1C4DA', '#D0DDEB', '#E8EFF7', '#FFFFFF'],
    footerInk: '#A7BBD2',
    dark: true
  }
};

const layout = {
  width: 297,
  height: 420,
  margin: 20,
  art: { x: 30, y: 92, w: 237 },
  titleSize: 31,
  showTicks: true,
  showLabels: true,
  showCompass: true,
  showScale: true,
  showColorbar: true,
  showSummit: true,
  paperTexture: false
};

module.exports = { styles, layout };
