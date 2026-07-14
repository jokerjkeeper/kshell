'use strict';

/* global Terminal, FitAddon */
const api = window.kshell;

// ---- 狀態 ----
let sessions = [];
const tabs = new Map(); // tabId -> { sessionId, term, fit, paneEl, tabEl, statusEl }
let activeTab = null;
let editingId = null;

// 終端全域字體大小（可縮放，記憶於 localStorage）。預設 15，範圍 8–40。
const FONT_MIN = 8, FONT_MAX = 40;
let termFontSize = (() => {
  const v = parseInt(localStorage.getItem('kshell.fontSize'), 10);
  return v >= FONT_MIN && v <= FONT_MAX ? v : 15;
})();

/** 設定所有終端的字體大小並重排。 */
function setFontSize(size) {
  termFontSize = Math.max(FONT_MIN, Math.min(FONT_MAX, size));
  localStorage.setItem('kshell.fontSize', termFontSize);
  for (const t of tabs.values()) {
    t.term.options.fontSize = termFontSize;
    t.fit.fit();
  }
}

// ==================================================================
// 鎖屏 / 主密碼
// ==================================================================
const lockScreen = document.getElementById('lock-screen');
const lockHint = document.getElementById('lock-hint');
const masterPw = document.getElementById('master-pw');
const masterPw2 = document.getElementById('master-pw2');
const lockBtn = document.getElementById('lock-btn');
const lockError = document.getElementById('lock-error');
let vaultInitialized = false;

async function initLockScreen() {
  const status = await api.vault.status();
  vaultInitialized = status.initialized;
  if (vaultInitialized) {
    lockHint.textContent = '請輸入主密碼以解鎖保險庫';
    masterPw2.style.display = 'none';
    lockBtn.textContent = '解鎖';
  } else {
    lockHint.textContent = '首次使用：請設定主密碼（用於加密所有連線資訊）';
    masterPw2.style.display = 'block';
    lockBtn.textContent = '建立保險庫';
  }
  masterPw.focus();
}

async function handleUnlock() {
  lockError.textContent = '';
  const pw = masterPw.value;
  if (!pw) { lockError.textContent = '請輸入主密碼'; return; }

  if (!vaultInitialized) {
    if (pw.length < 4) { lockError.textContent = '主密碼至少 4 個字元'; return; }
    if (pw !== masterPw2.value) { lockError.textContent = '兩次輸入不一致'; return; }
    await api.vault.initialize(pw);
    // 建立後直接解鎖
    await api.vault.unlock(pw);
    enterApp();
    return;
  }

  const ok = await api.vault.unlock(pw);
  if (ok) enterApp();
  else lockError.textContent = '主密碼錯誤';
}

lockBtn.addEventListener('click', handleUnlock);
[masterPw, masterPw2].forEach((el) =>
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleUnlock(); })
);

async function enterApp() {
  masterPw.value = masterPw2.value = '';
  lockScreen.style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  await refreshSessions();
}

// ==================================================================
// Session 樹
// ==================================================================
const tree = document.getElementById('session-tree');

async function refreshSessions() {
  sessions = await api.sessions.list();
  renderTree();
}

function renderTree() {
  tree.innerHTML = '';
  if (!sessions.length) {
    tree.innerHTML = '<div class="group-title">尚無連線</div>';
    return;
  }
  const groups = {};
  for (const s of sessions) {
    const g = s.group || '預設';
    (groups[g] = groups[g] || []).push(s);
  }
  for (const g of Object.keys(groups).sort()) {
    const title = document.createElement('div');
    title.className = 'group-title';
    title.textContent = g;
    tree.appendChild(title);
    for (const s of groups[g].sort((a, b) => a.name.localeCompare(b.name))) {
      const item = document.createElement('div');
      item.className = 'session-item';
      item.title = `${s.username || ''}@${s.host}:${s.port}`;
      item.innerHTML = `<span>🖧</span><span>${escapeHtml(s.name)}</span>` +
        `<span class="host">${escapeHtml(s.host)}</span>` +
        `<span class="del" title="刪除">✕</span>`;
      item.addEventListener('dblclick', () => openSession(s.id));
      item.querySelector('.del').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`刪除連線「${s.name}」？`)) {
          await api.sessions.delete(s.id);
          await refreshSessions();
        }
      });
      item.addEventListener('click', (e) => {
        if (e.detail === 2) return; // 讓 dblclick 處理
      });
      item.addEventListener('contextmenu', (e) => { e.preventDefault(); editSession(s.id); });
      tree.appendChild(item);
    }
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ==================================================================
// 連線 / 分頁 / 終端
// ==================================================================
const tabBar = document.getElementById('tab-bar');
const terminalHost = document.getElementById('terminal-host');
const welcome = document.getElementById('welcome');

