# 日和三號館財務：部署步驟

財務系統和任務系統完全分開：另一份 Google Sheet、另一個 Apps Script，Tori 和店長都用 Google 帳號登入。

網址：`https://torikuo314.github.io/chiefrom.hair/finance/`

## 1. 建立財務專用的 Google Sheet 與後台

1. 用 Tori 的 Google 帳號開一份新的 Google Sheet，命名「日和三號館 財務」。**不要分享給任何人**，包括店長。
2. 「擴充功能 → Apps Script」，刪掉預設程式碼，貼上 `finance/apps-script/Code.gs`，存檔。
3. 函式選單選 `setup`，按「執行」，照畫面授權（會要求 Sheet、Drive、對外連線三種權限）。
4. 完成後 Sheet 會多出：設定、支出、營收、店長個人業績、乙方補款、代墊償還、結算鎖定、修改歷程。Drive 也會多一個「日和三號館 財務憑證」資料夾。

## 2. 申請 Google 登入用的 ID

1. 打開 https://console.cloud.google.com ，用 Tori 的帳號登入，建立一個新專案（名稱例如「hiyori3-finance」）。
2. 到「Google Auth Platform」（或「API 和服務 → OAuth 同意畫面」）：
   - 應用程式名稱：日和三號館財務；使用者支援電子郵件：Tori 的 Gmail
   - 使用者類型：外部
   - 發布狀態：如果保留「測試中」，要把 Tori 和店長的 Gmail 加進「測試使用者」；也可以直接「發布應用程式」（只用到基本登入資訊，不需要 Google 審查）
3. 到「用戶端」（或「憑證 → 建立憑證 → OAuth 用戶端 ID」）：
   - 應用程式類型：網頁應用程式
   - 已授權的 JavaScript 來源：`https://torikuo314.github.io`
   - 建立後複製「用戶端 ID」（結尾是 `.apps.googleusercontent.com`）

## 3. 填設定

在財務 Sheet 的「設定」分頁填：

| key | value |
|---|---|
| googleClientId | 上一步的用戶端 ID |
| adminEmails | Tori 的 Gmail |
| managerEmails | 三號館店長的 Gmail |

Gmail 只存在這份不公開的 Sheet 裡，不會出現在程式碼中。之後要換人或停權，改這裡就立刻生效。

## 4. 部署

1. Apps Script「部署 → 新增部署作業 → 網頁應用程式」，執行身分「我」，存取權「任何人」。
2. 把網址和用戶端 ID 填進 `finance/index.html` 最上面的 `SCRIPT_URL`、`GOOGLE_CLIENT_ID`。

改了 `Code.gs` 之後要「部署 → 管理部署作業 → 編輯 → 版本選新版本」，網址才會用到新程式。

## 驗收

- 名單外的 Gmail 登入會看到「沒有使用權限」
- 店長登入只有「輸入」「我的紀錄」兩頁；直接呼叫結算、統整、設備、設定的 API 一律回傳 `FORBIDDEN`
- 月結算鎖定後，店長不能再新增或修改該月
- 每筆新增、修改、刪除、鎖定、設定變更都記在「修改歷程」
- 用「盈餘 10 萬」核對：預備金 5 萬、乙方 3 萬、甲方 2 萬

本機測試（不需要 Google 帳號）：

```bash
node finance/apps-script/test/finance.test.js
```
