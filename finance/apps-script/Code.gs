/**
 * 日和三號館 財務後台（Google Apps Script，綁定在「財務專用」的 Google Sheet 上，不分享給任何人）
 *
 * - 登入：前端用「Google 帳號登入」取得 ID token，這裡向 Google 驗證後，
 *   只接受「設定」分頁 adminEmails／managerEmails 裡的信箱，發 6 小時有效的 session token
 * - 權限全部在這裡判斷：店長只能新增支出／營收／個人業績、讀改自己的紀錄
 * - 已結算鎖定的月份不能再新增或修改；每筆新增、修改、刪除都寫進「修改歷程」
 * - 計算規則與原型一致（月結算、季結算、出資拆層、設備折舊）
 *
 * 第一次使用：在 Apps Script 編輯器執行 setup()，再到「設定」分頁填 Google 登入 ID 與兩人的 Gmail。
 */

const TOKEN_TTL_SEC = 6 * 60 * 60;
const BRANCH = 'H3'; // 日和三號館。資料表都有館別欄位，之後加一、二號館用
const VOUCHER_MAX_BYTES = 8 * 1024 * 1024;

const COST_CATS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];
const CAT_NAME = {
  c1: '店長執行業務酬金', c2: '營運系統費', c3: '現場人事費用與業績獎金', c4: '水電、電話、租金、大樓管理費',
  c5: '產品、材料成本', c6: '專屬行銷費用', c7: '雜支', eq: '設備（不列入月成本）',
};
const PAYERS = ['A', 'B', 'S']; // 公司（甲方）、店長（乙方）、店內營收
const NATURES = ['capital', 'advance']; // 算出資、算代墊
const METHODS = ['現金', '刷卡', '轉帳', '行動支付', '混合'];

const META = ['id', 'branch', 'by', 'byName', 'at', 'updatedAt', 'deleted'];
const SHEETS = {
  expense: { name: '支出', cols: ['date', 'item', 'amount', 'payer', 'nature', 'cat', 'life', 'voucherId', 'note'] },
  revenue: { name: '營收', cols: ['date', 'amount', 'method', 'note'] },
  perf:    { name: '店長個人業績', cols: ['date', 'amount', 'note'] },
  bpay:    { name: '乙方補款', cols: ['date', 'amount', 'note'] },
  repay:   { name: '代墊償還', cols: ['date', 'amount', 'to', 'note'] },
};
const LOCK_SHEET = { name: '結算鎖定', cols: ['branch', 'month', 'lockedBy', 'lockedAt'] };
const AUDIT_SHEET = { name: '修改歷程', cols: ['at', 'by', 'kind', 'recordId', 'action', 'before', 'after'] };
const SETTINGS_SHEET = '設定';

// 可在網頁「設定」頁修改的數字與規則；信箱、登入 ID 只能在 Sheet 裡改
const DEFAULT_SETTINGS = {
  contractStart: ['2026-08-01', '合約起日'],
  contractEnd: ['2031-07-31', '合約迄日'],
  bFirstDate: ['', '店長首期匯款日（合約待補）'],
  bFirstAmount: ['0', '店長首期金額（合約待補）'],
  bMonthlyStart: ['', '每月補款起始月（合約待補）'],
  reserveRate: ['50', '預備金比例 %'],
  monthlyB: ['60', '月分潤店長 %（公司取其餘）'],
  quarterThreshold: ['1000000', '季分潤門檻（元）'],
  quarterlyB: ['40', '季分潤店長 %（公司取其餘）'],
  aCapital: ['600000', '公司出資額（元）'],
  bCapital: ['400000', '店長出資額（元）'],
  defaultLife: ['5', '設備預設耐用年限（年）'],
  perfBase: ['100000', '店長基本業績（元）'],
  perfRate: ['20', '超過基本業績部分的獎金 %'],
  negativeRule: ['reserve', '月盈餘為負：reserve＝從預備金扣；carry＝累計到下月'],
  bCapExpReducesDebt: ['true', '店長自付「算出資」是否扣減店長欠公司（true／false）'],
};
const PRIVATE_SETTINGS = {
  googleClientId: ['', 'Google 登入用的用戶端 ID（…apps.googleusercontent.com）'],
  adminEmails: ['', '公司（管理者）Gmail，多個用逗號分隔'],
  managerEmails: ['', '三號館店長 Gmail，多個用逗號分隔'],
  voucherFolderId: ['', '憑證照片資料夾（setup 自動建立）'],
};
const EDITABLE_KEYS = Object.keys(DEFAULT_SETTINGS);
const NUMERIC_KEYS = ['bFirstAmount', 'reserveRate', 'monthlyB', 'quarterThreshold', 'quarterlyB', 'aCapital', 'bCapital', 'defaultLife', 'perfBase', 'perfRate'];

