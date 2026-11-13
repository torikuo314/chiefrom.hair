// 在 Node 裡模擬 Apps Script 環境，跑 Code.gs 的驗收測試：node apps-script/test/backend.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function makeEnv() {
  const sheets = {};
  const sheet = name => {
    const data = [];
    return {
      name, data,
      getLastRow: () => data.length,
      appendRow: row => data.push(row.slice()),
      setFrozenRows() {},
      getRange: (a, c) => typeof a === 'string'
        ? { setNumberFormat() {} }
        : { setValue: v => { data[a - 1][c - 1] = v; } },
      getDataRange: () => ({ getValues: () => data.map(r => r.slice()) }),
      deleteRow: r => data.splice(r - 1, 1),
    };
  };
  const cache = new Map();
  const props = new Map();
  const logs = [];
  const ctx = {
    console,
    SpreadsheetApp: { getActive: () => ({
      getSheetByName: n => sheets[n] || null,
      insertSheet: n => (sheets[n] = sheet(n)),
    }) },
    CacheService: { getScriptCache: () => ({
      get: k => cache.has(k) ? cache.get(k) : null,
      put: (k, v) => cache.set(k, v),
      remove: k => cache.delete(k),
    }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => props.get(k) || null,
      setProperty: (k, v) => props.set(k, v),
    }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      computeHmacSha256Signature: (v, k) => [...crypto.createHmac('sha256', k).update(v).digest()],
      base64Encode: b => Buffer.from(b).toString('base64'),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Logger: { log: m => logs.push(m) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ setMimeType: () => ({ body: s }) }) },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8') + '\nthis.__h=handle_;this.__setup=setup;', ctx);
  ctx.__setup();
  const adminPin = logs.join('\n').match(/PIN：(\d+)/)[1];
  return { call: req => JSON.parse(JSON.stringify(ctx.__h(req))), sheets, adminPin, http: req => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(req) } }).body), get: () => JSON.parse(ctx.doGet().body) };
}

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  → ' + JSON.stringify(detail) : '')); }
};

const env = makeEnv();
const A = env.call({ action: 'login', memberId: '__admin__', pin: env.adminPin });
t('管理者用 setup 產生的 PIN 可以登入', A.ok && A.user.role === 'admin', A);
const admin = A.token;
const add = env.call({ action: 'addMember', token: admin, name: '店長', pin: '246810', color: '#6A8464' });
const add2 = env.call({ action: 'addMember', token: admin, name: '助理', pin: '135790' });
const M = env.call({ action: 'login', memberId: add.data.id, pin: '246810' });
const mem = M.token;
const M2 = env.call({ action: 'login', memberId: add2.data.id, pin: '135790' });

console.log('\n驗收 1：不帶 token 直接呼叫後台，所有動作都回傳未授權');
const actions = ['logout', 'listMembers', 'listTasks', 'addTask', 'updateTask', 'deleteTask', 'listComments', 'addComment', 'deleteComment', 'addMember', 'updateMember', 'resetPin', 'removeMember'];
const leaks = actions.filter(a => env.call({ action: a }).error !== 'UNAUTHORIZED');
t(`${actions.length} 個動作不帶 token 全部 UNAUTHORIZED`, leaks.length === 0, leaks);
t('帶假 token 也是 UNAUTHORIZED', env.call({ action: 'listTasks', token: 'x'.repeat(64) }).error === 'UNAUTHORIZED');
t('GET 一律拒絕', env.get().error === 'USE_POST');

console.log('\n驗收 2：網路回應裡找不到任何人的 PIN');
const responses = [
  env.call({ action: 'publicMembers' }), env.call({ action: 'listMembers', token: mem }),
  M, A, add, env.call({ action: 'updateMember', token: admin, id: add.data.id, color: '#123456' }),
];
const blob = JSON.stringify(responses);
t('回應中沒有 PIN 明碼', !['246810', '135790', env.adminPin].some(p => blob.includes(p)));
t('回應中沒有 pinHash／salt 欄位', !/pinHash|salt/.test(blob));
const memberRows = JSON.stringify(env.sheets.Members.data);
t('Sheet 裡也只存雜湊，不存明碼', !['246810', '135790', env.adminPin].some(p => memberRows.includes(p)));

