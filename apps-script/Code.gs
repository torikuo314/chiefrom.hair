/**
 * 頭沐 chiefrom.hair 任務系統後台（Google Apps Script，綁定在 Google Sheet 上）
 *
 * 安全原則：所有權限都在這裡判斷，前端只負責顯示。
 * - 登入：成員 ID ＋ PIN 送到後台核對，成功後發 6 小時有效的 session token
 * - PIN 以「加鹽 ＋ 伺服器密鑰」雜湊儲存，永遠不回傳給前端
 * - 同一帳號連續錯 5 次鎖 15 分鐘；PIN 至少 6 位數
 * - 成員管理、重設 PIN、刪除任務只限管理者 token
 * - 只接受 POST（text/plain 傳 JSON，避開 CORS 預檢）
 *
 * 第一次使用：在 Apps Script 編輯器執行 setup()，到「執行記錄」看管理者初始 PIN。
 */

const TOKEN_TTL_SEC = 6 * 60 * 60;   // CacheService 上限就是 6 小時
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const PIN_RE = /^\d{6,12}$/;
const ADMIN_ID = '__admin__';

const SHEETS = {
  Members:  ['id', 'name', 'color', 'role', 'pinHash', 'salt', 'failCount', 'lockUntil', 'tokenVer', 'updatedAt'],
  Tasks:    ['id', 'title', 'desc', 'category', 'priority', 'status', 'assignee', 'due', 'assigneeDue', 'createdBy', 'createdAt', 'updatedAt'],
  Comments: ['id', 'taskId', 'author', 'content', 'createdAt'],
};
const PUBLIC_MEMBER_FIELDS = ['id', 'name', 'color', 'role'];
const TASK_META_FIELDS = ['title', 'desc', 'category', 'priority', 'due'];
const TASK_PROGRESS_FIELDS = ['status', 'assignee', 'assigneeDue'];
const ENUMS = {
  category: ['ops', 'brand', 'product', 'hr', 'other'],
  priority: ['high', 'mid', 'low'],
  status: ['todo', 'doing', 'review', 'done', 'hold'],
};

/* ───────────── 入口 ───────────── */

function doGet() {
  return json_({ ok: false, error: 'USE_POST', message: '請用 POST 呼叫' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'BAD_REQUEST', message: '格式錯誤' });
  }
  return json_(handle_(req));
}