/* ───────────── 入口 ───────────── */

function doGet() { return json_({ ok: false, error: 'USE_POST', message: '請用 POST 呼叫' }); }

function doPost(e) {
  let req;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json_({ ok: false, error: 'BAD_REQUEST' }); }
  return json_(handle_(req));
}

function handle_(req) {
  try {
    const action = String(req.action || '');
    if (action === 'login') return login_(req.idToken);
    const user = authenticate_(req.token);
    if (!user) return { ok: false, error: 'UNAUTHORIZED', message: '未登入或登入已過期' };
    const h = ACTIONS[action];
    if (!h) return { ok: false, error: 'UNKNOWN_ACTION' };
    if (h.admin && user.role !== 'admin') return { ok: false, error: 'FORBIDDEN', message: '此帳號無權執行 ' + action };
    return h.fn(req, user);
  } catch (err) {
    console.error(err);
    return { ok: false, error: 'SERVER_ERROR', message: String(err && err.message || err) };
  }
}

const ACTIONS = {
  logout:            { fn: r => { CacheService.getScriptCache().remove('fin:' + r.token); return { ok: true }; } },
  me:                { fn: (r, u) => ({ ok: true, user: u, meta: meta_() }) },
  addExpense:        { fn: (r, u) => addRecord_('expense', r.record, u) },
  addRevenue:        { fn: (r, u) => addRecord_('revenue', r.record, u) },
  addPerf:           { fn: (r, u) => addRecord_('perf', r.record, u) },
  updateRecord:      { fn: (r, u) => updateRecord_(r.kind, r.id, r.patch, u) },
  listMine:          { fn: (r, u) => listRecords_(u, false) },
  uploadVoucher:     { fn: uploadVoucher_ },
  addBPayment:       { fn: (r, u) => addRecord_('bpay', r.record, u), admin: true },
  addRepayment:      { fn: (r, u) => addRecord_('repay', r.record, u), admin: true },
  deleteRecord:      { fn: (r, u) => deleteRecord_(r.kind, r.id, u), admin: true },
  listAll:           { fn: (r, u) => listRecords_(u, true), admin: true },
  dashboard:         { fn: dashboard_, admin: true },
  getSettings:       { fn: () => ({ ok: true, settings: settings_() }), admin: true },
  saveSettings:      { fn: saveSettings_, admin: true },
  lockMonth:         { fn: lockMonth_, admin: true },
};

/* ───────────── Google 登入 ───────────── */

function login_(idToken) {
  if (!idToken || typeof idToken !== 'string') return { ok: false, error: 'LOGIN_FAILED', message: '缺少 Google 登入資料' };
  const conf = privateSettings_();
  if (!conf.googleClientId) return { ok: false, error: 'NOT_CONFIGURED', message: '後台尚未設定 Google 登入 ID' };
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return { ok: false, error: 'LOGIN_FAILED', message: 'Google 登入驗證失敗，請重新登入' };
  const info = JSON.parse(res.getContentText());
  const issOk = info.iss === 'accounts.google.com' || info.iss === 'https://accounts.google.com';
  const fresh = Number(info.exp) * 1000 > Date.now();
  if (info.aud !== conf.googleClientId || !issOk || !fresh || String(info.email_verified) !== 'true') {
    return { ok: false, error: 'LOGIN_FAILED', message: 'Google 登入驗證失敗，請重新登入' };
  }
  const email = String(info.email).toLowerCase();
  const role = roleOf_(email, conf);
  if (!role) return { ok: false, error: 'NOT_ALLOWED', message: email + ' 沒有使用權限，請聯絡 Tori' };
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const user = { email: email, name: info.name || email, role: role };
  CacheService.getScriptCache().put('fin:' + token, JSON.stringify(user), TOKEN_TTL_SEC);
  return { ok: true, token: token, user: user, meta: meta_() };
}

