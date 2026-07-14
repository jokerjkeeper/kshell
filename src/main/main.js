'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { Vault } = require('./vault');
const { SSHManager } = require('./ssh');
const xshell = require('./xshell-import');

let mainWindow = null;
const vault = new Vault(path.join(app.getPath('userData'), 'kshell.vault'));
const ssh = new SSHManager();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#1e1e1e',
    title: 'kshell',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 除錯：設定 KSHELL_DEBUG=1 時，將渲染層 console 與載入失敗轉發到主進程 stdout。
  if (process.env.KSHELL_DEBUG) {
    mainWindow.webContents.on('console-message', (...args) => {
      // Electron 舊版：(event, level, message)；新版：(event) 帶 message 屬性
      const msg = typeof args[2] === 'string' ? args[2] : (args[0] && args[0].message);
      console.log(`[renderer] ${msg}`);
    });
    mainWindow.webContents.on('did-fail-load', (e, code, desc, url) => {
      console.log(`[did-fail-load] ${code} ${desc} ${url}`);
    });
  }
}

// ---- SSH 事件轉發到渲染層 ----
function forward(event) {
  ssh.on(event, (tabId, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`ssh:${event}`, { tabId, payload });
    }
  });
}
['data', 'ready', 'close', 'error'].forEach(forward);

// ---- Vault IPC ----
ipcMain.handle('vault:status', () => ({ initialized: vault.isInitialized(), unlocked: vault.isUnlocked() }));
ipcMain.handle('vault:initialize', (e, pw) => { vault.initialize(pw); return true; });
ipcMain.handle('vault:unlock', (e, pw) => vault.unlock(pw));
ipcMain.handle('vault:lock', () => { vault.lock(); return true; });
ipcMain.handle('vault:changeMaster', (e, pw) => { vault.changeMasterPassword(pw); return true; });

// ---- Session IPC ----
ipcMain.handle('sessions:list', () => vault.getSessions());
ipcMain.handle('sessions:save', (e, session) => vault.upsertSession(session));
ipcMain.handle('sessions:delete', (e, id) => { vault.deleteSession(id); return true; });

// ---- Xshell 導入 ----
ipcMain.handle('xshell:guessDir', () => xshell.guessXshellSessionsDir());
ipcMain.handle('xshell:pickDir', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '選擇 Xshell Sessions 資料夾',
    properties: ['openDirectory'],
    defaultPath: xshell.guessXshellSessionsDir() || undefined,
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});
ipcMain.handle('xshell:import', (e, dir) => {
  const targetDir = dir || xshell.guessXshellSessionsDir();
  if (!targetDir) throw new Error('找不到 Xshell Sessions 目錄，請手動選擇。');
  const parsed = xshell.importFromDirectory(targetDir);
  const added = vault.importSessions(parsed);
  return { added, total: parsed.length, dir: targetDir };
});

// ---- SSH IPC ----
ipcMain.handle('ssh:connect', (e, { tabId, sessionId, runtimePassword, cols, rows }) => {
  const session = vault.getSessions().find((s) => s.id === sessionId);
  if (!session) throw new Error('找不到 session。');
  const password = runtimePassword || session.password || '';
  ssh.connect(tabId, {
    host: session.host,
    port: session.port,
    username: session.username,
    password,
    privateKeyPath: session.authMethod === 'privateKey' ? session.privateKeyPath : '',
    passphrase: runtimePassword && session.authMethod === 'privateKey' ? runtimePassword : '',
    cols: cols || (session.terminal && session.terminal.cols) || 80,
    rows: rows || (session.terminal && session.terminal.rows) || 24,
    term: 'xterm-256color',
  });
  return true;
});
ipcMain.handle('ssh:write', (e, { tabId, data }) => { ssh.write(tabId, data); return true; });
ipcMain.handle('ssh:resize', (e, { tabId, cols, rows }) => { ssh.resize(tabId, cols, rows); return true; });
ipcMain.handle('ssh:disconnect', (e, { tabId }) => { ssh.disconnect(tabId); return true; });

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  ssh.disconnectAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
