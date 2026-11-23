// 在 Node 裡模擬 Apps Script，跑行銷助手後台測試：node marketing/apps-script/test/marketing.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ADMIN = '__admin__', ADMIN_PIN = '20261115';

function makeEnv() {
  const sheets = {};
  const mkSheet = () => {
    const data = [];
    return { data, getLastRow: () => data.length, appendRow: r => data.push(r.map(String)), setFrozenRows() {},
      getRange: (a, c) => typeof a === 'string' ? { setNumberFormat() {} }
        : { setValue: v => { while (data[a - 1].length < c) data[a - 1].push(''); data[a - 1][c - 1] = String(v); } },
      getDataRange: () => ({ getValues: () => { const w = Math.max(...data.map(r => r.length)); return data.map(r => r.concat(Array(w - r.length).fill(''))); } }),
      deleteRow: r => data.splice(r - 1, 1) };
  };
  const cache = new Map(), folders = [], props = new Map(), logs = [];
  const ctx = {
    console,
    SpreadsheetApp: { getActive: () => ({ getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = mkSheet()) }) },
    CacheService: { getScriptCache: () => ({ get: k => cache.get(k) ?? null, put: (k, v) => cache.set(k, v), remove: k => cache.delete(k) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props.get(k) ?? null, setProperty: (k, v) => props.set(k, v) }) },
    DriveApp: { createFolder: n => { folders.push(n); return { getId: () => 'folder1', getUrl: () => 'https://drive/folder1' }; } },
    Utilities: { getUuid: () => crypto.randomUUID(), formatDate: d => d.toISOString().slice(0, 10),
      computeHmacSha256Signature: (v, k) => [...crypto.createHmac('sha256', k).update(v).digest()],
      base64Encode: b => Buffer.from(b).toString('base64') },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Logger: { log: m => logs.push(String(m)) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ setMimeType: () => ({ body: s }) }) },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8') + '\nthis.__={handle_,setup,scanBanned_,resetAdminPinFromEditor};', ctx);
  ctx.__.setup();
  const initialPin = (logs.join('\n').match(/管理者初始 PIN：(\d+)/) || [])[1];
  const call = req => JSON.parse(JSON.stringify(ctx.__.handle_(req)));
  const login = (id, pin) => call({ action: 'login', memberId: id, pin: pin });
  // 測試方便：先把管理者 PIN 改成固定值
  const first = login(ADMIN, initialPin);
  call({ action: 'resetPin', token: first.token, id: ADMIN, pin: ADMIN_PIN });
  const admin = () => login(ADMIN, ADMIN_PIN);
  return { ctx, sheets, call, login, admin, folders, logs, initialPin, F: ctx.__ };
}

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};

console.log('setup 與初始資料');
{
  const env = makeEnv();
  const { sheets, folders, F } = env;
  const names = ['設定', '門市', '人員', '關鍵字庫', '禁用詞', '定稿範例', '脆素材庫', '獎品清單', '遊戲主題表', '挑戰主題', '內容', '脆問答', '對比照', '每月活動', '用量紀錄'];
  t('建立所有工作表', names.every(n => sheets[n]), Object.keys(sheets));
  t('第一列是中文欄名', sheets['關鍵字庫'].data[0].join(',') === '編號,主關鍵字,長尾詞,階段,優先序,適合月份,上次使用日,啟用', sheets['關鍵字庫'].data[0]);
  t('匯入 30 組關鍵字', sheets['關鍵字庫'].data.length === 31);
  t('K27 適合月份 12–1 月、優先序 A', sheets['關鍵字庫'].data[27].slice(0, 6).join('|') === 'K27|過年前染髮|過年染髮要提早預約嗎|檔期|A|12–1 月', sheets['關鍵字庫'].data[27]);
  t('三間門市、預約連結留白待補', sheets['門市'].data.length === 4 && sheets['門市'].data.slice(1).every(r => r[4] === ''));
  t('12 個月遊戲主題、8 個挑戰主題、3 個獎品', sheets['遊戲主題表'].data.length === 13 && sheets['挑戰主題'].data.length === 9 && sheets['獎品清單'].data.length === 4);
  t('建立管理者，初始 PIN 只出現在執行記錄', sheets['人員'].data[1][0] === '__admin__' && /^\d{8}$/.test(env.initialPin)
    && !JSON.stringify(sheets).includes(env.initialPin), env.initialPin);
  t('建立對比照資料夾', folders.length === 1 && sheets['設定'].data.find(r => r[0] === 'photoFolderId')[2] === 'folder1');
  const s = sheets['設定'].data.find(r => r[0] === 'brandName');
  t('品牌名稱 頭沐 | CHIEFROM', s[2] === '頭沐 | CHIEFROM');
  sheets['關鍵字庫'].data[1][1] = '改過的關鍵字';
  sheets['設定'].data.find(r => r[0] === 'slogan')[2] = '改過的標語';
  F.setup();
  t('重跑 setup 不覆蓋、不重複匯入', sheets['關鍵字庫'].data.length === 31 && sheets['人員'].data.length === 2 && sheets['關鍵字庫'].data[1][1] === '改過的關鍵字'
    && sheets['設定'].data.find(r => r[0] === 'slogan')[2] === '改過的標語' && folders.length === 1);
}