/** 不經 HTTP 的處理函式，測試也呼叫這個 */
function handle_(req) {
  try {
    const action = String(req.action || '');
    if (action === 'publicMembers') return { ok: true, data: listMembersPublic_() };
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
  logout:        { fn: (r, u) => { CacheService.getScriptCache().remove('tok:' + r.token); return { ok: true }; } },
  listMembers:   { fn: () => ({ ok: true, data: listMembersPublic_() }) },
  listTasks:     { fn: listTasks_ },
  addTask:       { fn: addTask_ },
  updateTask:    { fn: updateTask_ },
  deleteTask:    { fn: deleteTask_, admin: true },
  listComments:  { fn: listComments_ },
  addComment:    { fn: addComment_ },
  deleteComment: { fn: deleteComment_ },
  addMember:     { fn: addMember_, admin: true },
  updateMember:  { fn: updateMember_, admin: true },
  resetPin:      { fn: resetPin_, admin: true },
  removeMember:  { fn: removeMember_, admin: true },
};

/* ───────────── 登入與 token ───────────── */

function login_(memberId, pin) {
  return withLock_(() => {
    const t = table_('Members');
    const m = t.rows.find(r => r.id === String(memberId || ''));
    const fail = { ok: false, error: 'LOGIN_FAILED', message: '帳號或 PIN 不正確' };
    if (!m) return fail;
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
    CacheService.getScriptCache().put('tok:' + token,
      JSON.stringify({ id: m.id, ver: String(m.tokenVer || '0') }), TOKEN_TTL_SEC);
    return { ok: true, token: token, user: pick_(m, PUBLIC_MEMBER_FIELDS), expiresIn: TOKEN_TTL_SEC };
  });
}

/** 每次都回頭查成員表：被移除、改 PIN 或改角色會立刻生效 */
function authenticate_(token) {
  if (!token || typeof token !== 'string') return null;
  const raw = CacheService.getScriptCache().get('tok:' + token);
  if (!raw) return null;
  const s = JSON.parse(raw);
  const m = table_('Members').rows.find(r => r.id === s.id);
  if (!m || String(m.tokenVer || '0') !== s.ver) return null;
  return pick_(m, PUBLIC_MEMBER_FIELDS);
}

function hashPin_(pin, salt) {
  const pepper = getPepper_();
  let h = pin + ':' + salt;
  for (let i = 0; i < 200; i++) {
    h = Utilities.base64Encode(Utilities.computeHmacSha256Signature(h, pepper));
  }
  return h;
}

function getPepper_() {
  const props = PropertiesService.getScriptProperties();
  let p = props.getProperty('PIN_PEPPER');
  if (!p) {
    p = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('PIN_PEPPER', p);
  }
  return p;
}

function newSalt_() { return Utilities.getUuid().replace(/-/g, ''); }

/* ───────────── 成員 ───────────── */

function listMembersPublic_() {
  return table_('Members').rows.map(m => pick_(m, PUBLIC_MEMBER_FIELDS));
}

function addMember_(r) {
  const name = clean_(r.name, 20);
  if (!name) return invalid_('請填名稱');
  if (!PIN_RE.test(String(r.pin || ''))) return invalid_('PIN 需為 6–12 位數字');
  return withLock_(() => {
    const t = table_('Members');
    if (t.rows.some(m => m.name === name)) return invalid_('名稱已存在');
    const salt = newSalt_();
    const row = {
      id: 'm' + Utilities.getUuid().slice(0, 8), name: name, color: color_(r.color), role: 'member',
      pinHash: hashPin_(String(r.pin), salt), salt: salt, failCount: 0, lockUntil: '', tokenVer: '1', updatedAt: now_(),
    };
    t.append(row);
    return { ok: true, data: pick_(row, PUBLIC_MEMBER_FIELDS) };
  });
}

function updateMember_(r) {
  return withLock_(() => {
    const t = table_('Members');
    const m = t.rows.find(x => x.id === r.id);
    if (!m) return { ok: false, error: 'NOT_FOUND' };
    const patch = { updatedAt: now_() };
    if (r.name !== undefined) {
      const name = clean_(r.name, 20);
      if (!name) return invalid_('請填名稱');
      if (t.rows.some(x => x.name === name && x.id !== m.id)) return invalid_('名稱已存在');
      patch.name = name;
    }
    if (r.color !== undefined) patch.color = color_(r.color);
    const oldName = m.name;
    t.update(m, patch);
    // 任務與留言用名字記錄負責人／建立人，改名時一起更新
    if (patch.name && patch.name !== oldName) renameEverywhere_(oldName, patch.name);
    return { ok: true, data: pick_(m, PUBLIC_MEMBER_FIELDS) };
  });
}

function resetPin_(r) {
  if (!PIN_RE.test(String(r.pin || ''))) return invalid_('PIN 需為 6–12 位數字');
  return withLock_(() => {
    const t = table_('Members');
    const m = t.rows.find(x => x.id === r.id);
    if (!m) return { ok: false, error: 'NOT_FOUND' };
    const salt = newSalt_();
    t.update(m, {
      pinHash: hashPin_(String(r.pin), salt), salt: salt, failCount: 0, lockUntil: '',
      tokenVer: String(Number(m.tokenVer || 0) + 1), updatedAt: now_(),
    });
    return { ok: true };
  });
}

function removeMember_(r) {
  if (r.id === ADMIN_ID) return invalid_('不能移除管理者');
  return withLock_(() => {
    const t = table_('Members');
    const m = t.rows.find(x => x.id === r.id);
    if (!m) return { ok: false, error: 'NOT_FOUND' };
    t.remove(m);
    return { ok: true };
  });
}

function renameEverywhere_(oldName, newName) {
  const tasks = table_('Tasks');
  tasks.rows.forEach(x => {
    const p = {};
    if (x.assignee === oldName) p.assignee = newName;
    if (x.createdBy === oldName) p.createdBy = newName;
    if (Object.keys(p).length) tasks.update(x, p);
  });
  const cm = table_('Comments');
  cm.rows.forEach(x => { if (x.author === oldName) cm.update(x, { author: newName }); });
}

/* ───────────── 任務 ───────────── */

function listTasks_() {
  const counts = {};
  table_('Comments').rows.forEach(c => { counts[c.taskId] = (counts[c.taskId] || 0) + 1; });
  const data = table_('Tasks').rows
    .map(t => Object.assign(pick_(t, SHEETS.Tasks), { commentCount: counts[t.id] || 0 }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return { ok: true, data: data };
}

function addTask_(r, user) {
  const title = clean_(r.title, 200);
  if (!title) return invalid_('請填任務名稱');
  const row = {
    id: 't' + Utilities.getUuid().slice(0, 12), title: title, desc: clean_(r.desc, 2000),
    category: enum_('category', r.category, 'ops'), priority: enum_('priority', r.priority, 'mid'),
    status: enum_('status', r.status, 'todo'), assignee: memberName_(r.assignee),
    due: date_(r.due), assigneeDue: date_(r.assigneeDue),
    createdBy: user.name, createdAt: now_(), updatedAt: now_(),
  };
  return withLock_(() => { table_('Tasks').append(row); return { ok: true, data: row }; });
}

function updateTask_(r, user) {
  return withLock_(() => {
    const t = table_('Tasks');
    const task = t.rows.find(x => x.id === r.id);
    if (!task) return { ok: false, error: 'NOT_FOUND' };
    const isAdmin = user.role === 'admin';
    const isCreator = task.createdBy === user.name;
    const isOwner = task.assignee === user.name;
    const allowed = (isAdmin || isCreator) ? TASK_META_FIELDS.concat(TASK_PROGRESS_FIELDS)
      : isOwner ? TASK_PROGRESS_FIELDS : [];
    if (!allowed.length) return { ok: false, error: 'FORBIDDEN', message: '只有建立者、負責人或管理者可以修改' };
    const patch = {};
    const denied = [];
    Object.keys(r).forEach(k => {
      if (k === 'action' || k === 'token' || k === 'id') return;
      if (SHEETS.Tasks.indexOf(k) < 0) return;
      if (String(r[k] ?? '') === String(task[k] ?? '')) return;
      if (allowed.indexOf(k) < 0) { denied.push(k); return; }
      patch[k] = sanitizeTaskField_(k, r[k]);
    });
    if (denied.length) return { ok: false, error: 'FORBIDDEN', message: '沒有權限修改：' + denied.join('、') };
    if (patch.title === '') return invalid_('任務名稱不能空白');
    if (Object.keys(patch).length) { patch.updatedAt = now_(); t.update(task, patch); }
    return { ok: true, data: pick_(task, SHEETS.Tasks) };
  });
}

function sanitizeTaskField_(k, v) {
  if (ENUMS[k]) return enum_(k, v, ENUMS[k][0]);
  if (k === 'due' || k === 'assigneeDue') return date_(v);
  if (k === 'assignee') return memberName_(v);
  return clean_(v, k === 'desc' ? 2000 : 200);
}

function deleteTask_(r) {
  return withLock_(() => {
    const t = table_('Tasks');
    const task = t.rows.find(x => x.id === r.id);
    if (!task) return { ok: false, error: 'NOT_FOUND' };
    t.remove(task);
    const cm = table_('Comments');
    cm.rows.filter(c => c.taskId === task.id).forEach(c => cm.remove(c));
    return { ok: true };
  });
}

/* ───────────── 留言 ───────────── */

function listComments_(r) {
  const data = table_('Comments').rows.filter(c => c.taskId === r.taskId)
    .map(c => pick_(c, SHEETS.Comments))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return { ok: true, data: data };
}

function addComment_(r, user) {
  const content = clean_(r.content, 2000);
  if (!content) return invalid_('留言不能空白');
  if (!table_('Tasks').rows.some(t => t.id === r.taskId)) return { ok: false, error: 'NOT_FOUND' };
  const row = { id: 'c' + Utilities.getUuid().slice(0, 12), taskId: r.taskId, author: user.name, content: content, createdAt: now_() };
  return withLock_(() => { table_('Comments').append(row); return { ok: true, data: row }; });
}

function deleteComment_(r, user) {
  return withLock_(() => {
    const cm = table_('Comments');
    const c = cm.rows.find(x => x.id === r.id);
    if (!c) return { ok: false, error: 'NOT_FOUND' };
    const task = table_('Tasks').rows.find(t => t.id === c.taskId);
    const ok = user.role === 'admin' || c.author === user.name || (task && task.createdBy === user.name);
    if (!ok) return { ok: false, error: 'FORBIDDEN', message: '只能刪除自己的留言' };
    cm.remove(c);
    return { ok: true };
  });
}

/* ───────────── 初始化（在編輯器手動執行一次） ───────────── */

function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(SHEETS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) sh.appendRow(SHEETS[name]);
    sh.setFrozenRows(1);
  });
  // 所有欄位存成純文字，避免日期、PIN 雜湊被 Sheets 自動轉格式
  Object.keys(SHEETS).forEach(name => ss.getSheetByName(name).getRange('A:Z').setNumberFormat('@'));
  const t = table_('Members');
  if (!t.rows.some(m => m.id === ADMIN_ID)) {
    const pin = String(Math.floor(10000000 + Math.random() * 90000000));
    const salt = newSalt_();
    t.append({ id: ADMIN_ID, name: '管理者', color: '#2A2018', role: 'admin', pinHash: hashPin_(pin, salt), salt: salt,
      failCount: 0, lockUntil: '', tokenVer: '1', updatedAt: now_() });
    Logger.log('管理者初始 PIN：' + pin + '（登入後請到「管理成員」改成自己的 PIN）');
  } else {
    Logger.log('管理者帳號已存在，沒有變更。');
  }
}

