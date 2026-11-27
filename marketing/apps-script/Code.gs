/**
 * 頭沐 CHIEFROM 行銷助手 後台（Google Apps Script，綁定在「行銷助手」專用的 Google Sheet 上）
 *
 * 登入做法和財務系統、每日回報系統一致：用 Google 帳號登入
 * - 前端取得 Google ID token，這裡向 Google 驗證後發 6 小時 session token
 * - 管理者：「設定」分頁 adminEmails 裡的 Gmail（setup 自動填入執行者本人）；員工：「人員」分頁裡啟用的 Gmail，綁定所屬門市
 * - 權限範圍（appsscript.json）：只能讀寫這份試算表、只能「讀取」雲端硬碟、可以連外（Google 驗證、Claude API）
 * - 權限全部在這裡判斷，前端只負責顯示；設定類動作只限管理者
 * - 所有規則、口吻、關鍵字、禁用詞都存在試算表，網頁上可改，不寫死在程式裡
 *   （這個檔案裡的內容只是 setup() 第一次匯入用的初始資料）
 *
 * 第一次使用：在 Apps Script 編輯器執行 setup()。
 * Claude API 金鑰放在「專案設定 → 指令碼屬性」的 ANTHROPIC_API_KEY，絕不放在試算表或程式碼裡。
 */

const BACKEND_VERSION = 11; // 前端會檢查這個數字，太舊就提醒 Tori 部署新版本
const TOKEN_TTL_SEC = 6 * 60 * 60;   // CacheService 上限就是 6 小時
const ADMIN_ID = '__admin__';
const SETTINGS_SHEET = '設定';
const DISCLAIMER = '這是系統檢查，不等於法律意見，發布前請再看一次。';

/* ───────────── 設定（項目／內容） ───────────── */

// 只能在試算表裡改，永遠不回傳給前端
const PRIVATE_SETTINGS = {
  googleClientId: ['Google 登入 ID', '', 'Google 登入用的用戶端 ID（setup 自動填入，和每日回報系統共用）'],
  adminEmails: ['管理者 Gmail', '', '管理者的 Gmail，多個用逗號分隔（setup 自動填入執行 setup 的帳號）'],
  photoFolderId: ['（停用）對比照資料夾', '', '舊版用的，現在照片改從 PO 文素材資料夾讀取'],
  poFolderId: ['PO 文素材資料夾', '', '每日回報系統「回流訊息」存的「頭沐 PO文素材」資料夾編號（setup 自動找；找不到就手動貼上）'],
};

// 網頁「設定頁」可以改的項目：key: [分組, 名稱, 初始內容, 說明, 是否多行]
const EDITABLE_SETTINGS = {
  /* 品牌 */
  brandName: ['品牌', '品牌名稱', '頭沐 | CHIEFROM', '英文一律寫 CHIEFROM，不可寫 TUMU', false],
  company: ['品牌', '公司名稱', '桃林有限公司', '', false],
  slogan: ['品牌', '標語', '白髮交給我，健康留給你', '', false],
  audience: ['品牌', '客群', '30 歲以上女性為主，媽媽居多', '', false],
  differentiators: ['品牌', '差異點', '染白髮也顧到頭皮舒適\n染劑不含阿摩尼亞\n先看頭皮再選顏色', '一行一點', true],
  contentFocus: ['品牌', '內容主題',
    '以「染白髮」為主。頭皮只當「為什麼選頭沐染白髮」的理由，不主打頭皮護理、頭皮 SPA、按摩。', '', true],
  notOffered: ['品牌', '不提供的服務', '白髮挑染、手刷染、漸層', '內容不可提及', false],
  allowedFacts: ['品牌', '可以寫的事實',
    '頭沐使用的染劑不含阿摩尼亞。只寫這個事實，不延伸成不刺激、不傷髮。', '', true],
  websiteUrl: ['品牌', '官網網址', '', '【待補】例如 https://chiefrom.com.tw', false],
  articleUrlFormat: ['品牌', '文章網址格式', '', '【待補】例如 https://chiefrom.com.tw/blog/{代稱}', false],

  /* 各平台規則 */
  rulesCommon: ['各平台規則', '共通規則',
    '全部使用繁體中文、台灣用語。\n' +
    '服務人員一律稱「染護師」，不寫設計師。\n' +
    '四種內容的口吻不同，不可混用。\n' +
    '不可編造 Tori 的經歷、客人的話、店內事件或數據；素材不足就標「待素材」。', '', true],
  rulesArticle: ['各平台規則', '官網文章',
    '口吻：專業、溫暖，作者掛 Tori。建議發布日：週一。\n' +
    '目標依序是：不違法、SEO、GEO（讓 AI 搜尋引用）。\n' +
    '1,500–2,000 字。標題含主關鍵字，30 字內。\n' +
    '第一段直接回答問題，粗體，不鋪陳。主關鍵字在前 100 字內出現。\n' +
    'H2／H3 結構，自然放入 2–3 個長尾詞，帶到「高雄」「台南」。\n' +
    '誠實講優缺點，可用比較表；不貶低同業或其他染髮方式。\n' +
    '放進頭沐第一線的真實觀察，素材不足時不編造。\n' +
    '結尾：常見問題 3 題（一問一答）、三間店預約引導、作者小檔案。\n' +
    '另外產出：Meta 描述（80 字內）、建議網址代稱（英文）、建議配圖說明、FAQ 與作者的結構化資料（JSON-LD）、建議連到哪些舊文章。\n' +
    '關鍵字以「染白髮」為主、「草本」為輔。', '', true],
  articleStyle: ['各平台規則', '官網文章寫作風格',
    '寧短勿長：字數以 1,500 字為目標，把字數花在具體資訊上，不是鋪陳。\n' +
    '一句只講一件事，句子短；一段只講一個重點，三到四句就換段。\n' +
    '不寫空泛的開場和結尾，例如「在這個…的時代」「相信很多人都有這樣的困擾」「總而言之」「希望這篇文章對你有幫助」。\n' +
    '同一個重點只說一次，不要換句話再說一遍；不要每段都重複關鍵字。\n' +
    '能用條列或表格說清楚的，就不要寫成長段落。\n' +
    '少用形容詞和客套話，用具體的做法、時間、步驟代替。', '覺得囉唆或太短時改這裡', true],
  rulesGbp: ['各平台規則', 'Google 商家貼文',
    '口吻：品牌口吻，不帶入 Tori 個人。建議發布日：週二。\n' +
    '三間店各一篇，每篇約 300 字，各挑文章裡不同的重點，內容不可高度重複。\n' +
    '帶城市加區名：高雄左營、高雄前鎮、台南安南。\n' +
    '按鈕一律「預約」，連到該店的預約連結。高雄兩間店共用一個連結，文末要提醒客人預約時選對店。\n' +
    '內文不放電話號碼。', '', true],
  rulesThreads: ['各平台規則', '脆（Threads）',
    '口吻：Tori 本人。建議發布日：週二、四、六。\n' +
    '脆的任務是讓人認識「Tori 這個人」，不用扣關鍵字。主軸叫「Tori 的創業實驗」。\n' +
    '同心圓三圈，每週一圈一則，三圈都從創業者的角度寫：\n' +
    '・外圈 Tori 這個人：創業翻車史、經營心法、人生觀察\n' +
    '・中圈 受眾在意的事：30 歲以上女人的自我價值；玄學（生命靈數、命盤、人類圖）用初學者、實驗者的身分分享，例如「創業後才學會的自我價值」「用命盤看自己適不適合創業」\n' +
    '・內圈 白髮、染髮：現場金句、客人反應\n' +
    '受眾是 30 歲以上女性，媽媽居多。Tori 本人不是媽媽，不可用媽媽的身分寫。\n' +
    '玄學只當人格和人生話題，不可連到頭髮或健康。\n' +
    '流程：先出 3 題（三圈各一題）→ Tori 打字回答 → 用她的回答寫初稿，盡量保留她的原話和用詞。\n' +
    '沒回答的題目標「待素材」，不可編造經歷、客人對話或店內事件。', '', true],
  rulesIg: ['各平台規則', 'IG 限時動態',
    '口吻：頭沐小編，親切、活潑，比 Google 商家輕鬆。建議發布日：週一、三、五。\n' +
    '每組 2–4 頁，每頁主文字 15 字內。\n' +
    '每頁寫出：主文字、建議畫面、互動貼圖（投票、測驗、問答箱、滑桿、連結）。\n' +
    '三組固定類型：互動型、知識型、髮色對比型。\n' +
    '每組最後一頁導向預約。\n' +
    '系統不產圖，照片由店裡拍。髮色對比型要用已取得同意的對比照，文案只描述顏色，不寫成效。', '', true],
  rulesLine: ['各平台規則', 'LINE 每月活動',
    '每月兩個活動，分別在兩個管道。官方帳號不分眾，一則推給所有好友。\n' +
    '・LINE 官方帳號：互動遊戲，客人私訊回覆。產出企劃（主題、玩法、期間）、官方帳號公告 1 則（150 字內，一個明確行動）。\n' +
    '・LINE 社群（私域圈）：健康挑戰，在社群打卡。產出企劃（主題、天數、打卡方式）、開場公告 1 則、中途打氣 2–3 則、結尾公布 1 則。語氣輕鬆，像跟熟客聊天。\n' +
    '健康挑戰文案只寫「養成好習慣」，不寫對頭髮或身體的效果。\n' +
    '本月獎勵說明：系統從獎品清單提議，Tori 核可前都是草稿。', '', true],
  rewardRules: ['各平台規則', '獎勵方式與券的規則',
    '每次只跑一種，三種輪流：\n' +
    '・參加就拿券：未儲值客人 85 折券；儲值客人加值券\n' +
    '・每月抽獎：當月參加者抽一個大獎\n' +
    '・儲值客人限定：儲值客人拿限定加值；未儲值客人仍有 85 折券\n' +
    '券限用一次、60 天內有效（配合 40–60 天的回訪週期）、不與其他優惠併用。\n' +
    '社群挑戰比較辛苦，獎勵比官方帳號遊戲好一點。\n' +
    '大獎文案只寫「免費體驗一次」，不描述效果。', '', true],

  /* 法規 */
  legalRules: ['法規紅線', '法規紅線（優先於 SEO 和文案效果）',
    '依據《化粧品衛生安全管理法》第 10 條與「化粧品標示宣傳廣告涉及虛偽誇大或醫療效能認定準則」。罰則：虛偽誇大 4 萬至 20 萬元，涉及醫療效能 60 萬至 500 萬元。\n' +
    '不可出現：\n' +
    '・醫療效能：治療、根治、預防、改善疾病或症狀、消炎、抗菌\n' +
    '・生理機能：生髮、活化毛囊、刺激毛囊、預防或減少掉髮、白髮變黑\n' +
    '・絕對用語：100% 天然、完全無化學、零過敏、零刺激、完全不傷髮\n' +
    '・沒有證據的說法、編造的數據或醫師說法、客人見證的成效數字\n' +
    '・貶低同業或其他染髮方式\n' +
    '必須做到：\n' +
    '・提到頭皮紅腫、傷口、過敏、嚴重掉髮，一律建議就醫，不給醫療判斷\n' +
    '・引用數據或醫師說法要附來源連結；查不到就不寫\n' +
    '・前後對比照只描述顏色變化，例如「從滿頭白髮到自然的深棕」。主管機關看的是文字和圖片的整體印象。', '', true],

  /* Tori */
  authorBio: ['Tori', '作者小檔案（官網文章文末）',
    '作者｜Tori\n頭沐 | CHIEFROM 創辦人。從零經驗走進美業，一路試錯、修正，經營高雄左營、高雄前鎮、台南安南三間草本頭皮養護門市。創業 16 年，同時是美業講師，喜歡分享經營現場的真實心得。', '', true],
  toriVoice: ['Tori', 'Tori 口吻設定',
    '用一句自己的觀察或自嘲切入；先講真實經歷，再說體會，不說教、不推銷。\n' +
    '短句、一句一行、留白多。口語，會用「捏」「勒」，對話用「」框起來。\n' +
    '真誠、敢自我揭露，帶點幽默和淡淡的自嘲。\n' +
    '創業者視角：試錯、抓重點、找對的人。\n' +
    '長度 300–500 字以內，可以更短。', '', true],
  antiAi: ['Tori', '反 AI 感規則',
    '不套固定公式：不一定要有鉤子、結論或結尾問句，三則的結構不可一樣。\n' +
    '不寫金句，寧可平淡。\n' +
    '段落長短不一，可以插括號自言自語。\n' +
    '細節要具體（數字、地點、對話原話），只用 Tori 給的素材。\n' +
    '表情符號最多 1 個，可以不放。標籤最多 1–2 個。', '', true],

  /* 對比照 */
  customerReplyTemplate: ['對比照', '給客人的回留訊息公版', '',
    '【待補】Tori 提供的公版。系統只套入變數、不用 AI 改寫。可用變數：{門市} {日期} {建議回訪日} {預約連結}', true],
  revisitDays: ['對比照', '建議回訪天數', '50', '回留訊息的 {建議回訪日} = 上傳日期 + 這個天數（回訪週期 40–60 天）', false],

  /* AI 與費用 */
  modelText: ['AI 與費用', '文字用模型名稱', 'claude-opus-5-5', '預設 claude-opus-5-5（Claude Opus 5.5）。要換模型時到 docs.claude.com 查名稱', false],
  modelVision: ['AI 與費用', '看圖用模型名稱', 'claude-opus-5-5', '要支援圖片輸入，可以和上面相同', false],
  aiEffort: ['AI 與費用', '思考程度', 'medium', 'low（快、便宜）／medium（預設）／high（慢、比較貴，品質不夠時再試）', false],
  priceInputUsd: ['AI 與費用', '輸入單價（美元／百萬 token）', '4', '估算費用用，Claude Opus 5.5 是 4。換模型要一起改', false],
  priceOutputUsd: ['AI 與費用', '輸出單價（美元／百萬 token）', '20', '估算費用用，Claude Opus 5.5 是 20。換模型要一起改', false],
  monthlyBudgetTwd: ['AI 與費用', '每月花費上限（新台幣）', '1000', '【待定】達上限就停止產出並提示；Anthropic 後台也要另設一道上限', false],
  usdToTwd: ['AI 與費用', '美元換台幣匯率', '32', '估算費用用', false],
};
const SETTING_GROUPS = ['品牌', '各平台規則', '法規紅線', 'Tori', '對比照', 'AI 與費用'];
const NUMERIC_SETTINGS = ['revisitDays', 'monthlyBudgetTwd', 'usdToTwd', 'priceInputUsd', 'priceOutputUsd'];
const FILL_IF_BLANK = ['modelText', 'modelVision', 'aiEffort', 'priceInputUsd', 'priceOutputUsd'];