console.log('登入與權限');
{
  const { call, login, admin, sheets } = makeEnv();
  t('登入畫面名單只有姓名與門市', JSON.stringify(call({ action: 'publicMembers' }).data) === JSON.stringify([{ id: ADMIN, name: 'Tori', store: '' }]));
  t('不帶 token 一律 UNAUTHORIZED', call({ action: 'getConfig' }).error === 'UNAUTHORIZED');
  t('PIN 錯誤登入失敗', login(ADMIN, '000000').error === 'LOGIN_FAILED');
  t('不存在的帳號登入失敗', login('P9', ADMIN_PIN).error === 'LOGIN_FAILED');
  const a = admin();
  t('管理者登入', a.ok && a.user.role === 'admin', a);
  t('新增人員沒設 PIN 被擋', call({ action: 'saveRow', token: a.token, table: 'staff', row: { name: '小美', store: '本館', active: '是' } }).error === 'INVALID');
  t('PIN 少於 6 位被擋', call({ action: 'saveRow', token: a.token, table: 'staff', pin: '123', row: { name: '小美', store: '本館', active: '是' } }).error === 'INVALID');
  const add = call({ action: 'saveRow', token: a.token, table: 'staff', pin: '135790', row: { name: '小美', store: '本館', active: '是' } });
  t('管理者新增員工', add.ok && add.row.id === 'P1' && add.row.pinHash === undefined, add);
  t('重複姓名被擋', call({ action: 'saveRow', token: a.token, table: 'staff', pin: '135790', row: { name: '小美', store: '本館', active: '是' } }).error === 'INVALID');
  const s = login('P1', '135790');
  t('員工登入，帶所屬門市', s.ok && s.user.role === 'staff' && s.user.store === '本館', s);
  t('員工看不到設定', call({ action: 'getConfig', token: s.token }).error === 'FORBIDDEN');
  t('員工不能改設定', call({ action: 'saveSettings', token: s.token, values: { slogan: 'x' } }).error === 'FORBIDDEN');
  t('員工不能改資料表', call({ action: 'saveRow', token: s.token, table: 'staff', pin: '111111', row: { name: 'x', store: '本館', active: '是' } }).error === 'FORBIDDEN');
  t('員工不能重設 PIN', call({ action: 'resetPin', token: s.token, id: ADMIN, pin: '111111' }).error === 'FORBIDDEN');
  t('員工可以呼叫 me', call({ action: 'me', token: s.token }).user.store === '本館');
  call({ action: 'resetPin', token: a.token, id: 'P1', pin: '246802' });
  t('重設 PIN 後舊 token 失效、舊 PIN 不能用', call({ action: 'me', token: s.token }).error === 'UNAUTHORIZED' && login('P1', '135790').error === 'LOGIN_FAILED');
  const s2 = login('P1', '246802');
  t('新 PIN 可以登入', s2.ok);
  call({ action: 'saveRow', token: a.token, table: 'staff', row: { id: 'P1', active: '否' } });
  t('停用員工後 token 立刻失效', call({ action: 'me', token: s2.token }).error === 'UNAUTHORIZED');
  t('停用的員工不能登入、不在登入名單', login('P1', '246802').error === 'LOGIN_FAILED' && call({ action: 'publicMembers' }).data.length === 1);
  t('編輯員工不會動到 PIN', sheets['人員'].data[2][4] !== '');
  t('不能停用管理者', call({ action: 'saveRow', token: a.token, table: 'staff', row: { id: ADMIN, active: '否' } }).row.active === '是');
  t('不能刪除管理者', call({ action: 'deleteRow', token: a.token, table: 'staff', id: ADMIN }).error === 'INVALID');
  t('管理者可以改自己的名字', call({ action: 'saveRow', token: a.token, table: 'staff', row: { id: ADMIN, name: 'Tori 郭' } }).row.name === 'Tori 郭');
  const cfg = JSON.stringify(call({ action: 'getConfig', token: a.token }));
  t('設定頁不回傳 PIN 雜湊與 salt', !/pinHash|salt|tokenVer|failCount/.test(cfg) && !cfg.includes(sheets['人員'].data[1][4]));
  for (let i = 0; i < 4; i++) login(ADMIN, '999999');
  const locked = login(ADMIN, '999999');
  t('連錯 5 次鎖 15 分鐘', locked.error === 'LOCKED' && login(ADMIN, ADMIN_PIN).error === 'LOCKED', locked);
  call({ action: 'logout', token: a.token });
  t('登出後 token 失效', call({ action: 'me', token: a.token }).error === 'UNAUTHORIZED');
}
{
  const { login, F, logs } = makeEnv();
  F.resetAdminPinFromEditor();
  const pin = logs.join('\n').match(/管理者新 PIN：(\d+)/)[1];
  t('忘記管理者 PIN 可以在編輯器重設', login(ADMIN, pin).ok && login(ADMIN, ADMIN_PIN).error === 'LOGIN_FAILED');
}