/** 每次都重新比對設定分頁：從名單拿掉的信箱立刻失效 */
function authenticate_(token) {
  if (!token || typeof token !== 'string') return null;
  const raw = CacheService.getScriptCache().get('fin:' + token);
  if (!raw) return null;
  const u = JSON.parse(raw);
  const role = roleOf_(u.email, privateSettings_());
  if (!role) return null;
  u.role = role;
  return u;
}

function roleOf_(email, conf) {
  const list = s => String(s || '').toLowerCase().split(/[,，\s]+/).filter(Boolean);
  if (list(conf.adminEmails).indexOf(email) >= 0) return 'admin';
  if (list(conf.managerEmails).indexOf(email) >= 0) return 'manager';
  return null;
}

/* ───────────── 紀錄 ───────────── */

function addRecord_(kind, rec, user) {
  if (!SHEETS[kind]) return { ok: false, error: 'BAD_KIND' };
  const S = settings_();
  const r = normalize_(kind, rec || {}, S);
  const err = validate_(kind, r, user, S);
  if (err) return invalid_(err);
  return withLock_(() => {
    if (isLocked_(r.date)) return locked_(r.date);
    const t = table_(SHEETS[kind].name, META.concat(SHEETS[kind].cols));
    if (kind === 'perf' && t.rows.some(x => x.deleted !== 'true' && x.date === r.date)) {
      return { ok: false, error: 'DUPLICATE', message: r.date + ' 已經有個人業績紀錄，請修改那一筆' };
    }
    const row = Object.assign({ id: kind[0] + Utilities.getUuid().slice(0, 10), branch: BRANCH, by: user.email, byName: user.name,
      at: now_(), updatedAt: '', deleted: '' }, r);
    t.append(row);
    audit_(user, kind, row.id, 'add', null, r);
    return { ok: true, record: present_(kind, row, user) };
  });
}

function updateRecord_(kind, id, patch, user) {
  if (!SHEETS[kind]) return { ok: false, error: 'BAD_KIND' };
  const S = settings_();
  return withLock_(() => {
    const t = table_(SHEETS[kind].name, META.concat(SHEETS[kind].cols));
    const rec = t.rows.find(x => x.id === id && x.deleted !== 'true');
    if (!rec) return { ok: false, error: 'NOT_FOUND' };
    if (user.role !== 'admin' && (rec.by !== user.email || ['expense', 'revenue', 'perf'].indexOf(kind) < 0)) {
      return { ok: false, error: 'FORBIDDEN', message: '只能修改自己輸入的紀錄' };
    }
    const current = pickCols_(kind, rec);
    const next = normalize_(kind, Object.assign({}, current, patch || {}), S);
    if (isLocked_(rec.date)) return locked_(rec.date);
    if (isLocked_(next.date)) return locked_(next.date);
    const err = validate_(kind, next, user, S);
    if (err) return invalid_(err);
    const before = {}, after = {};
    SHEETS[kind].cols.forEach(k => { if (String(current[k]) !== String(next[k])) { before[k] = current[k]; after[k] = next[k]; } });
    if (!Object.keys(after).length) return { ok: true, record: present_(kind, rec, user), unchanged: true };
    if (kind === 'perf' && after.date && t.rows.some(x => x !== rec && x.deleted !== 'true' && x.date === next.date)) {
      return { ok: false, error: 'DUPLICATE', message: next.date + ' 已經有個人業績紀錄' };
    }
    after.updatedAt = now_();
    t.update(rec, after);
    delete after.updatedAt;
    audit_(user, kind, id, 'update', before, after);
    return { ok: true, record: present_(kind, rec, user) };
  });
}

