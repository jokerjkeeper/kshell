'use strict';

// 主密碼保險庫：所有連線設定（含密碼）以主密碼派生的金鑰加密後保存於本地。
// 加密：scrypt 派生 32 bytes 金鑰 + AES-256-GCM（GCM auth tag 同時作為主密碼驗證器）。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 32;

class Vault {
  /**
   * @param {string} filePath 保險庫檔案完整路徑
   */
  constructor(filePath) {
    this.filePath = filePath;
    this.key = null;      // 解鎖後保存於記憶體的對稱金鑰
    this.data = null;     // 解鎖後的明文資料 { sessions: [...] }
  }

  /** 保險庫檔案是否已存在（是否已初始化過主密碼）。 */
  isInitialized() {
    return fs.existsSync(this.filePath);
  }

  /** 目前是否已解鎖。 */
  isUnlocked() {
    return this.key !== null && this.data !== null;
  }

  _deriveKey(password, salt) {
    return crypto.scryptSync(password, salt, KEY_LEN, SCRYPT_PARAMS);
  }

  /**
   * 首次建立保險庫並設定主密碼。
   * @param {string} masterPassword
   */
  initialize(masterPassword) {
    if (this.isInitialized()) {
      throw new Error('保險庫已存在，無法重複初始化。');
    }
    const salt = crypto.randomBytes(16);
    this.key = this._deriveKey(masterPassword, salt);
    this._salt = salt;
    this.data = { sessions: [] };
    this._persist();
  }

  /**
   * 以主密碼解鎖保險庫。
   * @param {string} masterPassword
   * @returns {boolean} 密碼正確與否
   */
  unlock(masterPassword) {
    if (!this.isInitialized()) {
      throw new Error('保險庫尚未初始化。');
    }
    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    const salt = Buffer.from(raw.salt, 'hex');
    const iv = Buffer.from(raw.iv, 'hex');
    const tag = Buffer.from(raw.tag, 'hex');
    const ciphertext = Buffer.from(raw.ciphertext, 'hex');
    const key = this._deriveKey(masterPassword, salt);
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      this.key = key;
      this._salt = salt;
      this.data = JSON.parse(plaintext.toString('utf8'));
      if (!Array.isArray(this.data.sessions)) this.data.sessions = [];
      return true;
    } catch (err) {
      // GCM 驗證失敗 => 主密碼錯誤
      return false;
    }
  }

  /** 鎖定：清除記憶體中的金鑰與明文。 */
  lock() {
    this.key = null;
    this.data = null;
    this._salt = null;
  }

  _assertUnlocked() {
    if (!this.isUnlocked()) throw new Error('保險庫未解鎖。');
  }

  /** 將目前明文資料加密寫回磁碟。 */
  _persist() {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(this.data), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const out = {
      version: 1,
      salt: this._salt.toString('hex'),
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      ciphertext: ciphertext.toString('hex'),
    };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, this.filePath); // 原子性寫入，避免中途損毀
  }

  /** 變更主密碼（需目前已解鎖）。 */
  changeMasterPassword(newPassword) {
    this._assertUnlocked();
    this._salt = crypto.randomBytes(16);
    this.key = this._deriveKey(newPassword, this._salt);
    this._persist();
  }

  // ---- Session CRUD ----

  getSessions() {
    this._assertUnlocked();
    return this.data.sessions;
  }

  /**
   * 新增或更新 session（依 id 判斷）。
   * @param {object} session
   */
  upsertSession(session) {
    this._assertUnlocked();
    const list = this.data.sessions;
    const idx = list.findIndex((s) => s.id === session.id);
    if (idx >= 0) list[idx] = session;
    else list.push(session);
    this._persist();
    return session;
  }

  deleteSession(id) {
    this._assertUnlocked();
    this.data.sessions = this.data.sessions.filter((s) => s.id !== id);
    this._persist();
  }

  /** 批次匯入 sessions（Xshell 導入用），依 id 去重。 */
  importSessions(sessions) {
    this._assertUnlocked();
    let added = 0;
    for (const s of sessions) {
      const exists = this.data.sessions.some((x) => x.id === s.id);
      if (!exists) {
        this.data.sessions.push(s);
        added++;
      }
    }
    this._persist();
    return added;
  }
}

module.exports = { Vault };