async function openSession(sessionId) {
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return;

  // 需求：若未儲存密碼且為密碼認證，連線前提示輸入。
  let runtimePassword = '';
  const needPrompt = session.authMethod === 'password' ? !session.password
    : (session.authMethod === 'privateKey' ? false : !session.password);
  if (needPrompt) {
    runtimePassword = await promptPassword(session);
    if (runtimePassword === null) return; // 取消
  }

  const tabId = 't' + Date.now() + Math.floor(Math.random() * 1000);
  createTab(tabId, session);

  const pane = tabs.get(tabId).paneEl;
  const term = tabs.get(tabId).term;
  const fit = tabs.get(tabId).fit;
  requestAnimationFrame(() => fit.fit());

  try {
    await api.ssh.connect({
      tabId, sessionId,
      runtimePassword,
      cols: term.cols, rows: term.rows,
    });
    term.writeln(`\x1b[90m正在連線 ${session.username}@${session.host}:${session.port} ...\x1b[0m`);
  } catch (err) {
    term.writeln(`\x1b[31m連線失敗：${err.message}\x1b[0m`);
    setTabStatus(tabId, 'error');
  }
}

function createTab(tabId, session) {
  welcome.style.display = 'none';

  // 終端面板
  const pane = document.createElement('div');
  pane.className = 'term-pane';
  terminalHost.appendChild(pane);

  const term = new Terminal({
    fontFamily: (session.terminal && session.terminal.fontFace) || 'Consolas, "Courier New", monospace',
    fontSize: termFontSize, // 全域字體大小（忽略 Xshell 導入的過小值），可用 Ctrl+加/減/滾輪縮放
    cursorBlink: true,
    theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
    scrollback: 5000,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(pane);

  term.onData((data) => api.ssh.write(tabId, data));
  term.onResize(({ cols, rows }) => api.ssh.resize(tabId, cols, rows));

  // 分頁標籤
  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.innerHTML = `<span class="status"></span><span class="label">${escapeHtml(session.name)}</span>` +
    `<span class="close">✕</span>`;
  tabEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('close')) { closeTab(tabId); return; }
    activateTab(tabId);
  });
  tabBar.appendChild(tabEl);

  tabs.set(tabId, {
    sessionId: session.id, term, fit, paneEl: pane, tabEl,
    statusEl: tabEl.querySelector('.status'),
  });
  activateTab(tabId);
}

function activateTab(tabId) {
  activeTab = tabId;
  for (const [id, t] of tabs) {
    const on = id === tabId;
    t.paneEl.classList.toggle('active', on);
    t.tabEl.classList.toggle('active', on);
  }
  const t = tabs.get(tabId);
  if (t) { requestAnimationFrame(() => { t.fit.fit(); t.term.focus(); }); }
}

function closeTab(tabId) {
  const t = tabs.get(tabId);
  if (!t) return;
  api.ssh.disconnect(tabId);
  t.term.dispose();
  t.paneEl.remove();
  t.tabEl.remove();
  tabs.delete(tabId);
  if (activeTab === tabId) {
    const next = tabs.keys().next();
    if (!next.done) activateTab(next.value);
    else { activeTab = null; welcome.style.display = 'block'; }
  }
}