/* ───────────── 資料表 ───────────── */
// 每個欄位：[key, 試算表欄名, 型別, 選項或長度]
// 型別：text、long（多行）、select、date、bool（是／否）、num、secret（只在後台用，不回傳、不能從網頁改）
const YES = '是', NO = '否';
const RINGS = ['外圈', '中圈', '內圈'];
const TABLES = {
  stores: { sheet: '門市', title: '門市與預約連結', editable: true, cols: [
    ['id', '編號', 'id'], ['name', '門市名稱', 'text'], ['city', '城市', 'text'], ['district', '區', 'text'],
    ['bookingUrl', '預約連結', 'text'], ['note', 'Google 商家備註', 'long']] },
  staff: { sheet: '人員', title: '人員', editable: true, cols: [
    ['id', '編號', 'id'], ['name', '姓名', 'text'], ['email', 'Gmail', 'text'], ['store', '門市', 'store'], ['active', '啟用', 'bool']] },
  keywords: { sheet: '關鍵字庫', title: '關鍵字庫', editable: true, cols: [
    ['id', '編號', 'id'], ['main', '主關鍵字', 'text'], ['longtail', '長尾詞', 'text'],
    ['stage', '階段', 'select', ['決策', '維護', '焦慮', '在地', '檔期']], ['priority', '優先序', 'select', ['A', 'B', 'C']],
    ['months', '適合月份', 'text'], ['lastUsed', '上次使用日', 'date'], ['active', '啟用', 'bool']] },
  banned: { sheet: '禁用詞', title: '法規禁用詞', editable: true, cols: [
    ['id', '編號', 'id'], ['word', '詞', 'text'],
    ['category', '類別', 'select', ['醫療效能', '生理機能', '絕對用語', '貶低比較', '品牌用語', '不提供服務']], ['note', '說明', 'text']] },
  examples: { sheet: '定稿範例', title: 'Tori 定稿範例', editable: true, cols: [
    ['id', '編號', 'id'], ['body', '內文', 'long'], ['ring', '圈層', 'select', RINGS], ['date', '日期', 'date']] },
  articlePool: { sheet: '文章素材庫', title: '文章素材庫（官網文章用剩、下次可用的現場觀察）', editable: true, cols: [
    ['id', '編號', 'id'], ['body', '素材', 'long'], ['source', '來源', 'text'], ['date', '日期', 'date'], ['used', '是否已用', 'bool']] },
  threadsPool: { sheet: '脆素材庫', title: '脆素材庫', editable: true, cols: [
    ['id', '編號', 'id'], ['body', '素材', 'long'], ['ring', '圈層', 'select', RINGS], ['used', '是否已用', 'bool']] },
  prizes: { sheet: '獎品清單', title: '獎品清單', editable: true, cols: [
    ['id', '編號', 'id'], ['level', '等級', 'select', ['小', '中', '大']], ['item', '項目', 'text'], ['use', '用途', 'text'],
    ['active', '啟用', 'bool']] },
  gameThemes: { sheet: '遊戲主題表', title: '每月遊戲主題（LINE 官方帳號）', editable: true, cols: [
    ['id', '編號', 'id'], ['month', '月份', 'select', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']],
    ['game', '遊戲', 'text']] },
  challengeThemes: { sheet: '挑戰主題', title: '健康挑戰主題（LINE 社群，每月輪替）', editable: true, cols: [
    ['id', '編號', 'id'], ['theme', '主題', 'text'], ['order', '順序', 'num'], ['active', '啟用', 'bool']] },

  // 下面這幾張表在後面的開發步驟才會用到，setup 先建好欄位
  content: { sheet: '內容', cols: [
    ['id', '編號', 'id'], ['type', '類型', 'text'], ['store', '門市', 'text'], ['keyword', '關鍵字', 'text'],
    ['draft', '初稿', 'long'], ['final', '定稿', 'long'], ['status', '狀態', 'text'], ['check', '自檢結果', 'long'],
    ['suggestDate', '建議發布日', 'date'], ['publishedDate', '實際發布日', 'date'], ['owner', '負責人', 'text'],
    ['createdAt', '建立時間', 'text'], ['title', '標題', 'text'], ['extra', '附加資料', 'long'], ['input', '輸入素材', 'long'],
    ['error', '錯誤訊息', 'text'], ['startedAt', '開始產出時間', 'text'], ['job', 'AI 編輯工作', 'long'],
    ['prev', 'AI 修改前的版本', 'long']] },
  threadsQA: { sheet: '脆問答', cols: [
    ['id', '編號', 'id'], ['ring', '圈層', 'text'], ['question', '題目', 'long'], ['answer', 'Tori 的回答', 'long'],
    ['contentId', '對應內容編號', 'text'], ['batch', '出題批次', 'text'], ['hint', '回答提示', 'text'], ['poolId', '參考素材', 'text'],
    ['status', '狀態', 'text'], ['createdAt', '出題時間', 'text']] },
  photos: { sheet: '對比照', cols: [
    ['id', '編號', 'id'], ['store', '門市', 'text'], ['uploader', '上傳者', 'text'], ['date', '日期', 'date'],
    ['beforeFileId', '前照檔案編號', 'text'], ['afterFileId', '後照檔案編號', 'text'], ['consent', '客人同意', 'bool'],
    ['used', '是否已用', 'bool']] },
  monthly: { sheet: '每月活動', cols: [
    ['id', '編號', 'id'], ['month', '月份', 'text'], ['game', '遊戲主題', 'text'], ['challenge', '挑戰主題', 'text'],
    ['rewardType', '獎勵方式', 'text'], ['coupon', '券內容', 'long'], ['approval', '核可狀態', 'text']] },
  usage: { sheet: '用量紀錄', cols: [
    ['id', '編號', 'id'], ['at', '時間', 'text'], ['type', '內容類型', 'text'], ['tokens', '用量', 'text'],
    ['costTwd', '估算費用', 'text']] },
};
const LENGTH = { secret: 200, text: 300, long: 8000, store: 50, num: 10, date: 10, select: 20, bool: 1 };
const ID_PREFIX = { articlePool: 'N', stores: 'S', staff: 'P', keywords: 'K', banned: 'B', examples: 'E', threadsPool: 'M', prizes: 'R', gameThemes: 'G', challengeThemes: 'C' };

/* ───────────── 初始資料（第 9 節，只在 setup 時匯入空的表） ───────────── */

const SEED = {
  stores: [
    ['S1', '本館', '高雄市', '左營區', '', '【待補：高雄預約連結】高雄兩間店共用一個預約連結，文末提醒客人預約時選對店'],
    ['S2', '散步二館', '高雄市', '前鎮區', '', '【待補：高雄預約連結，與本館共用】文末提醒客人預約時選對店'],
    ['S3', '日和三館', '台南市', '安南區', '', '【待補：台南預約連結】'],
  ],
  keywords: [
    ['K01', '白髮染髮推薦', '染白髮推薦、蓋白髮', '決策', 'A', '全年'],
    ['K02', '遮白髮怎麼染', '蓋白髮、遮白髮', '決策', 'A', '全年'],
    ['K03', '染白髮傷髮嗎', '染白髮傷頭皮嗎', '決策', 'A', '全年'],
    ['K04', '白髮染什麼顏色', '染白髮顯年輕髮色、白髮不一定染黑', '決策', 'A', '全年'],
    ['K05', '無阿摩尼亞染髮', '染髮不臭、染髮味道', '決策', 'A', '全年'],
    ['K06', '自己染白髮還是給專業染', '白髮染髮劑推薦、在家染白髮', '決策', 'A', '全年'],
    ['K07', '第一次染白髮', '染白髮注意事項', '決策', 'A', '全年'],
    ['K08', '草本染髮', '植物染白髮、草本染髮缺點', '決策', 'A', '全年'],
    ['K09', '敏感頭皮染髮', '頭皮敏感可以染髮嗎', '決策', 'A', '全年'],
    ['K10', '染完頭皮癢', '染髮頭皮刺痛', '決策', 'A', '全年'],
    ['K11', '布丁頭補染', '白髮長出來怎麼辦', '維護', 'A', '全年'],
    ['K12', '白髮補染多久一次', '補染間隔', '維護', 'A', '全年'],
    ['K13', '髮根補染還是全頭染', '髮根補染', '維護', 'B', '全年'],
    ['K14', '染後護色', '染髮後幾天洗頭', '維護', 'B', '全年'],
    ['K15', '染髮頻率', '染髮多久染一次', '維護', 'B', '全年'],
    ['K16', '白頭髮變多原因', '白頭髮越來越多', '焦慮', 'B', '全年'],
    ['K17', '少年白', '少年白怎麼辦', '焦慮', 'B', '全年'],
    ['K18', '白頭髮可以拔嗎', '拔白頭髮會越長越多嗎', '焦慮', 'B', '全年'],
    ['K19', '男生白髮染髮', '男生染白髮推薦', '焦慮', 'B', '全年'],
    ['K20', '30 歲白頭髮', '三十歲長白頭髮', '焦慮', 'B', '全年'],
    ['K21', '高雄染白髮推薦', '左營染白髮、前鎮染白髮', '在地', 'A', '全年'],
    ['K22', '高雄染髮推薦', '左營染髮、前鎮染髮', '在地', 'A', '全年'],
    ['K23', '高雄草本染髮', '高雄植物染', '在地', 'A', '全年'],
    ['K24', '台南染白髮推薦', '安南區染白髮', '在地', 'A', '全年'],
    ['K25', '台南染髮推薦', '安南區染髮', '在地', 'A', '全年'],
    ['K26', '台南草本染髮', '台南植物染', '在地', 'A', '全年'],
    ['K27', '過年前染髮', '過年染髮要提早預約嗎', '檔期', 'A', '12–1 月'],
    ['K28', '母親節帶媽媽染白髮', '長輩染髮推薦', '檔期', 'A', '4–5 月'],
    ['K29', '父親節長輩染髮', '爸爸染白髮', '檔期', 'B', '8 月'],
    ['K30', '婚禮前染白髮', '拍照前染白髮、新人爸媽染髮', '檔期', 'B', '全年'],
  ].map(r => r.concat(['', YES])),
  banned: [
    ['治療', '醫療效能'], ['根治', '醫療效能'], ['預防', '醫療效能', '預防疾病、症狀或掉髮都不可寫'],
    ['改善', '醫療效能', '改善疾病或症狀不可寫；其他用法請人工確認'], ['消炎', '醫療效能'], ['抗菌', '醫療效能'],
    ['療效', '醫療效能'], ['生髮', '生理機能'], ['活化毛囊', '生理機能'], ['刺激毛囊', '生理機能'],
    ['減少掉髮', '生理機能'], ['防掉髮', '生理機能'], ['白髮變黑', '生理機能'],
    ['100%天然', '絕對用語'], ['100% 天然', '絕對用語'], ['完全無化學', '絕對用語'], ['零過敏', '絕對用語'],
    ['零刺激', '絕對用語'], ['完全不傷髮', '絕對用語'], ['不傷髮', '絕對用語', '「不含阿摩尼亞」不可延伸成不傷髮'],
    ['不刺激', '絕對用語', '「不含阿摩尼亞」不可延伸成不刺激'],
    ['設計師', '品牌用語', '服務人員一律稱「染護師」'], ['TUMU', '品牌用語', '英文一律寫 CHIEFROM'],
    ['挑染', '不提供服務'], ['手刷染', '不提供服務'], ['漸層', '不提供服務'],
  ].map((r, i) => ['B' + String(i + 1).padStart(2, '0'), r[0], r[1], r[2] || '']),
  prizes: [
    ['R1', '小', '旅行款洗髮精', '參加就送的加值', YES],
    ['R2', '中', '約 100 元的禮品，例如首飾盒【待確認品項】', '儲值客人限定', YES],
    ['R3', '大', '免費一次頭皮護理、染髮或結構護髮', '每月抽獎（文案只寫「免費體驗一次」，不描述效果）', YES],
  ],
  gameThemes: [
    '新年新髮色：許一個今年的願望', '元宵猜燈謎', '婦女節：對自己說一句話', '春天換季：猜猜這是什麼髮色',
    '母親節：分享媽媽的超能力', '端午：頭沐小知識問答', '【待定】原本的喝水挑戰已移到社群，需另訂主題',
    '父親節：爸爸的經典語錄', '中秋猜燈謎', '感恩月：想謝謝的一個人', '品牌月：我和頭沐的故事', '年末回顧：今年最想稱讚自己的事',
  ].map((g, i) => ['G' + String(i + 1).padStart(2, '0'), String(i + 1), g]),
  challengeThemes: ['喝水', '早睡', '每天走路', '吃早餐', '少喝含糖飲料', '睡前不滑手機', '每天伸展 5 分鐘', '每天稱讚自己一句']
    .map((t, i) => ['C' + (i + 1), t, String(i + 1), YES]),
};

/* ───────────── 入口 ───────────── */

function doGet() { return json_({ ok: false, error: 'USE_POST', message: '請用 POST 呼叫' }); }

function doPost(e) {
  let req;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json_({ ok: false, error: 'BAD_REQUEST', message: '格式錯誤' }); }
  return json_(handle_(req));
}

/** 不經 HTTP 的處理函式，測試也呼叫這個 */
function handle_(req) {
  try {
    const action = String(req.action || '');
    if (action === 'login') return login_(req.idToken);
    const user = authenticate_(req.token);
    if (!user) return { ok: false, error: 'UNAUTHORIZED', message: '未登入或登入已過期' };
    const h = ACTIONS[action];
    if (!h) return { ok: false, error: 'UNKNOWN_ACTION' };
    if (h.admin && user.role !== 'admin') return { ok: false, error: 'FORBIDDEN', message: '只有管理者可以執行這個動作' };
    return h.fn(req, user);
  } catch (err) {
    console.error(err);
    return { ok: false, error: 'SERVER_ERROR', message: String(err && err.message || err) };
  }
}

const ACTIONS = {
  logout:       { fn: r => { CacheService.getScriptCache().remove('mkt:' + r.token); return { ok: true }; } },
  me:           { fn: (r, u) => ({ ok: true, user: u, backendVersion: BACKEND_VERSION }) },
  getConfig:    { fn: getConfig_, admin: true },
  saveSettings: { fn: saveSettings_, admin: true },
  saveRow:      { fn: saveRow_, admin: true },
  people:       { fn: () => ({ ok: true, data: rows_('staff').filter(m => m.active === YES).map(m => ({ id: m.id, name: m.name, store: m.store })) }), admin: true },
  deleteRow:    { fn: deleteRow_, admin: true },
  checkText:    { fn: r => ({ ok: true, hits: scanBanned_(String(r.text || '')), disclaimer: DISCLAIMER }), admin: true },
  articleOptions: { fn: articleOptions_, admin: true },
  startArticle: { fn: startArticle_, admin: true },
  threadsQuestions: { fn: threadsQuestions_, admin: true },
  threadsPending: { fn: threadsPending_, admin: true },
  updateQuestion: { fn: updateQuestion_, admin: true },
  startThreads: { fn: startThreads_, admin: true },
  saveExample:  { fn: saveExample_, admin: true },
  startGbp:     { fn: (r, u) => startBatch_(T_GBP, r, u), admin: true },
  startIg:      { fn: startIg_, admin: true },
  listMaterials: { fn: listMaterials_, admin: true },
  getMaterial:  { fn: getMaterial_, admin: true },
  runJob:       { fn: runJob_, admin: true },
  getContent:   { fn: getContent_, admin: true },
  listContent:  { fn: listContent_, admin: true },
  saveContent:  { fn: saveContent_, admin: true },
  setStatus:    { fn: setStatus_, admin: true },
  startEdit:    { fn: startEdit_, admin: true },
  deleteContent: { fn: deleteContent_, admin: true },
  restorePrev:  { fn: restorePrev_, admin: true },
  applyFix:     { fn: applyFix_, admin: true },
  dismissIssue: { fn: dismissIssue_, admin: true },
};

/* ───────────── Google 登入 ───────────── */

const DEFAULT_CLIENT_ID = '666667317547-qt7hdpi8du19tq2fb2genfvhkcs7hu5j.apps.googleusercontent.com'; // 每日回報系統的登入 ID（公開的，不是密碼）

function login_(idToken) {
  if (!idToken || typeof idToken !== 'string') return { ok: false, error: 'LOGIN_FAILED', message: '缺少 Google 登入資料' };
  const conf = privateSettings_();
  const clientId = conf.googleClientId || DEFAULT_CLIENT_ID;
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return { ok: false, error: 'LOGIN_FAILED', message: 'Google 登入驗證失敗，請重新登入' };
  const info = JSON.parse(res.getContentText());
  const issOk = info.iss === 'accounts.google.com' || info.iss === 'https://accounts.google.com';
  if (info.aud !== clientId || !issOk || Number(info.exp) * 1000 <= Date.now() || String(info.email_verified) !== 'true') {
    return { ok: false, error: 'LOGIN_FAILED', message: 'Google 登入驗證失敗，請重新登入' };
  }
  const email = String(info.email).toLowerCase();
  const user = userOf_(email, conf);
  if (!user) return { ok: false, error: 'NOT_ALLOWED', message: email + ' 沒有使用權限，請聯絡 Tori' };
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('mkt:' + token, JSON.stringify({ email: email }), TOKEN_TTL_SEC);
  return { ok: true, token: token, user: user };
}