function deleteRecord_(kind, id, user) {
  if (!SHEETS[kind]) return { ok: false, error: 'BAD_KIND' };
  return withLock_(() => {
    const t = table_(SHEETS[kind].name, META.concat(SHEETS[kind].cols));
    const rec = t.rows.find(x => x.id === id && x.deleted !== 'true');
    if (!rec) return { ok: false, error: 'NOT_FOUND' };
    if (isLocked_(rec.date)) return locked_(rec.date);
    t.update(rec, { deleted: 'true', updatedAt: now_() });
    audit_(user, kind, id, 'delete', pickCols_(kind, rec), null);
    return { ok: true };
  });
}

function listRecords_(user, all) {
  const out = {};
  const history = all ? auditByRecord_() : auditByRecord_(user.email);
  Object.keys(SHEETS).forEach(kind => {
    if (!all && ['expense', 'revenue', 'perf'].indexOf(kind) < 0) return;
    out[kind] = loadKind_(kind)
      .filter(r => all || r.by === user.email)
      .map(r => Object.assign(present_(kind, r, user), { history: history[r.id] || [] }));
  });
  return { ok: true, records: out, locks: locks_() };
}

function normalize_(kind, r, S) {
  const o = {};
  SHEETS[kind].cols.forEach(k => { o[k] = r[k] === undefined || r[k] === null ? '' : String(r[k]).trim(); });
  o.amount = String(Math.round(Number(o.amount) || 0));
  if (kind === 'expense') {
    if (o.payer === 'S') o.nature = '';
    if (o.cat === 'eq') o.life = String(Math.max(1, Math.round(Number(o.life) || Number(S.defaultLife))));
    else o.life = '';
    o.item = o.item.slice(0, 200);
  }
  if ('note' in o) o.note = o.note.slice(0, 500);
  return o;
}

function validate_(kind, r, user, S) {
  const isDate = /^\d{4}-\d{2}-\d{2}$/.test(r.date);
  if (kind === 'perf' ? !/^\d{4}-\d{2}$/.test(r.date) : !isDate) return '請填正確的日期';
  if (!(Number(r.amount) > 0)) return '金額要大於 0';
  if (kind === 'expense') {
    if (!r.item) return '請填項目';
    if (!CAT_NAME[r.cat]) return '請選科目';
    if (PAYERS.indexOf(r.payer) < 0) return '請選誰付的';
    if (user.role !== 'admin' && r.payer === 'A') return '店長帳號不能登記公司付款';
    if (r.payer !== 'S' && NATURES.indexOf(r.nature) < 0) return '自己付的支出要選「算出資」或「算代墊」';
    if (r.nature === 'capital' && !(r.cat === 'eq' || r.date < S.contractStart)) {
      return '「算出資」只能用在設備，或合約起日（' + S.contractStart + '）以前的前期支出；這筆請選「算代墊」';
    }
  }
  if (kind === 'revenue' && METHODS.indexOf(r.method) < 0) return '請選付款方式';
  if (kind === 'repay' && ['甲方', '乙方'].indexOf(r.to) < 0) return '請選償還給誰'; // 存的值維持 甲方／乙方，畫面顯示 公司／店長
  return null;
}

/** 店長看不到 Drive 連結；管理者看得到（檔案只有 Tori 能開） */
function present_(kind, r, user) {
  const o = { id: r.id, by: r.by, byName: r.byName, at: r.at, updatedAt: r.updatedAt };
  SHEETS[kind].cols.forEach(k => { o[k] = r[k]; });
  o.amount = Number(r.amount);
  if (kind === 'expense') {
    o.life = r.life ? Number(r.life) : '';
    o.hasVoucher = !!r.voucherId;
    if (user.role === 'admin' && r.voucherId) o.voucherUrl = 'https://drive.google.com/file/d/' + r.voucherId + '/view';
    delete o.voucherId;
  }
  return o;
}

/* ───────────── 憑證照片 ───────────── */

function uploadVoucher_(r, user) {
  const mime = String(r.mimeType || '');
  if (!/^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/.test(mime)) return invalid_('只接受照片或 PDF');
  const bytes = Utilities.base64Decode(String(r.data || ''));
  if (!bytes.length) return invalid_('檔案是空的');
  if (bytes.length > VOUCHER_MAX_BYTES) return invalid_('檔案太大（上限 8 MB）');
  const conf = privateSettings_();
  const folder = DriveApp.getFolderById(conf.voucherFolderId);
  const name = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd-HHmmss') + '-' + String(r.filename || 'voucher').replace(/[^\w.\-一-鿿]/g, '_').slice(0, 60);
  const file = folder.createFile(Utilities.newBlob(bytes, mime, name));
  file.setDescription('上傳者：' + user.email);
  return { ok: true, voucherId: file.getId() };
}