function setTabStatus(tabId, status) {
  const t = tabs.get(tabId);
  if (!t) return;
  t.statusEl.className = 'status ' + status;
}

// SSH 事件
api.ssh.onData(({ tabId, payload }) => {
  const t = tabs.get(tabId);
  if (t) t.term.write(payload);
});
api.ssh.onReady(({ tabId }) => {
  setTabStatus(tabId, 'connected');
});
api.ssh.onClose(({ tabId }) => {
  const t = tabs.get(tabId);
  if (t) { t.term.writeln('\r\n\x1b[90m[連線已關閉]\x1b[0m'); setTabStatus(tabId, ''); }
});
api.ssh.onError(({ tabId, payload }) => {
  const t = tabs.get(tabId);
  if (t) { t.term.writeln(`\r\n\x1b[31m[錯誤] ${payload}\x1b[0m`); setTabStatus(tabId, 'error'); }
});

// 視窗尺寸變更時重新 fit
window.addEventListener('resize', () => {
  const t = tabs.get(activeTab);
  if (t) t.fit.fit();
});

// ==================================================================
// 連線密碼提示
// ==================================================================
const promptModal = document.getElementById('prompt-modal');
const promptPw = document.getElementById('prompt-pw');
const promptSub = document.getElementById('prompt-sub');

function promptPassword(session) {
  return new Promise((resolve) => {
    promptSub.textContent = `${session.username || ''}@${session.host}:${session.port}`;
    promptPw.value = '';
    promptModal.style.display = 'flex';
    promptPw.focus();

    const cleanup = () => {
      promptModal.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      promptPw.removeEventListener('keydown', onKey);
    };
    const onOk = () => { const v = promptPw.value; cleanup(); resolve(v); };
    const onCancel = () => { cleanup(); resolve(null); };
    const onKey = (e) => { if (e.key === 'Enter') onOk(); if (e.key === 'Escape') onCancel(); };
    const okBtn = document.getElementById('prompt-ok');
    const cancelBtn = document.getElementById('prompt-cancel');
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    promptPw.addEventListener('keydown', onKey);
  });
}

// ==================================================================
// Session 編輯器
// ==================================================================
const editorModal = document.getElementById('editor-modal');
const fields = {
  name: document.getElementById('f-name'),
  group: document.getElementById('f-group'),
  protocol: document.getElementById('f-protocol'),
  host: document.getElementById('f-host'),
  port: document.getElementById('f-port'),
  username: document.getElementById('f-username'),
  auth: document.getElementById('f-auth'),
  password: document.getElementById('f-password'),
  key: document.getElementById('f-key'),
};

fields.auth.addEventListener('change', () => {
  const isKey = fields.auth.value === 'privateKey';
  document.getElementById('wrap-key').style.display = isKey ? 'block' : 'none';
  document.getElementById('wrap-password').style.display = isKey ? 'none' : 'block';
});

function openEditor(session) {
  editingId = session ? session.id : null;
  document.getElementById('editor-title').textContent = session ? '編輯連線' : '新增連線';
  fields.name.value = session ? session.name : '';
  fields.group.value = session ? session.group : '';
  fields.protocol.value = session ? session.protocol : 'SSH';
  fields.host.value = session ? session.host : '';
  fields.port.value = session ? session.port : 22;
  fields.username.value = session ? session.username : '';
  fields.auth.value = session ? session.authMethod : 'password';
  fields.password.value = session ? (session.password || '') : '';
  fields.key.value = session ? (session.privateKeyPath || '') : '';
  fields.auth.dispatchEvent(new Event('change'));
  editorModal.style.display = 'flex';
  fields.name.focus();
}

function editSession(id) {
  const s = sessions.find((x) => x.id === id);
  if (s) openEditor(s);
}