/** 每次都重新比對名單：從名單拿掉、停用或換門市會立刻生效 */
function authenticate_(token) {
  if (!token || typeof token !== 'string') return null;
  const raw = CacheService.getScriptCache().get('mkt:' + token);
  if (!raw) return null;
  return userOf_(JSON.parse(raw).email, privateSettings_());
}

function adminList_(conf) { return String(conf.adminEmails || '').toLowerCase().split(/[,，\s]+/).filter(Boolean); }

function userOf_(email, conf) {
  email = String(email || '').toLowerCase();
  if (!email) return null;
  const people = rows_('staff');
  if (adminList_(conf).indexOf(email) >= 0) {
    const me = people.find(m => m.id === ADMIN_ID) || {};
    return { id: ADMIN_ID, email: email, name: me.name || 'Tori', role: 'admin', store: '' };
  }
  const m = people.find(x => x.id !== ADMIN_ID && String(x.email).toLowerCase() === email && x.active === YES);
  return m ? { id: m.id, email: email, name: m.name, role: 'staff', store: m.store } : null;
}

/* ───────────── 設定頁 ───────────── */

function getConfig_() {
  const raw = readSettings_();
  const settings = Object.keys(EDITABLE_SETTINGS).map(k => {
    const d = EDITABLE_SETTINGS[k];
    return { key: k, group: d[0], label: d[1], value: raw[k] !== undefined ? raw[k] : d[2], hint: d[3], multiline: d[4] };
  });
  const tables = {};
  Object.keys(TABLES).filter(k => TABLES[k].editable).forEach(k => {
    tables[k] = { title: TABLES[k].title,
      cols: TABLES[k].cols.filter(c => c[2] !== 'secret').map(c => ({ key: c[0], label: c[1], type: c[2], options: c[3] || null })),
      rows: rows_(k).map(publicRow_.bind(null, k)) };
  });
  return { ok: true, groups: SETTING_GROUPS, settings: settings, tables: tables, todo: todo_(raw, tables), disclaimer: DISCLAIMER };
}

/** 待補清單：空白的必要設定，與第 10 節要 Tori 補的資料 */
function todo_(raw, tables) {
  const list = [];
  const val = k => String(raw[k] !== undefined ? raw[k] : EDITABLE_SETTINGS[k][2]).trim();
  tables.stores.rows.filter(s => !s.bookingUrl).forEach(s => list.push('門市「' + s.name + '」的預約連結'));
  if (!val('websiteUrl')) list.push('官網網址');
  if (!val('articleUrlFormat')) list.push('文章網址格式');
  if (!val('customerReplyTemplate')) list.push('給客人的回留訊息公版');
  if (tables.examples.rows.length < 3) list.push('Tori 自己寫過的貼文（定稿範例，目前 ' + tables.examples.rows.length + ' 篇，需要 3 篇）');
  tables.gameThemes.rows.filter(g => /待定/.test(g.game)).forEach(g => list.push(g.month + ' 月的遊戲主題'));
  tables.prizes.rows.filter(p => /待確認/.test(p.item)).forEach(p => list.push(p.level + '等獎品的品項'));
  return list;
}

function saveSettings_(r) {
  const values = r.values || {};
  const keys = Object.keys(values).filter(k => EDITABLE_SETTINGS[k]);
  if (!keys.length) return invalid_('沒有可以儲存的項目');
  for (const k of keys) {
    const v = String(values[k] ?? '').trim();
    if (NUMERIC_SETTINGS.indexOf(k) >= 0 && v !== '' && !(Number(v) >= 0)) return invalid_('「' + EDITABLE_SETTINGS[k][1] + '」要填數字');
    if (v.length > 8000) return invalid_('「' + EDITABLE_SETTINGS[k][1] + '」太長了');
  }
  return withLock_(() => {
    keys.forEach(k => writeSetting_(k, String(values[k] ?? '').trim()));
    return { ok: true, saved: keys.length };
  });
}

function saveRow_(r) {
  const def = TABLES[r.table];
  if (!def || !def.editable) return { ok: false, error: 'BAD_TABLE' };
  const input = r.row || {};
  return withLock_(() => {
    const t = table_(r.table);
    const existing = input.id ? t.rows.find(x => x.id === String(input.id)) : null;
    if (input.id && !existing) return { ok: false, error: 'NOT_FOUND', message: '找不到這一列，可能已被刪除，請重新整理' };
    const row = {};
    for (const c of def.cols) {
      if (c[2] === 'id' || c[2] === 'secret') continue;
      const v = input[c[0]] !== undefined ? input[c[0]] : (existing ? existing[c[0]] : '');
      const res = cleanField_(c, v);
      if (res.error) return invalid_(res.error);
      row[c[0]] = res.value;
    }
    const err = validateRow_(r.table, row, t.rows.filter(x => x !== existing), !!existing && existing.id === ADMIN_ID);
    if (err) return invalid_(err);
    if (r.table === 'staff') {
      if (existing && existing.id === ADMIN_ID) { row.active = YES; row.store = ''; row.email = ''; }
    }
    if (existing) { t.update(existing, row); return { ok: true, row: publicRow_(r.table, existing) }; }
    row.id = nextId_(r.table, t.rows);
    t.append(row);
    return { ok: true, row: publicRow_(r.table, row) };
  });
}

function deleteRow_(r) {
  const def = TABLES[r.table];
  if (!def || !def.editable) return { ok: false, error: 'BAD_TABLE' };
  return withLock_(() => {
    const t = table_(r.table);
    const row = t.rows.find(x => x.id === String(r.id || ''));
    if (!row) return { ok: false, error: 'NOT_FOUND' };
    if (r.table === 'staff' && row.id === ADMIN_ID) return invalid_('不能刪除管理者');
    if (r.table === 'stores' && rows_('staff').some(p => p.store === row.name)) return invalid_('還有員工屬於這間門市，請先改員工的門市');
    t.remove(row);
    return { ok: true };
  });
}

function cleanField_(c, v) {
  const type = c[2], label = c[1];
  let s = String(v ?? '').trim().slice(0, LENGTH[type] || 300);
  if (type !== 'long') s = s.replace(/\s*\n\s*/g, ' ');
  if (type === 'bool') return { value: s === YES || s === 'true' || s === 'TRUE' ? YES : NO };
  if (type === 'select' && s && c[3].indexOf(s) < 0) return { error: '「' + label + '」只能選：' + c[3].join('、') };
  if (type === 'date' && s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) return { error: '「' + label + '」日期格式要是 2026-01-31' };
  if (type === 'num' && s && !(Number(s) >= 0)) return { error: '「' + label + '」要填數字' };
  return { value: s };
}

function validateRow_(table, row, others, isAdminRow) {
  const need = (k, label) => row[k] ? '' : '請填「' + label + '」';
  if (table === 'stores') {
    if (!row.name) return need('name', '門市名稱');
    if (others.some(x => x.name === row.name)) return '門市名稱重複';
    if (row.bookingUrl && !/^https:\/\/\S+$/.test(row.bookingUrl)) return '預約連結要以 https:// 開頭';
  }
  if (table === 'staff') {
    if (!row.name) return need('name', '姓名');
    if (others.some(x => x.name === row.name)) return '姓名重複';
    if (!isAdminRow) {
      row.email = String(row.email || '').toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.email)) return '請填正確的 Gmail';
      if (others.some(x => String(x.email).toLowerCase() === row.email)) return '這個 Gmail 已經在名單裡';
      if (!rows_('stores').some(s => s.name === row.store)) return '請選擇所屬門市';
    }
  }
  if (table === 'keywords' && !row.main) return need('main', '主關鍵字');
  if (table === 'banned') {
    if (!row.word) return need('word', '詞');
    if (others.some(x => x.word === row.word)) return '這個詞已經在清單裡';
  }
  if ((table === 'examples' || table === 'threadsPool' || table === 'articlePool') && !row.body) return '內容不能空白';
  if (table === 'prizes' && !row.item) return need('item', '項目');
  if (table === 'gameThemes') {
    if (!row.month || !row.game) return '請填月份和遊戲';
    if (others.some(x => x.month === row.month)) return row.month + ' 月已經有主題，請直接修改那一列';
  }
  if (table === 'challengeThemes' && !row.theme) return need('theme', '主題');
  return '';
}

function nextId_(table, rows) {
  const p = ID_PREFIX[table];
  const width = table === 'keywords' || table === 'banned' || table === 'gameThemes' ? 2 : 1;
  const max = rows.reduce((m, x) => {
    const mt = String(x.id).match(new RegExp('^' + p + '(\\d+)$'));
    return mt ? Math.max(m, Number(mt[1])) : m;
  }, 0);
  return p + String(max + 1).padStart(width, '0');
}

/* ───────────── 法規自檢：禁用詞比對（第 2 步產出時也用這個） ───────────── */

/** 回傳 [{word, category, note, sentence}]。同一句裡被較長禁用詞涵蓋的短詞不重複列（例：完全不傷髮 ⊃ 不傷髮） */
function scanBanned_(text) {
  const norm = s => String(s).replace(/\s+/g, '').toLowerCase();
  const words = rows_('banned').filter(b => b.word).map(b => Object.assign({ n: norm(b.word) }, b));
  const hits = [];
  String(text).split(/(?<=[。！？!?\n])/).forEach(sen => {
    const ns = norm(sen);
    if (!ns) return;
    const found = [];
    words.forEach(b => { if (ns.indexOf(b.n) >= 0 && !found.some(f => f.n === b.n)) found.push(b); });
    found.filter(b => !found.some(o => o.n !== b.n && o.n.indexOf(b.n) >= 0))
      .forEach(b => hits.push({ word: b.word, category: b.category, note: b.note, sentence: sen.trim() }));
  });
  return hits;
}

/* ───────────── AI 串接（Claude API） ───────────── */

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2026-10-21';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'; // 安全分類器拒答時，由 API 自動改用備援模型
const JOB_TIMEOUT_MS = 7 * 60 * 1000; // Apps Script 單次最多 6 分鐘，超過 7 分鐘還沒結束就當失敗
const ST = { RUNNING: '產出中', FAILED: '失敗', REVIEW: '待審', APPROVED: '已核可', PUBLISHED: '已發布' };
const NEED_MATERIAL = '待素材';
const LEAD_RULE = '# 開頭第一段\n第一段用粗體，只寫 1～2 句、60 字以內，直接回答主關鍵字的問題。補充說明放到第二段，用一般字體。';

/** 讀設定：有列就用試算表的值；模型、單價這幾個空白時用預設值 */
function setting_(k, raw) {
  raw = raw || readSettings_();
  const v = raw[k] !== undefined ? String(raw[k]).trim() : String(EDITABLE_SETTINGS[k][2]);
  return !v && FILL_IF_BLANK.indexOf(k) >= 0 ? String(EDITABLE_SETTINGS[k][2]) : v;
}

function aiError_(code, message) { const e = new Error(message); e.code = code; return e; }

/**
 * 呼叫 Claude API 一次，回傳 { json, usage }。schema 有給就要求回傳符合格式的 JSON。
 * 失敗一律丟出中文錯誤訊息，不靜默失敗。
 */
function callClaude_(opt) {
  const key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!key) throw aiError_('NO_API_KEY', '還沒設定 Claude API 金鑰：Apps Script「專案設定 → 指令碼屬性」要有 ANTHROPIC_API_KEY');
  const raw = opt.raw || readSettings_();
  const body = {
    model: opt.model || setting_('modelText', raw),
    max_tokens: opt.maxTokens || 16000,
    system: opt.system,
    messages: [{ role: 'user', content: opt.content || opt.user }],
    output_config: { effort: opt.effort || setting_('aiEffort', raw) },
    fallbacks: 'default',
  };
  if (opt.schema) body.output_config.format = { type: 'json_schema', schema: opt.schema };
  let res;
  try {
    res = UrlFetchApp.fetch(API_URL, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: JSON.stringify(body),
      headers: { 'x-api-key': key, 'anthropic-version': API_VERSION, 'anthropic-beta': FALLBACK_BETA },
    });
  } catch (err) {
    throw aiError_('AI_NETWORK', /timeout|逾時/i.test(String(err)) ? 'AI 回應超過時間，請再按一次；常發生的話，到設定把「思考程度」改成 low' : '連不上 Claude API：' + String(err.message || err));
  }
  const code = res.getResponseCode();
  let j = {};
  try { j = JSON.parse(res.getContentText()); } catch (e) { /* 非 JSON 回應 */ }
  if (code !== 200) {
    const msg = String((j.error && j.error.message) || res.getContentText()).slice(0, 300);
    if (code === 401) throw aiError_('AI_AUTH', 'Claude API 金鑰不正確或已被刪除，請到 Apps Script 指令碼屬性換新的金鑰');
    if (code === 403) throw aiError_('AI_FORBIDDEN', '這把金鑰沒有權限：' + msg);
    if (/credit balance|billing/i.test(msg)) throw aiError_('AI_BILLING', 'Claude 帳戶餘額不足或已達 Anthropic 後台的花費上限，請到 platform.claude.com 儲值或調高上限');
    if (code === 429) throw aiError_('AI_RATE', 'Claude 目前請求太多，請過 1 分鐘再試');
    if (code === 529 || code >= 500) throw aiError_('AI_BUSY', 'Claude 暫時忙碌，請稍後再試（' + code + '）');
    if (code === 404 || /model/i.test(msg)) throw aiError_('AI_MODEL', '模型名稱可能不對：' + body.model + '。請到設定「AI 與費用」確認。（' + msg + '）');
    throw aiError_('AI_ERROR', 'Claude API 錯誤 ' + code + '：' + msg);
  }
  const usage = usageOf_(j);
  logUsage_(opt.type, usage, raw);
  if (j.stop_reason === 'refusal') throw aiError_('AI_REFUSED', 'AI 拒絕產出這次的內容，請換個關鍵字或調整素材後再試');
  if (j.stop_reason === 'max_tokens') throw aiError_('AI_TRUNCATED', 'AI 寫到一半被截斷（內容太長），請再試一次');
  const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  if (!opt.schema) return { text: text, usage: usage };
  try { return { json: JSON.parse(text), usage: usage }; }
  catch (e) { throw aiError_('AI_FORMAT', 'AI 回傳的格式無法讀取，請再試一次'); }
}

/** 有備援時，usage.iterations 才是每次嘗試的實際用量 */
function usageOf_(j) {
  const its = j.usage && Array.isArray(j.usage.iterations) && j.usage.iterations.length ? j.usage.iterations : [j.usage || {}];
  return its.reduce((u, x) => ({
    input: u.input + (Number(x.input_tokens) || 0) + (Number(x.cache_creation_input_tokens) || 0) + (Number(x.cache_read_input_tokens) || 0),
    output: u.output + (Number(x.output_tokens) || 0),
  }), { input: 0, output: 0 });
}

function logUsage_(type, u, raw) {
  const usd = (u.input * Number(setting_('priceInputUsd', raw)) + u.output * Number(setting_('priceOutputUsd', raw))) / 1e6;
  const twd = Math.round(usd * Number(setting_('usdToTwd', raw)) * 100) / 100;
  withLock_(() => table_('usage', true).append({ id: 'U' + Utilities.getUuid().slice(0, 8), at: now_(), type: type || '',
    tokens: '輸入 ' + u.input + '／輸出 ' + u.output, costTwd: String(twd) }));
  return twd;
}

function monthSpend_() {
  const m = thisMonth_();
  return table_('usage', true).rows.filter(r => monthOfIso_(r.at) === m).reduce((t, r) => t + (Number(r.costTwd) || 0), 0);
}

