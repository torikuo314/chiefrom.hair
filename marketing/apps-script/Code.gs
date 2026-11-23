/**
 * 頭沐 CHIEFROM 行銷助手 後台（Google Apps Script，綁定在「行銷助手」專用的 Google Sheet 上）
 *
 * 登入做法和任務系統（apps-script/）一致，但帳號分開：
 * - 姓名 ＋ PIN 送到後台核對，成功後發 6 小時 session token
 * - PIN 以「加鹽 ＋ 伺服器密鑰」雜湊儲存，永遠不回傳給前端；連續錯 5 次鎖 15 分鐘；PIN 至少 6 位數
 * - 管理者是「人員」分頁裡編號 __admin__ 那一列；員工綁定所屬門市
 * - 權限全部在這裡判斷，前端只負責顯示；設定類動作只限管理者
 * - 所有規則、口吻、關鍵字、禁用詞都存在試算表，網頁上可改，不寫死在程式裡
 *   （這個檔案裡的內容只是 setup() 第一次匯入用的初始資料）
 *
 * 第一次使用：在 Apps Script 編輯器執行 setup()，到「執行記錄」看管理者初始 PIN。
 * Claude API 金鑰放在「專案設定 → 指令碼屬性」的 ANTHROPIC_API_KEY，絕不放在試算表或程式碼裡。
 */

const TOKEN_TTL_SEC = 6 * 60 * 60;   // CacheService 上限就是 6 小時
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const PIN_RE = /^\d{6,12}$/;
const ADMIN_ID = '__admin__';
const SETTINGS_SHEET = '設定';
const DISCLAIMER = '這是系統檢查，不等於法律意見，發布前請再看一次。';

/* ───────────── 設定（項目／內容） ───────────── */

// 只能在試算表裡改，永遠不回傳給前端
const PRIVATE_SETTINGS = {
  photoFolderId: ['對比照資料夾', '', '對比照存放的雲端硬碟資料夾編號（setup 自動建立，不公開分享）'],
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
  staff: { sheet: '人員', title: '人員與 PIN', editable: true, cols: [
    ['id', '編號', 'id'], ['name', '姓名', 'text'], ['store', '門市', 'store'], ['active', '啟用', 'bool'],
    ['pinHash', 'PIN 雜湊', 'secret'], ['salt', 'salt', 'secret'], ['failCount', '錯誤次數', 'secret'],
    ['lockUntil', '鎖定到', 'secret'], ['tokenVer', '登入版本', 'secret']] },
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
    ['error', '錯誤訊息', 'text'], ['startedAt', '開始產出時間', 'text']] },
  threadsQA: { sheet: '脆問答', cols: [
    ['id', '編號', 'id'], ['ring', '圈層', 'text'], ['question', '題目', 'long'], ['answer', 'Tori 的回答', 'long'],
    ['contentId', '對應內容編號', 'text']] },
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
    if (action === 'publicMembers') return { ok: true, data: publicMembers_() };
    if (action === 'login') return login_(req.memberId, req.pin);
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
  me:           { fn: (r, u) => ({ ok: true, user: u }) },
  getConfig:    { fn: getConfig_, admin: true },
  saveSettings: { fn: saveSettings_, admin: true },
  saveRow:      { fn: saveRow_, admin: true },
  resetPin:     { fn: resetPin_, admin: true },
  deleteRow:    { fn: deleteRow_, admin: true },
  checkText:    { fn: r => ({ ok: true, hits: scanBanned_(String(r.text || '')), disclaimer: DISCLAIMER }), admin: true },
  articleOptions: { fn: articleOptions_, admin: true },
  startArticle: { fn: startArticle_, admin: true },
  runJob:       { fn: runJob_, admin: true },
  getContent:   { fn: getContent_, admin: true },
  listContent:  { fn: listContent_, admin: true },
};

/* ───────────── PIN 登入 ───────────── */

/** 登入畫面用：只回傳姓名與門市 */
function publicMembers_() {
  return rows_('staff').filter(m => m.active === YES).map(m => ({ id: m.id, name: m.name, store: m.store }));
}

