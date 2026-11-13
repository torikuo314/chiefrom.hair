// 在 Node 裡模擬 Apps Script，跑財務後台測試：node finance/apps-script/test/finance.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const ADMIN = 'tori@example.com', MANAGER = 'manager@example.com', STRANGER = 'someone@example.com';

function makeEnv(today = new Date('2026-11-13T04:00:00Z')) {
  const sheets = {}, order = [];
  const mkSheet = name => {
    const data = [];
    return { data, getLastRow: () => data.length, appendRow: r => data.push(r.map(String)), setFrozenRows() {},
      getRange: (a, c) => typeof a === 'string' ? { setNumberFormat() {} } : { setValue: v => { data[a - 1][c - 1] = String(v); } },
      getDataRange: () => ({ getValues: () => data.map(r => r.slice()) }), deleteRow: r => data.splice(r - 1, 1) };
  };
  const cache = new Map(), files = [];
  const ctx = {
    console, Date: class extends Date { constructor(...a) { super(...(a.length ? a : [today])); } static now() { return today.getTime(); } },
    SpreadsheetApp: { getActive: () => ({ getSheetByName: n => sheets[n] || null, insertSheet: n => { order.push(n); return (sheets[n] = mkSheet(n)); } }) },
    CacheService: { getScriptCache: () => ({ get: k => cache.get(k) ?? null, put: (k, v) => cache.set(k, v), remove: k => cache.delete(k) }) },
    UrlFetchApp: { fetch: url => {
      const tok = decodeURIComponent(url.split('id_token=')[1] || '');
      const m = tok.match(/^google:(.+?):(.+)$/); // google:<email>:<aud>
      if (!m) return { getResponseCode: () => 400, getContentText: () => '{}' };
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ iss: 'https://accounts.google.com', aud: m[2], email: m[1], email_verified: 'true', exp: String(Math.floor(today.getTime() / 1000) + 3600), name: m[1].split('@')[0] }) };
    } },
    DriveApp: {
      createFolder: () => ({ getId: () => 'folder1', getUrl: () => 'https://drive/folder1' }),
      getFolderById: () => ({ createFile: blob => { files.push(blob); return { getId: () => 'file' + files.length, setDescription() {} }; } }),
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      formatDate: (d, tz, f) => f === 'yyyy-MM' ? new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 7) : 'stamp',
      base64Decode: s => [...Buffer.from(s, 'base64')],
      newBlob: (b, m, n) => ({ b, m, n }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Logger: { log() {} },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ setMimeType: () => ({ body: s }) }) },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8') +
    '\nthis.__={handle_,setup,computeLedger,capitalSummary,assetRows,settings_};', ctx);
  ctx.__.setup();
  const set = (k, v) => { const s = sheets['設定'].data; const r = s.find(x => x[0] === k); r[1] = v; };
  set('googleClientId', CLIENT_ID); set('adminEmails', ADMIN); set('managerEmails', MANAGER);
  const call = req => JSON.parse(JSON.stringify(ctx.__.handle_(req)));
  const login = email => call({ action: 'login', idToken: `google:${email}:${CLIENT_ID}` });
  return { ctx, sheets, call, login, set, files, F: ctx.__ };
}

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};

