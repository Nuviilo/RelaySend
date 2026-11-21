const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');

function resolveIcon() {
  const ico = path.join(__dirname, '..', 'build', 'icon.ico');
  if (fs.existsSync(ico)) return ico;
  const png = path.join(__dirname, '..', 'build', 'icon.png');
  if (fs.existsSync(png)) return png;
  return undefined;
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
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
