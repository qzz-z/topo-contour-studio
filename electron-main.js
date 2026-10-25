'use strict';
const { app, BrowserWindow, shell, dialog, Menu, utilityProcess } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');

const APP_ID = 'com.topocontour.studio';
const PRODUCT = 'Topo Contour Studio';
let mainWindow = null;
let splashWindow = null;
let serverProcess = null;
let serverUrl = '';
let isQuitting = false;
let logStream = null;
let logPath = '';

app.setAppUserModelId(APP_ID);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(boot).catch(err => fatal(err));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForServer(url, timeout = 30000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeout) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) {
        const data = await res.json();
        if (data.ok) return data;
      }
    } catch (err) { lastError = err; }
    await sleep(250);
  }
  throw new Error(`本地服务启动超时${lastError ? `：${lastError.message}` : ''}`);
}

function splashHtml() {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;height:100vh;background:#f3eee3;color:#20382d;font-family:'Noto Sans SC','Microsoft YaHei',sans-serif;display:flex;align-items:center;justify-content:center}
    .card{width:100%;padding:34px 38px;border:1px solid #d8cfbd;position:relative}
    .top{font-family:Consolas,monospace;font-size:9px;letter-spacing:.24em;color:#7c8779;display:flex;justify-content:space-between}
    h1{font-family:'Noto Serif SC','Songti SC',serif;font-size:30px;font-weight:600;letter-spacing:.06em;margin:22px 0 8px}
    p{font-size:11px;color:#7c8779;letter-spacing:.06em;margin:0}
    .bar{height:2px;background:#e4dbca;margin-top:26px;overflow:hidden}
    .bar i{display:block;width:34%;height:100%;background:#b45b34;animation:load 1.35s ease-in-out infinite}
    @keyframes load{0%{transform:translateX(-110%)}100%{transform:translateX(330%)}}
    .foot{display:flex;justify-content:space-between;margin-top:14px;font-family:Consolas,monospace;font-size:8px;letter-spacing:.14em;color:#9a9f90}
  </style></head><body><div class="card">
    <div class="top"><span>TOPO / CONTOUR</span><span>LOCAL APP</span></div>
    <h1>海拔等高线生成器</h1>
    <p>正在启动本地图形引擎，首次启动可能需要 10–20 秒…</p>
    <div class="bar"><i></i></div>
    <div class="foot"><span>A3 · 300 DPI · SRTM</span><span>INITIALIZING</span></div>
  </div></body></html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function showSplash() {
  splashWindow = new BrowserWindow({
    width: 460,
    height: 300,
    frame: false,
    resizable: false,
    show: true,
    backgroundColor: '#F3EEE3',
    skipTaskbar: false,
    title: PRODUCT,
    icon: path.join(__dirname, 'web', 'icon-512.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  splashWindow.loadURL(splashHtml());
}

async function startServer() {
  const port = await getFreePort();
  let base;
  try { base = path.join(app.getPath('documents'), PRODUCT); }
  catch (e) { base = path.join(app.getPath('userData'), PRODUCT); }
  const outputDir = path.join(base, 'output');
  const uploadDir = path.join(base, 'uploads');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(uploadDir, { recursive: true });

  try {
    const logs = app.getPath('logs');
    fs.mkdirSync(logs, { recursive: true });
    logPath = path.join(logs, 'server.log');
  } catch (e) {
    logPath = path.join(app.getPath('userData'), 'server.log');
  }
  logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStream.write(`\n===== ${new Date().toISOString()} =====\n`);

  const serverFile = path.join(__dirname, 'server.js');
  const env = {
    ...process.env,
    TOPO_NO_OPEN: '1',
    PORT: String(port),
    HOST: '127.0.0.1',
    TOPO_OUTPUT_DIR: outputDir,
    TOPO_UPLOAD_DIR: uploadDir,
    TOPO_OUTPUT_LABEL: '文档 / Topo Contour Studio / output'
  };
  serverProcess = utilityProcess.fork(serverFile, [], {
    env,
    serviceName: 'Topo Contour Engine',
    stdio: 'pipe'
  });
  serverProcess.stdout.on('data', chunk => logStream.write(chunk));
  serverProcess.stderr.on('data', chunk => logStream.write(chunk));
  serverProcess.on('exit', code => {
    if (isQuitting) return;
    dialog.showErrorBox('生成引擎已停止', `本地生成服务意外退出（代码 ${code}）。\n日志：${logPath}`);
    app.quit();
  });
  serverProcess.on('error', err => {
    logStream.write(`\n[spawn error] ${err.stack || err.message}\n`);
  });

  serverUrl = `http://127.0.0.1:${port}`;
  await waitForServer(serverUrl, 60000);
  return serverUrl;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: '#F3EEE3',
    title: PRODUCT,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'web', 'icon-512.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  mainWindow.loadURL(serverUrl);
  mainWindow.once('ready-to-show', () => {
    if (splashWindow) { splashWindow.close(); splashWindow = null; }
    mainWindow.show();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(serverUrl)) return { action: 'allow' };
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(serverUrl)) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

async function boot() {
  Menu.setApplicationMenu(null);
  showSplash();
  try {
    await startServer();
    createWindow();
  } catch (err) {
    if (splashWindow) { splashWindow.close(); splashWindow = null; }
    fatal(err);
  }
}

function fatal(err) {
  const message = err && err.stack ? err.stack : String(err);
  try { if (logStream) logStream.write(`\n[fatal] ${message}\n`); } catch (e) {}
  dialog.showErrorBox('Topo Contour Studio 启动失败', `${err.message || message}\n\n日志：${logPath || '不可用'}`);
  app.quit();
}

function stopServer() {
  if (serverProcess && !serverProcess.killed) {
    try { serverProcess.kill(); } catch (e) {}
    serverProcess = null;
  }
  if (logStream) { try { logStream.end(); } catch (e) {} logStream = null; }
}

app.on('before-quit', () => { isQuitting = true; stopServer(); });
app.on('window-all-closed', () => { app.quit(); });
app.on('activate', () => {
  if (mainWindow) mainWindow.show();
});