/* ── 計算（與原型相同的 20 項規則） ── */
console.log('計算規則');
{
  const { F } = makeEnv();
  const S = Object.assign({}, F.settings_(), { contractStart: '2027-01-01' });
  const blank = () => ({ expenses: [], revenues: [], perf: [], bPayments: [], repayments: [] });
  const E = o => Object.assign({ nature: '', life: '' }, o);
  let d = blank(); d.revenues.push({ date: '2027-01-20', amount: 100000 });
  let r = F.computeLedger(d, S, '2027-01').rows[0];
  t('月結算：盈餘 10 萬 → 預備金 5 萬、乙方 3 萬、甲方 2 萬', r.reserveAdd === 50000 && r.b === 30000 && r.a === 20000, r);

  d = blank(); d.expenses.push(E({ date: '2027-01-03', amount: 45000, payer: 'A', nature: 'advance', cat: 'c4' })); d.repayments.push({ date: '2027-01-20', amount: 15000, to: '甲方' });
  let c = F.capitalSummary(d, S, 0);
  t('Tori 付的營運支出算代墊：不算出資，記為店欠甲方', c.aPaid === 0 && c.storeOwesA === 30000, c);

  d = blank(); d.expenses.push(E({ date: '2027-01-02', amount: 1100000, payer: 'A', nature: 'capital', cat: 'eq' })); d.bPayments.push({ date: '2027-01-05', amount: 120000 });
  c = F.capitalSummary(d, S, 0);
  t('出資拆層：付 110 萬、補 12 萬 → 甲 60｜超出 10（甲 6／乙 4）｜乙欠 32｜進度 12/44',
    c.tierA === 600000 && c.tierX === 100000 && c.xA === 60000 && c.xB === 40000 && c.bOwesA === 320000 && c.progress === 120000 && c.bTarget === 440000, c);
  d.expenses.push(E({ date: '2027-01-03', amount: 50000, payer: 'B', nature: 'capital', cat: 'eq' }));
  c = F.capitalSummary(d, S, 0);
  t('乙方自付 5 萬設備算出資 → 進度 17、欠 27', c.progress === 170000 && c.bOwesA === 270000, c);

  d = blank(); ['01', '02', '03'].forEach(m => d.revenues.push({ date: `2027-${m}-10`, amount: 800000 }));
  let L = F.computeLedger(d, S, '2027-03'), q = L.quarters[0];
  t('月分潤乙 > 甲、季分潤甲 > 乙（沒有弄反）', L.rows[0].b > L.rows[0].a && q.qA > q.qB);
  t('季結算：預備金 120 萬 → 乙 8 萬、甲 12 萬、沖抵 8 萬、剩 100 萬', q.qB === 80000 && q.qA === 120000 && q.offset === 80000 && q.reserveAfter === 1000000, q);
  d.bPayments.push({ date: '2027-01-01', amount: 380000 });
  q = F.computeLedger(d, S, '2027-03').quarters[0];
  t('沖抵上限：已補 38 萬 → 只沖抵 2 萬、實領 6 萬', q.offset === 20000 && q.bCash === 60000, q);

  d = blank(); d.revenues.push({ date: '2027-01-10', amount: 100000 }); d.perf.push({ date: '2027-01', amount: 175000 }, { date: '2027-02', amount: 90000 });
  L = F.computeLedger(d, S, '2027-02');
  t('店長業績 17.5 萬 → 獎金 1.5 萬列入第 3 項；9 萬 → 0', L.rows[0].byCat.c3 === 15000 && L.rows[0].surplus === 85000 && L.rows[1].bonus === 0, L.rows[0]);

  d = blank(); d.expenses.push(E({ date: '2027-01-10', amount: 20000, payer: 'S', cat: 'c4' })); d.revenues.push({ date: '2027-02-10', amount: 100000 });
  const carry = F.computeLedger(d, Object.assign({}, S, { negativeRule: 'carry' }), '2027-02').rows[1];
  const res = F.computeLedger(d, S, '2027-02').rows[1];
  t('負盈餘「累計到下月」→ 2 月提撥 4 萬', carry.reserveAdd === 40000, carry);
  t('負盈餘「從預備金扣」（預設）→ 2 月後累計 3 萬', S.negativeRule === 'reserve' && res.reserveAfter === 30000, res);

  d = blank(); d.expenses.push(E({ id: 'x', date: '2027-01-03', amount: 600000, payer: 'A', nature: 'capital', cat: 'eq', life: '5' })); d.revenues.push({ date: '2027-01-10', amount: 100000 });
  t('設備費不扣進月成本', F.computeLedger(d, S, '2027-01').rows[0].surplus === 100000);
  const a = F.assetRows(d, S, '2028-01')[0];
  t('折舊：60 萬、5 年，12 個月後剩 48 萬', a.monthly === 10000 && a.value === 480000, a);
}

/* ── 登入 ── */
console.log('\nGoogle 登入');
{
  const env = makeEnv();
  t('管理者 Gmail 登入 → admin', env.login(ADMIN).user.role === 'admin');
  t('店長 Gmail 登入 → manager', env.login(MANAGER).user.role === 'manager');
  t('名單外的 Gmail 被拒', env.login(STRANGER).error === 'NOT_ALLOWED');
  t('給別的網站用的 Google 登入（aud 不同）被拒', env.call({ action: 'login', idToken: `google:${ADMIN}:other-app` }).error === 'LOGIN_FAILED');
  t('假的登入資料被拒', env.call({ action: 'login', idToken: 'forged' }).error === 'LOGIN_FAILED');
  const m = env.login(MANAGER).token;
  env.set('managerEmails', '');
  t('從名單拿掉店長後，已登入的 token 立刻失效', env.call({ action: 'listMine', token: m }).error === 'UNAUTHORIZED');
}