function login_(memberId, pin) {
  return withLock_(() => {
    const t = table_('staff');
    const m = t.rows.find(r => r.id === String(memberId || ''));
    const fail = { ok: false, error: 'LOGIN_FAILED', message: '帳號或 PIN 不正確' };
    if (!m || m.active !== YES) return fail;
    const now = Date.now();
    if (Number(m.lockUntil) > now) {
      const mins = Math.ceil((Number(m.lockUntil) - now) / 60000);
      return { ok: false, error: 'LOCKED', message: '錯誤次數過多，請 ' + mins + ' 分鐘後再試' };
    }
    if (!m.pinHash || hashPin_(String(pin || ''), m.salt) !== m.pinHash) {
      const fails = Number(m.failCount || 0) + 1;
      const patch = { failCount: fails >= MAX_FAILS ? 0 : fails };
      if (fails >= MAX_FAILS) patch.lockUntil = now + LOCK_MINUTES * 60000;
      t.update(m, patch);
      return fails >= MAX_FAILS
        ? { ok: false, error: 'LOCKED', message: '錯誤 ' + MAX_FAILS + ' 次，帳號鎖定 ' + LOCK_MINUTES + ' 分鐘' }
        : fail;
    }
    t.update(m, { failCount: 0, lockUntil: '' });
    const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    CacheService.getScriptCache().put('mkt:' + token, JSON.stringify({ id: m.id, ver: String(m.tokenVer || '0') }), TOKEN_TTL_SEC);
    return { ok: true, token: token, user: userOf_(m) };
  });
}

/** 每次都回頭查人員表：被停用、刪除、重設 PIN 或換門市會立刻生效 */
function authenticate_(token) {
  if (!token || typeof token !== 'string') return null;
  const raw = CacheService.getScriptCache().get('mkt:' + token);
  if (!raw) return null;
  const s = JSON.parse(raw);
  const m = table_('staff').rows.find(r => r.id === s.id);
  if (!m || m.active !== YES || String(m.tokenVer || '0') !== s.ver) return null;
  return userOf_(m);
}

function userOf_(m) {
  const admin = m.id === ADMIN_ID;
  return { id: m.id, name: m.name, role: admin ? 'admin' : 'staff', store: admin ? '' : m.store };
}

function resetPin_(r) {
  if (!PIN_RE.test(String(r.pin || ''))) return invalid_('PIN 需為 6–12 位數字');
  return withLock_(() => {
    const t = table_('staff');
    const m = t.rows.find(x => x.id === String(r.id || ''));
    if (!m) return { ok: false, error: 'NOT_FOUND' };
    t.update(m, pinPatch_(String(r.pin), m));
    return { ok: true };
  });
}

/** 新 PIN：換 salt、清錯誤次數、tokenVer＋1 讓舊的登入失效 */
function pinPatch_(pin, m) {
  const salt = Utilities.getUuid().replace(/-/g, '');
  return { pinHash: hashPin_(pin, salt), salt: salt, failCount: 0, lockUntil: '', tokenVer: String(Number((m && m.tokenVer) || 0) + 1) };
}

function hashPin_(pin, salt) {
  const pepper = getPepper_();
  let h = pin + ':' + salt;
  for (let i = 0; i < 200; i++) h = Utilities.base64Encode(Utilities.computeHmacSha256Signature(h, pepper));
  return h;
}

