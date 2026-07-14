'use strict';

// SSH 連線管理：以 tabId 為索引管理多條並行連線，透過 EventEmitter 對外送出
// data / close / error / ready 事件，供主進程轉發到對應的終端分頁。

const { Client } = require('ssh2');
const { EventEmitter } = require('events');
const fs = require('fs');

class SSHManager extends EventEmitter {
  constructor() {
    super();
    this.connections = new Map(); // tabId -> { client, stream }
  }

  /**
   * 建立一條 SSH 連線並開啟互動 shell。
   * @param {string} tabId 分頁識別
   * @param {object} opts { host, port, username, password, privateKeyPath, passphrase, cols, rows, term }
   */
  connect(tabId, opts) {
    if (this.connections.has(tabId)) {
      throw new Error(`分頁 ${tabId} 已有連線。`);
    }
    const client = new Client();
    const entry = { client, stream: null };
    this.connections.set(tabId, entry);

    client.on('ready', () => {
      client.shell(
        { term: opts.term || 'xterm-256color', cols: opts.cols || 80, rows: opts.rows || 24 },
        (err, stream) => {
          if (err) {
            this.emit('error', tabId, err.message);
            this.disconnect(tabId);
            return;
          }
          entry.stream = stream;
          this.emit('ready', tabId);
          stream.on('data', (data) => this.emit('data', tabId, data.toString('utf8')));
          stream.stderr.on('data', (data) => this.emit('data', tabId, data.toString('utf8')));
          stream.on('close', () => this.disconnect(tabId));
        }
      );
    });

    client.on('error', (err) => {
      this.emit('error', tabId, err.message);
      this.connections.delete(tabId);
    });

    client.on('close', () => {
      this.emit('close', tabId);
      this.connections.delete(tabId);
    });

    // keyboard-interactive 後援（部分伺服器以此方式收密碼）
    client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
      finish(prompts.map(() => opts.password || ''));
    });

    const connectConfig = {
      host: opts.host,
      port: opts.port || 22,
      username: opts.username,
      readyTimeout: 20000,
      keepaliveInterval: 30000,
      tryKeyboard: true,
    };

    if (opts.privateKeyPath) {
      try {
        connectConfig.privateKey = fs.readFileSync(opts.privateKeyPath);
        if (opts.passphrase) connectConfig.passphrase = opts.passphrase;
      } catch (err) {
        this.connections.delete(tabId);
        throw new Error(`讀取私鑰失敗：${err.message}`);
      }
    }
    if (opts.password) {
      connectConfig.password = opts.password;
    }

    client.connect(connectConfig);
  }

  /** 將使用者輸入寫入遠端 shell。 */
  write(tabId, data) {
    const entry = this.connections.get(tabId);
    if (entry && entry.stream) entry.stream.write(data);
  }

  /** 通知遠端終端尺寸變更。 */
  resize(tabId, cols, rows) {
    const entry = this.connections.get(tabId);
    if (entry && entry.stream) entry.stream.setWindow(rows, cols, 0, 0);
  }

  /** 關閉指定分頁的連線。 */
  disconnect(tabId) {
    const entry = this.connections.get(tabId);
    if (!entry) return;
    try {
      if (entry.stream) entry.stream.end();
      entry.client.end();
    } catch (err) {
      /* ignore */
    }
    this.connections.delete(tabId);
  }

  /** 關閉全部連線（結束程式時使用）。 */
  disconnectAll() {
    for (const tabId of Array.from(this.connections.keys())) {
      this.disconnect(tabId);
    }
  }
}

module.exports = { SSHManager };
