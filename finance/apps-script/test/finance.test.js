// 在 Node 裡模擬 Apps Script，跑財務後台測試：node finance/apps-script/test/finance.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const FAKE_TERMS = { contractStart: '2026-08-01', reserveRate: '30', monthlyB: '70', quarterThreshold: '500000', quarterlyB: '20',
  aCapital: '300000', bCapital: '200000', perfBase: '50000', perfRate: '10' };
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
      formatDate: (d, tz, f) => { const iso = new Date(d.getTime() + 8 * 3600e3).toISOString(); return f === 'yyyy-MM' ? iso.slice(0, 7) : f === 'yyyy-MM-dd' ? iso.slice(0, 10) : 'stamp'; },
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
  // 測試用的假合約數字（真正的比例與金額只存在不公開的財務 Sheet）
  Object.entries(FAKE_TERMS).forEach(([k, v]) => set(k, v));
  const call = req => JSON.parse(JSON.stringify(ctx.__.handle_(req)));
  const login = email => call({ action: 'login', idToken: `google:${email}:${CLIENT_ID}` });
  return { ctx, sheets, call, login, set, files, F: ctx.__ };
}

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};

/* ── 計算（與原型相同的 20 項規則） ── */
console.log('計算規則（用假的合約數字：預備金 30%、月分潤店長 70%、季門檻 50 萬、季分潤店長 20%、出資 30／20 萬、業績門檻 5 萬 ×10%）');
{
  const { F } = makeEnv();
  const S = Object.assign({}, F.settings_(), { contractStart: '2027-01-01' });
  const blank = () => ({ expenses: [], revenues: [], perf: [], bPayments: [], repayments: [] });
  const E = o => Object.assign({ nature: '', life: '' }, o);
  let d = blank(); d.revenues.push({ date: '2027-01-20', amount: 100000 });
  let r = F.computeLedger(d, S, '2027-01').rows[0];
  t('月結算：盈餘 10 萬 → 預備金 3 萬、店長 4.9 萬、公司 2.1 萬', r.reserveAdd === 30000 && r.b === 49000 && r.a === 21000, r);

  d = blank(); d.expenses.push(E({ date: '2027-01-03', amount: 45000, payer: 'A', nature: 'advance', cat: 'c4' })); d.repayments.push({ date: '2027-01-20', amount: 15000, to: '甲方' });
  let c = F.capitalSummary(d, S, 0);
  t('公司付的營運支出算代墊：不算出資，記為店欠公司', c.aPaid === 0 && c.storeOwesA === 30000, c);

  d = blank(); d.expenses.push(E({ date: '2027-01-02', amount: 700000, payer: 'A', nature: 'capital', cat: 'eq' })); d.bPayments.push({ date: '2027-01-05', amount: 50000 });
  c = F.capitalSummary(d, S, 0);
  t('出資拆層：公司付 70 萬、店長補 5 萬 → 公司自己 30｜超出 20 由公司 12／店長 8 分擔｜代店長墊 28｜店長欠 23',
    c.tierA === 300000 && c.tierXA === 120000 && c.tierB === 280000 && c.xB === 80000 && c.bOwesA === 230000 && c.progress === 50000 && c.bTarget === 280000, c);
  d.expenses.push(E({ date: '2027-01-03', amount: 30000, payer: 'B', nature: 'capital', cat: 'eq' }));
  c = F.capitalSummary(d, S, 0);
  t('店長自付 3 萬也算進開辦總支出：總支出 73 萬，超出 23 萬，店長分擔 9.2 萬 → 欠 20＋9.2−5−3 = 21.2 萬', c.totalSpent === 730000 && c.xB === 92000 && c.bOwesA === 212000 && c.progress === 80000, c);
  {
    // 跟實際情況同樣的結構：公司算出資 45 萬、店長自付算出資 10 萬，總支出超過約定的 50 萬
    const d3 = blank();
    d3.expenses.push(E({ date: '2027-01-02', amount: 450000, payer: 'A', nature: 'capital', cat: 'eq' }), E({ date: '2027-01-03', amount: 100000, payer: 'B', nature: 'capital', cat: 'eq' }));
    const c3 = F.capitalSummary(d3, S, 0);
    t('店長自付的出資也算進總支出：超出 5 萬由公司 3 萬、店長 2 萬分擔', c3.tierX === 50000 && c3.xA === 30000 && c3.xB === 20000, c3);
    t('公司代店長墊的金額 ＝ 店長欠公司的金額（12 萬）', c3.tierB === 120000 && c3.bOwesA === 120000, { tierB: c3.tierB, bOwesA: c3.bOwesA });
    t('公司付的錢拆成三塊加起來剛好等於公司出資合計', c3.tierA + c3.tierXA + c3.tierB === c3.aPaid);
  }
  {
    // 營業代墊不算出資；店長付超過應出資時，變成公司欠店長；超出分擔取整數
    const d4 = blank();
    d4.expenses.push(E({ date: '2027-01-02', amount: 450000, payer: 'A', nature: 'capital', cat: 'eq' }), E({ date: '2027-01-05', amount: 34720, payer: 'A', nature: 'advance', cat: 'c4' }));
    const c4 = F.capitalSummary(d4, S, 0);
    t('公司的營業代墊不算進出資，記為店欠公司', c4.aPaid === 450000 && c4.aPaidSplit.advance === 34720 && c4.storeOwesA === 34720, c4.aPaidSplit);
    const d5 = blank(); d5.expenses.push(E({ date: '2027-01-02', amount: 250000, payer: 'B', nature: 'capital', cat: 'eq' }));
    const c5 = F.capitalSummary(d5, S, 0);
    t('店長付超過應出資 → 顯示公司欠店長，不會變成 0', c5.bOwesA === 0 && c5.aOwesB === 50000, { bOwesA: c5.bOwesA, aOwesB: c5.aOwesB });
    const d6 = blank(); d6.expenses.push(E({ date: '2027-01-02', amount: 500001, payer: 'A', nature: 'capital', cat: 'eq' }), E({ date: '2027-01-02', amount: 2, payer: 'B', nature: 'capital', cat: 'eq' }));
    const c6 = F.capitalSummary(d6, S, 0);
    t('超出分擔取整數，加起來剛好等於超出金額', Number.isInteger(c6.xB) && c6.xA + c6.xB === c6.tierX, { xA: c6.xA, xB: c6.xB, tierX: c6.tierX });
  }
  t('超過總出資時沒有出資餘款', c.surplusToCompany === 0, c.surplusToCompany);
  {
    const d2 = blank(); d2.expenses.push(E({ date: '2027-01-02', amount: 380000, payer: 'A', nature: 'capital', cat: 'eq' })); d2.bPayments.push({ date: '2027-01-05', amount: 50000 });
    const c2 = F.capitalSummary(d2, S, 0);
    t('店長固定出資：公司只花 38 萬（沒到總出資 50 萬），店長仍欠 20 萬 − 已補 5 萬 = 15 萬', c2.bOwesA === 150000, c2.bOwesA);
    t('沒用完的 12 萬是出資餘款，歸公司資金', c2.surplusToCompany === 120000, c2.surplusToCompany);
  }

  d = blank(); ['01', '02', '03'].forEach(m => d.revenues.push({ date: `2027-${m}-10`, amount: 800000 }));
  let L = F.computeLedger(d, S, '2027-03'), q = L.quarters[0];
  t('月分潤用 monthlyB、季分潤用 quarterlyB（沒有弄反）', L.rows[0].b === 392000 && q.qB === 44000);
  t('季結算：預備金 72 萬 → 分超過的 22 萬：店長 4.4 萬、公司 17.6 萬，店長全數沖抵出資，剩 50 萬', q.excess === 220000 && q.qA === 176000 && q.offset === 44000 && q.reserveAfter === 500000, q);
  d.bPayments.push({ date: '2027-01-01', amount: 180000 });
  q = F.computeLedger(d, S, '2027-03').quarters[0];
  t('沖抵上限：已補 18 萬 → 只沖抵 2 萬、實領 2.4 萬', q.offset === 20000 && q.bCash === 24000, q);

  d = blank(); d.revenues.push({ date: '2027-01-10', amount: 100000 }); d.perf.push({ date: '2027-01', amount: 80000 }, { date: '2027-02', amount: 40000 });
  L = F.computeLedger(d, S, '2027-02');
  t('店長業績 8 萬 → 獎金 3 千列入第 3 項；4 萬 → 0', L.rows[0].byCat.c3 === 3000 && L.rows[0].surplus === 97000 && L.rows[1].bonus === 0, L.rows[0]);

  d = blank(); d.expenses.push(E({ date: '2027-01-10', amount: 20000, payer: 'S', cat: 'c4' })); d.revenues.push({ date: '2027-02-10', amount: 100000 });
  const carry = F.computeLedger(d, Object.assign({}, S, { negativeRule: 'carry' }), '2027-02').rows[1];
  const res = F.computeLedger(d, S, '2027-02').rows[1];
  t('負盈餘「累計到下月」→ 2 月用 8 萬算，提撥 2.4 萬', carry.reserveAdd === 24000, carry);
  t('負盈餘「從預備金扣」（預設）→ 2 月後累計 1 萬', S.negativeRule === 'reserve' && res.reserveAfter === 10000, res);

  {
    // 開幕前的營業費用、營業收入併入第一個月；開幕前的出資不算成本（合約起日 2027-01-01）
    const d7 = blank();
    d7.expenses.push(E({ date: '2026-12-20', amount: 20000, payer: 'A', nature: 'advance', cat: 'c4' }),
                     E({ date: '2026-12-10', amount: 50000, payer: 'A', nature: 'capital', cat: 'c4' }),
                     E({ date: '2027-01-05', amount: 10000, payer: 'S', cat: 'c5' }));
    d7.revenues.push({ date: '2026-12-28', amount: 3000 }, { date: '2027-01-10', amount: 100000 });
    const r7 = F.computeLedger(d7, S, '2027-02').rows;
    t('開幕前的營業代墊 2 萬算進第一個月成本（出資的 5 萬不算）', r7[0].cost === 30000 && r7[0].preOpenCost === 20000 && r7[1].cost === 0, r7[0]);
    t('開幕前的營收也算進第一個月', r7[0].rev === 103000 && r7[0].preOpenRev === 3000, r7[0]);
  }
  d = blank(); d.expenses.push(E({ id: 'x', date: '2027-01-03', amount: 600000, payer: 'A', nature: 'capital', cat: 'eq', life: '5' })); d.revenues.push({ date: '2027-01-10', amount: 100000 });
  t('設備費不扣進月成本', F.computeLedger(d, S, '2027-01').rows[0].surplus === 100000);
  const a = F.assetRows(d, S, '2028-01')[0];
  t('折舊：60 萬、5 年，12 個月後剩 48 萬', a.monthly === 10000 && a.value === 480000, a);
}
{
  const env = makeEnv();
  env.set('reserveRate', ''); env.set('aCapital', '');
  const A = env.login(ADMIN).token;
  const dash = env.call({ action: 'dashboard', token: A });
  t('合約數字沒填時不會亂算，會列出缺哪些設定', dash.ok && dash.missing.length === 2 && dash.ledger.rows.length === 0 && dash.capital === null, dash.missing);
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
  const actions = ['logout', 'me', 'addExpense', 'addRevenue', 'addPerf', 'updateRecord', 'listMine', 'uploadVoucher', 'addBPayment', 'addRepayment', 'deleteRecord', 'restoreRecord', 'listDeleted', 'listAll', 'dashboard', 'getSettings', 'saveSettings', 'lockMonth'];
  t(`不帶 token：${actions.length} 個動作全部 UNAUTHORIZED`, actions.every(a => env.call({ action: a }).error === 'UNAUTHORIZED'));
  const M = env.login(MANAGER).token, A = env.login(ADMIN).token;
  const adminOnly = ['addBPayment', 'addRepayment', 'deleteRecord', 'restoreRecord', 'listDeleted', 'listAll', 'dashboard', 'getSettings', 'saveSettings', 'lockMonth'];
  const leaked = adminOnly.filter(a => env.call({ action: a, token: M, month: '2026-10', locked: true }).error !== 'FORBIDDEN');
  t('店長呼叫 10 個結算／管理 API 全部 FORBIDDEN（看不到結算、甲方投入、設備、出資）', leaked.length === 0, leaked);

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
  t('鎖定後 Tori 也不能刪該月（要先解鎖）', env.call({ action: 'deleteRecord', token: A, kind: 'expense', id: rec.id, reason: '測試' }).error === 'MONTH_LOCKED');

  const dash = env.call({ action: 'dashboard', token: A });
  const oct = dash.ledger.rows.find(r => r.month === '2026-10');
  t('Tori 看得到結算：10 月營收 33 萬、獎金（17.5 萬 − 5 萬）×10% = 1.25 萬', dash.ok && oct.rev === 330000 && oct.bonus === 12500, oct);
  t('設備表含店長自付的吹風機與 Tori 的裝修', dash.assets.length === 2);
  t('網頁不能改信箱名單或登入 ID', env.call({ action: 'saveSettings', token: A, settings: { adminEmails: 'hacker@x.com' } }).error === 'INVALID');
  const ss = env.call({ action: 'saveSettings', token: A, settings: { negativeRule: 'carry', reserveRate: '40' } });
  t('Tori 可以改比例與規則', ss.ok && ss.settings.reserveRate === 40 && ss.settings.negativeRule === 'carry');
  t('getSettings 不會回傳信箱或登入 ID', !JSON.stringify(env.call({ action: 'getSettings', token: A })).match(/example\.com|apps\.googleusercontent/));

  const up2 = env.call({ action: 'uploadVoucher', token: M, filename: 'r.jpg', mimeType: 'image/jpeg', data: Buffer.from('jpegdata').toString('base64') });
  t('店長可以上傳憑證照片', up2.ok && env.files.length === 1, up2);
  t('不接受照片／PDF 以外的檔案', env.call({ action: 'uploadVoucher', token: M, filename: 'x.html', mimeType: 'text/html', data: 'AA==' }).error === 'INVALID');
  // 店長唯讀查看（即時資料，網頁依鎖定標示已確認／未確認）
  {
    const env2 = makeEnv();
    const A2 = env2.login(ADMIN).token, M2 = env2.login(MANAGER).token;
    const ad = (a, r) => env2.call({ action: a, token: A2, record: r });
    ad('addExpense', { date: '2026-07-20', item: '開幕前裝修', amount: 400000, payer: 'A', nature: 'capital', cat: 'eq', life: 5 });
    ad('addRevenue', { date: '2026-09-10', amount: 200000, method: '刷卡' });
    ad('addExpense', { date: '2026-10-15', item: '十月才買的設備', amount: 50000, payer: 'A', nature: 'capital', cat: 'eq', life: 5 });
    env2.call({ action: 'lockMonth', token: A2, month: '2026-09', locked: true });
    const pv = env2.call({ action: 'partnerView', token: M2 });
    const dash = env2.call({ action: 'dashboard', token: A2 });
    t('店長看到即時資料，數字和管理者一樣（含未鎖定的 10、11 月）', pv.ok && pv.partner && JSON.stringify(pv.ledger) === JSON.stringify(dash.ledger) && pv.capital.aPaid === 450000 && pv.assets.length === 2, pv.capital && pv.capital.aPaid);
    t('回傳已鎖定月份，讓網頁標示已確認', pv.locks.join() === '2026-09');
    t('店長看到的資料不含信箱、登入 ID', !JSON.stringify(pv).match(/example\.com|googleusercontent|voucherFolder/));
    t('店長還是不能用管理者專用的動作', ['dashboard', 'lockMonth', 'saveSettings', 'deleteRecord', 'listAll'].every(a => env2.call({ action: a, token: M2 }).error === 'FORBIDDEN'));
    env2.set('reserveRate', '');
    t('合約數字沒填時，店長看到說明而不是錯的數字', env2.call({ action: 'partnerView', token: M2 }).empty === true);
  }
  // Google Sheet 把日期欄自動轉成日期值時
  {
    const env3 = makeEnv();
    const A3 = env3.login(ADMIN).token;
    const r3 = env3.call({ action: 'addExpense', token: A3, record: { date: '2026-11-03', item: '匯入的設備', amount: 60000, payer: 'A', nature: 'capital', cat: 'eq', life: 5 } }).record;
    const p3 = env3.call({ action: 'addPerf', token: A3, record: { date: '2026-10', amount: 80000 } }).record;
    const setCell = (sheet, id, col, val) => { const d = env3.sheets[sheet].data; d.find(x => x[0] === id)[d[0].indexOf(col)] = val; };
    setCell('支出', r3.id, 'date', new Date('2026-11-03T00:00:00+08:00'));
    setCell('店長個人業績', p3.id, 'date', new Date('2026-10-01T00:00:00+08:00'));
    const got = env3.call({ action: 'listAll', token: A3 }).records;
    t('Sheet 裡的日期被轉成日期值時，仍讀回 2026-11-03（修改時日期不會變空白）', got.expense.find(x => x.id === r3.id).date === '2026-11-03', got.expense[0].date);
    t('個人業績的月份也讀回 2026-10', got.perf.find(x => x.id === p3.id).date === '2026-10', got.perf[0].date);
    const as = env3.call({ action: 'dashboard', token: A3 }).assets[0];
    t('折舊照常計算', as.elapsed === 0 && as.value === 60000, as);
  }
  // 開幕前的營業紀錄受第一個月鎖定保護（測試環境合約起日 2026-08-01）
  {
    const env4 = makeEnv();
    const A4 = env4.login(ADMIN).token;
    const pre = env4.call({ action: 'addExpense', token: A4, record: { date: '2026-07-25', item: '開幕前水電', amount: 3000, payer: 'A', nature: 'advance', cat: 'c4' } }).record;
    env4.call({ action: 'lockMonth', token: A4, month: '2026-08', locked: true });
    t('第一個月鎖定後，不能再補記開幕前的營業代墊', env4.call({ action: 'addExpense', token: A4, record: { date: '2026-07-20', item: '補記', amount: 1, payer: 'A', nature: 'advance', cat: 'c4' } }).error === 'MONTH_LOCKED');
    t('也不能修改或刪除開幕前的營業代墊', env4.call({ action: 'updateRecord', token: A4, kind: 'expense', id: pre.id, patch: { amount: 1 } }).error === 'MONTH_LOCKED'
      && env4.call({ action: 'deleteRecord', token: A4, kind: 'expense', id: pre.id, reason: 'x' }).error === 'MONTH_LOCKED');
    t('開幕前的出資（設備）不受影響，照常可以新增', env4.call({ action: 'addExpense', token: A4, record: { date: '2026-07-20', item: '補記設備', amount: 1, payer: 'A', nature: 'capital', cat: 'eq' } }).ok);
  }
  // 刪除與復原
  const tmp = env.call({ action: 'addExpense', token: A, record: { date: '2026-11-02', item: '打錯的', amount: 500, payer: 'S', cat: 'c5' } }).record;
  t('刪除一定要填原因', env.call({ action: 'deleteRecord', token: A, kind: 'expense', id: tmp.id, reason: '  ' }).error === 'INVALID');
  t('填原因後可以刪除，刪除後不出現在紀錄', env.call({ action: 'deleteRecord', token: A, kind: 'expense', id: tmp.id, reason: '重複輸入' }).ok
    && !env.call({ action: 'listAll', token: A }).records.expense.some(x => x.id === tmp.id));
  const del = env.call({ action: 'listDeleted', token: A }).records.find(x => x.id === tmp.id);
  t('「已刪除」清單看得到原因、誰刪的', del && del.reason === '重複輸入' && del.deletedBy === 'tori@example.com', del);
  t('Sheet 裡資料還在（只是標記已刪除）', env.sheets['支出'].data.some(row => row[0] === tmp.id));
  t('可以復原，復原後回到紀錄', env.call({ action: 'restoreRecord', token: A, kind: 'expense', id: tmp.id }).ok
    && env.call({ action: 'listAll', token: A }).records.expense.some(x => x.id === tmp.id) && !env.call({ action: 'listDeleted', token: A }).records.some(x => x.id === tmp.id));
  const p1 = env.call({ action: 'addPerf', token: A, record: { date: '2026-11', amount: 1 } }).record;
  env.call({ action: 'deleteRecord', token: A, kind: 'perf', id: p1.id, reason: '打錯' });
  env.call({ action: 'addPerf', token: A, record: { date: '2026-11', amount: 2 } });
  t('同月已有新的個人業績時，不能復原舊的', env.call({ action: 'restoreRecord', token: A, kind: 'perf', id: p1.id }).error === 'DUPLICATE');
  const audit = env.sheets['修改歷程'].data;
  t('刪除與復原都記在修改歷程', audit.some(r => r[4] === 'delete' && r[6].includes('重複輸入')) && audit.some(r => r[4] === 'restore'));
  t('每筆新增、修改、鎖定、設定變更都寫進修改歷程', audit.length > 8 && audit.some(r => r[4] === 'lock') && audit.some(r => r[2] === 'settings'));
}

console.log(`\n${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