console.log('\n驗收 3：一般成員 token 呼叫管理動作會被拒絕');
const task = env.call({ action: 'addTask', token: mem, title: '整理儲藏室', assignee: '助理' }).data;
const adminOnly = [
  ['deleteTask', { id: task.id }], ['addMember', { name: 'x', pin: '123456' }],
  ['updateMember', { id: add2.data.id, name: '駭客' }], ['resetPin', { id: '__admin__', pin: '111111' }],
  ['removeMember', { id: add2.data.id }],
];
const notBlocked = adminOnly.filter(([a, p]) => env.call(Object.assign({ action: a, token: mem }, p)).error !== 'FORBIDDEN');
t('成員呼叫 5 個管理動作全部 FORBIDDEN', notBlocked.length === 0, notBlocked.map(x => x[0]));
t('管理者可以刪任務', env.call({ action: 'deleteTask', token: admin, id: env.call({ action: 'addTask', token: admin, title: 'tmp' }).data.id }).ok);

console.log('\nPIN 規則與防暴力猜測');
t('PIN 少於 6 位不接受', env.call({ action: 'addMember', token: admin, name: '新人', pin: '1234' }).error === 'INVALID');
let last;
for (let i = 0; i < 5; i++) last = env.call({ action: 'login', memberId: add.data.id, pin: '000000' });
t('連續錯 5 次 → 鎖定', last.error === 'LOCKED', last);
t('鎖定期間連正確 PIN 也不能登入', env.call({ action: 'login', memberId: add.data.id, pin: '246810' }).error === 'LOCKED');
t('錯誤訊息不透露帳號是否存在', env.call({ action: 'login', memberId: 'nobody', pin: '000000' }).message === env.call({ action: 'login', memberId: add2.data.id, pin: '000000' }).message);

console.log('\n身分由後台決定，不信任前端傳的資料');
const t2 = env.call({ action: 'addTask', token: mem, title: '假冒', createdBy: '管理者' }).data;
t('建立人用 token 的身分，忽略前端傳的 createdBy', t2.createdBy === '店長', t2.createdBy);
const c = env.call({ action: 'addComment', token: mem, taskId: task.id, content: 'hi', author: '管理者' }).data;
t('留言人用 token 的身分', c.author === '店長', c.author);
t('負責人只能改進度欄位，不能改標題', env.call({ action: 'updateTask', token: M2.token, id: task.id, title: '改標題' }).error === 'FORBIDDEN');
t('負責人可以改狀態', env.call({ action: 'updateTask', token: M2.token, id: task.id, status: 'doing' }).data.status === 'doing');
const outsider = env.call({ action: 'addMember', token: admin, name: '行銷', pin: '975310' });
const O = env.call({ action: 'login', memberId: outsider.data.id, pin: '975310' }).token;
t('不相關的成員不能改別人的任務', env.call({ action: 'updateTask', token: O, id: task.id, status: 'done' }).error === 'FORBIDDEN');
t('不能刪別人的留言', env.call({ action: 'deleteComment', token: O, id: c.id }).error === 'FORBIDDEN');

console.log('\ntoken 失效');
env.call({ action: 'resetPin', token: admin, id: add2.data.id, pin: '864200' });
t('管理者重設 PIN 後，該成員舊 token 立刻失效', env.call({ action: 'listTasks', token: M2.token }).error === 'UNAUTHORIZED');
env.call({ action: 'removeMember', token: admin, id: outsider.data.id });
t('成員被移除後 token 立刻失效', env.call({ action: 'listTasks', token: O }).error === 'UNAUTHORIZED');
env.call({ action: 'logout', token: admin });
t('登出後 token 失效', env.call({ action: 'listTasks', token: admin }).error === 'UNAUTHORIZED');

console.log('\n透過 doPost（HTTP 入口）');
t('doPost 可以登入並讀任務', (() => { const r = env.http({ action: 'login', memberId: add2.data.id, pin: '864200' }); return env.http({ action: 'listTasks', token: r.token }).ok; })());

console.log(`\n${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