/* ───────────── 結算 ───────────── */

function dashboard_() {
  const S = settings_();
  const data = loadAll_();
  const cur = thisMonth_();
  const L = computeLedger(data, S, cur, cur);
  return {
    ok: true, settings: S, currentMonth: cur, locks: locks_(),
    ledger: L, capital: capitalSummary(data, S, L.offsetsCum), assets: assetRows(data, S, cur),
    byCatPayer: byCatPayer_(data),
  };
}

function byCatPayer_(data) {
  const out = {};
  COST_CATS.concat(['eq']).forEach(c => { out[c] = { A: 0, B: 0, S: 0 }; });
  data.expenses.forEach(e => { if (out[e.cat] && out[e.cat][e.payer] !== undefined) out[e.cat][e.payer] += e.amount; });
  return out;
}

function lockMonth_(r, user) {
  const m = String(r.month || '');
  if (!/^\d{4}-\d{2}$/.test(m)) return invalid_('月份格式錯誤');
  if (r.locked && m >= thisMonth_()) return invalid_('本月還沒結束，不能鎖定');
  return withLock_(() => {
    const t = table_(LOCK_SHEET.name, LOCK_SHEET.cols);
    const row = t.rows.find(x => x.branch === BRANCH && x.month === m);
    if (r.locked && !row) t.append({ branch: BRANCH, month: m, lockedBy: user.email, lockedAt: now_() });
    if (!r.locked && row) t.remove(row);
    audit_(user, 'lock', m, r.locked ? 'lock' : 'unlock', null, null);
    return { ok: true, locks: locks_() };
  });
}