/** 忘記管理者 PIN 時，在編輯器執行這個（只有能開這份 Sheet 的人做得到） */
function resetAdminPinFromEditor() {
  const pin = String(Math.floor(10000000 + Math.random() * 90000000));
  const r = resetPin_({ id: ADMIN_ID, pin: pin });
  Logger.log(r.ok ? '管理者新 PIN：' + pin : '失敗：' + JSON.stringify(r));
}

/* ───────────── 工具 ───────────── */

function table_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('找不到工作表 ' + name + '，請先執行 setup()');
  const values = sh.getDataRange().getValues();
  const header = values[0] || SHEETS[name];
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
      const idx = rows.indexOf(obj);
      rows.splice(idx, 1);
      rows.forEach(r => { if (r._row > obj._row) r._row -= 1; });
    },
  };
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function pick_(o, keys) { const r = {}; keys.forEach(k => { r[k] = o[k] === undefined ? '' : o[k]; }); return r; }
function invalid_(msg) { return { ok: false, error: 'INVALID', message: msg }; }
function now_() { return new Date().toISOString(); }
function clean_(v, max) { return String(v ?? '').trim().slice(0, max); }
function enum_(k, v, d) { return ENUMS[k].indexOf(v) >= 0 ? v : d; }
function date_(v) { v = String(v || ''); return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ''; }
function color_(v) { v = String(v || ''); return /^#[0-9a-fA-F]{6}$/.test(v) ? v : '#8A8078'; }
function memberName_(v) {
  v = String(v || '');
  if (!v) return '';
  return table_('Members').rows.some(m => m.name === v && m.id !== ADMIN_ID) ? v : '';
}