console.log('設定頁');
{
  const { call, admin, sheets } = makeEnv();
  const tok = admin().token;
  const c = call({ action: 'getConfig', token: tok });
  t('回傳設定分組與所有可編輯資料表', c.ok && c.groups.length === 6 && ['stores', 'staff', 'keywords', 'banned', 'examples', 'threadsPool', 'prizes', 'gameThemes', 'challengeThemes'].every(k => c.tables[k]), Object.keys(c.tables || {}));
  t('不回傳後面步驟的資料表', !c.tables.content && !c.tables.usage);
  t('關鍵字欄位帶選項', c.tables.keywords.cols.find(x => x.key === 'priority').options.join('') === 'ABC');
  t('待補清單列出預約連結、公版、範例、員工、7 月主題、中等獎品',
    ['本館」的預約連結', '回留訊息公版', '定稿範例', '員工名單', '7 月的遊戲主題', '中等獎品'].every(x => c.todo.some(y => y.includes(x))), c.todo);
  t('網頁改設定寫回試算表', call({ action: 'saveSettings', token: tok, values: { slogan: '新標語', monthlyBudgetTwd: '1500' } }).ok
    && sheets['設定'].data.find(r => r[0] === 'slogan')[2] === '新標語');
  t('數字設定擋非數字', call({ action: 'saveSettings', token: tok, values: { monthlyBudgetTwd: '一千' } }).error === 'INVALID');
  t('網頁不能改私密設定', call({ action: 'saveSettings', token: tok, values: { photoFolderId: 'x' } }).error === 'INVALID'
    && sheets['設定'].data.find(r => r[0] === 'photoFolderId')[2] === 'folder1');
  const u = call({ action: 'saveRow', token: tok, table: 'stores', row: { id: 'S1', bookingUrl: 'https://booking.example/khh' } });
  t('改門市預約連結', u.ok && u.row.bookingUrl === 'https://booking.example/khh' && u.row.name === '本館', u);
  t('預約連結要 https', call({ action: 'saveRow', token: tok, table: 'stores', row: { id: 'S1', bookingUrl: 'booking.example' } }).error === 'INVALID');
  const k = call({ action: 'saveRow', token: tok, table: 'keywords', row: { main: '白髮染深棕', priority: 'A', stage: '決策', months: '全年', active: '是' } });
  t('新增關鍵字，自動編號 K31', k.ok && k.row.id === 'K31', k);
  t('選項外的值被擋', call({ action: 'saveRow', token: tok, table: 'keywords', row: { main: 'x', priority: 'Z' } }).error === 'INVALID');
  t('停用關鍵字', call({ action: 'saveRow', token: tok, table: 'keywords', row: { id: 'K31', active: '否' } }).row.active === '否');
  t('重複禁用詞被擋', call({ action: 'saveRow', token: tok, table: 'banned', row: { word: '治療', category: '醫療效能' } }).error === 'INVALID');
  t('同一月份不能有兩個遊戲主題', call({ action: 'saveRow', token: tok, table: 'gameThemes', row: { month: '7', game: 'x' } }).error === 'INVALID');
  t('改 7 月主題', call({ action: 'saveRow', token: tok, table: 'gameThemes', row: { id: 'G07', game: '夏日猜髮色' } }).ok
    && !call({ action: 'getConfig', token: tok }).todo.some(x => x.includes('7 月')));
  t('刪除定稿範例以外的列', call({ action: 'deleteRow', token: tok, table: 'keywords', id: 'K31' }).ok && sheets['關鍵字庫'].data.length === 31);
  call({ action: 'saveRow', token: tok, table: 'staff', pin: '135790', row: { name: '小美', store: '本館', active: '是' } });
  t('還有員工的門市不能刪', call({ action: 'deleteRow', token: tok, table: 'stores', id: 'S1' }).error === 'INVALID');
  t('員工門市要存在', call({ action: 'saveRow', token: tok, table: 'staff', pin: '135790', row: { name: 'x', store: '不存在', active: '是' } }).error === 'INVALID');
  t('不能操作非設定用的表', call({ action: 'saveRow', token: tok, table: 'content', row: {} }).error === 'BAD_TABLE');
  t('改了找不到的列回 NOT_FOUND', call({ action: 'saveRow', token: tok, table: 'keywords', row: { id: 'K99', main: 'x' } }).error === 'NOT_FOUND');
  // Tori 在試算表上調換欄位順序
  const kw = sheets['關鍵字庫'].data;
  kw.forEach(r => { const x = r[1]; r[1] = r[2]; r[2] = x; });
  const c2 = call({ action: 'getConfig', token: tok });
  t('試算表調換欄位順序後仍讀對', c2.tables.keywords.rows[1].main === '遮白髮怎麼染', c2.tables.keywords.rows[1]);
}

