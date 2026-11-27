// 在 Node 裡模擬 Apps Script，跑行銷助手後台測試：node marketing/apps-script/test/marketing.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ADMIN = '__admin__', ADMIN_EMAIL = 'tori@example.com', STAFF_EMAIL = 'mei@example.com';
const CLIENT_ID = '666667317547-qt7hdpi8du19tq2fb2genfvhkcs7hu5j.apps.googleusercontent.com';

const TODAY = new Date('2026-11-23T04:00:00Z'); // 台北時間 11/23 週一中午

/** 假的 Claude API：依 schema 回傳文章或檢查結果；api.next 可以塞一次性的特殊回應 */
function fakeApi() {
  const api = { calls: [], next: [] };
  api.handle = (url, opt) => {
    const body = JSON.parse(opt.payload);
    api.calls.push({ url, headers: opt.headers, body });
    if (api.next.length) return api.next.shift()(body);
    const props = body.output_config.format && body.output_config.format.schema.properties;
    const out = props && props.posts ? { posts: [
        { store: '本館', angle: '先看頭皮', body: '高雄左營的本館，染護師會先看頭皮。高雄兩間店共用預約連結，預約時請選對店喔。' },
        { store: '散步二館', angle: '不含阿摩尼亞', body: '高雄前鎮散步二館使用不含阿摩尼亞的染劑。電話 07-555-1234。' },
        { store: '日和三館', angle: '補染間隔', body: '台南安南日和三館，補染約 40–60 天。按預約就能安排。' }] }
      : props && props.sets ? { sets: [...JSON.stringify(body.messages[0].content).matchAll(/photoId：(F\d+)/g)].map((m, i) => ({ photoId: m[1],
          theme: '白髮到深棕 ' + (i + 1), text: i === 1 ? '從滿頭白髮變成自然又好看的深棕色' : '從白髮到深棕', sub: i === 1 ? '這是一句超過二十個字的副標題用來測試長度檢查功能' : '染護師先看頭皮再選色', sticker: '滑桿：喜歡這個顏色嗎' })) }
      : props && props.changes ? { title: '白髮染髮推薦：潤飾後', body: '潤飾後的內文【待素材：客人第一次染白髮的反應】', changes: ['第一段刪掉重複的一句'] } : props && props.title ? {
      focus: '第一次染白髮先看頭皮', leftovers: ['客人說染完不臭', '有位客人想染深棕'],
      title: '白髮染髮推薦：第一次染白髮怎麼選', body: '**白髮染髮推薦先看頭皮狀況。**\n\n## 為什麼\n染護師會先看頭皮。這款染劑完全不傷髮。\n\n【待素材：客人第一次染白髮的反應】\n\n## 常見問題\n...',
      metaDescription: '白髮染髮推薦', slug: 'grey-hair-coloring', imageSuggestions: ['店內染護師看頭皮'], faq: [{ q: '多久補染？', a: '約 40–60 天。' }],
      internalLinks: [], needsMaterial: ['客人第一次染白髮的反應'],
    } : props && props.replacements ? { replacements: [{ index: 0, text: '有位客人染完說「真的不臭耶」。' }] } : props && props.issues ? { issues: [{ sentence: '這款染劑完全不傷髮。', reason: '絕對用語', suggestion: '改寫成染前會先評估髮況' }] } : null;
    const content = [{ type: 'thinking', thinking: '' }, { type: 'text', text: out ? JSON.stringify(out) : '連線成功' }];
    return resp(200, { content, stop_reason: 'end_turn', usage: { input_tokens: 10000, output_tokens: 5000 } });
  };
  return api;
}
/** 假的雲端硬碟：頭沐 PO文素材／門市／月份／檔案（結構同每日回報系統） */
function fakeDrive() {
  const byId = {};
  let n = 0;
  const it = arr => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
  const folder = (name, parent) => { const f = { id: 'D' + (++n), name, parent, kids: [], files: [] };
    f.api = { getId: () => f.id, getName: () => f.name, getFolders: () => it(f.kids.map(k => k.api)), getFiles: () => it(f.files.map(x => x.api)),
      getParents: () => it(f.parent ? [f.parent.api] : []), createFile: blob => file(blob.name, f, blob.bytes).api };
    byId[f.id] = f; if (parent) parent.kids.push(f); return f; };
  const file = (name, parent, bytes) => { const f = { id: 'F' + (++n), name, parent, bytes: bytes || [...Buffer.from('jpeg:' + name)] };
    f.api = { getId: () => f.id, getName: () => f.name, getParents: () => it([parent.api]),
      getBlob: () => ({ getBytes: () => f.bytes, getContentType: () => 'image/jpeg' }), getThumbnail: () => ({ getBytes: () => [...Buffer.from('thumb')], getContentType: () => 'image/png' }) };
    byId[f.id] = f; parent.files.push(f); return f; };
  const root = folder('頭沐 PO文素材'), other = folder('別的資料夾');
  const add = (store, month, date, staff, time) => { let sf = root.kids.find(k => k.name === store) || folder(store, root);
    let mf = sf.kids.find(k => k.name === month) || folder(month, sf);
    ['服務前', '服務後', '對比圖'].forEach(k => file(date + '_' + store + '_' + staff + '_' + time + '_' + k + '.jpg', mf));
    return mf.files[mf.files.length - 1].id; };
  return { byId, root, other, add, folder, file };
}

const resp = (code, j) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(j) });