function saveSettings_(r, user) {
  const patch = r.settings || {};
  const bad = Object.keys(patch).filter(k => EDITABLE_KEYS.indexOf(k) < 0);
  if (bad.length) return invalid_('不能從網頁修改：' + bad.join('、'));
  const clean = {};
  for (const k of Object.keys(patch)) {
    let v = String(patch[k]).trim();
    if (NUMERIC_KEYS.indexOf(k) >= 0) { if (v !== '' && !isFinite(Number(v))) return invalid_(k + ' 要是數字'); v = String(Number(v) || 0); }
    if (k === 'negativeRule' && ['reserve', 'carry'].indexOf(v) < 0) return invalid_('負盈餘規則錯誤');
    if (k === 'bCapExpReducesDebt') v = String(v === 'true');
    if (/Date|contract/.test(k) && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return invalid_(k + ' 日期格式錯誤');
    if (k === 'bMonthlyStart' && v && !/^\d{4}-\d{2}$/.test(v)) return invalid_('補款起始月格式錯誤');
    clean[k] = v;
  }
  return withLock_(() => {
    const sh = SpreadsheetApp.getActive().getSheetByName(SETTINGS_SHEET);
    const values = sh.getDataRange().getValues();
    const before = {};
    Object.keys(clean).forEach(k => {
      const i = values.findIndex(row => row[0] === k);
      if (i < 0) sh.appendRow([k, clean[k], DEFAULT_SETTINGS[k][1]]);
      else { before[k] = String(values[i][1]); sh.getRange(i + 1, 2).setValue(clean[k]); }
    });
    audit_(user, 'settings', '', 'update', before, clean);
    return { ok: true, settings: settings_() };
  });
}

/* ───────────── 計算核心（與原型相同，測試直接呼叫） ───────────── */

function computeLedger(data, S, upto, completeBefore) {
  const months = monthRange_(S.contractStart.slice(0, 7), upto);
  let reserve = 0, carry = 0, offsetsCum = 0;
  const rows = [], quarters = [];
  months.forEach(m => {
    const rev = sum_(data.revenues.filter(r => r.date.slice(0, 7) === m), r => r.amount);
    const byCat = {};
    COST_CATS.forEach(c => { byCat[c] = 0; });
    data.expenses.filter(e => e.date.slice(0, 7) === m && e.cat !== 'eq').forEach(e => { byCat[e.cat] += e.amount; });
    const perf = sum_(data.perf.filter(p => p.date.slice(0, 7) === m), p => p.amount);
    const bonus = perfBonus_(perf, S);
    byCat.c3 += bonus;
    const cost = sum_(COST_CATS, c => byCat[c]);
    const surplus = rev - cost;
    const carryIn = S.negativeRule === 'carry' ? carry : 0;
    const eff = surplus + carryIn;
    let reserveAdd = 0, b = 0, a = 0;
    if (eff >= 0) { reserveAdd = eff * S.reserveRate / 100; const rest = eff - reserveAdd; b = rest * S.monthlyB / 100; a = rest - b; carry = 0; }
    else if (S.negativeRule === 'carry') { carry = eff; }
    else { reserveAdd = eff; carry = 0; }
    reserve += reserveAdd;
    const row = { month: m, perf: perf, bonus: bonus, rev: rev, byCat: byCat, cost: cost, surplus: surplus, carryIn: carryIn, eff: eff,
      reserveAdd: reserveAdd, b: b, a: a, reserveAfter: reserve, carryOut: S.negativeRule === 'carry' ? carry : 0, quarter: null };
    rows.push(row);
    const mm = Number(m.slice(5));
    if (mm % 3 === 0 && (!completeBefore || m < completeBefore)) {
      const end = m + '-31';
      const bPaid = sum_(data.bPayments.filter(p => p.date <= end), p => p.amount);
      const bCapExp = sum_(data.expenses.filter(e => e.payer === 'B' && e.nature === 'capital' && e.date <= end), e => e.amount);
      const aPaidEnd = sum_(data.expenses.filter(e => e.payer === 'A' && e.nature !== 'advance' && e.date <= end), e => e.amount);
      const gap = Math.max(0, S.bCapital + extraShareB_(aPaidEnd, S) - bPaid - bCapExp - offsetsCum);
      const excess = Math.max(0, reserve - S.quarterThreshold);
      const qB = excess * S.quarterlyB / 100, qA = excess - qB, offset = Math.min(qB, gap);
      offsetsCum += offset;
      const q = { label: m.slice(0, 4) + ' Q' + (mm / 3), endMonth: m, reserveBefore: reserve, excess: excess, qB: qB, qA: qA,
        offset: offset, bCash: qB - offset, gapBefore: gap, reserveAfter: reserve - excess };
      reserve -= excess; row.reserveAfter = reserve; row.quarter = q; quarters.push(q);
    }
  });
  return { rows: rows, quarters: quarters, reserve: reserve, offsetsCum: offsetsCum, carry: carry };
}

function capitalSummary(data, S, offsets) {
  const exp = data.expenses;
  const aPaid = sum_(exp.filter(e => e.payer === 'A' && e.nature !== 'advance'), e => e.amount);
  const aAdv = sum_(exp.filter(e => e.payer === 'A' && e.nature === 'advance'), e => e.amount);
  const repaidA = sum_(data.repayments.filter(r => r.to === '甲方'), r => r.amount);
  const tierA = Math.min(aPaid, S.aCapital);
  const tierB = Math.min(Math.max(aPaid - S.aCapital, 0), S.bCapital);
  const tierX = Math.max(aPaid - S.aCapital - S.bCapital, 0);
  const bPaid = sum_(data.bPayments, p => p.amount);
  const bCapExp = sum_(exp.filter(e => e.payer === 'B' && e.nature === 'capital'), e => e.amount);
  const bAdv = sum_(exp.filter(e => e.payer === 'B' && e.nature === 'advance'), e => e.amount);
  const repaid = sum_(data.repayments.filter(r => r.to !== '甲方'), r => r.amount);
  const xB = extraShareB_(aPaid, S), xA = tierX - xB, bTarget = S.bCapital + xB;
  const progress = Math.min(bTarget, bPaid + offsets + bCapExp);
  const bOwesA = Math.max(0, tierB + xB - bPaid - offsets - (S.bCapExpReducesDebt ? bCapExp : 0));
  return { aPaid: aPaid, tierA: tierA, tierB: tierB, tierX: tierX, xA: xA, xB: xB, bTarget: bTarget, bPaid: bPaid, bCapExp: bCapExp,
    bAdv: bAdv, repaid: repaid, aAdv: aAdv, repaidA: repaidA, offsets: offsets, progress: progress, bOwesA: bOwesA,
    storeOwesB: Math.max(0, bAdv - repaid), storeOwesA: Math.max(0, aAdv - repaidA),
    paidBy: { A: sum_(exp.filter(e => e.payer === 'A'), e => e.amount), B: sum_(exp.filter(e => e.payer === 'B'), e => e.amount), S: sum_(exp.filter(e => e.payer === 'S'), e => e.amount) } };
}

function assetRows(data, S, asOf) {
  return data.expenses.filter(e => e.cat === 'eq').map(e => {
    const life = Number(e.life) || S.defaultLife, monthly = e.amount / (life * 12);
    const elapsed = Math.max(0, Math.min(life * 12, monthsDiff_(e.date.slice(0, 7), asOf)));
    return { id: e.id, date: e.date, item: e.item, payer: e.payer, nature: e.nature, amount: e.amount, life: life, monthly: monthly,
      elapsed: elapsed, value: Math.max(0, e.amount - monthly * elapsed) };
  });
}

function extraShareB_(aPaid, S) { return Math.max(0, aPaid - S.aCapital - S.bCapital) * S.bCapital / (S.aCapital + S.bCapital); }
function perfBonus_(amount, S) { return Math.max(0, amount - S.perfBase) * S.perfRate / 100; }

/* ───────────── 初始化（在編輯器手動執行一次） ───────────── */

function setup() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SETTINGS_SHEET);
  if (!sh) sh = ss.insertSheet(SETTINGS_SHEET, 0);
  if (sh.getLastRow() === 0) sh.appendRow(['key', 'value', '說明']);
  const existing = sh.getDataRange().getValues().map(r => r[0]);
  const all = Object.assign({}, PRIVATE_SETTINGS, DEFAULT_SETTINGS);
  Object.keys(all).forEach(k => { if (existing.indexOf(k) < 0) sh.appendRow([k, all[k][0], all[k][1]]); });
  sh.getRange('B:B').setNumberFormat('@');
  sh.setFrozenRows(1);
  Object.keys(SHEETS).forEach(kind => table_(SHEETS[kind].name, META.concat(SHEETS[kind].cols), true));
  table_(LOCK_SHEET.name, LOCK_SHEET.cols, true);
  table_(AUDIT_SHEET.name, AUDIT_SHEET.cols, true);
  const conf = privateSettings_();
  if (!conf.voucherFolderId) {
    const folder = DriveApp.createFolder('日和三號館 財務憑證');
    setPrivate_('voucherFolderId', folder.getId());
    Logger.log('已建立憑證資料夾：' + folder.getUrl());
  }
  UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=check', { muteHttpExceptions: true }); // 讓授權畫面一次問完
  Logger.log('完成。請到「設定」分頁填 googleClientId、adminEmails、managerEmails。');
}

