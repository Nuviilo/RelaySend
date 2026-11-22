const {app, BrowserWindow, ipcMain} = require('electron');
const {once} = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const activeDownloads = new Map();

function resolveIcon() {
  const ico = path.join(__dirname, '..', 'build', 'icon.ico');
  if (fs.existsSync(ico)) return ico;
  const png = path.join(__dirname, '..', 'build', 'icon.png');
  if (fs.existsSync(png)) return png;
  return undefined;
}

function sanitizeSegment(raw, fallback = 'file') {
  const cleaned = String(raw || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback;
  return cleaned;
}

function resolveUniqueFilePath(baseDir, safeRelativeSegments, safeFileName) {
  const downloadsRoot = path.resolve(baseDir);
  const targetDir = path.resolve(downloadsRoot, ...safeRelativeSegments);
  if (targetDir !== downloadsRoot && !targetDir.startsWith(downloadsRoot + path.sep)) {
    throw new Error('Invalid destination path');
  }
  fs.mkdirSync(targetDir, {recursive: true});

  const ext = path.extname(safeFileName);
  const stem = ext ? safeFileName.slice(0, -ext.length) : safeFileName;
  let candidate = path.join(targetDir, safeFileName);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(targetDir, `${stem} (${counter})${ext}`);
    counter += 1;
  }
  return candidate;
}

function registerFileIpc() {
  ipcMain.handle('relay:start-file', (_event, payload) => {
    try {
      const transferId = String(payload?.transferId || '');
      if (!transferId) return {ok: false};

      const prev = activeDownloads.get(transferId);
      if (prev) {
        activeDownloads.delete(transferId);
        prev.stream.destroy();
        try {
          if (fs.existsSync(prev.filePath)) fs.unlinkSync(prev.filePath);
        } catch {}
      }

      const downloadsDir = app.getPath('downloads');
      const safeName = sanitizeSegment(payload?.fileName, 'file');
      const relRaw = typeof payload?.relativePath === 'string' ? payload.relativePath : '';
      const relParts = relRaw
        .replace(/\\/g, '/')
        .split('/')
        .map((p) => p.trim())
        .filter((p) => p && p !== '.' && p !== '..');
      const folderParts = relParts.length > 1 ? relParts.slice(0, -1).map((p) => sanitizeSegment(p, 'folder')) : [];

      const filePath = resolveUniqueFilePath(downloadsDir, folderParts, safeName);
      const stream = fs.createWriteStream(filePath);
      activeDownloads.set(transferId, {stream, filePath});
      return {ok: true, filePath};
    } catch {
      return {ok: false};
    }
  });

  ipcMain.handle('relay:append-chunk', async (_event, payload) => {
    const transferId = String(payload?.transferId || '');
    const entry = activeDownloads.get(transferId);
    if (!entry || !payload?.chunk) return false;
    try {
      const buf = Buffer.from(payload.chunk);
      if (!entry.stream.write(buf)) {
        await once(entry.stream, 'drain');
      }
      return true;
    } catch {
      activeDownloads.delete(transferId);
      entry.stream.destroy();
      try {
        if (fs.existsSync(entry.filePath)) fs.unlinkSync(entry.filePath);
      } catch {}
      return false;
    }
  });

  ipcMain.handle('relay:finish-file', async (_event, payload) => {
    const transferId = String(payload?.transferId || '');
    const entry = activeDownloads.get(transferId);
    if (!entry) return false;
    activeDownloads.delete(transferId);
    try {
      await new Promise((resolve, reject) => {
        entry.stream.on('error', reject);
        entry.stream.end(resolve);
      });
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('relay:abort-file', (_event, payload) => {
    const transferId = String(payload?.transferId || '');
    const entry = activeDownloads.get(transferId);
    if (!entry) return;
    activeDownloads.delete(transferId);
    entry.stream.destroy();
    try {
      if (fs.existsSync(entry.filePath)) fs.unlinkSync(entry.filePath);
    } catch {}
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 380,
    minHeight: 540,
    title: 'Relay',
    icon: resolveIcon(),
    backgroundColor: '#FAFAFA',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.RELAY_DEV_URL) {
    win.loadURL(process.env.RELAY_DEV_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('app.relay.share');
  }
  registerFileIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  for (const entry of activeDownloads.values()) {
    entry.stream.destroy();
  }
  activeDownloads.clear();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