console.log('禁用詞自檢');
{
  const { call, admin, F } = makeEnv();
  const tok = admin().token;
  const r = call({ action: 'checkText', token: tok, text: '我們的染髮完全不傷髮，還能活化毛囊！染護師會先看頭皮。設計師推薦 100%天然。' });
  const words = r.hits.map(h => h.word);
  t('抓到完全不傷髮、活化毛囊、設計師、100%天然', ['完全不傷髮', '活化毛囊', '設計師'].every(w => words.includes(w)) && words.some(w => w.startsWith('100%')), words);
  t('被涵蓋的短詞不重複列（不傷髮）', !words.includes('不傷髮'), words);
  t('100%天然 與 100% 天然 只列一次', words.filter(w => w.startsWith('100%')).length === 1, words);
  const h0 = r.hits.find(h => h.word === '完全不傷髮');
  t('附上所在句子與類別', h0.sentence === '我們的染髮完全不傷髮，還能活化毛囊！' && h0.category === '絕對用語', h0);
  t('固定附免責說明', r.disclaimer === '這是系統檢查，不等於法律意見，發布前請再看一次。');
  t('合規句子沒有命中', F.scanBanned_('頭沐使用的染劑不含阿摩尼亞。從滿頭白髮到自然的深棕。').length === 0);
  t('忽略空白差異', F.scanBanned_('這款可以 根 治 頭皮問題').some(h => h.word === '根治'));
}

console.log(`\n${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