function makeEnv(sessionEmail = ADMIN_EMAIL) {
  const sheets = {};
  const mkSheet = () => {
    const data = [];
    return { data, getLastRow: () => data.length, appendRow: r => data.push(r.map(String)), setFrozenRows() {},
      getRange: (a, c) => typeof a === 'string' ? { setNumberFormat() {} }
        : { setValue: v => { while (data[a - 1].length < c) data[a - 1].push(''); data[a - 1][c - 1] = String(v); } },
      getDataRange: () => ({ getValues: () => { const w = Math.max(...data.map(r => r.length)); return data.map(r => r.concat(Array(w - r.length).fill(''))); } }),
      deleteRow: r => data.splice(r - 1, 1) };
  };
  const cache = new Map(), folders = [], props = new Map(), logs = [], api = fakeApi(), drive = fakeDrive();
  const ctx = {
    console: { log() {}, error() {} },
    Date: class extends Date { constructor(...a) { super(...(a.length ? a : [TODAY])); } static now() { return TODAY.getTime(); } },
    UrlFetchApp: { fetch: (url, opt) => {
      if (url.indexOf('oauth2.googleapis.com/tokeninfo') < 0) return api.handle(url, opt);
      const m = decodeURIComponent(url.split('id_token=')[1] || '').match(/^google:(.+?):(.+)$/); // google:<email>:<aud>
      if (!m) return { getResponseCode: () => 400, getContentText: () => '{}' };
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ iss: 'https://accounts.google.com', aud: m[2], email: m[1], email_verified: 'true',
        exp: String(Math.floor(TODAY.getTime() / 1000) + 3600), name: m[1].split('@')[0] }) };
    } },
    Session: { getEffectiveUser: () => ({ getEmail: () => sessionEmail }) },
    SpreadsheetApp: { getActive: () => ({ getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = mkSheet()) }) },
    CacheService: { getScriptCache: () => ({ get: k => cache.get(k) ?? null, put: (k, v) => cache.set(k, v), remove: k => cache.delete(k) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props.get(k) ?? null, setProperty: (k, v) => props.set(k, v) }) },
    DriveApp: {
      createFolder: n => { folders.push(n); return { getId: () => 'folder1', getUrl: () => 'https://drive/folder1' }; },
      getFoldersByName: n => { const arr = n === drive.root.name ? [drive.root.api] : []; let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; },
      getFolderById: id => { if (!drive.byId[id]) throw new Error('no folder ' + id); return drive.byId[id].api; },
      getFileById: id => { if (!drive.byId[id] || !drive.byId[id].bytes) throw new Error('no file ' + id); return drive.byId[id].api; },
    },
    Utilities: { getUuid: () => crypto.randomUUID(),
      formatDate: (d, tz, f) => { const iso = new Date(d.getTime() + 8 * 3600e3).toISOString(); return f === 'yyyy-MM' ? iso.slice(0, 7) : iso.slice(0, 10); },
      computeHmacSha256Signature: (v, k) => [...crypto.createHmac('sha256', k).update(v).digest()],
      base64Encode: b => Buffer.from(b).toString('base64') },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Logger: { log: m => logs.push(String(m)) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ setMimeType: () => ({ body: s }) }) },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8') + '\nthis.__={handle_,setup,scanBanned_,monthsOf_,rankKeywords_,testAI};', ctx);
  ctx.__.setup();
  const call = req => JSON.parse(JSON.stringify(ctx.__.handle_(req)));
  const login = (email, aud = CLIENT_ID) => call({ action: 'login', idToken: `google:${email}:${aud}` });
  const admin = () => login(ADMIN_EMAIL);
  /** 新增一位員工並用她的 Gmail 登入 */
  const staffLogin = (email = STAFF_EMAIL, name = '小美', store = '本館') => {
    call({ action: 'saveRow', token: admin().token, table: 'staff', row: { name, email, store, active: '是' } });
    return login(email);
  };
  return { ctx, sheets, call, login, admin, staffLogin, folders, logs, props, api, drive, F: ctx.__ };
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
  t('建立文章素材庫', !!sheets['文章素材庫']);
  t('建立所有工作表', names.every(n => sheets[n]), Object.keys(sheets));
  t('第一列是中文欄名', sheets['關鍵字庫'].data[0].join(',') === '編號,主關鍵字,長尾詞,階段,優先序,適合月份,上次使用日,啟用', sheets['關鍵字庫'].data[0]);
  t('匯入 30 組關鍵字', sheets['關鍵字庫'].data.length === 31);
  t('K27 適合月份 12–1 月、優先序 A', sheets['關鍵字庫'].data[27].slice(0, 6).join('|') === 'K27|過年前染髮|過年染髮要提早預約嗎|檔期|A|12–1 月', sheets['關鍵字庫'].data[27]);
  t('三間門市、預約連結留白待補', sheets['門市'].data.length === 4 && sheets['門市'].data.slice(1).every(r => r[4] === ''));
  t('12 個月遊戲主題、8 個挑戰主題、3 個獎品', sheets['遊戲主題表'].data.length === 13 && sheets['挑戰主題'].data.length === 9 && sheets['獎品清單'].data.length === 4);
  t('建立管理者那一列；setup 自動填入管理者 Gmail 與 Google 登入 ID', sheets['人員'].data[1][0] === '__admin__'
    && sheets['設定'].data.find(r => r[0] === 'adminEmails')[2] === ADMIN_EMAIL && sheets['設定'].data.find(r => r[0] === 'googleClientId')[2] === CLIENT_ID);
  t('setup 不再在雲端硬碟建立資料夾（只需要讀取權限）', env.folders.length === 0);
  t('setup 自動連到「頭沐 PO文素材」資料夾', sheets['設定'].data.find(r => r[0] === 'poFolderId')[2] === env.drive.root.id);
  const s = sheets['設定'].data.find(r => r[0] === 'brandName');
  t('品牌名稱 頭沐 | CHIEFROM', s[2] === '頭沐 | CHIEFROM');
  sheets['關鍵字庫'].data[1][1] = '改過的關鍵字';
  sheets['設定'].data.find(r => r[0] === 'slogan')[2] = '改過的標語';
  F.setup();
  t('重跑 setup 不覆蓋、不重複匯入', sheets['關鍵字庫'].data.length === 31 && sheets['人員'].data.length === 2 && sheets['關鍵字庫'].data[1][1] === '改過的關鍵字'
    && sheets['設定'].data.find(r => r[0] === 'slogan')[2] === '改過的標語');
}

