'use strict';

// 透過 contextBridge 暴露安全的 IPC API 給渲染層（contextIsolation 開啟，
// 渲染層無法直接存取 Node）。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kshell', {
  vault: {
    status: () => ipcRenderer.invoke('vault:status'),
    initialize: (pw) => ipcRenderer.invoke('vault:initialize', pw),
    unlock: (pw) => ipcRenderer.invoke('vault:unlock', pw),
    lock: () => ipcRenderer.invoke('vault:lock'),
    changeMaster: (pw) => ipcRenderer.invoke('vault:changeMaster', pw),
  },
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    save: (session) => ipcRenderer.invoke('sessions:save', session),
    delete: (id) => ipcRenderer.invoke('sessions:delete', id),
  },
  xshell: {
    guessDir: () => ipcRenderer.invoke('xshell:guessDir'),
    pickDir: () => ipcRenderer.invoke('xshell:pickDir'),
    import: (dir) => ipcRenderer.invoke('xshell:import', dir),
  },
  ssh: {
    connect: (args) => ipcRenderer.invoke('ssh:connect', args),
    write: (tabId, data) => ipcRenderer.invoke('ssh:write', { tabId, data }),
    resize: (tabId, cols, rows) => ipcRenderer.invoke('ssh:resize', { tabId, cols, rows }),
    disconnect: (tabId) => ipcRenderer.invoke('ssh:disconnect', { tabId }),
    onData: (cb) => ipcRenderer.on('ssh:data', (e, msg) => cb(msg)),
    onReady: (cb) => ipcRenderer.on('ssh:ready', (e, msg) => cb(msg)),
    onClose: (cb) => ipcRenderer.on('ssh:close', (e, msg) => cb(msg)),
    onError: (cb) => ipcRenderer.on('ssh:error', (e, msg) => cb(msg)),
  },
});
