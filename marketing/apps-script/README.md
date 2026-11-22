# 頭沐 行銷助手：部署步驟（第 1 步：試算表與設定頁）

行銷助手和任務系統、財務系統分開：另一份 Google Sheet、另一個 Apps Script，Tori 和員工都用 Google 帳號登入（做法和 `finance/` 一樣）。

網址：`https://torikuo314.github.io/chiefrom.hair/marketing/`

## 1. 建立行銷助手專用的 Google Sheet 與後台

1. 用 Tori 的 Google 帳號開一份新的 Google Sheet，命名「頭沐 行銷助手」。**不要分享給任何人**。
2. 「擴充功能 → Apps Script」，刪掉預設程式碼，貼上 `marketing/apps-script/Code.gs`，存檔。
3. 函式選單選 `setup`，按「執行」，照畫面授權（會要求 Sheet、Drive、對外連線三種權限）。
4. 完成後 Sheet 會多出這些分頁，並匯入規格書第 9 節的資料：
   - 設定（品牌資料、各平台規則、法規紅線、作者小檔案、Tori 口吻、反 AI 感規則、花費上限…）
   - 門市（3 間）、關鍵字庫（30 組）、禁用詞、獎品清單、遊戲主題表（12 個月）、挑戰主題（8 個）
   - 人員、定稿範例、脆素材庫（空的，等 Tori 補）
   - 內容、脆問答、對比照、每月活動、用量紀錄（後面步驟才會用到，先建好欄位）
   - 雲端硬碟會多一個「頭沐 行銷助手 對比照」資料夾（不公開分享）

`setup` 可以重跑：只補缺少的分頁和設定項目，不會覆蓋已經改過的資料。

## 2. Google 登入用的 ID

可以和財務系統共用同一個用戶端 ID（同樣是 `https://torikuo314.github.io` 這個網域，不用再設定），也可以另外建一個。

- **共用**：直接把 `finance/index.html` 裡的 `GOOGLE_CLIENT_ID` 拿來用。缺點是登入畫面上的應用程式名稱會顯示財務系統的名字；如果那個專案的發布狀態是「測試中」，員工的 Gmail 也要加進「測試使用者」。
- **另建**：照 `finance/apps-script/README.md` 第 2 步，在 Google Cloud 建新專案（例如「chiefrom-marketing」），已授權的 JavaScript 來源填 `https://torikuo314.github.io`。

## 3. 填設定

在 Sheet 的「設定」分頁填這兩列（只能在試算表改，網頁上看不到也改不了）：

| 項目 | 內容 |
|---|---|
| googleClientId | 上一步的用戶端 ID |
| adminEmails | Tori 的 Gmail |

員工不用在試算表填，Tori 登入後到網頁「設定 → 員工」新增 Gmail 和所屬門市即可。

## 4. 部署

1. Apps Script「部署 → 新增部署作業 → 網頁應用程式」，執行身分「我」，存取權「任何人」。
   - 「任何人」只代表網址連得到。每個動作都要先用 Google 帳號登入、在名單裡，後台才會回應。
2. 把網址和用戶端 ID 填進 `marketing/index.html` 最上面的 `SCRIPT_URL`、`GOOGLE_CLIENT_ID`，推上 GitHub。

改了 `Code.gs` 之後要「部署 → 管理部署作業 → 編輯 → 版本選新版本」，網址才會用到新程式。

## Claude API 金鑰（第 2 步才需要）

金鑰放在 Apps Script「專案設定 → 指令碼屬性」，名稱 `ANTHROPIC_API_KEY`。**不要**放在試算表、程式碼或 GitHub。

## 驗收（第 1 步）

- 名單外的 Gmail 登入會看到「沒有使用權限」。
- Tori 登入後有「產出、審稿、對比照、設定」四頁；設定頁可以改品牌資料、各平台規則、關鍵字、禁用詞、門市、員工、獎品、每月主題、花費上限，改完重新整理還在，Sheet 裡也看得到。
- 「設定 → 待補」列出還沒補的資料（預約連結、官網網址、回留訊息公版、定稿範例、員工名單、7 月主題、中等獎品）。
- 「設定 → 禁用詞試檢查」貼「完全不傷髮」會被標出來。
- 員工登入只看到「對比照」一頁；直接呼叫設定相關的 API 一律回傳 `FORBIDDEN`。
- 員工被停用或刪除後，已登入的畫面下一個動作就會被登出。

本機測試（不需要 Google 帳號）：

```bash
node marketing/apps-script/test/marketing.test.js
```