function budgetCheck_(raw) {
  const limit = Number(setting_('monthlyBudgetTwd', raw)) || 0;
  const spent = Math.round(monthSpend_());
  if (limit > 0 && spent >= limit) {
    return { ok: false, error: 'BUDGET', message: '本月 AI 花費約 NT$' + spent + '，已達上限 NT$' + limit + '，先停止產出。要繼續請到設定「AI 與費用」調高上限。' };
  }
  return null;
}

/* ───────────── 關鍵字建議 ───────────── */

/** 「全年」→ 1–12；「12–1 月」跨年；「4–5 月」；「8 月」；「3、9 月」 */
function monthsOf_(s) {
  s = String(s || '');
  if (!s.trim() || /全年/.test(s)) return null;
  const set = {};
  s.split(/[、,，]/).forEach(part => {
    const n = (part.match(/\d+/g) || []).map(Number).filter(x => x >= 1 && x <= 12);
    if (n.length >= 2) { let m = n[0]; for (let i = 0; i < 12; i++) { set[m] = true; if (m === n[1]) break; m = m % 12 + 1; } }
    else if (n.length === 1) set[n[0]] = true;
  });
  return Object.keys(set).map(Number);
}

/** 規則：先選適合月份包含當月的（檔期優先於全年），再依優先序 A→B→C，最後選最久沒用的 */
function rankKeywords_(rows, month) {
  const pri = { A: 0, B: 1, C: 2 };
  return rows.filter(k => k.active === YES && k.main).map(k => {
    const ms = monthsOf_(k.months);
    const fit = ms === null ? 1 : ms.indexOf(month) >= 0 ? 0 : 2;
    return { k: k, fit: fit };
  }).filter(x => x.fit < 2).sort((a, b) =>
    a.fit - b.fit || (pri[a.k.priority] ?? 3) - (pri[b.k.priority] ?? 3) || String(a.k.lastUsed).localeCompare(String(b.k.lastUsed)) || a.k.id.localeCompare(b.k.id)
  ).map(x => Object.assign({}, x.k, { seasonal: x.fit === 0 }));
}

function articleOptions_() {
  const month = Number(thisMonth_().slice(5, 7));
  const ranked = rankKeywords_(rows_('keywords'), month);
  const raw = readSettings_();
  const pool = rows_('articlePool').filter(m => m.used !== YES && m.body).map(m => ({ id: m.id, body: m.body, date: m.date }));
  const articles = table_('content').rows.filter(x => x.type === T_ARTICLE && [ST.REVIEW, ST.APPROVED, ST.PUBLISHED].indexOf(x.status) >= 0)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 15).map(x => ({ id: x.id, title: x.title, keyword: x.keyword, status: x.status }));
  return { ok: true, keywords: ranked, pool: pool, articles: articles, month: month, spent: Math.round(monthSpend_()), budget: Number(setting_('monthlyBudgetTwd', raw)) || 0,
    hasKey: !!PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY'), model: setting_('modelText', raw) };
}

/* ───────────── 官網文章 ───────────── */

function startArticle_(r, user) {
  const kw = rows_('keywords').find(k => k.id === String(r.keywordId || ''));
  if (!kw) return invalid_('請選一個關鍵字');
  const raw = readSettings_();
  const over = budgetCheck_(raw);
  if (over) return over;
  if (!PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY')) {
    return { ok: false, error: 'NO_API_KEY', message: '還沒設定 Claude API 金鑰：Apps Script「專案設定 → 指令碼屬性」要有 ANTHROPIC_API_KEY' };
  }
  const ids = Array.isArray(r.materialIds) ? r.materialIds.map(String) : [];
  const mats = rows_('articlePool').filter(m => ids.indexOf(m.id) >= 0 && m.used !== YES);
  const input = { keywordId: kw.id, main: kw.main, longtail: String(r.longtail ?? kw.longtail).trim().slice(0, 300), notes: String(r.notes || '').trim().slice(0, 4000),
    materialIds: mats.map(m => m.id), materials: mats.map(m => m.body) };
  const row = { id: 'A' + Utilities.getUuid().replace(/-/g, '').slice(0, 10), type: '官網文章', store: '', keyword: kw.main, draft: '', final: '',
    status: ST.RUNNING, check: '', suggestDate: nextWeekday_(1), publishedDate: '', owner: user.name, createdAt: now_(), title: '', extra: '',
    input: JSON.stringify(input), error: '', startedAt: '' };
  withLock_(() => table_('content').append(row));
  return { ok: true, id: row.id };
}

/** 前端送出後馬上呼叫這個（會跑 1～3 分鐘），同時用 getContent 輪詢結果。初次產出與審稿區的重寫、補素材、重新檢查都走這裡 */
function runJob_(r) {
  const id = String(r.id || '');
  const claim = withLock_(() => {
    const t = table_('content');
    const row = t.rows.find(x => x.id === id);
    if (!row) return { ok: false, error: 'NOT_FOUND' };
    if (row.status === ST.RUNNING) {
      const lead = (parseJson_(row.input) || {}).batchLead;
      if (row.startedAt || (lead && lead !== row.id)) return { ok: true, already: true };
      t.update(row, { startedAt: now_() });
      return { ok: true, kind: 'create', row: Object.assign({}, row) };
    }
    const job = parseJson_(row.job);
    if (!job || job.state !== 'queued') return { ok: true, already: true };
    job.state = 'running'; job.startedAt = now_();
    t.update(row, { job: JSON.stringify(job) });
    return { ok: true, kind: 'edit', row: Object.assign({}, row), job: job };
  });
  if (!claim.ok || claim.already) return claim;
  return claim.kind === 'create' ? runCreate_(claim.row) : runEdit_(claim.row, claim.job);
}

function runCreate_(row) {
  const id = row.id;
  const inp0 = parseJson_(row.input) || {};
  const ids = inp0.batchIds || [id];
  let patches, patch;
  try {
    const raw = readSettings_();
    const over = budgetCheck_(raw);
    if (over) throw aiError_('BUDGET', over.message);
    const all = table_('content').rows;
    const rows = ids.map(x => all.find(r => r.id === x)).filter(Boolean).map(r => Object.assign({}, r));
    if (row.type === T_ARTICLE) patches = [generateArticle_(inp0, raw)];
    else if (row.type === T_GBP) patches = generateGbp_(inp0, raw, rows);
    else if (row.type === T_IG) patches = generateIg_(inp0, raw, rows);
    else if (row.type === T_THREADS) patches = generateThreads_(inp0, raw, rows);
    else throw aiError_('BAD_TYPE', '不支援的內容類型：' + row.type);
    patches.forEach(p => { p.status = ST.REVIEW; p.error = ''; });
    patch = patches[0];
  } catch (err) {
    console.error(err);
    patch = { status: ST.FAILED, error: String(err && err.message || err).slice(0, 500) };
    patches = ids.map(() => patch);
  }
  withLock_(() => {
    const t = table_('content');
    ids.forEach((x, i) => { const cur = t.rows.find(r => r.id === x); if (cur && patches[i]) t.update(cur, patches[i]); });
    if (patch.status === ST.REVIEW && row.type === T_THREADS) markThreadsDone_(row, inp0);
    if (patch.status === ST.FAILED && row.type === T_THREADS) reopenThreads_(inp0);
    if (patch.status === ST.REVIEW && row.type === T_ARTICLE) {
      const kt = table_('keywords');
      const inp = JSON.parse(row.input);
      const kw = kt.rows.find(k => k.id === inp.keywordId);
      if (kw) kt.update(kw, { lastUsed: today_() });
      const pt = table_('articlePool', true);
      pt.rows.filter(m => (inp.materialIds || []).indexOf(m.id) >= 0).forEach(m => pt.update(m, { used: YES }));
      (JSON.parse(patch.extra).leftovers || []).forEach(text => addPool_(pt, text, '「' + inp.main + '」產出時留下'));
    }
  });
  return getContent_({ id: id });
}

function addPool_(pt, text, source) {
  const body = String(text || '').trim().slice(0, 4000);
  if (body) pt.append({ id: nextId_('articlePool', pt.rows), body: body, source: source, date: today_(), used: NO });
}

/* ───────────── 審稿區 ───────────── */

const PLACEHOLDER_RE = /【待素材[：:][^】]*】/g;
const EDIT_OPS = ['rewrite', 'polish', 'fill', 'recheck'];

function currentText_(row) { return row.final || row.draft; }
function placeholders_(text) { return String(text || '').match(PLACEHOLDER_RE) || []; }
function needsOf_(text) { return placeholders_(text).map(p => p.replace(/^【待素材[：:]\s*/, '').replace(/】$/, '')); }
function parseJson_(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }

/** Tori 直接改字、改標題、改建議發布日、改負責人 */
function saveContent_(r) {
  return withLock_(() => {
    const t = table_('content');
    const row = t.rows.find(x => x.id === String(r.id || ''));
    if (!row) return { ok: false, error: 'NOT_FOUND' };
    if (row.status === ST.RUNNING || row.status === ST.FAILED) return invalid_('這則內容還沒有產出成功，不能修改');
    if (isBusy_(row)) return invalid_('AI 正在處理這則內容，請等它完成再改');
    const p = r.patch || {};
    const patch = {};
    if (p.title !== undefined) { const v = String(p.title).trim().slice(0, 200); if (!v) return invalid_('標題不能空白'); if (v !== row.title) patch.title = v; }
    if (p.text !== undefined) { const v = String(p.text).replace(/\r/g, '').trim().slice(0, 40000); if (!v) return invalid_('內文不能空白'); if (v !== currentText_(row)) patch.final = v; }
    if (p.suggestDate !== undefined) { const v = String(p.suggestDate); if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return invalid_('日期格式不對'); patch.suggestDate = v; }
    if (p.owner !== undefined) {
      const v = String(p.owner).trim();
      if (!rows_('staff').some(m => m.name === v && m.active === YES)) return invalid_('負責人要是人員名單裡啟用中的人');
      patch.owner = v;
    }
    if (patch.title !== undefined || patch.final !== undefined) {
      const text = (patch.title ?? row.title) + '\n' + (patch.final ?? currentText_(row));
      const old = parseJson_(row.check) || {};
      patch.check = JSON.stringify({ banned: scanAll_(row.type, row.store, text), ai: [], aiError: '', aiStale: true, disclaimer: DISCLAIMER, prevAi: old.ai || [] });
      if (row.status === ST.APPROVED) patch.status = ST.REVIEW;
    }
    if (Object.keys(patch).length) t.update(row, patch);
    return { ok: true, item: presentContent_(row), reopened: patch.status === ST.REVIEW };
  });
}

/** 待審 → 已核可 → 已發布（記錄發布日期）；也可以退回待審 */
function setStatus_(r) {
  const to = String(r.status || '');
  return withLock_(() => {
    const t = table_('content');
    const row = t.rows.find(x => x.id === String(r.id || ''));
    if (!row) return { ok: false, error: 'NOT_FOUND' };
    if ([ST.REVIEW, ST.APPROVED, ST.PUBLISHED].indexOf(row.status) < 0) return invalid_('這則內容還沒有產出成功');
    if (isBusy_(row)) return invalid_('AI 正在處理這則內容，請等它完成');
    const patch = { status: to };
    if (to === ST.APPROVED) { if (row.status !== ST.REVIEW) return invalid_('只有待審的內容可以核可'); }
    else if (to === ST.PUBLISHED) {
      if (row.status !== ST.APPROVED) return invalid_('要先核可才能標記已發布');
      const d = String(r.publishedDate || today_());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return invalid_('發布日期格式不對');
      patch.publishedDate = d;
    } else if (to === ST.REVIEW) { patch.publishedDate = ''; }
    else return invalid_('不支援的狀態：' + to);
    t.update(row, patch);
    return { ok: true, item: presentContent_(row) };
  });
}

function deleteContent_(r) {
  return withLock_(() => {
    const t = table_('content');
    const row = t.rows.find(x => x.id === String(r.id || ''));
    if (!row) return { ok: false, error: 'NOT_FOUND' };
    if (row.status === ST.PUBLISHED) return invalid_('已發布的內容不能刪除，可以先退回待審');
    if (isBusy_(row)) return invalid_('AI 正在處理這則內容，請等它完成');
    t.remove(row);
    return { ok: true };
  });
}

/** 排一個 AI 編輯工作：重寫（可附指示）、補素材、重新 AI 檢查。排好後前端呼叫 runJob */
function startEdit_(r) {
  const op = String(r.op || '');
  if (EDIT_OPS.indexOf(op) < 0) return invalid_('不支援的動作');
  const over = budgetCheck_(readSettings_());
  if (over) return over;
  if (!PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY')) return { ok: false, error: 'NO_API_KEY', message: '還沒設定 Claude API 金鑰' };
  return withLock_(() => {
    const t = table_('content');
    const row = t.rows.find(x => x.id === String(r.id || ''));
    if (!row) return { ok: false, error: 'NOT_FOUND' };
    if ([ST.REVIEW, ST.APPROVED].indexOf(row.status) < 0) return invalid_(row.status === ST.PUBLISHED ? '已發布的內容要先退回待審才能讓 AI 修改' : '這則內容還沒有產出成功');
    if (isBusy_(row)) return invalid_('AI 已經在處理這則內容了');
    const job = { op: op, state: 'queued', at: now_() };
    if (op === 'rewrite' || op === 'polish') job.instruction = String(r.instruction || '').trim().slice(0, 1000);
    if (op === 'fill') {
      const ph = placeholders_(currentText_(row));
      const fills = (Array.isArray(r.fills) ? r.fills : []).map(f => ({ i: Number(f.i), text: String(f.text || '').trim().slice(0, 4000) }))
        .filter(f => f.text && ph[f.i] !== undefined);
      if (!fills.length) return invalid_('請至少填一個待素材');
      job.fills = fills.map(f => ({ placeholder: ph[f.i], text: f.text }));
    }
    t.update(row, { job: JSON.stringify(job) });
    return { ok: true, id: row.id };
  });
}

function isBusy_(row) {
  const job = parseJson_(row.job);
  return !!job && (job.state === 'queued' || job.state === 'running') && Date.now() - Date.parse(job.startedAt || job.at) < JOB_TIMEOUT_MS;
}

function runEdit_(row, job) {
  const id = row.id;
  let patch = {};
  try {
    const raw = readSettings_();
    const over = budgetCheck_(raw);
    if (over) throw aiError_('BUDGET', over.message);
    if ([T_ARTICLE, T_GBP, T_IG, T_THREADS].indexOf(row.type) < 0) throw aiError_('BAD_TYPE', '不支援的內容類型：' + row.type);
    const extra = parseJson_(row.extra) || {};
    let title = row.title, text = currentText_(row);
    if (job.op === 'rewrite' && row.type !== T_ARTICLE) {
      const a = rewriteShort_(row, job.instruction, raw);
      title = a.title; text = a.body; patch.title = title;
      patch.extra = JSON.stringify(Object.assign({}, extra, { needsMaterial: needsOf_(text) }));
    } else if (job.op === 'rewrite') {
      const a = rewriteArticle_(row, extra, job.instruction, raw);
      title = a.title; text = a.body;
      patch.extra = JSON.stringify(Object.assign({}, extra, { metaDescription: a.metaDescription, slug: a.slug, imageSuggestions: a.imageSuggestions,
        faq: a.faq, internalLinks: a.internalLinks, needsMaterial: a.needsMaterial, jsonLd: articleJsonLd_(a, raw) }));
      patch.title = title;
    } else if (job.op === 'polish') {
      const a = polishArticle_(row, extra, job.instruction, raw);
      title = a.title; text = a.body;
      patch.title = title;
      patch.extra = JSON.stringify(Object.assign({}, extra, { needsMaterial: needsOf_(text), lastChanges: a.changes || [] }));
    } else if (job.op === 'fill') {
      text = fillMaterial_(title, text, job.fills, raw, row.type);
      patch.extra = JSON.stringify(Object.assign({}, extra, { needsMaterial: needsOf_(text) }));
    }
    if (job.op !== 'recheck') patch.prev = JSON.stringify({ title: row.title, text: currentText_(row), extra: row.extra, op: job.op, at: now_() });
    patch.final = text;
    patch.check = JSON.stringify(complianceCheck_(row.type === T_ARTICLE ? title + '\n' + text + '\n' + (extra.metaDescription || '') : text, row.type, raw, row.store));
    patch.job = '';
    if (row.status === ST.APPROVED && job.op !== 'recheck') patch.status = ST.REVIEW;
  } catch (err) {
    console.error(err);
    patch = { job: JSON.stringify(Object.assign({}, job, { state: 'failed', error: String(err && err.message || err).slice(0, 500) })) };
  }
  withLock_(() => {
    const t = table_('content');
    const cur = t.rows.find(x => x.id === id);
    if (cur) t.update(cur, patch);
    if (job.op === 'fill' && patch.job === '') {
      const pt = table_('articlePool', true);
      job.fills.forEach(f => addPool_(pt, f.text, '補進「' + row.title + '」'));
    }
  });
  return getContent_({ id: id });
}

/** 依 Tori 的指示重寫整篇（沒有指示就照規則重寫一版），保留她的素材，不加新的經歷 */
function rewriteArticle_(row, extra, instruction, raw) {
  const inp = parseJson_(row.input) || {};
  const system = [
    '你是頭沐 CHIEFROM 的官網文章寫手，正在依 Tori 的意見修改一篇初稿。',
    brandBlock_(raw),
    '# 官網文章規則', setting_('rulesArticle', raw),
    '# 寫作風格', setting_('articleStyle', raw),
    LEAD_RULE,
    '# 作者小檔案（原文照放在文末）', setting_('authorBio', raw),
    legalBlock_(raw),
    '# 修改原則',
    '這篇的重點是：' + (extra.focus || '（同原文）') + '。維持一篇一個重點。',
    '原文裡 Tori 提供的經歷、客人的話要保留原意與原話；不可新增任何沒有出現在原文或素材裡的經歷、客人對話、店內事件或數據。',
    '原文裡還沒補的「【' + NEED_MATERIAL + '：…】」照樣保留在適當位置，並列進 needsMaterial。',
    'focus 照原重點填；leftovers 回空陣列。',
  ].join('\n\n');
  const user = [
    'Tori 的修改指示：' + (instruction || '（沒有特別指示，請照規則寫得更精簡、更好讀）'),
    '主關鍵字：' + (inp.main || row.keyword) + '\n長尾詞：' + (inp.longtail || ''),
    '目前的標題：' + row.title,
    '目前的內文：\n' + currentText_(row),
  ].join('\n\n');
  return callClaude_({ type: '官網文章重寫', system: system, user: user, schema: ARTICLE_SCHEMA, raw: raw }).json;
}

const POLISH_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['title', 'body', 'changes'],
  properties: {
    title: { type: 'string' },
    body: { type: 'string', description: '潤飾後的完整內文 Markdown' },
    changes: { type: 'array', items: { type: 'string' }, description: '改了哪些地方，每項一句，例如「第二段刪掉重複的一句」' },
  },
};