/* ───────────── 資料存取與工具 ───────────── */

function loadKind_(kind) {
  return table_(SHEETS[kind].name, META.concat(SHEETS[kind].cols)).rows
    .filter(r => r.deleted !== 'true' && (r.branch || BRANCH) === BRANCH)
    .map(r => Object.assign({}, r, { amount: Number(r.amount) || 0 }));
}
function loadAll_() {
  return { expenses: loadKind_('expense'), revenues: loadKind_('revenue'), perf: loadKind_('perf'), bPayments: loadKind_('bpay'), repayments: loadKind_('repay') };
}
function pickCols_(kind, r) { const o = {}; SHEETS[kind].cols.forEach(k => { o[k] = r[k]; }); return o; }

function settings_() {
  const raw = readSettings_();
  const S = {};
  Object.keys(DEFAULT_SETTINGS).forEach(k => { S[k] = raw[k] !== undefined && raw[k] !== '' ? raw[k] : DEFAULT_SETTINGS[k][0]; });
  NUMERIC_KEYS.forEach(k => { S[k] = Number(S[k]) || 0; });
  S.bCapExpReducesDebt = String(S.bCapExpReducesDebt) === 'true';
  return S;
}
function privateSettings_() {
  const raw = readSettings_();
  const o = {};
  Object.keys(PRIVATE_SETTINGS).forEach(k => { o[k] = String(raw[k] || '').trim(); });
  return o;
}
function readSettings_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SETTINGS_SHEET);
  if (!sh) throw new Error('找不到「設定」分頁，請先執行 setup()');
  const o = {};
  sh.getDataRange().getValues().slice(1).forEach(r => { if (r[0]) o[String(r[0])] = String(r[1]); });
  return o;
}
function setPrivate_(k, v) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SETTINGS_SHEET);
  const values = sh.getDataRange().getValues();
  const i = values.findIndex(r => r[0] === k);
  if (i < 0) sh.appendRow([k, v, (PRIVATE_SETTINGS[k] || [''])[1]]); else sh.getRange(i + 1, 2).setValue(v);
}
function meta_() {
  return { branch: BRANCH, branchName: '日和三號館', currentMonth: thisMonth_(), contractStart: settings_().contractStart, catName: CAT_NAME, methods: METHODS, defaultLife: settings_().defaultLife, perfBase: settings_().perfBase, perfRate: settings_().perfRate, locks: locks_() };
}
function locks_() {
  return table_(LOCK_SHEET.name, LOCK_SHEET.cols).rows.filter(r => r.branch === BRANCH).map(r => r.month);
}
function isLocked_(date) { return locks_().indexOf(String(date).slice(0, 7)) >= 0; }
function locked_(date) { return { ok: false, error: 'MONTH_LOCKED', message: String(date).slice(0, 7) + ' 已結算鎖定，請 Tori 先解鎖' }; }

