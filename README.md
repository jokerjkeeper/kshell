# kshell

一個類似 **Xshell** 的跨平台 SSH 終端工具，基於 Electron + xterm.js + ssh2。

## 功能

- **接近 Xshell 的體驗**：左側連線樹（分群組）、多分頁終端、真實終端渲染（xterm.js，支援 256 色與 UTF-8）。
- **導入 Xshell 設定**：一鍵掃描 Xshell 的 `Sessions` 目錄，解析 `.xsh` 檔案並導入主機 / 埠 / 使用者 / 終端設定。
- **主密碼保險庫**：啟動時需輸入主密碼解鎖；所有連線資訊（含密碼）以 `scrypt + AES-256-GCM` 加密保存於本地。開新連線若未儲存密碼，會即時提示輸入。

## 安裝與啟動

需求：Node.js 18+（已在 Node 22 測試）。

```bash
npm install
npm start
```

首次啟動會要求**建立主密碼**；之後每次啟動需輸入該主密碼解鎖。

## 使用

| 操作 | 說明 |
|------|------|
| 雙擊左側連線 | 開啟新分頁並連線 |
| 右鍵左側連線 | 編輯該連線 |
| `＋` | 新增連線 |
| `⇩` | 從 Xshell 導入（自動偵測 `Documents\NetSarang\Xshell\Sessions`） |
| `🔒` | 鎖定（清除記憶體金鑰，回到主密碼畫面） |

## 從 Xshell 導入的注意事項

- 導入的是**連線中繼資料**：主機、埠、協定、使用者名稱、終端設定（編碼 / 色彩方案 / 字型）。
- **不導入 Xshell 的加密密碼**：Xshell 密碼為其專有加密且與 Xshell 主密碼綁定，無法安全還原。導入後請在連線時輸入密碼，或於「編輯連線」中填入並儲存（將由 kshell 保險庫加密保存）。
- 資料夾結構會對應為 kshell 的「群組」。

## 資料存放

- 保險庫檔案：Electron `userData` 目錄下的 `kshell.vault`（Windows：`%APPDATA%\kshell\kshell.vault`）。
- 檔案內容全程加密，主密碼不落地保存；忘記主密碼將無法還原。

## 架構

```
src/
├── main/
│   ├── main.js           Electron 主進程 + IPC 路由
│   ├── preload.js        contextBridge 安全 API
│   ├── vault.js          主密碼保險庫（scrypt + AES-256-GCM）
│   ├── ssh.js            ssh2 連線管理（多分頁）
│   └── xshell-import.js  .xsh 解析與導入
└── renderer/
    ├── index.html        UI 結構
    ├── styles.css        樣式
    └── renderer.js       UI 邏輯（鎖屏 / 樹 / 分頁 / 終端）
```

## 安全性說明

- 對稱金鑰僅存在於記憶體，鎖定或關閉程式即清除。
- 保險庫以 AES-256-GCM 加密，GCM auth tag 同時作為主密碼正確性驗證。
- `.gitignore` 已排除 `data/` 與 `*.vault`，本地連線資料不會進入版本控制。

## License

MIT