/* ── 權限 ── */
console.log('\n權限（後台判斷）');
{
  const env = makeEnv();
  const actions = ['logout', 'me', 'addExpense', 'addRevenue', 'addPerf', 'updateRecord', 'listMine', 'uploadVoucher', 'addBPayment', 'addRepayment', 'deleteRecord', 'listAll', 'dashboard', 'getSettings', 'saveSettings', 'lockMonth'];
  t(`不帶 token：${actions.length} 個動作全部 UNAUTHORIZED`, actions.every(a => env.call({ action: a }).error === 'UNAUTHORIZED'));
  const M = env.login(MANAGER).token, A = env.login(ADMIN).token;
  const adminOnly = ['addBPayment', 'addRepayment', 'deleteRecord', 'listAll', 'dashboard', 'getSettings', 'saveSettings', 'lockMonth'];
  const leaked = adminOnly.filter(a => env.call({ action: a, token: M, month: '2026-10', locked: true }).error !== 'FORBIDDEN');
  t('店長呼叫 8 個結算／管理 API 全部 FORBIDDEN（看不到結算、甲方投入、設備、出資）', leaked.length === 0, leaked);

  const ok = env.call({ action: 'addExpense', token: M, record: { date: '2026-10-05', item: 'IG 廣告', amount: 8000, payer: 'B', nature: 'advance', cat: 'c6' } });
  t('店長可以記支出', ok.ok, ok);
  t('店長不能登記甲方付款', env.call({ action: 'addExpense', token: M, record: { date: '2026-10-05', item: 'x', amount: 1, payer: 'A', nature: 'advance', cat: 'c5' } }).error === 'INVALID');
  t('合約期間的材料費不能算出資', env.call({ action: 'addExpense', token: M, record: { date: '2026-10-05', item: 'x', amount: 1, payer: 'B', nature: 'capital', cat: 'c5' } }).error === 'INVALID');
  t('設備可以算出資', env.call({ action: 'addExpense', token: M, record: { date: '2026-10-06', item: '吹風機', amount: 3000, payer: 'B', nature: 'capital', cat: 'eq' } }).ok);
  t('營收要選付款方式', env.call({ action: 'addRevenue', token: M, record: { date: '2026-10-05', amount: 5000 } }).error === 'INVALID');
  env.call({ action: 'addRevenue', token: M, record: { date: '2026-10-05', amount: 330000, method: '刷卡' } });
  env.call({ action: 'addPerf', token: M, record: { date: '2026-10', amount: 175000 } });
  t('個人業績每月只能一筆', env.call({ action: 'addPerf', token: M, record: { date: '2026-10', amount: 1 } }).error === 'DUPLICATE');

  const adminRec = env.call({ action: 'addExpense', token: A, record: { date: '2026-07-10', item: '裝修', amount: 1100000, payer: 'A', nature: 'capital', cat: 'eq', life: 5 } });
  const mine = env.call({ action: 'listMine', token: M });
  t('店長只看到自己輸入的（看不到 Tori 的 110 萬裝修）', mine.ok && mine.records.expense.length === 2 && !mine.records.bpay && !JSON.stringify(mine).includes('1100000'), mine.records);
  t('店長改不到 Tori 的紀錄', env.call({ action: 'updateRecord', token: M, kind: 'expense', id: adminRec.record.id, patch: { amount: 1 } }).error === 'FORBIDDEN');

  const rec = ok.record;
  const up = env.call({ action: 'updateRecord', token: M, kind: 'expense', id: rec.id, patch: { amount: 9000 } });
  t('店長可以改自己的紀錄，並留下修改歷程', up.ok && env.call({ action: 'listMine', token: M }).records.expense.find(x => x.id === rec.id).history[0].before.amount === '8000', up);

  t('本月不能鎖定', env.call({ action: 'lockMonth', token: A, month: '2026-11', locked: true }).error === 'INVALID');
  env.call({ action: 'lockMonth', token: A, month: '2026-10', locked: true });
  t('鎖定後店長不能改該月', env.call({ action: 'updateRecord', token: M, kind: 'expense', id: rec.id, patch: { amount: 1 } }).error === 'MONTH_LOCKED');
  t('鎖定後也不能新增該月', env.call({ action: 'addRevenue', token: M, record: { date: '2026-10-20', amount: 1, method: '現金' } }).error === 'MONTH_LOCKED');
  t('鎖定後 Tori 也不能刪該月（要先解鎖）', env.call({ action: 'deleteRecord', token: A, kind: 'expense', id: rec.id }).error === 'MONTH_LOCKED');

  const dash = env.call({ action: 'dashboard', token: A });
  const oct = dash.ledger.rows.find(r => r.month === '2026-10');
  t('Tori 看得到結算：10 月營收 33 萬、獎金 1.5 萬', dash.ok && oct.rev === 330000 && oct.bonus === 15000, oct);
  t('設備表含店長自付的吹風機與 Tori 的裝修', dash.assets.length === 2);
  t('網頁不能改信箱名單或登入 ID', env.call({ action: 'saveSettings', token: A, settings: { adminEmails: 'hacker@x.com' } }).error === 'INVALID');
  const ss = env.call({ action: 'saveSettings', token: A, settings: { negativeRule: 'carry', reserveRate: '40' } });
  t('Tori 可以改比例與規則', ss.ok && ss.settings.reserveRate === 40 && ss.settings.negativeRule === 'carry');
  t('getSettings 不會回傳信箱或登入 ID', !JSON.stringify(env.call({ action: 'getSettings', token: A })).match(/example\.com|apps\.googleusercontent/));

  const up2 = env.call({ action: 'uploadVoucher', token: M, filename: 'r.jpg', mimeType: 'image/jpeg', data: Buffer.from('jpegdata').toString('base64') });
  t('店長可以上傳憑證照片', up2.ok && env.files.length === 1, up2);
  t('不接受照片／PDF 以外的檔案', env.call({ action: 'uploadVoucher', token: M, filename: 'x.html', mimeType: 'text/html', data: 'AA==' }).error === 'INVALID');
  const audit = env.sheets['修改歷程'].data;
  t('每筆新增、修改、鎖定、設定變更都寫進修改歷程', audit.length > 8 && audit.some(r => r[4] === 'lock') && audit.some(r => r[2] === 'settings'));
}

console.log(`\n${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