function audit_(user, kind, id, action, before, after) {
  table_(AUDIT_SHEET.name, AUDIT_SHEET.cols).append({ at: now_(), by: user.email, kind: kind, recordId: id, action: action,
    before: before ? JSON.stringify(before) : '', after: after ? JSON.stringify(after) : '' });
}
function auditByRecord_(onlyBy) {
  const out = {};
  table_(AUDIT_SHEET.name, AUDIT_SHEET.cols).rows.forEach(a => {
    if (a.action !== 'update') return;
    if (onlyBy && a.by !== onlyBy) return;
    (out[a.recordId] = out[a.recordId] || []).push({ at: a.at, by: a.by, before: JSON.parse(a.before || '{}'), after: JSON.parse(a.after || '{}') });
  });
  return out;
}

function table_(name, cols, create) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    if (!create) throw new Error('找不到工作表「' + name + '」，請先執行 setup()');
    sh = ss.insertSheet(name);
  }
  if (sh.getLastRow() === 0) { sh.appendRow(cols); sh.setFrozenRows(1); sh.getRange('A:Z').setNumberFormat('@'); }
  const values = sh.getDataRange().getValues();
  const header = values[0];
  const rows = values.slice(1).map((v, i) => {
    const o = {};
    header.forEach((h, j) => { o[h] = v[j] === undefined || v[j] === null ? '' : String(v[j]); });
    Object.defineProperty(o, '_row', { value: i + 2, writable: true, enumerable: false });
    return o;
  });
  return {
    rows: rows,
    append(obj) {
      sh.appendRow(header.map(h => obj[h] === undefined ? '' : String(obj[h])));
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

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return fn(); } finally { lock.releaseLock(); }
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function invalid_(msg) { return { ok: false, error: 'INVALID', message: msg }; }
function now_() { return new Date().toISOString(); }
function thisMonth_() { return Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM'); }
function sum_(a, f) { return a.reduce((t, x) => t + (f ? f(x) : x), 0); }
function monthRange_(a, b) {
  const o = [];
  let y = Number(a.slice(0, 4)), m = Number(a.slice(5, 7));
  const ey = Number(b.slice(0, 4)), em = Number(b.slice(5, 7));
  while (y < ey || (y === ey && m <= em)) { o.push(y + '-' + String(m).padStart(2, '0')); if (++m > 12) { m = 1; y++; } }
  return o;
}
function monthsDiff_(a, b) { return (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7))); }