console.log('登入與權限');
{
  const env = makeEnv();
  const { call, login, admin, staffLogin, sheets } = env;
  t('不帶 token 一律 UNAUTHORIZED', call({ action: 'getConfig' }).error === 'UNAUTHORIZED');
  t('假的 Google token 登入失敗', call({ action: 'login', idToken: 'nope' }).error === 'LOGIN_FAILED');
  t('別的網站的登入 ID（aud 不符）登入失敗', login(ADMIN_EMAIL, 'other.apps.googleusercontent.com').error === 'LOGIN_FAILED');
  t('名單外的 Gmail 不能登入', login('someone@example.com').error === 'NOT_ALLOWED');
  t('PIN 登入已移除', call({ action: 'publicMembers' }).error === 'UNAUTHORIZED' && call({ action: 'login', memberId: ADMIN, pin: '123456' }).error === 'LOGIN_FAILED');
  const a = admin();
  t('管理者用 Gmail 登入（大小寫不影響）', a.ok && a.user.role === 'admin' && a.user.name === 'Tori' && login('Tori@Example.com').ok, a);
  t('新增員工要填 Gmail', call({ action: 'saveRow', token: a.token, table: 'staff', row: { name: '小美', store: '本館', active: '是' } }).error === 'INVALID');
  const add = call({ action: 'saveRow', token: a.token, table: 'staff', row: { name: '小美', email: 'Mei@Example.com', store: '本館', active: '是' } });
  t('管理者新增員工（Gmail 轉小寫）', add.ok && add.row.id === 'P1' && add.row.email === STAFF_EMAIL, add);
  t('重複 Gmail 被擋', call({ action: 'saveRow', token: a.token, table: 'staff', row: { name: '小美2', email: STAFF_EMAIL, store: '本館', active: '是' } }).error === 'INVALID');
  const s = login(STAFF_EMAIL);
  t('員工用 Gmail 登入，帶所屬門市', s.ok && s.user.role === 'staff' && s.user.store === '本館', s);
  t('員工看不到設定', call({ action: 'getConfig', token: s.token }).error === 'FORBIDDEN');
  t('員工不能改設定', call({ action: 'saveSettings', token: s.token, values: { slogan: 'x' } }).error === 'FORBIDDEN');
  t('員工不能改資料表', call({ action: 'saveRow', token: s.token, table: 'staff', row: { name: 'x', email: 'x@x.com', store: '本館', active: '是' } }).error === 'FORBIDDEN');
  t('員工可以呼叫 me', call({ action: 'me', token: s.token }).user.store === '本館');
  t('me 回傳後台版本', call({ action: 'me', token: s.token }).backendVersion >= 9);
  t('員工不能看 PO 文素材', call({ action: 'listMaterials', token: s.token }).error === 'FORBIDDEN' && call({ action: 'getMaterial', token: s.token, id: 'x' }).error === 'FORBIDDEN');
  call({ action: 'saveRow', token: a.token, table: 'staff', row: { id: 'P1', store: '散步二館' } });
  t('換門市立刻生效', call({ action: 'me', token: s.token }).user.store === '散步二館');
  call({ action: 'saveRow', token: a.token, table: 'staff', row: { id: 'P1', active: '否' } });
  t('停用員工後 token 立刻失效、不能再登入', call({ action: 'me', token: s.token }).error === 'UNAUTHORIZED' && login(STAFF_EMAIL).error === 'NOT_ALLOWED');
  t('不能停用管理者', call({ action: 'saveRow', token: a.token, table: 'staff', row: { id: ADMIN, active: '否' } }).row.active === '是');
  t('不能刪除管理者', call({ action: 'deleteRow', token: a.token, table: 'staff', id: ADMIN }).error === 'INVALID');
  t('管理者可以改自己的名字', call({ action: 'saveRow', token: a.token, table: 'staff', row: { id: ADMIN, name: 'Tori 郭' } }).row.name === 'Tori 郭' && call({ action: 'me', token: a.token }).user.name === 'Tori 郭');
  t('負責人名單', call({ action: 'people', token: a.token }).data.map(x => x.name).join() === 'Tori 郭');
  const cfg = JSON.stringify(call({ action: 'getConfig', token: a.token }));
  t('設定頁不回傳管理者 Gmail 與登入 ID', !cfg.includes(ADMIN_EMAIL) && !cfg.includes(CLIENT_ID) && !/adminEmails|googleClientId|poFolderId/.test(cfg));
  sheets['設定'].data.find(r => r[0] === 'adminEmails')[2] = 'boss@example.com';
  t('從管理者名單拿掉後立刻失效', call({ action: 'me', token: a.token }).error === 'UNAUTHORIZED');
  call({ action: 'logout', token: a.token });
  t('登出後 token 失效', call({ action: 'me', token: a.token }).error === 'UNAUTHORIZED');
}
{
  const env = makeEnv('');
  t('讀不到 Gmail 時 setup 提示手動填', env.logs.some(l => l.includes('adminEmails')) && env.login(ADMIN_EMAIL).error === 'NOT_ALLOWED');
}

