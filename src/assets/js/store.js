/* store.js — 工作区状态与本地持久化（浏览器 localStorage） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(root); }
  else { root.OpsStore = factory(root); }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';
  var KEY = 'ops-workbench-web-v1';
  var E = (root && root.OpsEngine) || (typeof require === 'function' ? require('./engine.js') : null);
  var D = (root && root.OPSData) || (typeof require === 'function' ? require('./data.js') : null);

  // 数据来源优先级：数值越大越优先。
  // 规则：手动导入（manual）永远高于后台自动同步（auto）与示例数据（sample）——
  // 手动导入占用的日期/周期会被「锁定」，自动同步不会覆盖它，见 mergeByKey()。
  var SRC_LEVEL = { manual: 2, auto: 1, sample: 1 };
  var KINDS = ['daily', 'weekly', 'users', 'feedback'];
  function srcLevel(s) { var v = SRC_LEVEL[s]; return v === undefined ? 1 : v; }

  function emptyState() {
    return {
      version: 1,
      daily: [],      // {date,metric,value,compare,basis,_src}
      weekly: [],     // {date,metric,value,_src}
      users: [],      // {id,regDate,lastActive,orders,amount,fbCount,lastFbDate,channel,note,_src}
      feedback: [],   // {date,time,channel,userId,content,_src}
      ledgers: { ledger: [], metrics: [], tags: [] },
      config: JSON.parse(JSON.stringify(D.DEFAULT_CONFIG)),
      llm: { enabled: false, baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
      sync: { baseUrl: 'data/', auto: true, files: {}, last: null, log: [] },
      locks: { daily: {}, weekly: {}, users: {}, feedback: {} },   // 被手动数据占用的 日期 / 周期
      updated: ''
    };
  }

  /** 把任意来源的原始状态补齐成完整状态（老工作区没有 locks / sync 也能安全运行） */
  function hydrate(raw) {
    var r = raw || {};
    var s = Object.assign(emptyState(), r);
    s.ledgers = Object.assign({ ledger: [], metrics: [], tags: [] }, r.ledgers || {});
    s.config = r.config || JSON.parse(JSON.stringify(D.DEFAULT_CONFIG));
    s.llm = Object.assign({ enabled: false, baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' }, r.llm || {});
    s.sync = Object.assign({ baseUrl: 'data/', auto: true, files: {}, last: null, log: [] }, r.sync || {});
    s.sync.files = s.sync.files || {};
    s.sync.log = s.sync.log || [];
    var locks = {};
    KINDS.forEach(function (k) { locks[k] = (r.locks && r.locks[k]) || {}; });
    s.locks = locks;
    KINDS.forEach(function (k) { if (!Array.isArray(s[k])) { s[k] = []; } });
    return s;
  }

  var state = emptyState();

  function load() {
    try {
      var raw = root.localStorage ? root.localStorage.getItem(KEY) : null;
      if (raw) { state = hydrate(JSON.parse(raw)); }
    } catch (e) { console.warn('读取本地数据失败：', e); }
    return state;
  }
  function save() {
    state.updated = new Date().toISOString();
    try { if (root.localStorage) { root.localStorage.setItem(KEY, JSON.stringify(state)); } } catch (e) { console.warn('保存失败（可能超出容量）：', e); }
    return state;
  }
  function reset() { state = emptyState(); save(); return state; }

  // ---------- 数据写入（带来源优先级） ----------
  /** 按 key 合并：新数据只有在「不低于」旧数据来源优先级时才能覆盖它 */
  function mergeByKey(list, items, keyFn, origin) {
    var lv = srcLevel(origin);
    var incoming = {};
    items.forEach(function (it) { incoming[keyFn(it)] = 1; });
    // 旧记录：与新数据同 key 且旧来源优先级更高 → 保留（手动数据不被自动同步覆盖）
    var kept = list.filter(function (it) {
      var k = keyFn(it);
      if (!incoming[k]) { return true; }
      return srcLevel(it._src) > lv;
    });
    var keptKeys = {};
    kept.forEach(function (it) { keptKeys[keyFn(it)] = 1; });
    var accepted = items.filter(function (it) { return !keptKeys[keyFn(it)]; });
    return { list: kept.concat(accepted), accepted: accepted.length, blocked: items.length - accepted.length };
  }
  function stamp(rows, origin) {
    rows.forEach(function (r) { r._src = origin; });
    return rows;
  }
  function lockKey(kind, origin, key, accepted) {
    if (origin !== 'manual' || !key || !accepted) { return; }
    if (!state.locks[kind]) { state.locks[kind] = {}; }
    state.locks[kind][key] = 'manual';
  }

  function addDaily(rows, origin, key) {
    origin = origin || 'manual';
    var k = key || (rows[0] && rows[0].date) || '';
    var res = mergeByKey(state.daily, stamp(rows, origin), function (r) { return r.date + '|' + r.metric; }, origin);
    state.daily = res.list.slice().sort(byDate);
    lockKey('daily', origin, k, res.accepted);
    save();
    return res.accepted;
  }
  function addWeekly(rows, origin, key) {
    origin = origin || 'manual';
    var k = key || (rows[0] && rows[0].date) || '';
    var res = mergeByKey(state.weekly, stamp(rows, origin), function (r) { return r.date + '|' + r.metric; }, origin);
    state.weekly = res.list.slice().sort(byDate);
    lockKey('weekly', origin, k, res.accepted);
    save();
    return res.accepted;
  }
  function addUsers(rows, origin, key) {
    origin = origin || 'manual';
    var res = mergeByKey(state.users, stamp(rows, origin), function (r) { return r.id; }, origin);
    state.users = res.list;
    lockKey('users', origin, key || '', res.accepted);
    save();
    return res.accepted;
  }
  function addFeedback(items, origin, key) {
    origin = origin || 'manual';
    var k = key || (items[0] && items[0].date) || '';
    var res = mergeByKey(state.feedback, stamp(items, origin), function (r) { return r.date + '|' + r.content; }, origin);
    state.feedback = res.list.slice().sort(byDate);
    lockKey('feedback', origin, k, res.accepted);
    save();
    return res.accepted;
  }
  function byDate(a, b) { return String(a.date) < String(b.date) ? -1 : (String(a.date) > String(b.date) ? 1 : 0); }

  // ---------- 手动优先锁定 ----------
  /** 该 日期/周期 是否已被手动导入的数据占用（自动同步需跳过） */
  function isManualLocked(kind, key) {
    if (!key) { return false; }
    var m = state.locks && state.locks[kind];
    return !!(m && m[key]);
  }
  function lockedKeys(kind) { return Object.keys((state.locks && state.locks[kind]) || {}).sort(); }
  /** 解除手动优先：清掉锁定、把手动记录降级，并让自动数据能重新拉回来 */
  function unlockManual(kind) {
    var kinds = (kind && kind !== 'all') ? [kind] : KINDS.slice();
    var n = 0;
    kinds.forEach(function (k) {
      n += Object.keys((state.locks && state.locks[k]) || {}).length;
      if (state.locks) { state.locks[k] = {}; }
      (state[k] || []).forEach(function (r) { if (r._src === 'manual') { r._src = 'auto'; } });
    });
    // 这些文件当初可能已被自动同步过、只是被锁定挡掉了；不清哈希缓存的话
    // 下一次同步会判定「无变化」而拒绝下载，自动数据就永远盖不回来。
    if (n && state.sync) { state.sync.files = {}; }
    save();
    return n;
  }

  function clearData(kind) {
    if (kind === 'all') { KINDS.forEach(function (k) { state[k] = []; }); }
    else if (KINDS.indexOf(kind) >= 0) { state[kind] = []; }
    else if (kind === 'ledgers') { state.ledgers = { ledger: [], metrics: [], tags: [] }; }
    if (kind === 'all' || KINDS.indexOf(kind) >= 0) {
      var kinds = (kind === 'all') ? KINDS.slice() : [kind];
      kinds.forEach(function (k) { if (state.locks) { state.locks[k] = {}; } });
    }
    save();
  }

  // ---------- 示例数据 ----------
  // 示例数据按 auto 级写入：手动导入过的日期不会被它覆盖；后台自动同步也会覆盖它。
  function loadSample() {
    var f = D.buildSampleFiles();
    f.daily.forEach(function (x) { addDaily(E.parseDailyCSV(x.text, x.name.slice(0, 10)), 'sample'); });
    f.weekly.forEach(function (x) { addWeekly(E.parseWeeklyCSV(x.text), 'sample'); });
    f.users.forEach(function (x) { addUsers(E.parseUsersCSV(x.text), 'sample'); });
    f.feedback.forEach(function (x) { addFeedback(E.parseFeedbackTXT(x.text, x.name.slice(0, 10)), 'sample'); });
    return summary();
  }

  // ---------- 统计 ----------
  function summary() {
    var dates = {};
    state.daily.forEach(function (r) { dates[r.date] = 1; });
    var fdates = {};
    state.feedback.forEach(function (r) { fdates[r.date] = 1; });
    var locks = {};
    KINDS.forEach(function (k) { locks[k] = lockedKeys(k); });
    return {
      dailyDates: Object.keys(dates).sort(),
      feedbackDates: Object.keys(fdates).sort(),
      dailyRows: state.daily.length,
      weeklyRows: state.weekly.length,
      users: state.users.length,
      feedback: state.feedback.length,
      latestDate: Object.keys(dates).sort().pop() || '',
      latestFeedbackDate: Object.keys(fdates).sort().pop() || '',
      locks: locks,
      lockedTotal: KINDS.reduce(function (a, k) { return a + locks[k].length; }, 0),
      manualRows: KINDS.reduce(function (a, k) {
        return a + (state[k] || []).filter(function (r) { return r._src === 'manual'; }).length;
      }, 0)
    };
  }

  // ---------- 台账 ----------
  var LEDGER_DEF = {
    ledger: { file: 'ledger.csv', head: ['分析日期', '分析类型', '数据范围', '核心结论', '关键问题', '建议动作', '产出文件', '执行Skill'] },
    metrics: { file: 'metrics-ledger.csv', head: ['记录日期', '指标名称', '数值', '对比基准', '变化', '异常标记', '归因假设', '数据源'] },
    tags: { file: 'tag-ledger.csv', head: ['用户ID', '生命周期阶段', '价值标签', '反馈行为标签', '打标日期', '建议动作'] }
  };
  function addLedger(kind, rows) {
    if (!LEDGER_DEF[kind]) { return 0; }
    var head = LEDGER_DEF[kind].head;
    rows.forEach(function (r) {
      var obj = {};
      head.forEach(function (h, i) { obj[h] = Array.isArray(r) ? (r[i] === undefined ? '' : r[i]) : (r[h] === undefined ? '' : r[h]); });
      obj['_ts'] = new Date().toISOString();
      state.ledgers[kind].push(obj);
    });
    save();
    return rows.length;
  }
  function removeLedger(kind, index) { state.ledgers[kind].splice(index, 1); save(); }
  function prevTags() { return state.ledgers.tags; }

  function toCSV(kind) {
    var def = LEDGER_DEF[kind]; if (!def) { return ''; }
    var esc = function (v) { var s = String(v === undefined || v === null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    var out = [def.head.join(',')];
    state.ledgers[kind].forEach(function (row) { out.push(def.head.map(function (h) { return esc(row[h]); }).join(',')); });
    return out.join('\r\n');
  }

  // ---------- 导出 / 导入 ----------
  function exportJSON() { return JSON.stringify(state, null, 2); }
  function importJSON(text) {
    var s = JSON.parse(text);
    if (!s || typeof s !== 'object') { throw new Error('文件格式不正确'); }
    state = hydrate(s);
    save();
    return summary();
  }

  return {
    KEY: KEY, LEDGER_DEF: LEDGER_DEF, SRC_LEVEL: SRC_LEVEL, KINDS: KINDS,
    state: function () { return state; },
    load: load, save: save, reset: reset, summary: summary,
    addDaily: addDaily, addWeekly: addWeekly, addUsers: addUsers, addFeedback: addFeedback,
    isManualLocked: isManualLocked, lockedKeys: lockedKeys, unlockManual: unlockManual,
    clearData: clearData, loadSample: loadSample,
    addLedger: addLedger, removeLedger: removeLedger, prevTags: prevTags, toCSV: toCSV,
    exportJSON: exportJSON, importJSON: importJSON
  };
});