/** 潤飾：保留 Tori 改過的內容、順序、小標，只修順句子、刪重複、改錯字 */
function polishArticle_(row, extra, instruction, raw) {
  const system = [
    '你是頭沐 CHIEFROM 的文字編輯。Tori 已經親手改過這則「' + row.type + '」，請你做「潤飾」，不是重寫。',
    '# 潤飾原則',
    '保留所有段落、小標、順序與重點，不增加新的段落或新的資訊。',
    'Tori 的用詞和說法盡量保留，只在不通順、重複、錯字、標點不對、句子太長的地方動手；能不改就不改。',
    '不可新增任何經歷、客人對話、店內事件或數據。「【' + NEED_MATERIAL + '：…】」原樣保留。',
    'changes 用一句話一項列出你改了哪些地方；沒有需要改的就回原文、changes 回空陣列。',
    '# 寫作風格', setting_(STYLE_KEY[row.type] || 'articleStyle', raw),
    row.type === T_THREADS ? '# Tori 口吻設定\n' + setting_('toriVoice', raw) + '\n\n# 反 AI 感規則\n' + setting_('antiAi', raw) + '\n\n這是 Tori 本人的脆，用第一人稱，純文字。' : '',
    row.type === T_IG ? '保留每頁「**主文字**／**建議畫面**／**互動貼圖**」的格式，主文字 15 字內。' : '',
    legalBlock_(raw),
    '用繁體中文、台灣用語。服務人員一律稱「染護師」。',
  ].filter(Boolean).join('\n\n');
  const user = [
    'Tori 的潤飾指示：' + (instruction || '（沒有特別指示，修順就好）'),
    '標題：' + row.title,
    '內文：\n' + currentText_(row),
  ].join('\n\n');
  return callClaude_({ type: row.type + '潤飾', system: system, user: user, schema: POLISH_SCHEMA, raw: raw }).json;
}

/** 在文中找到原句的位置：先找原文，找不到就去掉 Markdown 記號（#、-、**）再找 */
function locate_(text, sentence) {
  const s0 = String(sentence || '').trim();
  if (!s0) return null;
  if (text.indexOf(s0) >= 0) return s0;
  const bare = s0.replace(/^#{1,6}\s+/, '').replace(/^[-*]\s+/, '').replace(/\*\*/g, '').trim();
  if (bare && text.indexOf(bare) >= 0) return bare;
  return null;
}

/** 套用法規提醒的修改：把文中那一句換成 Tori 確認過的寫法（不呼叫 AI） */
function applyFix_(r) {
  const kind = r.kind === 'banned' ? 'banned' : 'ai';
  const to = String(r.text ?? '').replace(/\r/g, '').trim();
  return withLock_(() => {
    const t = table_('content');
    const row = t.rows.find(x => x.id === String(r.id || ''));
    if (!row) return { ok: false, error: 'NOT_FOUND' };
    if (isBusy_(row)) return invalid_('AI 正在處理這則內容，請等它完成');
    const check = parseJson_(row.check) || { banned: [], ai: [] };
    const list = check[kind] || [];
    const issue = list[Number(r.index)];
    if (!issue) return invalid_('找不到這條提醒，請重新整理');
    let title = row.title, text = currentText_(row);
    const inBody = locate_(text, issue.sentence), inTitle = !inBody && locate_(title, issue.sentence);
    if (!inBody && !inTitle) return invalid_('文章裡找不到這句原文（可能已經改過了），請用「直接改字」修改');
    const target = inBody || inTitle;
    let rep = to;
    // 原句是整行標題或條列時，保留開頭的 Markdown 記號
    const lead = (String(issue.sentence).match(/^(#{1,6}\s+|[-*]\s+)/) || [''])[0];
    if (lead && target !== issue.sentence.trim() && rep.indexOf(lead.trim()) === 0) rep = rep.slice(lead.length).trim();
    if (inBody) text = text.replace(target, rep); else title = title.replace(target, rep);
    if (!title.trim()) return invalid_('標題不能空白');
    const next = { banned: scanAll_(row.type, row.store, title + '\n' + text), ai: (check.ai || []).filter((x, i) => !(kind === 'ai' && i === Number(r.index))),
      aiError: check.aiError || '', aiStale: check.aiStale, disclaimer: DISCLAIMER, dismissed: check.dismissed || [] };
    const patch = { title: title, final: text, check: JSON.stringify(next) };
    if (row.status === ST.APPROVED) patch.status = ST.REVIEW;
    t.update(row, patch);
    return { ok: true, item: presentContent_(row) };
  });
}

/** 忽略一條提醒（Tori 判斷沒問題）：從清單拿掉，記在 dismissed */
function dismissIssue_(r) {
  const kind = r.kind === 'banned' ? 'banned' : 'ai';
  return withLock_(() => {
    const t = table_('content');
    const row = t.rows.find(x => x.id === String(r.id || ''));
    if (!row) return { ok: false, error: 'NOT_FOUND' };
    const check = parseJson_(row.check) || { banned: [], ai: [] };
    const list = check[kind] || [];
    const issue = list[Number(r.index)];
    if (!issue) return invalid_('找不到這條提醒，請重新整理');
    list.splice(Number(r.index), 1);
    check[kind] = list;
    check.dismissed = (check.dismissed || []).concat([Object.assign({ kind: kind, at: now_() }, issue)]);
    t.update(row, { check: JSON.stringify(check) });
    return { ok: true, item: presentContent_(row) };
  });
}

/** 還原成 AI 修改前的版本（只保留一層） */
function restorePrev_(r) {
  return withLock_(() => {
    const t = table_('content');
    const row = t.rows.find(x => x.id === String(r.id || ''));
    if (!row) return { ok: false, error: 'NOT_FOUND' };
    if (isBusy_(row)) return invalid_('AI 正在處理這則內容，請等它完成');
    const prev = parseJson_(row.prev);
    if (!prev) return invalid_('沒有可以還原的版本');
    const text = prev.title + '\n' + prev.text;
    const patch = { title: prev.title, final: prev.text, prev: '',
      check: JSON.stringify({ banned: scanAll_(row.type, row.store, text), ai: [], aiError: '', aiStale: true, disclaimer: DISCLAIMER }) };
    if (prev.extra) patch.extra = prev.extra;
    if (row.status === ST.APPROVED) patch.status = ST.REVIEW;
    t.update(row, patch);
    return { ok: true, item: presentContent_(row) };
  });
}

const FILL_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['replacements'],
  properties: { replacements: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['index', 'text'],
    properties: { index: { type: 'integer' }, text: { type: 'string' } } } } },
};

/** 只替換【待素材】那幾處：AI 只寫替換用的句子，由程式放回原位，其他段落一字不動 */
function fillMaterial_(title, text, fills, raw, type) {
  const items = fills.map((f, i) => {
    const pos = text.indexOf(f.placeholder);
    const ctx = pos < 0 ? '' : text.slice(Math.max(0, pos - 300), pos) + '▲' + text.slice(pos + f.placeholder.length, pos + f.placeholder.length + 200);
    return '## 第 ' + i + ' 處\n要替換的標記：' + f.placeholder + '\n前後文（▲是標記的位置）：\n' + ctx + '\nTori 提供的素材：\n' + f.text;
  }).join('\n\n');
  const system = [
    '你在幫頭沐 CHIEFROM 的官網文章補上 Tori 提供的真實素材。每一處只寫要放進「▲」位置的文字，讓前後文讀起來通順。',
    '盡量保留 Tori 的原話和用詞；客人說的話用「」框起來。不可加入素材裡沒有的細節、數字或對話。',
    '長度跟素材差不多，不要擴寫成長段落；不要重複前後文已經說過的內容。',
    legalBlock_(raw),
    '用繁體中文、台灣用語。服務人員一律稱「染護師」。回傳每一處的 index 與 text。',
  ].join('\n\n');
  const res = callClaude_({ type: (type || T_ARTICLE) + '補素材', system: system, user: '文章標題：' + title + '\n\n' + items, schema: FILL_SCHEMA, maxTokens: 8000, raw: raw }).json;
  let out = text;
  fills.forEach((f, i) => {
    const rep = (res.replacements || []).find(x => x.index === i);
    if (rep && String(rep.text).trim()) out = out.replace(f.placeholder, String(rep.text).trim());
  });
  if (out === text) throw aiError_('AI_FORMAT', 'AI 沒有回傳可以補進去的內容，請再試一次');
  return out;
}

function getContent_(r) {
  const t = table_('content');
  const row = t.rows.find(x => x.id === String(r.id || ''));
  if (!row) return { ok: false, error: 'NOT_FOUND' };
  const startedOrCreated = Date.parse(row.startedAt || row.createdAt);
  if (row.status === ST.RUNNING && Date.now() - startedOrCreated > JOB_TIMEOUT_MS) {
    withLock_(() => {
      t.update(row, { status: ST.FAILED, error: '執行逾時（超過 6 分鐘），請再產出一次' });
      if (row.type === T_THREADS) reopenThreads_(parseJson_(row.input) || {});
    });
  }
  const job = parseJson_(row.job);
  if (job && (job.state === 'queued' || job.state === 'running') && !isBusy_(row)) {
    withLock_(() => t.update(row, { job: JSON.stringify(Object.assign(job, { state: 'failed', error: '執行逾時（超過 6 分鐘），請再試一次' })) }));
  }
  return { ok: true, item: presentContent_(row) };
}

function listContent_(r) {
  const type = String(r.type || ''), status = String(r.status || '');
  const items = table_('content').rows.filter(x => (!type || x.type === type) && (!status || x.status === status))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 30)
    .map(x => ({ id: x.id, type: x.type, title: x.title, keyword: x.keyword, status: x.status, createdAt: x.createdAt, suggestDate: x.suggestDate,
      publishedDate: x.publishedDate, owner: x.owner, needs: placeholders_(currentText_(x)).length, busy: isBusy_(x) }));
  return { ok: true, items: items };
}

function presentContent_(row) {
  const parse = s => { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } };
  return { id: row.id, type: row.type, store: row.store, keyword: row.keyword, title: row.title, draft: row.draft, final: row.final,
    text: currentText_(row), placeholders: placeholders_(currentText_(row)), job: parse(row.job), busy: isBusy_(row), publishedDate: row.publishedDate,
    prev: (p => p ? { op: p.op, at: p.at } : null)(parse(row.prev)), siblings: batchSiblings_(row),
    status: row.status, check: parse(row.check), extra: parse(row.extra), input: parse(row.input), suggestDate: row.suggestDate,
    owner: row.owner, createdAt: row.createdAt, error: row.error, disclaimer: DISCLAIMER };
}

const ARTICLE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['focus', 'title', 'body', 'metaDescription', 'slug', 'imageSuggestions', 'faq', 'internalLinks', 'needsMaterial', 'leftovers'],
  properties: {
    focus: { type: 'string', description: '這篇唯一的重點，一句話' },
    leftovers: { type: 'array', items: { type: 'string' }, description: 'Tori 素材裡這篇沒用到的其他重點，一個重點一則，保留原話' },
    title: { type: 'string', description: '標題，含主關鍵字，30 字內' },
    body: { type: 'string', description: '完整文章 Markdown：第一段粗體直接回答；H2/H3；結尾常見問題 3 題、三間店預約引導、作者小檔案' },
    metaDescription: { type: 'string', description: 'Meta 描述，80 字內' },
    slug: { type: 'string', description: '建議網址代稱，英文小寫與連字號' },
    imageSuggestions: { type: 'array', items: { type: 'string' }, description: '建議配圖說明' },
    faq: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['q', 'a'], properties: { q: { type: 'string' }, a: { type: 'string' } } } },
    internalLinks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'reason'], properties: { title: { type: 'string' }, reason: { type: 'string' } } } },
    needsMaterial: { type: 'array', items: { type: 'string' }, description: '文中標「待素材」的地方，各說明需要 Tori 補什麼' },
  },
};

const CHECK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['issues'],
  properties: { issues: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['sentence', 'reason', 'suggestion'],
    properties: { sentence: { type: 'string' }, reason: { type: 'string' }, suggestion: { type: 'string' } } } } },
};

function brandBlock_(raw) {
  const v = k => setting_(k, raw);
  const stores = rows_('stores').map(s => '・' + s.name + '（' + s.city + s.district + '）預約連結：' + (s.bookingUrl || '【尚未提供，寫「預約連結」佔位】') + (s.note ? '；' + s.note : '')).join('\n');
  return [
    '# 品牌', '名稱：' + v('brandName') + '（公司：' + v('company') + '）', '標語：' + v('slogan'), '客群：' + v('audience'),
    '差異點：\n' + v('differentiators'), '內容主題：' + v('contentFocus'), '不提供的服務（內容不可提及）：' + v('notOffered'),
    '可以寫的事實：' + v('allowedFacts'), '官網：' + (v('websiteUrl') || '（未提供）'),
    '# 門市', stores,
    '# 共通規則', v('rulesCommon'),
  ].join('\n');
}

function legalBlock_(raw) {
  const words = rows_('banned').map(b => b.word + (b.note ? '（' + b.note + '）' : '')).join('、');
  return '# 法規紅線（優先於 SEO 和文案效果）\n' + setting_('legalRules', raw) + '\n禁用詞清單：' + words;
}