console.log('設定頁');
{
  const { call, admin, sheets } = makeEnv();
  const tok = admin().token;
  const c = call({ action: 'getConfig', token: tok });
  t('回傳設定分組與所有可編輯資料表', c.ok && c.groups.length === 6 && ['stores', 'staff', 'keywords', 'banned', 'examples', 'threadsPool', 'prizes', 'gameThemes', 'challengeThemes'].every(k => c.tables[k]), Object.keys(c.tables || {}));
  t('不回傳後面步驟的資料表', !c.tables.content && !c.tables.usage);
  t('關鍵字欄位帶選項', c.tables.keywords.cols.find(x => x.key === 'priority').options.join('') === 'ABC');
  t('待補清單列出預約連結、公版、範例、7 月主題、中等獎品',
    ['本館」的預約連結', '回留訊息公版', '定稿範例', '7 月的遊戲主題', '中等獎品'].every(x => c.todo.some(y => y.includes(x))), c.todo);
  t('網頁改設定寫回試算表', call({ action: 'saveSettings', token: tok, values: { slogan: '新標語', monthlyBudgetTwd: '1500' } }).ok
    && sheets['設定'].data.find(r => r[0] === 'slogan')[2] === '新標語');
  t('數字設定擋非數字', call({ action: 'saveSettings', token: tok, values: { monthlyBudgetTwd: '一千' } }).error === 'INVALID');
  t('網頁不能改私密設定（管理者 Gmail、PO 文素材資料夾）', call({ action: 'saveSettings', token: tok, values: { adminEmails: 'evil@x.com', poFolderId: 'x' } }).error === 'INVALID'
    && sheets['設定'].data.find(r => r[0] === 'adminEmails')[2] === ADMIN_EMAIL);
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
  call({ action: 'saveRow', token: tok, table: 'staff', row: { name: '小美', email: STAFF_EMAIL, store: '本館', active: '是' } });
  t('還有員工的門市不能刪', call({ action: 'deleteRow', token: tok, table: 'stores', id: 'S1' }).error === 'INVALID');
  t('員工門市要存在', call({ action: 'saveRow', token: tok, table: 'staff', row: { name: 'x', email: 'x@example.com', store: '不存在', active: '是' } }).error === 'INVALID');
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

console.log('關鍵字建議');
{
  const { call, admin, F } = makeEnv();
  t('月份解析', JSON.stringify(F.monthsOf_('12–1 月')) === '[1,12]' && JSON.stringify(F.monthsOf_('4–5 月')) === '[4,5]' && F.monthsOf_('全年') === null
    && JSON.stringify(F.monthsOf_('8 月')) === '[8]' && JSON.stringify(F.monthsOf_('10–2 月')) === '[1,2,10,11,12]', F.monthsOf_('10–2 月'));
  const tok = admin().token;
  const o = call({ action: 'articleOptions', token: tok });
  t('11 月：沒有檔期詞，第一個是 A 級最久沒用的 K01', o.ok && o.keywords[0].id === 'K01' && o.month === 11, o.keywords && o.keywords[0]);
  t('不在當月的檔期詞（母親節、父親節、過年）不建議', !o.keywords.some(k => ['K27', 'K28', 'K29'].includes(k.id)));
  t('B 級排在 A 級後面', o.keywords.findIndex(k => k.priority === 'B') > o.keywords.filter(k => k.priority === 'A').length - 1);
  const rows = [
    { id: 'K1', main: 'a', priority: 'A', months: '全年', lastUsed: '2026-11-01', active: '是' },
    { id: 'K2', main: 'b', priority: 'A', months: '全年', lastUsed: '', active: '是' },
    { id: 'K3', main: 'c', priority: 'B', months: '12–1 月', lastUsed: '', active: '是' },
    { id: 'K4', main: 'd', priority: 'A', months: '全年', lastUsed: '', active: '否' },
  ];
  const r12 = F.rankKeywords_(rows, 12).map(k => k.id).join(',');
  t('12 月：檔期詞優先，其次沒用過的，停用的不建議', r12 === 'K3,K2,K1', r12);
  t('沒有金鑰時 hasKey=false', o.hasKey === false && o.model === 'claude-opus-5-5' && o.budget === 1000);
}

console.log('官網文章產出');
{
  const env = makeEnv();
  const { call, admin, sheets, props, api } = env;
  const tok = admin().token;
  t('沒有金鑰不能產出，訊息說明去哪設定', call({ action: 'startArticle', token: tok, keywordId: 'K01' }).message.includes('ANTHROPIC_API_KEY'));
  props.set('ANTHROPIC_API_KEY', 'sk-test');
  t('沒選關鍵字被擋', call({ action: 'startArticle', token: tok }).error === 'INVALID');
  const st = call({ action: 'startArticle', token: tok, keywordId: 'K01', notes: '上週有位客人說第一次覺得染髮不臭' });
  t('開始產出，狀態產出中', st.ok && call({ action: 'getContent', token: tok, id: st.id }).item.status === '產出中', st);
  const done = call({ action: 'runJob', token: tok, id: st.id });
  const it = done.item;
  t('產出完成進待審', done.ok && it.status === '待審' && it.title.includes('白髮') && it.draft.startsWith('**'), it);
  t('建議發布日是下週一', it.suggestDate === '2026-11-30', it.suggestDate);
  t('負責人預設 Tori', it.owner === 'Tori');
  t('附加資料：Meta、代稱、配圖、待素材、JSON-LD', it.extra.slug === 'grey-hair-coloring' && it.extra.needsMaterial.length === 1
    && it.extra.jsonLd.includes('FAQPage') && it.extra.jsonLd.includes('"Person"'), it.extra);
  t('禁用詞比對抓到「完全不傷髮」', it.check.banned.some(h => h.word === '完全不傷髮'), it.check);
  t('AI 語意檢查結果與免責說明', it.check.ai.length === 1 && it.check.disclaimer.includes('不等於法律意見'));
  const c0 = api.calls[0];
  t('呼叫帶金鑰、API 版本、備援 beta，模型來自設定', c0.headers['x-api-key'] === 'sk-test' && c0.headers['anthropic-version'] === '2026-10-21'
    && c0.headers['anthropic-beta'] === 'server-side-fallback-2026-07-01' && c0.body.model === 'claude-opus-5-5' && c0.body.fallbacks === 'default');
  t('沒有送 temperature、沒有關掉思考', !('temperature' in c0.body) && !('thinking' in c0.body));
  t('指令帶入品牌、官網規則、寫作風格、開頭規則、法規、禁用詞、作者小檔案、門市', ['頭沐 | CHIEFROM', '第一段直接回答', '寧短勿長', '60 字以內', '化粧品衛生安全管理法', '活化毛囊', '作者｜Tori', '日和三館']
    .every(x => c0.body.system.includes(x)));
  t('帶入 Tori 的現場觀察與關鍵字', c0.body.messages[0].content.includes('染髮不臭') && c0.body.messages[0].content.includes('白髮染髮推薦'));
  t('沒有現場觀察時要求標待素材', c0.body.system.includes('待素材'));
  t('語意檢查用 low 思考程度', api.calls[1].body.output_config.effort === 'low' && api.calls[0].body.output_config.effort === 'medium');
  t('用量紀錄兩筆，估算費用（1 萬輸入 5 千輸出 ≈ NT$4.48）', sheets['用量紀錄'].data.length === 3 && sheets['用量紀錄'].data[1][4] === '4.48', sheets['用量紀錄'].data);
  t('關鍵字寫入上次使用日', sheets['關鍵字庫'].data[1][6] === '2026-11-23');
  t('之後建議改成下一個 A 級關鍵字', call({ action: 'articleOptions', token: tok }).keywords[0].id === 'K02');
  t('重複呼叫 runJob 不會再產一次', call({ action: 'runJob', token: tok, id: st.id }).already === true && api.calls.length === 2);
  t('內容清單', call({ action: 'listContent', token: tok, type: '官網文章' }).items[0].id === st.id);
  t('第二篇會把第一篇列為可內部連結的舊文章', (() => {
    const s2 = call({ action: 'startArticle', token: tok, keywordId: 'K02' }); call({ action: 'runJob', token: tok, id: s2.id });
    return api.calls[2].body.messages[0].content.includes('白髮染髮推薦：第一次染白髮怎麼選'); })());
  const staff = env.staffLogin();
  t('員工不能產出或讀內容', call({ action: 'startArticle', token: staff.token, keywordId: 'K01' }).error === 'FORBIDDEN'
    && call({ action: 'getContent', token: staff.token, id: st.id }).error === 'FORBIDDEN');
}

console.log('一篇一個重點與文章素材庫');
{
  const { call, admin, props, api, sheets } = makeEnv();
  props.set('ANTHROPIC_API_KEY', 'sk-test');
  const tok = admin().token;
  const s1 = call({ action: 'startArticle', token: tok, keywordId: 'K01', notes: '客人說不臭；客人想染深棕；第一次染先看頭皮' });
  const it = call({ action: 'runJob', token: tok, id: s1.id }).item;
  t('回傳這篇的重點與留下的素材', it.extra.focus === '第一次染白髮先看頭皮' && it.extra.leftovers.length === 2);
  t('指令要求一篇一個重點、其他留存', api.calls[0].body.system.includes('一篇一個重點') && api.calls[0].body.system.includes('leftovers'));
  const pool = sheets['文章素材庫'].data;
  t('沒用到的重點存進文章素材庫', pool.length === 3 && pool[1][1] === '客人說染完不臭' && pool[1][2].includes('白髮染髮推薦') && pool[1][4] === '否', pool);
  const o = call({ action: 'articleOptions', token: tok });
  t('產出頁列出未使用的素材', o.pool.length === 2 && o.pool[0].id === 'N1', o.pool);
  const s2 = call({ action: 'startArticle', token: tok, keywordId: 'K02', notes: '', materialIds: ['N1', 'N999'] });
  call({ action: 'runJob', token: tok, id: s2.id });
  t('勾選的素材帶進指令', api.calls[2].body.messages[0].content.includes('・客人說染完不臭') && !api.calls[2].body.messages[0].content.includes('有位客人想染深棕'));
  t('用過的素材標已用，新的留存再加入', pool[1][4] === '是' && pool[2][4] === '否' && pool.length === 5, pool);
  const fail = call({ action: 'startArticle', token: tok, keywordId: 'K03', materialIds: ['N2'] });
  api.next.push(() => resp(401, {}));
  call({ action: 'runJob', token: tok, id: fail.id });
  t('產出失敗時素材不算用掉', pool[2][4] === '否');
  t('素材庫可在設定頁編輯', call({ action: 'getConfig', token: tok }).tables.articlePool.rows.length === 4
    && call({ action: 'saveRow', token: tok, table: 'articlePool', row: { body: '手動加的素材', used: '否' } }).row.id === 'N5');
}

console.log('審稿區');
{
  const env = makeEnv();
  const { call, admin, props, api, sheets } = env;
  props.set('ANTHROPIC_API_KEY', 'sk-test');
  const tok = admin().token;
  const st = call({ action: 'startArticle', token: tok, keywordId: 'K01' });
  let it = call({ action: 'runJob', token: tok, id: st.id }).item;
  const id = st.id;
  t('結果帶目前內文與待素材標記', it.text === it.draft && it.placeholders.length === 1 && it.placeholders[0] === '【待素材：客人第一次染白髮的反應】', it.placeholders);
  t('清單可依狀態篩選、顯示待素材數', call({ action: 'listContent', token: tok, status: '待審' }).items[0].needs === 1
    && call({ action: 'listContent', token: tok, status: '已發布' }).items.length === 0);
  // 直接套用法規提醒
  {
    const s9 = call({ action: 'startArticle', token: tok, keywordId: 'K05' });
    let x = call({ action: 'runJob', token: tok, id: s9.id }).item;
    t('有 AI 建議與禁用詞提醒', x.check.ai[0].sentence === '這款染劑完全不傷髮。' && x.check.banned.length === 1);
    const n = api.calls.length;
    x = call({ action: 'applyFix', token: tok, id: s9.id, kind: 'ai', index: 0, text: '染前染護師會先評估髮況。' }).item;
    t('套用建議：只換掉那一句，不呼叫 AI', x.text.includes('染護師會先看頭皮。染前染護師會先評估髮況。') && !x.text.includes('完全不傷髮') && api.calls.length === n, x.text);
    t('套用後那條 AI 提醒拿掉，禁用詞重新比對', x.check.ai.length === 0 && x.check.banned.length === 0);
    t('找不到的提醒回錯誤', call({ action: 'applyFix', token: tok, id: s9.id, kind: 'ai', index: 0, text: 'x' }).error === 'INVALID');
    call({ action: 'saveContent', token: tok, id: s9.id, patch: { text: '## 草本比較不傷髮嗎？\n內文' } });
    x = call({ action: 'getContent', token: tok, id: s9.id }).item;
    t('改字後禁用詞抓到標題行', x.check.banned[0].sentence === '## 草本比較不傷髮嗎？', x.check.banned);
    x = call({ action: 'applyFix', token: tok, id: s9.id, kind: 'banned', index: 0, text: '## 草本對髮質的影響比較小嗎？' }).item;
    t('套用禁用詞修改，保留小標格式', x.text === '## 草本對髮質的影響比較小嗎？\n內文' && x.check.banned.length === 0, x.text);
    call({ action: 'saveContent', token: tok, id: s9.id, patch: { text: '- **頭皮有傷口**：先延後\n## 草本不傷髮\n其他' } });
    x = call({ action: 'getContent', token: tok, id: s9.id }).item;
    const r9 = call({ action: 'dismissIssue', token: tok, id: s9.id, kind: 'banned', index: 0 });
    t('忽略提醒：從清單拿掉並留紀錄', r9.ok && r9.item.check.banned.length === 0 && r9.item.check.dismissed[0].word === '不傷髮');
    t('員工不能套用或忽略', ['applyFix', 'dismissIssue'].every(a => call({ action: a, token: 'x', id: s9.id }).error === 'UNAUTHORIZED'));
    call({ action: 'deleteContent', token: tok, id: s9.id });
  }
  // 直接改字
  let r = call({ action: 'saveContent', token: tok, id, patch: { text: it.text.replace('完全不傷髮', '不含阿摩尼亞') + '\n加一句。' } });
  t('直接改字存在定稿，保留 AI 初稿', r.ok && r.item.final.includes('加一句') && r.item.draft.includes('完全不傷髮'));
  t('改字後重新比對禁用詞，AI 檢查標示待重做', r.item.check.banned.length === 0 && r.item.check.aiStale === true, r.item.check);
  t('標題不能空白', call({ action: 'saveContent', token: tok, id, patch: { title: ' ' } }).error === 'INVALID');
  t('改建議發布日、負責人', call({ action: 'saveContent', token: tok, id, patch: { suggestDate: '2026-12-07', owner: 'Tori' } }).item.suggestDate === '2026-12-07');
  t('負責人要在人員名單裡', call({ action: 'saveContent', token: tok, id, patch: { owner: '不存在' } }).error === 'INVALID');
  // 狀態
  t('待審不能直接標已發布', call({ action: 'setStatus', token: tok, id, status: '已發布' }).error === 'INVALID');
  t('核可', call({ action: 'setStatus', token: tok, id, status: '已核可' }).item.status === '已核可');
  t('核可後改字會退回待審', call({ action: 'saveContent', token: tok, id, patch: { text: '改過的內文【待素材：客人第一次染白髮的反應】' } }).reopened === true);
  call({ action: 'setStatus', token: tok, id, status: '已核可' });
  r = call({ action: 'setStatus', token: tok, id, status: '已發布', publishedDate: '2026-11-30' });
  t('標記已發布並記錄發布日期', r.item.status === '已發布' && r.item.publishedDate === '2026-11-30');
  t('已發布不能刪除、不能讓 AI 改', call({ action: 'deleteContent', token: tok, id }).error === 'INVALID' && call({ action: 'startEdit', token: tok, id, op: 'rewrite' }).error === 'INVALID');
  t('退回待審清掉發布日期', call({ action: 'setStatus', token: tok, id, status: '待審' }).item.publishedDate === '');
  // 補素材
  const n0 = api.calls.length;
  t('補素材要至少填一處', call({ action: 'startEdit', token: tok, id, op: 'fill', fills: [{ i: 0, text: '' }] }).error === 'INVALID');
  const se = call({ action: 'startEdit', token: tok, id, op: 'fill', fills: [{ i: 0, text: '客人說真的不臭耶' }] });
  t('排入補素材工作，處理中不能再排或改字', se.ok && call({ action: 'startEdit', token: tok, id, op: 'recheck' }).error === 'INVALID'
    && call({ action: 'saveContent', token: tok, id, patch: { text: 'x' } }).error === 'INVALID' && call({ action: 'getContent', token: tok, id }).item.busy === true);
  it = call({ action: 'runJob', token: tok, id }).item;
  t('只替換待素材那一處，其他文字一字不動', it.text === '改過的內文有位客人染完說「真的不臭耶」。' && it.placeholders.length === 0 && it.extra.needsMaterial.length === 0, it.text);
  t('補素材時帶入前後文與 Tori 的素材', api.calls[n0].body.messages[0].content.includes('改過的內文▲') && api.calls[n0].body.messages[0].content.includes('客人說真的不臭耶'));
  t('補完重新做 AI 法規檢查', it.check.ai.length === 1 && !it.check.aiStale && it.job === null);
  t('補的素材也存進文章素材庫', sheets['文章素材庫'].data.some(row => row[1] === '客人說真的不臭耶' && row[2].startsWith('補進')));
  // 重寫
  const n1 = api.calls.length;
  const leftBefore = sheets['文章素材庫'].data.filter(r => r[2].includes('產出時留下')).length;
  call({ action: 'startEdit', token: tok, id, op: 'rewrite', instruction: '再短一點，開頭直接講結論' });
  it = call({ action: 'runJob', token: tok, id }).item;
  t('附指示重寫：帶入指示、目前內文、原重點', api.calls[n1].body.messages[0].content.includes('再短一點') && api.calls[n1].body.messages[0].content.includes('改過的內文')
    && api.calls[n1].body.system.includes('第一次染白髮先看頭皮'));
  t('重寫後更新內文、標題、附加資料，不新增留存素材', it.text.startsWith('**') && it.extra.slug === 'grey-hair-coloring' && it.extra.focus === '第一次染白髮先看頭皮'
    && sheets['文章素材庫'].data.filter(r => r[2].includes('產出時留下')).length === leftBefore);
  t('重寫時要求不可新增經歷、保留待素材、開頭 60 字內', api.calls[n1].body.system.includes('不可新增任何沒有出現在原文') && api.calls[n1].body.system.includes('60 字以內'));
  // 潤飾與還原
  call({ action: 'saveContent', token: tok, id, patch: { text: '我親手改過的內文【待素材：客人第一次染白髮的反應】' } });
  const n2 = api.calls.length;
  call({ action: 'startEdit', token: tok, id, op: 'polish', instruction: '口氣輕鬆一點' });
  it = call({ action: 'runJob', token: tok, id }).item;
  const ps = api.calls[n2].body;
  t('潤飾：帶入指示與 Tori 改過的內文，要求不是重寫', ps.messages[0].content.includes('口氣輕鬆一點') && ps.messages[0].content.includes('我親手改過的內文')
    && ps.system.includes('不是重寫') && ps.system.includes('能不改就不改'));
  t('潤飾後更新內文、列出改了哪裡、保留待素材', it.text.startsWith('潤飾後') && it.extra.lastChanges[0].includes('刪掉') && it.placeholders.length === 1);
  t('潤飾後重做 AI 檢查、可以還原', it.check.ai.length === 1 && it.prev.op === 'polish');
  it = call({ action: 'restorePrev', token: tok, id }).item;
  t('還原成潤飾前的版本，AI 檢查標示待重做', it.text === '我親手改過的內文【待素材：客人第一次染白髮的反應】' && it.check.aiStale && it.prev === null);
  t('沒有上一版時不能還原', call({ action: 'restorePrev', token: tok, id }).error === 'INVALID');
  // 重新檢查
  call({ action: 'saveContent', token: tok, id, patch: { text: it.text + '\n再改一點' } });
  call({ action: 'startEdit', token: tok, id, op: 'recheck' });
  it = call({ action: 'runJob', token: tok, id }).item;
  t('重新 AI 檢查', it.check.aiStale === undefined && it.check.ai.length === 1 && it.text.endsWith('再改一點'));
  // 失敗保留原文
  call({ action: 'startEdit', token: tok, id, op: 'rewrite' });
  api.next.push(() => resp(529, {}));
  it = call({ action: 'runJob', token: tok, id }).item;
  t('AI 編輯失敗：內文不變、顯示原因、可以再試', it.text.endsWith('再改一點') && it.job.state === 'failed' && it.job.error.includes('忙碌') && !it.busy
    && call({ action: 'startEdit', token: tok, id, op: 'recheck' }).ok);
  call({ action: 'runJob', token: tok, id });
  // 卡住的編輯工作
  call({ action: 'startEdit', token: tok, id, op: 'recheck' });
  const row = sheets['內容'].data.find(x => x[0] === id), col = sheets['內容'].data[0].indexOf('AI 編輯工作');
  const job = JSON.parse(row[col]); job.at = '2026-11-23T03:50:00.000Z'; row[col] = JSON.stringify(job);
  it = call({ action: 'getContent', token: tok, id }).item;
  t('卡住超過 7 分鐘的編輯標成逾時，可以再改', it.job.state === 'failed' && it.job.error.includes('逾時') && call({ action: 'saveContent', token: tok, id, patch: { title: '新標題' } }).ok);
  t('刪除內容', call({ action: 'deleteContent', token: tok, id }).ok && call({ action: 'getContent', token: tok, id }).error === 'NOT_FOUND');
  const staff = env.staffLogin();
  t('員工不能審稿', ['saveContent', 'setStatus', 'startEdit', 'deleteContent', 'listContent', 'restorePrev'].every(a => call({ action: a, token: staff.token, id }).error === 'FORBIDDEN'));
}

console.log('Google 商家與 IG 限動');
{
  const env = makeEnv();
  const { call, admin, props, api, sheets } = env;
  props.set('ANTHROPIC_API_KEY', 'sk-test');
  const tok = admin().token;
  call({ action: 'saveRow', token: tok, table: 'stores', row: { id: 'S1', bookingUrl: 'https://lin.ee/khh' } });
  const art = call({ action: 'startArticle', token: tok, keywordId: 'K01' });
  call({ action: 'runJob', token: tok, id: art.id });
  const o = call({ action: 'articleOptions', token: tok });
  t('產出頁可選最近的官網文章', o.articles[0].id === art.id);
  t('Google 商家沒選來源被擋', call({ action: 'startGbp', token: tok }).error === 'INVALID');
  const g = call({ action: 'startGbp', token: tok, articleId: art.id, notes: '這週想推補染' });
  t('一次建立三間店各一則', g.ok && g.ids.length === 3 && sheets['內容'].data.filter(r => r[1] === 'Google 商家').map(r => r[2]).join() === '本館,散步二館,日和三館');
  t('只有第一則會觸發產出', call({ action: 'runJob', token: tok, id: g.ids[1] }).already === true);
  const n0 = api.calls.length;
  let it = call({ action: 'runJob', token: tok, id: g.ids[0] }).item;
  const gc = api.calls[n0].body;
  t('一次呼叫產出三篇，帶入來源文章與 Google 商家規則', gc.messages[0].content.includes('白髮染髮推薦') && gc.messages[0].content.includes('這週想推補染')
    && gc.system.includes('不帶入 Tori 個人') && gc.system.includes('選對店') && gc.system.includes('不放電話號碼'));
  t('三篇各做一次 AI 法規檢查', api.calls.length === n0 + 4);
  const all = g.ids.map(id => call({ action: 'getContent', token: tok, id }).item);
  t('三篇都進待審，建議發布日是週二', all.every(x => x.status === '待審' && x.suggestDate === '2026-11-24'), all.map(x => x.suggestDate));
  t('帶門市預約按鈕連結', all[0].extra.button === '預約' && all[0].extra.bookingUrl === 'https://lin.ee/khh' && all[0].title.startsWith('本館｜'));
  t('同一批可以互相切換', it.siblings.length === 3 && it.siblings[2].store === '日和三館');
  t('格式檢查：抓到電話號碼、高雄店沒提醒選對店', all[1].check.banned.some(h => h.word === '電話號碼') && all[1].check.banned.some(h => h.word === '沒有提醒選對店')
    && !all[0].check.banned.some(h => h.category === '格式') && !all[2].check.banned.some(h => h.word === '沒有提醒選對店'));
  // 只選關鍵字
  const g2 = call({ action: 'startGbp', token: tok, keywordId: 'K21' });
  call({ action: 'runJob', token: tok, id: g2.ids[0] });
  t('也可以只選關鍵字', api.calls[api.calls.length - 4].body.messages[0].content.includes('高雄染白髮推薦'));
  // 失敗時三則都標失敗
  const g3 = call({ action: 'startGbp', token: tok, keywordId: 'K21' });
  api.next.push(() => resp(529, {}));
  call({ action: 'runJob', token: tok, id: g3.ids[0] });
  t('產出失敗：同一批三則都標失敗', g3.ids.every(id => call({ action: 'getContent', token: tok, id }).item.status === '失敗'));
  // 少一間
  const g4 = call({ action: 'startGbp', token: tok, keywordId: 'K21' });
  api.next.push(() => resp(200, { content: [{ type: 'text', text: JSON.stringify({ posts: [{ store: '本館', angle: 'a', body: 'b' }] }) }], stop_reason: 'end_turn', usage: {} }));
  t('AI 少寫一間：清楚的錯誤訊息', call({ action: 'runJob', token: tok, id: g4.ids[0] }).item.error.includes('散步二館'));
  // IG（用每日回報系統存的對比圖）
  const d = env.drive;
  const c1 = d.add('旗艦本館', '2026-11', '2026-11-20', 'Kelly', '101500');
  const c2 = d.add('散步二館', '2026-11', '2026-11-22', '小美', '153000');
  const c3 = d.add('台南日和三館', '2026-10', '2026-10-30', '阿芳', '120000');
  d.add('旗艦本館', '2026-07', '2026-07-01', 'Kelly', '090000');
  let m = call({ action: 'listMaterials', token: tok });
  t('素材：只列對比圖、最新的在前、略過太舊的月份', m.ok && m.items.map(x => x.id).join() === [c2, c1, c3].join() && m.total === 3, m.items);
  t('素材：門市名稱對到行銷助手（旗艦本館→本館、台南→日和三館），帶同仁與日期', m.items[1].store === '本館' && m.items[2].store === '日和三館' && m.items[0].staff === '小美' && m.items[0].date === '2026-11-22');
  t('素材：統計近 7 天各店上傳數', m.weekByStore.find(x => x.store === '本館').count === 1 && m.weekByStore.find(x => x.store === '日和三館').count === 0);
  const th = call({ action: 'getMaterial', token: tok, id: c1 }), full = call({ action: 'getMaterial', token: tok, id: c1, full: true });
  t('素材：可以看縮圖、下載原圖', th.ok && Buffer.from(th.data, 'base64').toString() === 'thumb' && Buffer.from(full.data, 'base64').toString().startsWith('jpeg:2026-11-20_旗艦本館_Kelly'));
  const outside = d.file('2026-11-01_x_y_000000_對比圖.jpg', d.other).id;
  t('素材：不在 PO 文素材資料夾裡的檔案拿不到', call({ action: 'getMaterial', token: tok, id: outside }).error === 'NOT_FOUND'
    && call({ action: 'getMaterial', token: tok, id: d.root.kids[0].kids[0].files[0].id }).error === 'NOT_FOUND');
  t('IG 沒選對比圖被擋', call({ action: 'startIg', token: tok, photoIds: [] }).error === 'INVALID');
  const ig = call({ action: 'startIg', token: tok, photoIds: [c2, c1], notes: '這週主打深棕' });
  const n1 = api.calls.length;
  call({ action: 'runJob', token: tok, id: ig.ids[0] });
  const igs = ig.ids.map(id => call({ action: 'getContent', token: tok, id }).item);
  const ib = api.calls[n1].body;
  t('IG：同一批的版面不重複', igs[0].extra.layout !== igs[1].extra.layout && igs.every(x => x.extra.layout >= 0 && x.extra.layout < 5), igs.map(x => x.extra.layout));
  t('IG：每張對比圖一張圖，帶門市，建議週一、三', igs.length === 2 && igs.map(x => x.store).join() === '散步二館,本館' && igs.map(x => x.suggestDate).join() === '2026-11-25,2026-11-27'
    && igs[0].extra.photoId === c2 && igs[0].extra.photoStaff === '小美', igs.map(x => x.suggestDate));
  t('IG：把對比圖原圖傳給看圖模型，附 Tori 的補充', ib.model === 'claude-opus-5-5' && ib.messages[0].content.filter(c => c.type === 'image').length === 2
    && JSON.stringify(ib.messages[0].content).includes('這週主打深棕') && JSON.stringify(ib.messages[0].content).includes('上面是服務前'));
  t('IG：指令要求一張圖、只描述顏色、不評論外表、15 字內', ['「一張」限動圖', '只描述顏色變化', '不要評論客人的外表', '15 字內', '20 字內'].every(x => ib.system.includes(x)));
  m = call({ action: 'listMaterials', token: tok, unused: true });
  t('IG：用過的對比圖不再出現在可選清單，也不能再選', m.items.map(x => x.id).join() === c3 && call({ action: 'startIg', token: tok, photoIds: [c1] }).message.includes('已經用過'));
  t('IG：單張格式（主文字、副標、互動貼圖、連結貼圖）', igs[0].text === '## 白髮到深棕 1\n\n**主文字**：從白髮到深棕\n**副標**：染護師先看頭皮再選色\n**互動貼圖**：滑桿：喜歡這個顏色嗎\n**連結貼圖**：預約', igs[0].text);
  t('IG：主文字超過 15 字、副標超過 20 字被標出', igs[1].check.banned.some(h => h.word.startsWith('主文字 ') && h.sentence.startsWith('**主文字**'))
    && igs[1].check.banned.some(h => h.word.startsWith('副標 ')) && !igs[0].check.banned.some(h => h.category === '格式'));
  t('IG：可以換版面，存起來', call({ action: 'saveContent', token: tok, id: ig.ids[0], patch: { layout: 3 } }).item.extra.layout === 3
    && call({ action: 'saveContent', token: tok, id: ig.ids[0], patch: { layout: 9 } }).error === 'INVALID'
    && call({ action: 'saveContent', token: tok, id: g.ids[0], patch: { layout: 1 } }).error === 'INVALID');
  let x = call({ action: 'applyFix', token: tok, id: ig.ids[1], kind: 'banned', index: igs[1].check.banned.findIndex(h => h.word.startsWith('主文字')), text: '**主文字**：白髮到深棕' }).item;
  t('IG：套用修改後格式提醒消失', x.text.includes('**主文字**：白髮到深棕') && !x.check.banned.some(h => h.word.startsWith('主文字')));
  x = call({ action: 'saveContent', token: tok, id: ig.ids[1], patch: { text: x.text.replace(/預約/g, '來店') } }).item;
  t('IG：拿掉預約會被提醒', x.check.banned.some(h => h.word === '沒有導向預約'));
  const ig2 = call({ action: 'startIg', token: tok, photoIds: [c3] });
  delete d.byId[c3];
  t('IG：對比圖在產出前被刪掉 → 清楚的錯誤', call({ action: 'runJob', token: tok, id: ig2.ids[0] }).item.error.includes('找不到'));
  t('IG 產出失敗後，那張對比圖可以再選', (d.byId[c3] = d.root.kids.find(k => k.name === '台南日和三館').kids[0].files[2], call({ action: 'listMaterials', token: tok, unused: true }).items.some(i => i.id === c3)));
  // 重寫、潤飾
  const n2 = api.calls.length;
  call({ action: 'startEdit', token: tok, id: g.ids[1], op: 'rewrite', instruction: '拿掉電話' });
  x = call({ action: 'runJob', token: tok, id: g.ids[1] }).item;
  t('Google 商家重寫：用該平台規則與門市', api.calls[n2].body.system.includes('「散步二館」的貼文') && api.calls[n2].body.system.includes('不帶入 Tori 個人') && x.prev.op === 'rewrite');
  const n3 = api.calls.length;
  call({ action: 'startEdit', token: tok, id: ig.ids[0], op: 'polish' });
  call({ action: 'runJob', token: tok, id: ig.ids[0] });
  t('IG 潤飾：保留三行格式的指示與 IG 規則', api.calls[n3].body.system.includes('主文字 15 字內') && api.calls[n3].body.system.includes('頭沐小編'));
  t('審稿清單看得到三種類型', ['官網文章', 'Google 商家', 'IG 限動'].every(ty => call({ action: 'listContent', token: tok }).items.some(i => i.type === ty)));
}

console.log('錯誤處理與花費上限');
{
  const env = makeEnv();
  const { call, admin, props, api, sheets, F, logs } = env;
  props.set('ANTHROPIC_API_KEY', 'sk-test');
  const tok = admin().token;
  const run = () => { const s = call({ action: 'startArticle', token: tok, keywordId: 'K01' }); return call({ action: 'runJob', token: tok, id: s.id }).item; };
  api.next.push(() => resp(401, { error: { message: 'invalid x-api-key' } }));
  let it = run();
  t('金鑰錯誤 → 失敗並說明', it.status === '失敗' && it.error.includes('金鑰不正確'), it.error);
  t('失敗不更新關鍵字使用日', sheets['關鍵字庫'].data[1][6] === '');
  api.next.push(() => resp(400, { error: { message: 'Your credit balance is too low to access the Anthropic API.' } }));
  t('餘額不足 → 說明去儲值', run().error.includes('餘額不足'));
  api.next.push(() => resp(529, { error: { message: 'Overloaded' } }));
  t('Claude 忙碌 → 稍後再試', run().error.includes('暫時忙碌'));
  api.next.push(() => resp(200, { content: [], stop_reason: 'refusal', usage: { input_tokens: 100, output_tokens: 0 } }));
  t('拒答 → 清楚訊息', run().error.includes('拒絕'));
  api.next.push(() => resp(200, { content: [{ type: 'text', text: '{"title":"半' }], stop_reason: 'max_tokens', usage: { input_tokens: 100, output_tokens: 16000 } }));
  t('被截斷 → 清楚訊息', run().error.includes('截斷'));
  api.next.push(() => { throw new Error('Timeout: https://api.anthropic.com/v1/messages'); });
  t('逾時 → 清楚訊息', run().error.includes('超過時間'));
  api.next.push(b => { const q = api.next; api.next = []; const r = api.handle('', { payload: JSON.stringify(b), headers: {} }); api.next = q; return r; }, () => resp(500, {}));
  it = run();
  t('AI 語意檢查失敗不擋文章，但標示出來', it.status === '待審' && it.check.aiError.includes('沒有完成') && it.check.banned.length > 0, it.check);
  // 卡住的工作：開始後 7 分鐘以上
  const s = call({ action: 'startArticle', token: tok, keywordId: 'K01' });
  const row = sheets['內容'].data.find(r => r[0] === s.id);
  row[sheets['內容'].data[0].indexOf('建立時間')] = '2026-11-23T03:50:00.000Z';
  t('超過 7 分鐘還在產出中 → 標成逾時失敗', call({ action: 'getContent', token: tok, id: s.id }).item.error.includes('逾時'));
  sheets['用量紀錄'].data.push(['U1', '2026-11-05T00:00:00.000Z', '官網文章', '', '995']);
  const over = call({ action: 'startArticle', token: tok, keywordId: 'K01' });
  t('本月花費達上限就停止產出', over.error === 'BUDGET' && over.message.includes('NT$1000'), over);
  sheets['用量紀錄'].data[sheets['用量紀錄'].data.length - 1][1] = '2026-10-05T00:00:00.000Z';
  t('上個月的花費不算', call({ action: 'startArticle', token: tok, keywordId: 'K01' }).ok);
  F.testAI();
  t('編輯器的 testAI 會記錄 AI 回覆', logs.some(l => l.includes('連線成功')));
}

console.log('設定升級');
{
  const { sheets, F } = makeEnv();
  sheets['設定'].data.find(r => r[0] === 'modelText')[2] = '';
  sheets['設定'].data.splice(sheets['設定'].data.findIndex(r => r[0] === 'aiEffort'), 1);
  F.setup();
  t('重跑 setup：空白的模型名稱補預設、新設定項目補上', sheets['設定'].data.find(r => r[0] === 'modelText')[2] === 'claude-opus-5-5'
    && sheets['設定'].data.find(r => r[0] === 'aiEffort')[2] === 'medium');
}

console.log('權限範圍');
{
  const man = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'appsscript.json'), 'utf8'));
  t('只要求：這份試算表、雲端硬碟唯讀、連外、自己的 Gmail', JSON.stringify(man.oauthScopes.slice().sort()) === JSON.stringify([
    'https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/script.external_request',
    'https://www.googleapis.com/auth/spreadsheets.currentonly', 'https://www.googleapis.com/auth/userinfo.email'].sort()), man.oauthScopes);
  t('網頁應用程式：以部署者身分執行、任何人可連（每個動作都要登入）', man.webapp.executeAs === 'USER_DEPLOYING' && man.webapp.access === 'ANYONE_ANONYMOUS');
  const code = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
  t('程式不會寫入雲端硬碟或開別的試算表', !/\.(createFile|createFolder|setTrashed|addFile|removeFile|moveTo|setSharing|addEditor|addViewer)\(|openById|openByUrl/.test(code));
}

console.log(`\n${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