function getPepper_() {
  const props = PropertiesService.getScriptProperties();
  let p = props.getProperty('PIN_PEPPER');
  if (!p) { p = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('PIN_PEPPER', p); }
  return p;
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
  if (!tables.staff.rows.some(p => p.id !== ADMIN_ID)) list.push('員工名單（姓名、所屬門市與 PIN）');
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
      if (existing && existing.id === ADMIN_ID) { row.active = YES; row.store = ''; }
      if (!existing && !PIN_RE.test(String(r.pin || ''))) return invalid_('新增人員要設定 PIN（6–12 位數字）');
    }
    if (existing) { t.update(existing, row); return { ok: true, row: publicRow_(r.table, existing) }; }
    row.id = nextId_(r.table, t.rows);
    if (r.table === 'staff') Object.assign(row, pinPatch_(String(r.pin), null));
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
    if (others.some(x => x.name === row.name)) return '姓名重複，登入畫面會分不出來';
    if (!isAdminRow && !rows_('stores').some(s => s.name === row.store)) return '請選擇所屬門市';
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
    messages: [{ role: 'user', content: opt.user }],
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
  return { ok: true, keywords: ranked, pool: pool, month: month, spent: Math.round(monthSpend_()), budget: Number(setting_('monthlyBudgetTwd', raw)) || 0,
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

/** 前端送出後馬上呼叫這個（會跑 1～3 分鐘），同時用 getContent 輪詢結果 */
function runJob_(r) {
  const id = String(r.id || '');
  const claim = withLock_(() => {
    const t = table_('content');
    const row = t.rows.find(x => x.id === id);
    if (!row) return { ok: false, error: 'NOT_FOUND' };
    if (row.status !== ST.RUNNING || row.startedAt) return { ok: true, already: true };
    t.update(row, { startedAt: now_() });
    return { ok: true, row: Object.assign({}, row) };
  });
  if (!claim.ok || claim.already) return claim;
  const row = claim.row;
  let patch;
  try {
    const raw = readSettings_();
    const over = budgetCheck_(raw);
    if (over) throw aiError_('BUDGET', over.message);
    if (row.type === '官網文章') patch = generateArticle_(JSON.parse(row.input || '{}'), raw);
    else throw aiError_('BAD_TYPE', '不支援的內容類型：' + row.type);
    patch.status = ST.REVIEW;
    patch.error = '';
  } catch (err) {
    console.error(err);
    patch = { status: ST.FAILED, error: String(err && err.message || err).slice(0, 500) };
  }
  withLock_(() => {
    const t = table_('content');
    const cur = t.rows.find(x => x.id === id);
    if (cur) t.update(cur, patch);
    if (patch.status === ST.REVIEW && row.type === '官網文章') {
      const kt = table_('keywords');
      const inp = JSON.parse(row.input);
      const kw = kt.rows.find(k => k.id === inp.keywordId);
      if (kw) kt.update(kw, { lastUsed: today_() });
      const pt = table_('articlePool', true);
      pt.rows.filter(m => (inp.materialIds || []).indexOf(m.id) >= 0).forEach(m => pt.update(m, { used: YES }));
      (JSON.parse(patch.extra).leftovers || []).forEach(text => {
        const body = String(text || '').trim().slice(0, 4000);
        if (body) pt.append({ id: nextId_('articlePool', pt.rows), body: body, source: '「' + inp.main + '」產出時留下', date: today_(), used: NO });
      });
    }
  });
  return getContent_({ id: id });
}

function getContent_(r) {
  const t = table_('content');
  const row = t.rows.find(x => x.id === String(r.id || ''));
  if (!row) return { ok: false, error: 'NOT_FOUND' };
  const startedOrCreated = Date.parse(row.startedAt || row.createdAt);
  if (row.status === ST.RUNNING && Date.now() - startedOrCreated > JOB_TIMEOUT_MS) {
    withLock_(() => t.update(row, { status: ST.FAILED, error: '執行逾時（超過 6 分鐘），請再產出一次' }));
  }
  return { ok: true, item: presentContent_(row) };
}

function listContent_(r) {
  const type = String(r.type || '');
  const items = table_('content').rows.filter(x => !type || x.type === type)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 30)
    .map(x => ({ id: x.id, type: x.type, title: x.title, keyword: x.keyword, status: x.status, createdAt: x.createdAt, suggestDate: x.suggestDate }));
  return { ok: true, items: items };
}

function presentContent_(row) {
  const parse = s => { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } };
  return { id: row.id, type: row.type, store: row.store, keyword: row.keyword, title: row.title, draft: row.draft, final: row.final,
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
function complianceCheck_(text, type, raw) {
  const result = { banned: scanBanned_(text), ai: [], aiError: '', disclaimer: DISCLAIMER };
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
  if (!staff.rows.some(m => m.id === ADMIN_ID)) {
    const pin = String(Math.floor(10000000 + Math.random() * 90000000));
    staff.append(Object.assign({ id: ADMIN_ID, name: 'Tori', store: '', active: YES }, pinPatch_(pin, null)));
    Logger.log('管理者初始 PIN：' + pin + '（登入後請到「設定 → 人員」改成自己的 PIN）');
  }
  if (!privateSettings_().photoFolderId) {
    const folder = DriveApp.createFolder('頭沐 行銷助手 對比照');
    writeSetting_('photoFolderId', folder.getId());
    Logger.log('已建立對比照資料夾（不公開分享）：' + folder.getUrl());
  }
  Logger.log(seeded.length ? '已匯入初始資料：' + seeded.join('、') : '資料表都已有資料，沒有重複匯入。');
  Logger.log('完成。接著部署成網頁應用程式（見 README）。');
}

/** 忘記管理者 PIN 時，在編輯器執行這個（只有能開這份 Sheet 的人做得到） */
function resetAdminPinFromEditor() {
  const pin = String(Math.floor(10000000 + Math.random() * 90000000));
  const r = resetPin_({ id: ADMIN_ID, pin: pin });
  Logger.log(r.ok ? '管理者新 PIN：' + pin : '失敗：' + JSON.stringify(r));
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