function generateArticle_(input, raw) {
  const previous = table_('content').rows.filter(x => x.type === '官網文章' && x.title && x.status !== ST.FAILED)
    .slice(-30).map(x => '・' + x.title + '（關鍵字：' + x.keyword + '）').join('\n');
  const system = [
    '你是頭沐 CHIEFROM 的官網文章寫手，替創辦人 Tori 寫初稿，Tori 會審稿後才發布。',
    brandBlock_(raw),
    '# 官網文章規則', setting_('rulesArticle', raw),
    '# 寫作風格', setting_('articleStyle', raw),
    LEAD_RULE,
    '# 作者小檔案（原文照放在文末）', setting_('authorBio', raw),
    legalBlock_(raw),
    '# 素材與誠實',
    '只能使用下面「Tori 的現場觀察」裡的經歷、客人反應、店內事件和數字。素材不足的地方，不要編造，直接在文中寫「【' + NEED_MATERIAL + '：需要 Tori 補充＿＿】」，並列進 needsMaterial。',
    '不要編造數據、研究或醫師說法；沒有可附來源連結的數據就不要寫數據。',
    '用繁體中文、台灣用語。服務人員一律稱「染護師」。',
    '# 一篇一個重點',
    '整篇只講一個重點（寫在 focus）。Tori 的現場觀察如果有好幾個重點，挑最適合這次關鍵字的一個寫進文章；其他沒用到的重點放進 leftovers，一個重點一則，盡量保留 Tori 的原話，不要改寫、加料或合併。只有一個重點或沒有提供素材時，leftovers 回空陣列。',
  ].join('\n\n');
  const material = [input.notes].concat((input.materials || []).map(m => '・' + m)).filter(Boolean).join('\n');
  const user = [
    '請寫一篇官網文章。',
    '主關鍵字：' + input.main,
    '長尾詞：' + (input.longtail || '（無）'),
    'Tori 的現場觀察：\n' + (material || '（這次沒有提供。需要第一線經驗的地方一律標「' + NEED_MATERIAL + '」。）'),
    '已經有的舊文章（建議內部連結只能從這裡挑；沒有就回傳空陣列）：\n' + (previous || '（還沒有）'),
  ].join('\n\n');
  const a = callClaude_({ type: '官網文章', system: system, user: user, schema: ARTICLE_SCHEMA, raw: raw }).json;
  const extra = {
    focus: a.focus, leftovers: a.leftovers || [],
    metaDescription: a.metaDescription, slug: a.slug, imageSuggestions: a.imageSuggestions, faq: a.faq, internalLinks: a.internalLinks,
    needsMaterial: a.needsMaterial, jsonLd: articleJsonLd_(a, raw),
  };
  const fullText = a.title + '\n' + a.body + '\n' + a.metaDescription;
  return { title: a.title, draft: a.body, extra: JSON.stringify(extra), check: JSON.stringify(complianceCheck_(fullText, '官網文章', raw)) };
}

/** FAQ 與作者的結構化資料，由程式組，不讓 AI 自由發揮 */
function articleJsonLd_(a, raw) {
  const site = setting_('websiteUrl', raw);
  const fmt = setting_('articleUrlFormat', raw);
  // 格式有 {代稱} 就替換；貼的是一篇文章的網址，就換掉最後一段路徑
  const url = !fmt ? '' : /\{[^}]*\}/.test(fmt) ? fmt.replace(/\{[^}]*\}/, a.slug)
    : /^https?:\/\/[^/]+\/.+/.test(fmt) && !/[?#]/.test(fmt) ? fmt.replace(/[^/]+\/?$/, a.slug) : '';
  const article = { '@context': 'https://schema.org', '@type': 'Article', headline: a.title, description: a.metaDescription,
    author: { '@type': 'Person', name: 'Tori', jobTitle: '頭沐 CHIEFROM 創辦人' },
    publisher: { '@type': 'Organization', name: setting_('brandName', raw), url: site || undefined } };
  if (url) article.mainEntityOfPage = url;
  const faq = { '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: (a.faq || []).map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) };
  return '<script type="application/ld+json">\n' + JSON.stringify([article, faq], null, 2) + '\n</script>';
}

/** 法規自檢：1. 禁用詞清單比對 2. AI 再檢查整體語意有沒有暗示療效。AI 檢查失敗不擋產出，但會標示出來 */
function complianceCheck_(text, type, raw, store) {
  const result = { banned: scanAll_(type, store || '', text), ai: [], aiError: '', disclaimer: DISCLAIMER };
  try {
    const system = '你是台灣化粧品廣告法規的檢查員，只找問題，不改寫全文。\n\n' + legalBlock_(raw) +
      '\n\n請找出會讓人聯想到療效、生理機能改變、絕對保證、貶低同業，或沒有來源的數據與醫師說法的句子。' +
      '「不含阿摩尼亞」本身是可以寫的事實，但延伸成不刺激、不傷髮就要標出。提到頭皮紅腫、傷口、過敏、嚴重掉髮卻沒有建議就醫，也要標出。' +
      'sentence 請原文照抄（一字不改），reason 用一句話說明，suggestion 給可以替換的寫法。沒有問題就回傳空陣列。';
    result.ai = callClaude_({ type: type + '自檢', system: system, user: '要檢查的' + type + '：\n\n' + text, schema: CHECK_SCHEMA,
      effort: 'low', maxTokens: 8000, raw: raw }).json.issues || [];
  } catch (err) {
    result.aiError = 'AI 語意檢查沒有完成：' + String(err.message || err);
  }
  return result;
}

function thisMonth_() { return today_().slice(0, 7); }
function today_() { return Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd'); }
function monthOfIso_(iso) { const d = new Date(iso); return isNaN(d) ? '' : Utilities.formatDate(d, 'Asia/Taipei', 'yyyy-MM'); }
function now_() { return new Date().toISOString(); }
/** 下一個星期幾（0=日、1=一…），今天剛好是就回今天之後的那一個 */
function nextWeekday_(wd) {
  const t = new Date(today_() + 'T00:00:00Z');
  const add = ((wd - t.getUTCDay() + 7) % 7) || 7;
  return new Date(t.getTime() + add * 86400000).toISOString().slice(0, 10);
}

/** 在 Apps Script 編輯器手動執行：確認金鑰和模型都正常（會花一點點費用） */
function testAI() {
  const r = callClaude_({ type: '連線測試', system: '你是測試助手。', user: '請只回覆「連線成功」四個字。', effort: 'low', maxTokens: 2000 });
  Logger.log('AI 回覆：' + r.text + '（輸入 ' + r.usage.input + '／輸出 ' + r.usage.output + ' token）');
}

/* ───────────── Google 商家貼文、IG 限動（一次產出 3 則） ───────────── */

const T_ARTICLE = '官網文章', T_GBP = 'Google 商家', T_IG = 'IG 限動';
const STYLE_KEY = { '官網文章': 'articleStyle', 'Google 商家': 'rulesGbp', 'IG 限動': 'rulesIg', '脆': 'rulesThreads' };

/** 來源素材：選一篇官網文章，或只選關鍵字 */
function sourceOf_(r) {
  if (r.articleId) {
    const a = table_('content').rows.find(x => x.id === String(r.articleId) && x.type === T_ARTICLE && [ST.REVIEW, ST.APPROVED, ST.PUBLISHED].indexOf(x.status) >= 0);
    if (!a) return { error: '找不到這篇官網文章，請重新選擇' };
    return { articleId: a.id, main: a.keyword, articleTitle: a.title };
  }
  if (r.keywordId) {
    const k = rows_('keywords').find(x => x.id === String(r.keywordId));
    if (!k) return { error: '請選一個關鍵字' };
    return { keywordId: k.id, main: k.main, longtail: k.longtail };
  }
  return { main: '' };
}

function startBatch_(type, r, user) {
  const raw = readSettings_();
  const over = budgetCheck_(raw);
  if (over) return over;
  if (!PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY')) {
    return { ok: false, error: 'NO_API_KEY', message: '還沒設定 Claude API 金鑰：Apps Script「專案設定 → 指令碼屬性」要有 ANTHROPIC_API_KEY' };
  }
  const src = sourceOf_(r);
  if (src.error) return invalid_(src.error);
  if (type === T_GBP && !src.main) return invalid_('請選一篇官網文章或一個關鍵字');
  const stores = rows_('stores');
  if (type === T_GBP && !stores.length) return invalid_('還沒有門市資料');
  const slots = stores.map(s => ({ store: s.name, date: nextWeekday_(2) }));
  const prefix = 'G';
  const ids = slots.map(() => prefix + Utilities.getUuid().replace(/-/g, '').slice(0, 10));
  const input = Object.assign({}, src, { notes: String(r.notes || '').trim().slice(0, 4000), batchLead: ids[0], batchIds: ids });
  withLock_(() => {
    const t = table_('content');
    slots.forEach((s, i) => t.append({ id: ids[i], type: type, store: s.store, keyword: src.main, draft: '', final: '', status: ST.RUNNING, check: '',
      suggestDate: s.date, publishedDate: '', owner: user.name, createdAt: now_(), title: s.setType ? T_IG + '｜' + s.setType : s.store,
      extra: s.setType ? JSON.stringify({ setType: s.setType }) : '', input: JSON.stringify(input), error: '', startedAt: '' }));
  });
  return { ok: true, id: ids[0], ids: ids };
}

function sourceBlock_(input) {
  if (input.articleId) {
    const a = table_('content').rows.find(x => x.id === input.articleId);
    if (a) return '來源官網文章：《' + a.title + '》（關鍵字：' + a.keyword + '）\n' + currentText_(a);
  }
  if (input.main) return '主題關鍵字：' + input.main + (input.longtail ? '（長尾詞：' + input.longtail + '）' : '');
  return '（沒有指定文章或關鍵字，請從品牌差異點挑主題）';
}

const GBP_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['posts'],
  properties: { posts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['store', 'angle', 'body'],
    properties: { store: { type: 'string', description: '門市名稱，照抄' }, angle: { type: 'string', description: '這篇挑的重點，一句話' }, body: { type: 'string' } } } } },
};

function generateGbp_(input, raw, rows) {
  const stores = rows_('stores');
  const system = [
    '你是頭沐 CHIEFROM 的小編，要寫 Google 商家（Google 地圖）的貼文。用品牌口吻，不帶入 Tori 個人。',
    brandBlock_(raw),
    '# Google 商家貼文規則', setting_('rulesGbp', raw),
    legalBlock_(raw),
    '# 這次要寫的',
    '每間門市各一篇：' + rows.map(r => '「' + r.store + '」').join('、') + '。store 欄位照抄門市名稱。',
    '三篇各挑一個不同的重點（寫在 angle），內容不可高度重複；開頭也不要用同一句。',
    '每篇約 300 字，自然帶到該店的城市加區名（例如高雄左營）。貼文會配一個「預約」按鈕，結尾用一句話引導按預約。',
    '高雄兩間店共用一個預約連結，高雄的兩篇結尾要提醒客人預約時選對店。內文不放電話號碼，也不要貼網址。',
    '只用下面來源裡的資訊和品牌資料；需要店內真實經驗但素材沒有的地方，寫「【' + NEED_MATERIAL + '：需要 Tori 補充＿＿】」，不可編造。',
    '用繁體中文、台灣用語，服務人員一律稱「染護師」。純文字，不用 Markdown 標題。',
  ].join('\n\n');
  const user = sourceBlock_(input) + (input.notes ? '\n\nTori 這次補充：\n' + input.notes : '');
  const out = callClaude_({ type: T_GBP, system: system, user: user, schema: GBP_SCHEMA, raw: raw }).json;
  return rows.map(r => {
    const p = (out.posts || []).find(x => String(x.store).trim() === r.store);
    if (!p) throw aiError_('AI_FORMAT', 'AI 少寫了「' + r.store + '」的貼文，請再產出一次');
    const st = stores.find(s => s.name === r.store) || {};
    return { title: r.store + '｜' + p.angle, draft: p.body,
      extra: JSON.stringify({ angle: p.angle, button: '預約', bookingUrl: st.bookingUrl || '' }),
      check: JSON.stringify(complianceCheck_(p.body, T_GBP, raw, r.store)) };
  });
}

/* ───────────── 格式檢查（程式判斷，不花 AI 費用） ───────────── */

const PHONE_RE = /(?:\+?886[-\s]?|\b0)\d{1,2}[-\s]?\d{3,4}[-\s]?\d{3,4}\b/;

