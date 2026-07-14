'use strict';

// Xshell .xsh session 導入。
// .xsh 為 INI 格式；本模組解析連線與終端設定，映射為 kshell session。
// 注意：Xshell 的 Password 欄位為其專有加密，且與使用者的 Xshell 主密碼綁定，
// 此處「不」嘗試解密，僅導入連線中繼資料；密碼由使用者於 kshell 保險庫中另行填入。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 讀取檔案並處理 BOM / UTF-16LE 編碼（Xshell 可能以任一種保存）。 */
function readTextFile(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString('utf16le').replace(/^﻿/, '');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString('utf8');
  }
  return buf.toString('utf8');
}

/** 極簡 INI 解析：回傳 { section: { key: value } }。 */
function parseIni(text) {
  const result = {};
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      current = sec[1];
      result[current] = result[current] || {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1 || current === null) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    result[current][key] = value;
  }
  return result;
}

/** Xshell 常見 CodePage 對應到易讀的編碼名稱。 */
function codePageToEncoding(cp) {
  const map = { '65001': 'UTF-8', '936': 'GBK', '950': 'Big5', '932': 'Shift_JIS', '-1': 'Default' };
  return map[String(cp)] || 'Default';
}

/**
 * 解析單一 .xsh 檔案為 kshell session 物件。
 * @param {string} filePath
 * @param {string} group 群組（來自資料夾結構）
 * @returns {object|null}
 */
function parseXshFile(filePath, group) {
  let ini;
  try {
    ini = parseIni(readTextFile(filePath));
  } catch (err) {
    return null;
  }
  const conn = ini['CONNECTION'] || {};
  const auth = ini['CONNECTION:AUTHENTICATION'] || {};
  const term = ini['TERMINAL'] || {};
  const win = ini['TERMINAL:WINDOW'] || {};

  const protocol = (conn.Protocol || 'SSH').toUpperCase();
  const host = conn.Host || '';
  if (!host) return null; // 無主機視為無效

  const name = path.basename(filePath).replace(/\.xsh$/i, '');
  // 以相對識別（群組+名稱）產生穩定 id，供重複導入去重。
  const stableKey = `${group}/${name}/${host}`;
  const id = 'xsh-' + crypto.createHash('sha1').update(stableKey).digest('hex').slice(0, 16);

  const hasKey = !!(auth.UserKey && auth.UserKey.trim());

  return {
    id,
    name,
    group: group || 'imported',
    protocol,                       // SSH / TELNET / ...
    host,
    port: parseInt(conn.Port, 10) || (protocol === 'TELNET' ? 23 : 22),
    username: auth.UserName || '',
    authMethod: hasKey ? 'privateKey' : 'password',
    privateKeyPath: hasKey ? auth.UserKey : '',
    // 密碼刻意留空：Xshell 加密密碼不導入，改由使用者在保險庫中填寫。
    password: '',
    terminal: {
      type: term.Type || 'xterm',
      cols: parseInt(term.Cols, 10) || 80,
      rows: parseInt(term.Rows, 10) || 24,
      encoding: codePageToEncoding(term.CodePage),
      colorScheme: win.ColorScheme || 'ANSI Colors on Black',
      fontFace: win.FontFace || 'Courier New',
      fontSize: parseInt(win.FontSize, 10) || 12,
    },
    source: 'xshell',
    _importedFrom: filePath,
  };
}

/**
 * 遞迴掃描 Xshell Sessions 目錄，回傳所有解析出的 session。
 * @param {string} rootDir Sessions 根目錄
 * @returns {object[]}
 */
function importFromDirectory(rootDir) {
  const sessions = [];
  function walk(dir, group) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const nextGroup = group ? `${group}/${entry.name}` : entry.name;
        walk(full, nextGroup);
      } else if (entry.isFile() && /\.xsh$/i.test(entry.name)) {
        const s = parseXshFile(full, group || 'imported');
        if (s) sessions.push(s);
      }
    }
  }
  walk(rootDir, '');
  return sessions;
}

/** 常見的 Xshell Sessions 目錄猜測（Windows）。 */
function guessXshellSessionsDir() {
  const candidates = [];
  const docs = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Documents') : null;
  if (docs) {
    candidates.push(path.join(docs, 'NetSarang', 'Xshell', 'Sessions'));
    candidates.push(path.join(docs, 'NetSarang Computer'));
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

module.exports = { importFromDirectory, parseXshFile, guessXshellSessionsDir };
