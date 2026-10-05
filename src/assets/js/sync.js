/* sync.js — 数据源自动同步（浏览器侧）
 *
 * 取消手动上传：打开页面时（或点「立即同步」）从数据源目录拉取 manifest.json，
 * 与本地已同步记录按 sha256 比对，只下载新增 / 变更的文件，解析后写入工作区。
 *
 * 数据源既可以是同站目录（默认 data/），也可以是后台 / 对象存储的任意 https 前缀
 * （需要对方允许 CORS）；离线场景仍保留原有「选择文件 / 粘贴文本」作为兜底。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(root); }
  else { root.OpsSync = factory(root); }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';
  var S = (root && root.OpsStore) || (typeof require === 'function' ? require('./store.js') : null);
  var E = (root && root.OpsEngine) || (typeof require === 'function' ? require('./engine.js') : null);

  var LOG_MAX = 20;
  var FETCH_TIMEOUT = 15000;

  function defaults() { return { baseUrl: 'data/', auto: true, files: {}, last: null, log: [] }; }

  /** 取（并补齐）同步配置：老工作区没有 sync 字段也能安全运行 */
  function config() {
    var st = S.state();
    if (!st.sync) { st.sync = defaults(); }
    var d = defaults();
    ['auto'].forEach(function (k) { if (st.sync[k] === undefined) { st.sync[k] = d[k]; } });
    if (!st.sync.baseUrl) { st.sync.baseUrl = d.baseUrl; }
    if (!st.sync.files) { st.sync.files = {}; }
    if (!st.sync.log) { st.sync.log = []; }
    return st.sync;
  }

  /** 把可能相对的地址补成绝对地址（Pages 子路径 / file:// 都适用） */
  function resolveBase(url) {
    var u = String(url || 'data/').trim();
    if (/^https?:\/\//i.test(u) || /^file:\/\//i.test(u)) { return u.replace(/\/?$/, '/'); }
    try {
      var base = (root && root.document && root.document.baseURI) || (root && root.location && root.location.href) || '';
      if (base) { return new URL(u.replace(/\/?$/, '/'), base).href; }
    } catch (e) { /* 退化到原样 */ }
    return u.replace(/\/?$/, '/');
  }

  function setConfig(patch) {
    var c = config();
    Object.keys(patch || {}).forEach(function (k) { c[k] = patch[k]; });
    // 换数据源等于换了一份数据：清空已同步记录，避免用旧哈希误判为「没变」
    if (patch && patch.baseUrl !== undefined) { c.files = {}; }
    S.save();
    return c;
  }

  function getJSON(url) {
    return fetchTimeout(url).then(function (r) {
      if (!r.ok) { throw new Error('HTTP ' + r.status); }
      return r.text();
    }).then(function (t) { return JSON.parse(t); });
  }

  function fetchTimeout(url) {
    var f = (root && root.fetch) || (typeof fetch === 'function' ? fetch : null);
    if (!f) { return Promise.reject(new Error('当前环境不支持 fetch')); }
    if (!root || !root.AbortController) { return f(url, { cache: 'no-store' }); }
    var ac = new root.AbortController();
    var timer = root.setTimeout(function () { ac.abort(); }, FETCH_TIMEOUT);
    return f(url, { cache: 'no-store', signal: ac.signal }).then(function (r) {
      if (timer) { root.clearTimeout(timer); }
      return r;
    }, function (e) {
      if (timer) { root.clearTimeout(timer); }
      throw e;
    });
  }

  /** 清单校验：格式不对就明确报错，不要静默当成「没有更新」 */
  function validate(man) {
    if (!man || typeof man !== 'object') { throw new Error('清单格式不正确'); }
    if (man.schema !== 1) { throw new Error('清单 schema 不支持：' + man.schema); }
    if (!Array.isArray(man.files)) { throw new Error('清单缺少 files'); }
    man.files.forEach(function (f) {
      if (!f || !f.id || !f.path || !f.kind) { throw new Error('清单条目缺少 id/path/kind'); }
    });
    return man;
  }

  /** 差异：返回需要下载的文件（新增 + 内容变更） */
  function plan(man) {
    var c = config();
    var fresh = [], changed = [], skipped = 0;
    man.files.forEach(function (f) {
      var seen = c.files[f.id];
      if (!seen) { fresh.push(f); }
      else if (seen.sha256 !== f.sha256) { changed.push(f); }
      else { skipped++; }
    });
    return { fresh: fresh, changed: changed, unchanged: skipped, todo: fresh.concat(changed) };
  }

  function parseByKind(kind, text, date) {
    if (kind === 'daily') { return { kind: kind, rows: E.parseDailyCSV(text, date) }; }
    if (kind === 'feedback') { return { kind: kind, rows: E.parseFeedbackTXT(text, date) }; }
    if (kind === 'weekly') { return { kind: kind, rows: E.parseWeeklyCSV(text) }; }
    if (kind === 'users') { return { kind: kind, rows: E.parseUsersCSV(text) }; }
    throw new Error('未知数据类型：' + kind);
  }

  function apply(kind, rows) {
    if (kind === 'daily') { return S.addDaily(rows); }
    if (kind === 'feedback') { return S.addFeedback(rows); }
    if (kind === 'weekly') { return S.addWeekly(rows); }
    if (kind === 'users') { return S.addUsers(rows); }
    return 0;
  }

  function pushLog(entry) {
    var c = config();
    c.log.unshift(entry);
    if (c.log.length > LOG_MAX) { c.log = c.log.slice(0, LOG_MAX); }
  }

  function finish(res) {
    var c = config();
    c.last = res;
    pushLog({ at: res.at, ok: res.ok, base: res.base, newFiles: res.newFiles, rows: res.rows, message: res.message });
    S.save();
    return res;
  }

  /**
   * 执行同步。dryRun=true 时只比对不下载（用于「检查更新」）。
   * 任何失败都返回结构化结果，不抛异常 —— 数据源不通不应该影响工作台其他功能。
   */
  function run(opts) {
    opts = opts || {};
    var c = config();
    var base = resolveBase(opts.baseUrl || c.baseUrl);
    var at = new Date().toISOString();
    var result = { ok: false, at: at, base: base, newFiles: 0, changed: 0, rows: 0, unchanged: 0, message: '', dryRun: !!opts.dryRun };
    var man;
    return getJSON(base + 'manifest.json').then(function (m) {
      man = validate(m);
      var p = plan(man);
      result.unchanged = p.unchanged;
      result.newFiles = p.fresh.length;
      result.changed = p.changed.length;
      if (opts.dryRun) {
        result.ok = true;
        result.message = p.todo.length ? ('有 ' + p.todo.length + ' 个文件待同步') : '已是最新';
        return result;
      }
      if (!p.todo.length) {
        result.ok = true;
        result.message = '已是最新，无需下载';
        result.source = man.source || '';
        result.dataVersion = man.generatedAt || '';
        return finish(result);
      }
      return p.todo.reduce(function (chain, f) {
        return chain.then(function () {
          return fetchTimeout(base + f.path).then(function (r) {
            if (!r.ok) { throw new Error(f.path + ' HTTP ' + r.status); }
            return r.text();
          }).then(function (text) {
            var parsed = parseByKind(f.kind, text, f.date || '');
            apply(f.kind, parsed.rows);
            var cc = config();
            cc.files[f.id] = { sha256: f.sha256, at: new Date().toISOString(), rows: parsed.rows.length };
            result.rows += parsed.rows.length;
          });
        });
      }, Promise.resolve()).then(function () {
        result.ok = true;
        result.message = '同步完成：' + (result.newFiles + result.changed) + ' 个文件 / ' + result.rows + ' 条记录';
        result.source = man.source || '';
        result.dataVersion = man.generatedAt || '';
        return finish(result);
      });
    }).catch(function (e) {
      result.ok = false;
      result.message = '同步失败：' + (e && e.message ? e.message : e);
      return finish(result);
    });
  }

  function forget() {
    var c = config();
    c.files = {};
    c.log = [];
    c.last = null;
    S.save();
    return c;
  }

  return {
    defaults: defaults, config: config, setConfig: setConfig, resolveBase: resolveBase,
    validate: validate, plan: plan, parseByKind: parseByKind, run: run, forget: forget
  };
});