/** 禁用詞＋各平台的格式規則，結果放在同一個清單 */
function scanAll_(type, store, text) {
  const hits = scanBanned_(text);
  const lines = String(text).split('\n');
  if (type === '脆') {
    const emoji = (String(text).match(/\p{Extended_Pictographic}/gu) || []).length;
    if (emoji > 1) hits.push({ word: '表情符號 ' + emoji + ' 個', category: '格式', note: '表情符號最多 1 個，可以不放', sentence: '' });
    const tags = (String(text).match(/(^|\s)#[^\s#]+/g) || []).length;
    if (tags > 2) hits.push({ word: '標籤 ' + tags + ' 個', category: '格式', note: '標籤最多 1～2 個', sentence: '' });
    const n = Array.from(String(text).replace(/\s/g, '')).length;
    if (n > 500) hits.push({ word: n + ' 字', category: '格式', note: '脆 500 字以內，可以更短', sentence: '' });
  }
  if (type === T_GBP || type === T_IG) {
    lines.filter(l => PHONE_RE.test(l)).forEach(l => hits.push({ word: '電話號碼', category: '格式', note: '內文不放電話號碼', sentence: l.trim() }));
  }
  if (type === T_GBP && store) {
    const st = rows_('stores').find(s => s.name === store);
    if (st && /高雄/.test(st.city) && !/選對|選擇.{0,6}(店|館)|哪一?間|哪一?館/.test(text)) {
      hits.push({ word: '沒有提醒選對店', category: '格式', note: '高雄兩間店共用預約連結，文末要提醒客人預約時選對店', sentence: '' });
    }
  }
  if (type === T_IG) {
    lines.forEach(l => {
      const m = l.match(/^\*\*主文字\*\*[：:]\s*(.*)$/);
      if (m) { const n = Array.from(m[1].replace(/\s/g, '')).length; if (n > 15) hits.push({ word: '主文字 ' + n + ' 字', category: '格式', note: '每頁主文字 15 字內', sentence: l.trim() }); }
    });
    if (!/預約/.test(text)) hits.push({ word: '沒有導向預約', category: '格式', note: '每組最後一頁要導向預約', sentence: '' });
  }
  return hits;
}

/** 依內容類型重寫（Google 商家、IG 限動），保留原本的格式 */
const REWRITE_SHORT_SCHEMA = { type: 'object', additionalProperties: false, required: ['title', 'body'], properties: { title: { type: 'string' }, body: { type: 'string' } } };

function rewriteShort_(row, instruction, raw) {
  if (row.type === T_THREADS) {
    const ex = parseJson_(row.extra) || {};
    const q = rows_('threadsQA').find(x => x.id === ex.questionId) || {};
    const sys = [
      '你是 Tori 的寫作助手，正在依她的意見改一則脆（Threads）。這是 Tori 本人發的文，用第一人稱「我」。',
      voiceBlock_(raw), legalBlock_(raw),
      '只能用原文和 Tori 回答裡有的經歷、對話和數字，不可以新增；「【' + NEED_MATERIAL + '：…】」照樣保留。' + THREAD_MAX_CHARS + ' 字以內，純文字。title 照原本的標題。',
    ].join('\n\n');
    const usr = 'Tori 的修改指示：' + (instruction || '（沒有特別指示，請更像 Tori 平常說話的樣子）') + '\n\n題目：' + (q.question || ex.question || '') +
      '\nTori 當初的回答：\n' + (q.answer || '（找不到）') + '\n\n目前的標題：' + row.title + '\n\n目前的內文：\n' + currentText_(row);
    return callClaude_({ type: T_THREADS + '重寫', system: sys, user: usr, schema: REWRITE_SHORT_SCHEMA, raw: raw }).json;
  }
  const system = [
    '你是頭沐 CHIEFROM 的小編，正在依 Tori 的意見修改一則「' + row.type + '」。',
    brandBlock_(raw),
    '# ' + row.type + '規則', setting_(STYLE_KEY[row.type], raw),
    legalBlock_(raw),
    row.type === T_IG ? '保留原本的格式：「## 主題」、每頁「### 第 N 頁」，以及「**主文字**：」「**建議畫面**：」「**互動貼圖**：」三行。主文字 15 字內，最後一頁導向預約。'
      : '這是「' + row.store + '」的貼文，約 300 字，純文字。高雄門市結尾要提醒客人預約時選對店。不放電話號碼和網址。',
    '不可新增任何沒有出現在原文裡的經歷、客人對話、店內事件或數據。「【' + NEED_MATERIAL + '：…】」照樣保留。',
    '用繁體中文、台灣用語，服務人員一律稱「染護師」。',
  ].join('\n\n');
  const user = 'Tori 的修改指示：' + (instruction || '（沒有特別指示，請照規則改得更好讀）') + '\n\n目前的標題：' + row.title + '\n\n目前的內容：\n' + currentText_(row);
  return callClaude_({ type: row.type + '重寫', system: system, user: user, schema: REWRITE_SHORT_SCHEMA, raw: raw }).json;
}

function batchSiblings_(row) {
  const inp = parseJson_(row.input) || {};
  if (!inp.batchIds || inp.batchIds.length < 2) return [];
  const rows = table_('content').rows;
  return inp.batchIds.map(id => rows.find(x => x.id === id)).filter(Boolean)
    .map(x => ({ id: x.id, store: x.store, title: x.title, status: x.status, setType: (parseJson_(x.extra) || {}).setType || '' }));
}

/* ───────────── PO 文素材：每日回報系統「回流訊息」存下來的前後對比圖 ─────────────
 * 資料夾結構（由每日回報系統建立）：頭沐 PO文素材／{門市}／{yyyy-MM}／{日期}_{門市}_{同仁}_{時間}_對比圖.jpg
 * 臉部已在回報系統自動模糊；同仁勾「這次不存成 PO 文素材」的不會出現在這裡。
 * 行銷助手只讀取，不修改、不刪除這個資料夾。 */

const PO_FOLDER_NAME = '頭沐 PO文素材';
const COLLAGE_RE = /^(\d{4}-\d{2}-\d{2})_(.+?)_(.+?)_(\d{6})_對比圖\.(jpe?g)$/i;
const PO_MONTHS = 3; // 只看最近幾個月的資料夾，避免越來越慢

function poFolder_() {
  const id = privateSettings_().poFolderId;
  if (!id) throw aiError_('NO_PO_FOLDER', '還沒連到「' + PO_FOLDER_NAME + '」資料夾，請在 Apps Script 執行 setup');
  return DriveApp.getFolderById(id);
}

/** 回報系統的門市名稱 → 行銷助手的門市名稱（旗艦本館→本館、台南→日和三館） */
function normStore_(name) {
  const stores = rows_('stores');
  const n = String(name || '');
  const hit = stores.find(s => s.name === n) || stores.find(s => n.indexOf(s.name) >= 0 || s.name.indexOf(n) >= 0)
    || stores.find(s => s.city && n.indexOf(s.city.replace(/[市縣]$/, '')) >= 0);
  return hit ? hit.name : n;
}

function iter_(it) { const out = []; while (it.hasNext()) out.push(it.next()); return out; }

/** 掃最近幾個月的對比圖 */
function scanCollages_() {
  const root = poFolder_();
  const months = [];
  for (let i = 0; i < PO_MONTHS; i++) {
    const d = new Date(today_() + 'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() - i, 1);
    months.push(d.toISOString().slice(0, 7));
  }
  const used = {};
  table_('content').rows.filter(x => x.type === T_IG && x.status !== ST.FAILED).forEach(x => {
    const pid = (parseJson_(x.extra) || {}).photoId; if (pid) used[pid] = x.status === ST.RUNNING ? '產出中' : '已用';
  });
  const out = [];
  iter_(root.getFolders()).forEach(storeFolder => {
    iter_(storeFolder.getFolders()).filter(m => months.indexOf(m.getName()) >= 0).forEach(monthFolder => {
      iter_(monthFolder.getFiles()).forEach(f => {
        const m = f.getName().match(COLLAGE_RE);
        if (!m) return;
        out.push({ id: f.getId(), date: m[1], store: normStore_(m[2] || storeFolder.getName()), staff: m[3], time: m[4], used: used[f.getId()] || '' });
      });
    });
  });
  return out.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
}

function listMaterials_(r) {
  let items;
  try { items = scanCollages_(); } catch (err) { return { ok: false, error: err.code || 'PO_ERROR', message: String(err.message || err) }; }
  if (r.store) items = items.filter(x => x.store === r.store);
  if (r.unused) items = items.filter(x => !x.used);
  const since = new Date(new Date(today_() + 'T00:00:00Z').getTime() - 6 * 86400000).toISOString().slice(0, 10);
  const recent = items.filter(x => x.date >= since);
  const stores = rows_('stores').map(s => s.name);
  return { ok: true, items: items.slice(0, Number(r.limit) || 30), total: items.length,
    weekByStore: stores.map(s => ({ store: s, count: recent.filter(x => x.store === s).length })) };
}

/** 確認檔案真的在 PO 文素材資料夾裡（門市／月份兩層），才回傳 */
function poFile_(id) {
  const rootId = privateSettings_().poFolderId;
  let f;
  try { f = DriveApp.getFileById(String(id || '')); } catch (e) { return null; }
  if (!COLLAGE_RE.test(f.getName())) return null;
  const inside = iter_(f.getParents()).some(month => iter_(month.getParents()).some(store => iter_(store.getParents()).some(root => root.getId() === rootId)));
  return inside ? f : null;
}

function getMaterial_(r) {
  const f = poFile_(r.id);
  if (!f) return { ok: false, error: 'NOT_FOUND', message: '找不到這張對比圖' };
  const blob = r.full ? f.getBlob() : (f.getThumbnail() || f.getBlob());
  return { ok: true, mime: blob.getContentType() || 'image/jpeg', data: Utilities.base64Encode(blob.getBytes()), name: f.getName() };
}

/* ───────────── IG 限動：每組用一張對比圖 ───────────── */

const IG_SET = '髮色對比';
const IG_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['sets'],
  properties: { sets: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['photoId', 'theme', 'pages'], properties: {
    photoId: { type: 'string' }, theme: { type: 'string', description: '這組的主題，例如「滿頭白髮到自然深棕」' },
    pages: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'visual', 'sticker'], properties: {
      text: { type: 'string', description: '主文字，15 字內' }, visual: { type: 'string', description: '這頁放什麼畫面：對比圖、或店內畫面' },
      sticker: { type: 'string', description: '互動貼圖：投票／測驗／問答箱／滑桿／連結，或「無」，並寫出貼圖上的文字' } } } } } } } },
};

function startIg_(r, user) {
  const raw = readSettings_();
  const over = budgetCheck_(raw);
  if (over) return over;
  if (!PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY')) return { ok: false, error: 'NO_API_KEY', message: '還沒設定 Claude API 金鑰' };
  const want = (Array.isArray(r.photoIds) ? r.photoIds.map(String) : []).filter((x, i, a) => a.indexOf(x) === i).slice(0, 3);
  if (!want.length) return invalid_('請至少選一張對比圖');
  let all;
  try { all = scanCollages_(); } catch (err) { return { ok: false, error: err.code || 'PO_ERROR', message: String(err.message || err) }; }
  const picked = want.map(id => all.find(x => x.id === id));
  if (picked.some(x => !x)) return invalid_('有對比圖找不到了，請重新整理');
  const dup = picked.find(x => x.used);
  if (dup && !r.allowUsed) return invalid_(dup.date + ' ' + dup.store + ' 這張已經用過了，請換一張');
  const dates = [nextWeekday_(1), nextWeekday_(3), nextWeekday_(5)].sort();
  const ids = picked.map(() => 'I' + Utilities.getUuid().replace(/-/g, '').slice(0, 10));
  const input = { photoIds: picked.map(p => p.id), notes: String(r.notes || '').trim().slice(0, 2000), batchLead: ids[0], batchIds: ids };
  withLock_(() => {
    const t = table_('content');
    picked.forEach((p, i) => t.append({ id: ids[i], type: T_IG, store: p.store, keyword: '', draft: '', final: '', status: ST.RUNNING, check: '',
      suggestDate: dates[i], publishedDate: '', owner: user.name, createdAt: now_(), title: T_IG + '｜' + p.store + ' ' + p.date,
      extra: JSON.stringify({ setType: IG_SET, photoId: p.id, photoDate: p.date, photoStaff: p.staff }), input: JSON.stringify(input), error: '', startedAt: '' }));
  });
  return { ok: true, id: ids[0], ids: ids };
}

function igMarkdown_(s) {
  return '## ' + s.theme + '\n\n' + s.pages.map((p, i) =>
    '### 第 ' + (i + 1) + ' 頁\n**主文字**：' + p.text + '\n**建議畫面**：' + p.visual + '\n**互動貼圖**：' + p.sticker).join('\n\n');
}

function generateIg_(input, raw, rows) {
  const sets = rows.map(r => {
    const ex = parseJson_(r.extra) || {};
    const f = poFile_(ex.photoId);
    if (!f) throw aiError_('NO_PHOTO', '找不到 ' + (ex.photoDate || '') + ' ' + r.store + ' 那張對比圖，可能被移走或刪除了，請重新選');
    return { row: r, ex: ex, file: f };
  });
  const system = [
    '你是頭沐 CHIEFROM 的小編，要用店裡同仁拍的服務前後對比圖，做 IG 限時動態的腳本。口吻親切、活潑，比 Google 商家輕鬆。',
    brandBlock_(raw),
    '# IG 限動規則', setting_('rulesIg', raw),
    legalBlock_(raw),
    '# 這次要做的',
    '每張對比圖做一組限動，共 ' + sets.length + ' 組，photoId 照抄。每組 2～4 頁：第一頁放對比圖，最後一頁導向預約（互動貼圖用「連結」：預約）。幾組之間的主題和開頭不要重複。',
    '看圖只描述顏色變化，例如「從滿頭白髮到自然的深棕」，不寫頭皮、髮質或任何成效，也不要評論客人的外表或年齡，不要說出客人的身分。看不清楚的就寫「自然的髮色」。',
    '每頁主文字 15 字內（含標點）。不可編造客人的話或店內事件。',
    '用繁體中文、台灣用語，服務人員一律稱「染護師」。',
  ].join('\n\n');
  const content = [{ type: 'text', text: (input.notes ? 'Tori 這次補充：' + input.notes + '\n\n' : '') + '以下是這次的對比圖（每張上面是服務前、下面是服務後，臉部已模糊）：' }];
  sets.forEach((s, i) => {
    content.push({ type: 'text', text: '第 ' + (i + 1) + ' 組　photoId：' + s.ex.photoId + '　門市：' + s.row.store + '　日期：' + (s.ex.photoDate || '') });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Utilities.base64Encode(s.file.getBlob().getBytes()) } });
  });
  const out = callClaude_({ type: T_IG, system: system, content: content, schema: IG_SCHEMA, model: setting_('modelVision', raw), raw: raw }).json;
  return sets.map(s => {
    const set = (out.sets || []).find(x => x.photoId === s.ex.photoId);
    if (!set || !(set.pages || []).length) throw aiError_('AI_FORMAT', 'AI 少做了 ' + (s.ex.photoDate || '') + ' ' + s.row.store + ' 那組，請再產出一次');
    const md = igMarkdown_(set);
    return { title: T_IG + '｜' + s.row.store + '・' + set.theme, draft: md,
      extra: JSON.stringify(Object.assign({}, s.ex, { theme: set.theme, pages: set.pages })),
      check: JSON.stringify(complianceCheck_(md, T_IG, raw, '')) };
  });
}

/* ───────────── 脆（Threads）：先出題 → Tori 回答 → 用她的話寫初稿（第 5 步） ───────────── */

const T_THREADS = '脆';
const Q_OPEN = '待回答', Q_DONE = '已寫', Q_SKIP = '略過', Q_BUSY = '寫初稿中';
const THREAD_MAX_CHARS = 500;

/** Tori 的口吻、反 AI 感規則、最近 5 篇定稿範例 */
function voiceBlock_(raw) {
  const ex = rows_('examples').filter(e => e.body).sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 5);
  return [
    '# 脆的規則', setting_('rulesThreads', raw),
    '# Tori 口吻設定', setting_('toriVoice', raw),
    '# 反 AI 感規則', setting_('antiAi', raw),
    '# Tori 自己寫的定稿範例（學她的語氣、節奏、斷行，不要抄內容）',
    ex.length ? ex.map((e, i) => '【範例 ' + (i + 1) + '｜' + (e.ring || '') + '】\n' + e.body).join('\n\n') : '（還沒有範例）',
  ].join('\n\n');
}

const Q_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['questions'],
  properties: { questions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ring', 'question', 'hint', 'poolId'], properties: {
    ring: { type: 'string', enum: RINGS }, question: { type: 'string', description: '問 Tori 的一個問題，口語、具體，一句話' },
    hint: { type: 'string', description: '怎麼回答比較好寫，例如「講一個具體的場景、當時說了什麼」' },
    poolId: { type: 'string', description: '這題參考了哪則脆素材的編號，沒有就空字串' } } } } },
};

/** 出 3 題：三圈各一題，可以參考脆素材庫；不重複最近問過的 */
function threadsQuestions_(r, user) {
  const raw = readSettings_();
  const over = budgetCheck_(raw);
  if (over) return over;
  const pool = rows_('threadsPool').filter(m => m.used !== YES && m.body).slice(0, 30);
  const recent = rows_('threadsQA').slice(-30).map(q => '・' + q.question).join('\n');
  const system = [
    '你在幫頭沐 CHIEFROM 的創辦人 Tori 準備脆（Threads）的素材。你的工作是「問她問題」，不是寫文章。',
    voiceBlock_(raw),
    '# 出題規則',
    '出 3 題，外圈、中圈、內圈各一題。每題都從創業者的角度問，問得具體，讓她能用一個真實的場景、一句當時說的話、一個數字來回答。',
    '不要問是非題，不要一次問好幾件事，不要問她沒辦法用親身經歷回答的事。中圈的玄學題要用初學者、實驗者的角度，不要連到頭髮或健康。Tori 不是媽媽，不要從媽媽的身分問。',
    '可以參考下面的脆素材（有用到就把編號填在 poolId），也可以不用。不要跟最近問過的題目重複。',
  ].join('\n\n');
  const ask = '這個月：' + thisMonth_() + (r.focus ? '\nTori 想聊的方向：' + String(r.focus).slice(0, 300) : '') +
    '\n\n脆素材庫：\n' + (pool.length ? pool.map(m => m.id + '（' + m.ring + '）' + m.body).join('\n') : '（沒有）') +
    '\n\n最近問過的題目：\n' + (recent || '（沒有）');
  let out;
  try { out = callClaude_({ type: '脆出題', system: system, user: ask, schema: Q_SCHEMA, effort: 'low', maxTokens: 8000, raw: raw }).json; }
  catch (err) { return { ok: false, error: err.code || 'AI_ERROR', message: String(err.message || err) }; }
  const qs = RINGS.map(ring => (out.questions || []).find(q => q.ring === ring)).filter(Boolean);
  if (qs.length < 3) return { ok: false, error: 'AI_FORMAT', message: 'AI 出的題目不完整，請再按一次' };
  const batch = 'Q' + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
  const rows = qs.map((q, i) => ({ id: batch + '-' + (i + 1), ring: q.ring, question: String(q.question).trim(), answer: '', contentId: '',
    batch: batch, hint: q.hint || '', poolId: pool.some(m => m.id === q.poolId) ? q.poolId : '', status: Q_OPEN, createdAt: now_() }));
  withLock_(() => { const t = table_('threadsQA', true); rows.forEach(x => t.append(x)); });
  return { ok: true, questions: rows.map(presentQ_) };
}

