/* store.js — 工作区状态与本地持久化（浏览器 localStorage） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(root); }
  else { root.OpsStore = factory(root); }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';
  var KEY = 'ops-workbench-web-v1';
  var E = (root && root.OpsEngine) || (typeof require === 'function' ? require('./engine.js') : null);
  var D = (root && root.OPSData) || (typeof require === 'function' ? require('./data.js') : null);

  function emptyState() {
    return {
      version: 1,
      daily: [],      // {date,metric,value,compare,basis}
      weekly: [],     // {date,metric,value}
      users: [],      // {id,regDate,lastActive,orders,amount,fbCount,lastFbDate,channel,note}
      feedback: [],   // {date,time,channel,userId,content}
      ledgers: { ledger: [], metrics: [], tags: [] },
      config: JSON.parse(JSON.stringify(D.DEFAULT_CONFIG)),
      llm: { enabled: false, baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
      sync: { baseUrl: 'data/', auto: true, files: {}, last: null, log: [] },
      updated: ''
    };
  }

  var state = emptyState();

  function load() {
    try {
      var raw = root.localStorage ? root.localStorage.getItem(KEY) : null;
      if (raw) {
        var s = JSON.parse(raw);
        state = Object.assign(emptyState(), s);
        state.ledgers = Object.assign({ ledger: [], metrics: [], tags: [] }, s.ledgers || {});
        state.config = s.config || JSON.parse(JSON.stringify(D.DEFAULT_CONFIG));
        state.llm = Object.assign({ enabled: false, baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' }, s.llm || {});
        state.sync = Object.assign({ baseUrl: 'data/', auto: true, files: {}, last: null, log: [] }, s.sync || {});
        state.sync.files = state.sync.files || {};
        state.sync.log = state.sync.log || [];
      }
    } catch (e) { console.warn('读取本地数据失败：', e); }
    return state;
  }
  function save() {
    state.updated = new Date().toISOString();
    try { if (root.localStorage) { root.localStorage.setItem(KEY, JSON.stringify(state)); } } catch (e) { console.warn('保存失败（可能超出容量）：', e); }
    return state;
  }
  function reset() { state = emptyState(); save(); return state; }

  // ---------- 数据写入 ----------
  function replaceByKey(list, items, keyFn) {
    var seen = {};
    items.forEach(function (it) { seen[keyFn(it)] = 1; });
    var kept = list.filter(function (it) { return !seen[keyFn(it)]; });
    return kept.concat(items);
  }
  function addDaily(rows) { state.daily = replaceByKey(state.daily, rows, function (r) { return r.date + '|' + r.metric; }); state.daily.sort(byDate); save(); return rows.length; }
  function addWeekly(rows) { state.weekly = replaceByKey(state.weekly, rows, function (r) { return r.date + '|' + r.metric; }); state.weekly.sort(byDate); save(); return rows.length; }
  function addUsers(rows) { state.users = replaceByKey(state.users, rows, function (r) { return r.id; }); save(); return rows.length; }
  function addFeedback(items) { state.feedback = replaceByKey(state.feedback, items, function (r) { return r.date + '|' + r.content; }); state.feedback.sort(byDate); save(); return items.length; }
  function byDate(a, b) { return String(a.date) < String(b.date) ? -1 : (String(a.date) > String(b.date) ? 1 : 0); }

  function clearData(kind) {
    if (kind === 'all') { state.daily = []; state.weekly = []; state.users = []; state.feedback = []; }
    else if (kind === 'daily') { state.daily = []; }
    else if (kind === 'weekly') { state.weekly = []; }
    else if (kind === 'users') { state.users = []; }
    else if (kind === 'feedback') { state.feedback = []; }
    else if (kind === 'ledgers') { state.ledgers = { ledger: [], metrics: [], tags: [] }; }
    save();
  }

  // ---------- 示例数据 ----------
  function loadSample() {
    var f = D.buildSampleFiles();
    f.daily.forEach(function (x) { addDaily(E.parseDailyCSV(x.text, x.name.slice(0, 10))); });
    f.weekly.forEach(function (x) { addWeekly(E.parseWeeklyCSV(x.text)); });
    f.users.forEach(function (x) { addUsers(E.parseUsersCSV(x.text)); });
    f.feedback.forEach(function (x) { addFeedback(E.parseFeedbackTXT(x.text, x.name.slice(0, 10))); });
    return summary();
  }

  // ---------- 统计 ----------
  function summary() {
    var dates = {};
    state.daily.forEach(function (r) { dates[r.date] = 1; });
    var fdates = {};
    state.feedback.forEach(function (r) { fdates[r.date] = 1; });
    return {
      dailyDates: Object.keys(dates).sort(),
      feedbackDates: Object.keys(fdates).sort(),
      dailyRows: state.daily.length,
      weeklyRows: state.weekly.length,
      users: state.users.length,
      feedback: state.feedback.length,
      latestDate: Object.keys(dates).sort().pop() || '',
      latestFeedbackDate: Object.keys(fdates).sort().pop() || ''
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
    state = Object.assign(emptyState(), s);
    save();
    return summary();
  }

  return {
    KEY: KEY, LEDGER_DEF: LEDGER_DEF,
    state: function () { return state; },
    load: load, save: save, reset: reset, summary: summary,
    addDaily: addDaily, addWeekly: addWeekly, addUsers: addUsers, addFeedback: addFeedback,
    clearData: clearData, loadSample: loadSample,
    addLedger: addLedger, removeLedger: removeLedger, prevTags: prevTags, toCSV: toCSV,
    exportJSON: exportJSON, importJSON: importJSON
  };
});