document.getElementById('editor-cancel').addEventListener('click', () => {
  editorModal.style.display = 'none';
});
document.getElementById('editor-save').addEventListener('click', async () => {
  const host = fields.host.value.trim();
  if (!host) { alert('請輸入主機'); return; }
  const existing = editingId ? sessions.find((s) => s.id === editingId) : null;
  const session = {
    id: editingId || ('s' + Date.now() + Math.floor(Math.random() * 1000)),
    name: fields.name.value.trim() || host,
    group: fields.group.value.trim() || '預設',
    protocol: fields.protocol.value,
    host,
    port: parseInt(fields.port.value, 10) || 22,
    username: fields.username.value.trim(),
    authMethod: fields.auth.value,
    password: fields.auth.value === 'password' ? fields.password.value : '',
    privateKeyPath: fields.auth.value === 'privateKey' ? fields.key.value.trim() : '',
    terminal: existing ? existing.terminal : { type: 'xterm', cols: 80, rows: 24, encoding: 'UTF-8' },
    source: existing ? existing.source : 'manual',
  };
  await api.sessions.save(session);
  editorModal.style.display = 'none';
  await refreshSessions();
});

// ==================================================================
// 工具列按鈕
// ==================================================================
document.getElementById('btn-new').addEventListener('click', () => openEditor(null));
document.getElementById('btn-lock').addEventListener('click', async () => {
  for (const id of Array.from(tabs.keys())) closeTab(id);
  await api.vault.lock();
  document.getElementById('app').style.display = 'none';
  lockScreen.style.display = 'flex';
  await initLockScreen();
});
document.getElementById('btn-import').addEventListener('click', async () => {
  let dir = await api.xshell.guessDir();
  if (!dir) {
    dir = await api.xshell.pickDir();
    if (!dir) return;
  } else {
    // 有猜到目錄，讓使用者確認或另選
    if (!confirm(`偵測到 Xshell 目錄：\n${dir}\n\n按「確定」導入此目錄，「取消」另選資料夾。`)) {
      dir = await api.xshell.pickDir();
      if (!dir) return;
    }
  }
  try {
    const res = await api.xshell.import(dir);
    alert(`導入完成：新增 ${res.added} 筆（共解析 ${res.total} 筆）。\n\n注意：Xshell 加密密碼未導入，請在連線時輸入或於編輯中儲存。`);
    await refreshSessions();
  } catch (err) {
    alert('導入失敗：' + err.message);
  }
});

// ==================================================================
// 側欄寬度拖曳
// ==================================================================
(function initSidebarResizer() {
  const sidebar = document.getElementById('sidebar');
  const resizer = document.getElementById('sidebar-resizer');
  const MIN = 120, MAX = 600;

  // 還原上次寬度
  const saved = parseInt(localStorage.getItem('kshell.sidebarWidth'), 10);
  if (saved >= MIN && saved <= MAX) sidebar.style.width = saved + 'px';

  let dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    let w = e.clientX; // 側欄從最左，寬度即為游標 X
    w = Math.max(MIN, Math.min(MAX, w));
    sidebar.style.width = w + 'px';
    const t = tabs.get(activeTab);
    if (t) t.fit.fit(); // 即時重排終端
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.classList.remove('resizing');
    localStorage.setItem('kshell.sidebarWidth', parseInt(sidebar.style.width, 10));
    const t = tabs.get(activeTab);
    if (t) t.fit.fit();
  };
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    resizer.classList.add('dragging');
    document.body.classList.add('resizing');
  });
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
})();

// ==================================================================
// 終端字體縮放（Ctrl + 加/減/0、Ctrl + 滾輪）
// ==================================================================
window.addEventListener('keydown', (e) => {
  if (!e.ctrlKey) return;
  if (e.key === '=' || e.key === '+') { e.preventDefault(); setFontSize(termFontSize + 1); }
  else if (e.key === '-' || e.key === '_') { e.preventDefault(); setFontSize(termFontSize - 1); }
  else if (e.key === '0') { e.preventDefault(); setFontSize(15); } // 重設
});
document.getElementById('terminal-host').addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setFontSize(termFontSize + (e.deltaY < 0 ? 1 : -1));
}, { passive: false });

// ==================================================================
// 啟動
// ==================================================================
initLockScreen();