function presentQ_(q) { return { id: q.id, ring: q.ring, question: q.question, hint: q.hint, answer: q.answer, status: q.status, createdAt: q.createdAt }; }

/** 還沒回答的題目（新的在前） */
function threadsPending_() {
  const qs = rows_('threadsQA').filter(q => q.status === Q_OPEN || (!q.status && !q.contentId))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 12).map(presentQ_);
  return { ok: true, questions: qs };
}

/** 改題目文字、或拿掉這題（略過） */
function updateQuestion_(r) {
  return withLock_(() => {
    const t = table_('threadsQA', true);
    const q = t.rows.find(x => x.id === String(r.id || ''));
    if (!q) return { ok: false, error: 'NOT_FOUND' };
    if (q.status === Q_DONE || q.status === Q_BUSY) return invalid_('這題已經寫成初稿了');
    const patch = {};
    if (r.skip) patch.status = Q_SKIP;
    if (r.question !== undefined) { const v = String(r.question).trim().slice(0, 300); if (!v) return invalid_('題目不能空白'); patch.question = v; }
    if (r.answer !== undefined) patch.answer = String(r.answer).trim().slice(0, 4000);
    t.update(q, patch);
    return { ok: true, question: presentQ_(q) };
  });
}

/** 用回答寫初稿：有回答的題目各寫一則；沒回答的留著，下次再回答 */
function startThreads_(r, user) {
  const raw = readSettings_();
  const over = budgetCheck_(raw);
  if (over) return over;
  if (!PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY')) return { ok: false, error: 'NO_API_KEY', message: '還沒設定 Claude API 金鑰' };
  const answers = (Array.isArray(r.answers) ? r.answers : []).map(a => ({ id: String(a.id || ''), answer: String(a.answer || '').trim().slice(0, 4000),
    question: a.question === undefined ? undefined : String(a.question).trim().slice(0, 300) }));
  const t = table_('threadsQA', true);
  // 先把所有填過的回答存起來（包括這次沒有要寫的），再挑有回答的來寫
  withLock_(() => answers.forEach(a => {
    const q = t.rows.find(x => x.id === a.id);
    if (q && q.status !== Q_DONE && q.status !== Q_BUSY) t.update(q, Object.assign({ answer: a.answer }, a.question ? { question: a.question } : {}));
  }));
  const picked = answers.filter(a => a.answer).map(a => t.rows.find(x => x.id === a.id)).filter(q => q && q.status !== Q_DONE && q.status !== Q_BUSY).slice(0, 3);
  if (!picked.length) return invalid_('請至少回答一題');
  const order = { '外圈': 0, '中圈': 1, '內圈': 2 };
  picked.sort((a, b) => (order[a.ring] ?? 9) - (order[b.ring] ?? 9));
  const dates = [nextWeekday_(2), nextWeekday_(4), nextWeekday_(6)].sort();
  const ids = picked.map(() => 'T' + Utilities.getUuid().replace(/-/g, '').slice(0, 10));
  const input = { qids: picked.map(q => q.id), batchLead: ids[0], batchIds: ids };
  withLock_(() => {
    picked.forEach(q => t.update(q, { status: Q_BUSY }));
    const ct = table_('content');
    picked.forEach((q, i) => ct.append({ id: ids[i], type: T_THREADS, store: '', keyword: q.ring, draft: '', final: '', status: ST.RUNNING, check: '',
      suggestDate: dates[i], publishedDate: '', owner: user.name, createdAt: now_(), title: T_THREADS + '｜' + q.ring + '：' + q.question.slice(0, 24),
      extra: JSON.stringify({ ring: q.ring, questionId: q.id, question: q.question }), input: JSON.stringify(input), error: '', startedAt: '' }));
  });
  return { ok: true, id: ids[0], ids: ids };
}

const THREADS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['threads'],
  properties: { threads: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['qid', 'body'], properties: {
    qid: { type: 'string' }, body: { type: 'string', description: '脆的內文，純文字，一句一行' } } } } },
};

function generateThreads_(input, raw, rows) {
  const qs = rows_('threadsQA');
  const items = rows.map(r => {
    const qid = (parseJson_(r.extra) || {}).questionId;
    const q = qs.find(x => x.id === qid);
    if (!q || !q.answer) throw aiError_('NO_ANSWER', '找不到「' + r.keyword + '」那題的回答，請重新回答');
    return { row: r, q: q };
  });
  const system = [
    '你是 Tori 的寫作助手，幫她把「她自己的回答」整理成脆（Threads）的初稿。這是 Tori 本人發的文，用第一人稱「我」。',
    voiceBlock_(raw),
    legalBlock_(raw),
    '# 這次的寫法',
    '每題寫一則，qid 照抄。盡量保留 Tori 回答裡的原話、用詞、口頭禪和她舉的細節；可以調順序、斷行、刪掉重複，但不要把她的話改得更漂亮。',
    '只能用她回答裡有的經歷、對話和數字；回答沒提到的不要補，需要的話寫「【' + NEED_MATERIAL + '：需要 Tori 補充＿＿】」。',
    '每則 ' + THREAD_MAX_CHARS + ' 字以內，可以更短。幾則的開頭和結構不可以一樣；不寫金句、不硬加結尾問句。表情符號最多 1 個，標籤最多 1～2 個，也可以都不放。',
    '純文字，不用 Markdown 標題或粗體。',
  ].join('\n\n');
  const user = items.map((it, i) => '## 第 ' + (i + 1) + ' 則　qid：' + it.q.id + '　圈層：' + it.q.ring + '\n題目：' + it.q.question + '\nTori 的回答：\n' + it.q.answer).join('\n\n');
  const out = callClaude_({ type: T_THREADS, system: system, user: user, schema: THREADS_SCHEMA, raw: raw }).json;
  return items.map(it => {
    const p = (out.threads || []).find(x => x.qid === it.q.id);
    if (!p || !p.body) throw aiError_('AI_FORMAT', 'AI 少寫了「' + it.q.ring + '」那則，請再產出一次');
    return { draft: p.body.trim(), check: JSON.stringify(complianceCheck_(p.body, T_THREADS, raw, '')) };
  });
}

/** 寫初稿失敗：題目放回待回答（回答留著），可以再送一次 */
function reopenThreads_(inp) {
  const t = table_('threadsQA', true);
  (inp.qids || []).forEach(qid => { const q = t.rows.find(x => x.id === qid); if (q && q.status === Q_BUSY) t.update(q, { status: Q_OPEN }); });
}

/** 初稿寫好後：題目標成已寫、用到的脆素材標成已用 */
function markThreadsDone_(row, inp) {
  const t = table_('threadsQA', true), pt = table_('threadsPool', true);
  const ids = inp.batchIds || [row.id];
  (inp.qids || []).forEach((qid, i) => {
    const q = t.rows.find(x => x.id === qid);
    if (!q) return;
    t.update(q, { status: Q_DONE, contentId: ids[i] || '' });
    const m = q.poolId && pt.rows.find(x => x.id === q.poolId);
    if (m) pt.update(m, { used: YES });
  });
}

/** 把這則脆存成 Tori 定稿範例（之後寫初稿會參考最近 5 篇） */
function saveExample_(r) {
  return withLock_(() => {
    const t = table_('content');
    const row = t.rows.find(x => x.id === String(r.id || ''));
    if (!row) return { ok: false, error: 'NOT_FOUND' };
    if (row.type !== T_THREADS) return invalid_('只有脆可以存成範例');
    if ([ST.REVIEW, ST.APPROVED, ST.PUBLISHED].indexOf(row.status) < 0) return invalid_('這則還沒有產出成功');
    const text = currentText_(row);
    if (placeholders_(text).length) return invalid_('還有【待素材】沒補，補完再存成範例');
    const extra = parseJson_(row.extra) || {};
    const et = table_('examples');
    const ex = extra.exampleId && et.rows.find(x => x.id === extra.exampleId);
    if (ex) et.update(ex, { body: text, ring: extra.ring || '', date: today_() });
    else {
      const id = nextId_('examples', et.rows);
      et.append({ id: id, body: text, ring: RINGS.indexOf(extra.ring) >= 0 ? extra.ring : '', date: today_() });
      extra.exampleId = id;
      t.update(row, { extra: JSON.stringify(extra) });
    }
    return { ok: true, item: presentContent_(row), updated: !!ex };
  });
}

/* ───────────── 初始化（在編輯器手動執行一次；重跑不會覆蓋已改過的資料） ───────────── */

function setup() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SETTINGS_SHEET);
  if (!sh) sh = ss.insertSheet(SETTINGS_SHEET, 0);
  if (sh.getLastRow() === 0) { sh.appendRow(['項目', '名稱', '內容', '說明']); sh.setFrozenRows(1); }
  sh.getRange('C:C').setNumberFormat('@');
  const existing = sh.getDataRange().getValues().map(r => String(r[0]));
  Object.keys(PRIVATE_SETTINGS).forEach(k => {
    const d = PRIVATE_SETTINGS[k];
    if (existing.indexOf(k) < 0) sh.appendRow([k, d[0] + '（只在試算表改）', d[1], d[2]]);
  });
  Object.keys(EDITABLE_SETTINGS).forEach(k => {
    const d = EDITABLE_SETTINGS[k];
    if (existing.indexOf(k) < 0) sh.appendRow([k, d[1], d[2], d[3]]);
  });
  const raw = readSettings_();
  FILL_IF_BLANK.forEach(k => { if (!String(raw[k] || '').trim()) writeSetting_(k, EDITABLE_SETTINGS[k][2]); });
  const seeded = [];
  Object.keys(TABLES).forEach(k => {
    const t = table_(k, true);
    if (SEED[k] && !t.rows.length) {
      const keys = TABLES[k].cols.map(c => c[0]);
      SEED[k].forEach(v => { const o = {}; keys.forEach((key, i) => { o[key] = v[i] === undefined ? '' : v[i]; }); t.append(o); });
      seeded.push(TABLES[k].sheet + ' ' + SEED[k].length + ' 筆');
    }
  });
  const staff = table_('staff');
  if (!staff.rows.some(m => m.id === ADMIN_ID)) staff.append({ id: ADMIN_ID, name: 'Tori', email: '', store: '', active: YES });
  const conf = privateSettings_();
  if (!conf.googleClientId) writeSetting_('googleClientId', DEFAULT_CLIENT_ID);
  if (!adminList_(conf).length) {
    const me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
    if (me) { writeSetting_('adminEmails', me); Logger.log('管理者 Gmail：' + me + '（登入網頁時請用這個帳號）'); }
    else Logger.log('讀不到你的 Gmail，請在「設定」分頁的 adminEmails 填上你的 Gmail');
  }
  if (!privateSettings_().poFolderId) {
    const found = iter_(DriveApp.getFoldersByName(PO_FOLDER_NAME));
    if (found.length === 1) { writeSetting_('poFolderId', found[0].getId()); Logger.log('已連到「' + PO_FOLDER_NAME + '」資料夾'); }
    else Logger.log(found.length ? '找到 ' + found.length + ' 個「' + PO_FOLDER_NAME + '」資料夾，請在「設定」分頁的 poFolderId 貼上要用的那個資料夾編號'
      : '還沒有「' + PO_FOLDER_NAME + '」資料夾（同仁第一次在每日回報系統存 PO 文素材時會建立），建立後再執行一次 setup');
  }
  Logger.log(seeded.length ? '已匯入初始資料：' + seeded.join('、') : '資料表都已有資料，沒有重複匯入。');
  Logger.log('完成。接著部署成網頁應用程式（見 README）。');
}

/* ───────────── 資料存取與工具 ───────────── */

function rows_(table) { return table_(table).rows.map(r => pickRow_(table, r)); }
function publicRow_(table, r) {
  const o = {}; TABLES[table].cols.forEach(c => { if (c[2] !== 'secret') o[c[0]] = r[c[0]] === undefined ? '' : r[c[0]]; }); return o;
}
function pickRow_(table, r) { const o = {}; TABLES[table].cols.forEach(c => { o[c[0]] = r[c[0]] === undefined ? '' : r[c[0]]; }); return o; }

/** 試算表第一列是中文欄名，程式內用英文 key；欄位順序以試算表為準，Tori 在表上調整欄位順序也不會壞 */
function table_(table, create) {
  const def = TABLES[table];
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(def.sheet);
  if (!sh) {
    if (!create) throw new Error('找不到工作表「' + def.sheet + '」，請先執行 setup()');
    sh = ss.insertSheet(def.sheet);
  }
  if (sh.getLastRow() === 0) { sh.appendRow(def.cols.map(c => c[1])); sh.setFrozenRows(1); sh.getRange('A:Z').setNumberFormat('@'); }
  const values = sh.getDataRange().getValues();
  const labels = values[0].map(String);
  const header = labels.map(l => { const c = def.cols.find(x => x[1] === l); return c ? c[0] : null; });
  def.cols.forEach(c => {
    if (header.indexOf(c[0]) < 0) { sh.getRange(1, header.length + 1).setValue(c[1]); header.push(c[0]); }
  });
  const rows = values.slice(1).map((v, i) => {
    const o = {};
    header.forEach((h, j) => { if (h) o[h] = cellText_(v[j]); });
    Object.defineProperty(o, '_row', { value: i + 2, writable: true, enumerable: false });
    return o;
  }).filter(o => Object.keys(o).some(k => o[k] !== ''));
  return {
    rows: rows,
    append(obj) {
      sh.appendRow(header.map(h => h && obj[h] !== undefined ? String(obj[h]) : ''));
      Object.defineProperty(obj, '_row', { value: sh.getLastRow(), writable: true, enumerable: false });
      rows.push(obj);
    },
    update(obj, patch) {
      Object.keys(patch).forEach(k => {
        const col = header.indexOf(k);
        if (col < 0) return;
        obj[k] = patch[k] === undefined || patch[k] === null ? '' : String(patch[k]);
        sh.getRange(obj._row, col + 1).setValue(obj[k]);
      });
    },
    remove(obj) {
      sh.deleteRow(obj._row);
      rows.splice(rows.indexOf(obj), 1);
      rows.forEach(r => { if (r._row > obj._row) r._row -= 1; });
    },
  };
}

/** Sheet 有時會把文字自動轉成日期值，轉回 yyyy-MM-dd */
function cellText_(v) {
  if (v === undefined || v === null) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, 'Asia/Taipei', 'yyyy-MM-dd');
  return String(v);
}

function readSettings_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SETTINGS_SHEET);
  if (!sh) throw new Error('找不到「設定」分頁，請先執行 setup()');
  const o = {};
  sh.getDataRange().getValues().slice(1).forEach(r => { if (r[0]) o[String(r[0])] = r[2] === undefined || r[2] === null ? '' : String(r[2]); });
  return o;
}
function privateSettings_() {
  const raw = readSettings_();
  const o = {};
  Object.keys(PRIVATE_SETTINGS).forEach(k => { o[k] = String(raw[k] || '').trim(); });
  return o;
}
function writeSetting_(k, v) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SETTINGS_SHEET);
  const values = sh.getDataRange().getValues();
  const i = values.findIndex(r => String(r[0]) === k);
  const d = PRIVATE_SETTINGS[k] || EDITABLE_SETTINGS[k];
  if (i < 0) sh.appendRow([k, PRIVATE_SETTINGS[k] ? d[0] : d[1], v, PRIVATE_SETTINGS[k] ? d[2] : d[3]]);
  else sh.getRange(i + 1, 3).setValue(v);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return fn(); } finally { lock.releaseLock(); }
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function invalid_(msg) { return { ok: false, error: 'INVALID', message: msg }; }
