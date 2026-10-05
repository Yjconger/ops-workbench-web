/* app.js — 运营工作台 Web 版界面与交互 */
(function () {
  'use strict';
  var S = window.OpsStore, E = window.OpsEngine, C = window.OpsCharts, D = window.OPSData, SY = window.OpsSync;
  var state = S.load();
  var cfg = state.config;
  var view = 'dashboard';
  var ui = { fbFilter: '全部', gran: '日', metricPick: '', search: '', ledgerTab: 'ledger', last: {} };

  // ---------------- 基础工具 ----------------
  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function todayStr() {
    var d = new Date(), p = function (n) { return String(n).length < 2 ? '0' + n : String(n); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function download(name, text, mime) {
    var blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  }
  function toast(msg) {
    var t = $('#toast'); if (!t) { return; }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }
  function chip(status, near) {
    var cls = status === '异常' ? 'bad' : status === '需关注' ? 'warn' : status === '正常' ? 'ok' : 'na';
    return '<span class="chip ' + cls + '">' + esc(status) + (near ? '·临界' : '') + '</span>';
  }
  function signed(v, suffix) { return (v > 0 ? '+' : '') + v + (suffix || ''); }
  function when(t) { return String(t || '').replace('T', ' ').slice(0, 16); }

  // ---------------- 数据派生 ----------------
  function daily() { return state.daily; }
  function weekly() { return state.weekly; }
  function summary() { return S.summary(); }
  function analyzeDaily() { return E.analyzeMetrics(daily(), cfg, { granularity: '日' }); }
  function analyzeWeekly() { return E.analyzeMetrics(weekly(), cfg, { granularity: '周' }); }
  function analyzePicked() { return ui.gran === '周' ? analyzeWeekly() : analyzeDaily(); }
  function combinedRows() {
    var byMetric = {};
    if (ui.gran === '周') { analyzeWeekly().rows.forEach(function (r) { byMetric[r.metric] = r; }); }
    else { analyzeDaily().rows.forEach(function (r) { byMetric[r.metric] = r; }); analyzeWeekly().rows.forEach(function (r) { byMetric[r.metric] = r; }); }
    return Object.keys(byMetric).map(function (k) { return byMetric[k]; });
  }
  function feedbackInScope() { return state.feedback; }
  function byDateOf(list) { var m = {}; list.forEach(function (x) { m[x.date] = (m[x.date] || 0) + 1; }); return m; }
  function consistency() {
    var fb = E.analyzeFeedback(feedbackInScope(), cfg);
    var negByDate = {};
    fb.annotated.forEach(function (a) {
      negByDate[a.date] = negByDate[a.date] || { total: 0, negative: 0 };
      negByDate[a.date].total++; if (a.sentiment === '负面') { negByDate[a.date].negative++; }
    });
    return Object.keys(negByDate).sort().map(function (d) {
      var row = daily().filter(function (x) { return x.metric === '负面反馈数' && x.date === d; })[0];
      return { date: d, metricValue: row ? row.value : null, textValue: negByDate[d].negative };
    });
  }
  function hasData() { var s = summary(); return !!(s.dailyRows || s.feedback.length || s.users || s.weeklyRows); }

  // ---------------- 台账写入 ----------------
  function writeMetricsLedger(an, source) {
    if (!an || !an.rows.length) { return 0; }
    var rows = an.rows.filter(function (r) { return r.status !== '正常' || r.near; }).map(function (r) {
      return [todayStr(), r.metric, r.value, (r.prevDate ? r.prevDate + ' ' : '') + (r.prev === null ? '—' : r.prev),
        (r.change === null ? '—' : signed(r.change)) + (r.changePct === null ? '' : '（' + signed(r.changePct, '%') + '）'),
        r.status + (r.near ? '（临界）' : ''), r.hypothesis && r.hypothesis[0] ? r.hypothesis[0].text : '', source];
    });
    return S.addLedger('metrics', rows);
  }
  function writeFeedbackLedger(fb, scope) {
    var top = fb.issues.slice(0, 2).map(function (i) { return i.name + '(' + i.count + ')'; }).join('、');
    var actions = fb.requirements.slice(0, 2).map(function (r) { return r.level + '：' + r.action; }).join('；');
    return S.addLedger('ledger', [[todayStr(), '反馈分析', scope, '负面 ' + fb.negativeCount + '/' + fb.total + '（' + fb.negativeRate + '%）',
      top || '无明显集中问题', actions, '（对话内输出）', 'analyze-feedback']]);
  }
  function writeCheckLedger(res) {
    var abn = res.rows.filter(function (r) { return r.status === '异常'; });
    return S.addLedger('ledger', [[todayStr(), '每日晨检', res.date,
      abn.length ? abn.map(function (r) { return r.metric + ' ' + r.value; }).join('、') + ' 异常' : '指标整体正常',
      res.feedback && res.feedback.issues.length ? res.feedback.issues[0].name : '—',
      res.todos.map(function (t) { return t.short; }).join('；'), '（对话内输出）', 'daily-check']]);
  }
  function writeTagLedger(tg) {
    var rows = tg.rows.map(function (r) {
      return [r.id, r.life, r.value, r.behavior, tg.today, r.action + (r.extra ? ' + ' + r.extra : '')];
    });
    return S.addLedger('tags', rows);
  }
  function writeIntegratedLedger(it) {
    return S.addLedger('ledger', [[todayStr(), '整合分析', '指标 + 反馈' + (summary().users ? ' + 用户分层' : ''),
      it.findings[0] ? it.findings[0].replace(/\*\*/g, '') : '—',
      '印证 ' + it.counts.ok + ' / 背离 ' + it.counts.warn + ' / 无法判断 ' + it.counts.na,
      it.strategies.slice(0, 2).map(function (s) { return s.level + '：' + s.action; }).join('；'),
      '（对话内输出）', 'integrated-report']]);
  }

  // ---------------- 页面：概览 ----------------
  var NAV = [
    { id: 'dashboard', label: '概览', hint: '今天先做什么', icon: '◎', group: '总览' },
    { id: 'data', label: '数据源', hint: '自动采集 / 导入', icon: '▤', group: '总览' },
    { id: 'check', label: '每日晨检', hint: '30 秒简报', icon: '☼', group: '分析' },
    { id: 'feedback', label: '反馈分析', hint: '情感 / 需求', icon: '✎', group: '分析' },
    { id: 'metrics', label: '指标分析', hint: '趋势 / 异常', icon: '▲', group: '分析' },
    { id: 'tags', label: '用户分层', hint: '三维标签', icon: '◈', group: '分析' },
    { id: 'integrated', label: '整合分析', hint: '交叉验证', icon: '⊞', group: '分析' },
    { id: 'ledgers', label: '台账', hint: '历史留痕', icon: '▦', group: '记录' },
    { id: 'config', label: '口径设置', hint: '阈值 / 字典', icon: '⚙', group: '记录' }
  ];

  function viewDashboard() {
    var s = summary();
    var gap = [];
    if (!s.dailyRows) { gap.push('日指标'); }
    if (!s.feedback.length) { gap.push('用户反馈'); }
    if (!s.weeklyRows) { gap.push('周指标'); }
    if (!s.users) { gap.push('用户行为数据'); }
    var recent = state.ledgers.ledger.slice(-5).reverse();
    return [
      '<div class="page-head"><h1>概览</h1><p class="sub">本工作台在浏览器本地运行：数据只存在这台设备的浏览器里，不会上传到任何服务器。</p></div>',
      '<div class="grid k4">',
      statCard('日指标', s.dailyRows ? s.dailyDates.length + ' 天' : '—', s.dailyRows ? '最新 ' + s.latestDate : '未导入', s.dailyRows ? 'ok' : 'na'),
      statCard('用户反馈', s.feedback ? s.feedback + ' 条' : '—', s.feedback ? s.feedbackDates.length + ' 天 · 最新 ' + s.latestFeedbackDate : '未导入', s.feedback ? 'ok' : 'na'),
      statCard('周指标', s.weeklyRows ? s.weeklyRows + ' 行' : '—', s.weeklyRows ? '可用于趋势分析' : '未导入', s.weeklyRows ? 'ok' : 'na'),
      statCard('用户数据', s.users ? s.users + ' 位' : '—', s.users ? '可用于分层打标' : '未导入', s.users ? 'ok' : 'na'),
      '</div>',
      gap.length ? '<div class="card notice"><b>还缺：' + gap.join(' / ') + '</b><p>等后台数据自动同步，或去「数据源」页手动导入 / 载入示例数据先跑一遍完整流程。</p>' +
        '<div class="row"><button class="btn primary" data-act="load-sample">载入示例数据</button><button class="btn" data-act="go" data-view="data">去导入数据</button></div></div>' : '',
      '<div class="grid k3 mt">',
      quickCard('每日晨检', '扫当日指标与反馈，产出 200 字简报 + 今日待办', 'check', '开始晨检'),
      quickCard('反馈分析', '情感判定、高频问题 Top5、带优先级的需求清单', 'feedback', '分析反馈'),
      quickCard('指标分析', '趋势识别、异常标注、归因假设（日 / 周粒度）', 'metrics', '分析指标'),
      quickCard('用户分层', '生命周期 · 价值 · 反馈行为三维标签', 'tags', '开始打标'),
      quickCard('整合分析', '交叉验证反馈与数据，输出策略与监控重点', 'integrated', '生成整合分析'),
      quickCard('台账', '历史结论留痕，支持导出 CSV', 'ledgers', '查看台账'),
      '</div>',
      '<div class="card mt"><div class="card-head"><h3>最近台账记录</h3><button class="btn tiny" data-act="go" data-view="ledgers">全部</button></div>',
      recent.length ? '<table class="tbl"><thead><tr><th>日期</th><th>类型</th><th>核心结论</th><th>关键问题</th></tr></thead><tbody>' +
        recent.map(function (r) {
          return '<tr><td>' + esc(r['分析日期']) + '</td><td>' + esc(r['分析类型']) + '</td><td>' + esc(r['核心结论']) + '</td><td>' + esc(r['关键问题']) + '</td></tr>';
        }).join('') + '</tbody></table>' : '<p class="muted">还没有记录。跑一次晨检或反馈分析，结论会自动记入台账。</p>',
      '</div>'
    ].join('');
  }
  function statCard(label, value, sub, tone) {
    var tn = tone || 'na';
    return '<div class="card stat ' + tn + '"><span class="stat-label">' + esc(label) + '</span><b>' + esc(value) + '</b>' +
      '<span class="stat-pill pill-' + tn + '">' + esc(sub) + '</span></div>';
  }
  function quickCard(title, desc, target, btn) {
    return '<div class="card quick"><h3>' + esc(title) + '</h3><p>' + esc(desc) + '</p>' +
      '<button class="btn primary sm" data-act="go" data-view="' + target + '">' + esc(btn) + ' →</button></div>';
  }

  // ---------------- 页面：数据 ----------------
  function viewData() {
    var s = summary();
    return [
      '<div class="page-head"><h1>数据源</h1><p class="sub">后台采集好的数据会自动同步进来，正常情况下不需要手动上传；下面的手动导入只在网络不通或临时补数时使用。</p></div>',
      syncCard(),
      '<h3 class="sec-h">手动导入（兜底）</h3>',
      '<div class="grid k2">',
      importCard('daily', '日指标 CSV', '文件名如 2026-10-03-metrics.csv；表头：指标,数值,对比值,对比口径', s.dailyRows ? s.dailyDates.length + ' 天 / ' + s.dailyRows + ' 行' : '未导入'),
      importCard('feedback', '用户反馈 TXT', '一行一条：时间 | 渠道 | 用户ID | 内容；# 开头为注释', s.feedback ? s.feedback + ' 条 / ' + s.feedbackDates.length + ' 天' : '未导入'),
      importCard('weekly', '周指标 CSV', '表头：周,指标,数值,环比,同比（同一文件可含多周）', s.weeklyRows ? s.weeklyRows + ' 行' : '未导入'),
      importCard('users', '用户行为 CSV', '表头：用户ID,注册日期,最近活跃日期,累计订单数,累计付费金额,反馈次数,最近反馈日期,渠道,备注', s.users ? s.users + ' 位' : '未导入'),
      '</div>',
      '<div class="card mt"><div class="card-head"><h3>工作区快照</h3><span class="muted sm">换设备 / 交接时用</span></div>',
      '<p class="muted">导出会把全部数据、台账与口径设置打包成一个 JSON 文件；导入会覆盖当前工作区，请先导出备份。</p>',
      '<div class="row"><button class="btn" data-act="export-all">导出工作区 JSON</button>',
      '<label class="btn">导入工作区 JSON<input type="file" accept=".json" data-file="workspace" hidden></label>',
      '<button class="btn" data-act="load-sample">载入示例数据</button>',
      '<button class="btn danger" data-act="clear" data-kind="all">清空全部数据</button></div>',
      '</div>',
      '<div class="card mt"><h3>字段规范</h3><table class="tbl"><thead><tr><th>数据</th><th>命名</th><th>字段</th></tr></thead><tbody>',
      '<tr><td>日指标</td><td>YYYY-MM-DD-metrics.csv</td><td>指标, 数值, 对比值, 对比口径</td></tr>',
      '<tr><td>反馈</td><td>YYYY-MM-DD-feedback.txt</td><td>时间 | 渠道 | 用户ID | 内容</td></tr>',
      '<tr><td>周指标</td><td>YYYY-Www-metrics.csv</td><td>周, 指标, 数值, 环比, 同比</td></tr>',
      '<tr><td>用户</td><td>YYYY-MM-users.csv</td><td>用户ID, 注册日期, 最近活跃日期, 累计订单数, 累计付费金额, 反馈次数, 最近反馈日期, 渠道, 备注</td></tr>',
      '</tbody></table><p class="muted sm">编码统一 UTF-8（Excel 另存为「CSV UTF-8（逗号分隔）」）；缺数据留空，不要填 0。</p></div>'
    ].join('');
  }
  // ---------------- 数据源：自动同步 ----------------
  function syncCard() {
    var c = SY ? SY.config() : { baseUrl: 'data/', auto: false, files: {}, last: null, log: [] };
    var last = c.last;
    var seenCount = Object.keys(c.files || {}).length;
    var badge = last ? (last.ok ? '<span class="chip ok">同步正常</span>' : '<span class="chip bad">同步失败</span>') : '<span class="chip na">未同步</span>';
    var logRows = (c.log || []).map(function (l) {
      return '<tr><td>' + esc(when(l.at)) + '</td><td>' + esc(l.base || '') + '</td>' +
        '<td>' + (l.ok ? '<span class="chip ok">成功</span>' : '<span class="chip bad">失败</span>') + ' ' + esc(l.message || '') + '</td>' +
        '<td>' + (l.rows || 0) + '</td></tr>';
    }).join('');
    return '<div class="card mt sync-card"><div class="card-head"><h3>数据源 · 自动同步</h3>' + badge + '</div>' +
      '<p class="muted sm">后台每日采集完成后，打开本页会自动拉取新增 / 变更的数据文件并入库，<b>不需要手动上传</b>。默认读取本站 <span class="mono">data/</span> 目录，也可以指向后台或对象存储的地址（需允许跨域）。同步按文件内容哈希比对，已同步过的文件不会重复下载。</p>' +
      '<div class="row"><input class="sync-url" type="text" data-input="sync-source" value="' + esc(c.baseUrl) + '" placeholder="data/ 或 https://example.com/ops-data/">' +
      '<button class="btn sm" data-act="sync-source-save">保存地址</button>' +
      '<button class="btn sm primary" data-act="sync-now">立即同步</button>' +
      '<button class="btn sm ghost" data-act="sync-check">检查更新</button></div>' +
      '<div class="row mt"><label class="switch"><input type="checkbox" data-input="sync-auto"' + (c.auto ? ' checked' : '') + '> 打开页面时自动同步</label>' +
      '<span class="muted sm">已同步文件 ' + seenCount + ' 个' + (last ? ' · 上次 ' + esc(when(last.at)) + '：' + esc(last.message) : '') + '</span></div>' +
      ((c.log && c.log.length) ? '<details class="logbox mt"><summary>同步日志（最近 ' + c.log.length + ' 条）</summary>' +
        '<table class="tbl"><thead><tr><th>时间</th><th>数据源</th><th>结果</th><th>新增记录</th></tr></thead><tbody>' + logRows + '</tbody></table>' +
        '<div class="row"><button class="btn tiny ghost danger" data-act="sync-forget">清空同步记录</button></div></details>' : '') +
      '</div>';
  }
  function doSync(dry) {
    if (!SY) { toast('同步模块未加载'); return; }
    toast(dry ? '正在检查更新…' : '正在从数据源同步…');
    SY.run({ dryRun: !!dry }).then(function (r) { toast(r.message); render(); });
  }
  var autoSynced = false;
  function autoSyncOnce() {
    if (autoSynced || !SY) { return; }
    if (!SY.config().auto) { return; }
    autoSynced = true;
    SY.run({}).then(function (r) {
      if (r.ok && (r.newFiles || r.changed)) { toast(r.message); render(); }
    });
  }
  function importCard(kind, title, hint, status) {
    return '<div class="card import"><div class="card-head"><h3>' + esc(title) + '</h3><span class="chip ok">' + esc(status) + '</span></div>' +
      '<p class="muted sm">' + esc(hint) + '</p>' +
      '<div class="row"><label class="btn sm">选择文件<input type="file" multiple accept=".csv,.txt" data-file="' + kind + '" hidden></label>' +
      '<button class="btn sm ghost" data-act="toggle-paste" data-kind="' + kind + '">粘贴文本</button>' +
      '<button class="btn sm ghost danger" data-act="clear" data-kind="' + kind + '">清空</button></div>' +
      '<div class="paste" data-paste="' + kind + '" hidden><textarea rows="5" placeholder="把 CSV / 反馈文本粘贴到这里…" data-text="' + kind + '"></textarea>' +
      '<button class="btn sm primary" data-act="import-paste" data-kind="' + kind + '">导入粘贴内容</button></div>' +
      '</div>';
  }
  // ---------------- 页面：每日晨检 ----------------
  function viewCheck() {
    var s = summary();
    if (!s.dailyRows && !s.feedback.length) {
      return emptyBig('每日晨检', '还没有数据。先去「数据」页导入当日指标与反馈，或载入示例数据体验完整流程。');
    }
    var dates = {};
    s.dailyDates.forEach(function (d) { dates[d] = 1; });
    s.feedbackDates.forEach(function (d) { dates[d] = 1; });
    var all = Object.keys(dates).sort();
    var date = ui.last.checkDate && dates[ui.last.checkDate] ? ui.last.checkDate : (s.latestDate || all[all.length - 1]);
    ui.last.checkDate = date;
    var res = E.dailyCheck({ cfg: cfg, date: date, metrics: daily(), feedback: state.feedback.filter(function (f) { return f.date === date; }) });
    var fb = res.feedback;
    return [
      '<div class="page-head"><h1>每日晨检</h1><p class="sub">只扫当日：指标是否破线 + 反馈是否集中，产出 200 字以内简报与最多 3 条待办。</p></div>',
      '<div class="toolbar">',
      '<label class="field">日期 <select data-act="pick-date" id="checkDate">' + all.map(function (d) {
        return '<option value="' + esc(d) + '"' + (d === date ? ' selected' : '') + '>' + esc(d) + '</option>';
      }).join('') + '</select></label>',
      '<button class="btn primary" data-act="rerender">刷新</button>',
      '<button class="btn" data-act="check-ledger">写入台账</button>',
      '<button class="btn ghost" data-act="download" data-dl="check">下载简报 Markdown</button>',
      '<span class="spacer"></span>',
      '<span class="chip ' + (res.briefCount <= 200 ? 'ok' : 'warn') + '">简报 ' + res.briefCount + '/200 字</span>',
      res.briefTrimmed ? '<span class="chip na">已自动精简</span>' : '',
      '</div>',
      '<div class="grid k2">',
      '<div class="card"><div class="card-head"><h3>晨检简报</h3><button class="btn tiny" data-act="copy" data-src="brief">复制</button></div>' +
        '<pre class="brief" id="briefBox">' + esc(res.brief) + '</pre></div>',
      '<div class="card"><div class="card-head"><h3>今日待办</h3><span class="muted sm">' + res.todos.length + ' 条</span></div>' +
        (res.todos.length ? res.todos.map(function (t, i) {
          return '<div class="todo"><b>' + (i + 1) + '. ' + esc(t.text) + '</b><small>依据：' + esc(t.basis) + '</small><small class="when">时间：' + esc(t.when) + '</small></div>';
        }).join('') : '<p class="muted">无待办</p>') + '</div>',
      '</div>',
      '<div class="card mt"><div class="card-head"><h3>当日指标状态</h3><span class="muted sm">共 ' + res.rows.length + ' 项，异常 ' +
        res.rows.filter(function (r) { return r.status === '异常'; }).length + ' 项</span></div>',
      res.rows.length ? '<table class="tbl"><thead><tr><th>指标</th><th>数值</th><th>对比</th><th>变化</th><th>状态</th><th>近 14 天</th></tr></thead><tbody>' +
        res.rows.map(function (r) {
          return '<tr><td>' + esc(r.metric) + '</td><td><b>' + esc(r.value) + '</b></td><td>' + (r.compare === null || r.compare === undefined ? '—' : esc(r.compare)) + '</td>' +
            '<td>' + (r.change === null ? '—' : signed(r.change) + (r.changePct === null ? '' : '（' + signed(r.changePct, '%') + '）')) + '</td>' +
            '<td>' + chip(r.status, r.near) + '</td><td>' + C.sparkline(r.series, { color: C.STATUS_COLOR[r.status] }) + '</td></tr>';
        }).join('') + '</tbody></table>' : '<p class="muted">当日没有指标数据</p>',
      '</div>',
      '<div class="card mt"><div class="card-head"><h3>当日反馈速览</h3></div>',
      fb ? ('<div class="row"><span class="chip na">共 ' + fb.total + ' 条</span><span class="chip bad">负面 ' + fb.negativeCount + '</span>' +
        '<span class="chip ' + (fb.negativeRate >= 50 ? 'bad' : 'ok') + '">负面占比 ' + fb.negativeRate + '%</span>' +
        (fb.issues[0] ? '<span class="chip warn">最集中：' + esc(fb.issues[0].name) + '</span>' : '') + '</div>' +
        '<p class="muted sm">完整情感分布与需求优先级请到「反馈分析」页运行。</p>') : '<p class="muted">当日没有反馈数据</p>',
      '</div>'
    ].join('');
  }

  // ---------------- 页面：反馈分析 ----------------
  function viewFeedback() {
    if (!state.feedback.length) { return emptyBig('反馈分析', '还没有反馈数据。去「数据」页导入反馈 txt（一行一条：时间 | 渠道 | 用户ID | 内容），或载入示例数据。'); }
    var fb = E.analyzeFeedback(feedbackInScope(), cfg);
    ui.last.feedback = fb;
    var filter = ui.fbFilter;
    var list = fb.annotated.filter(function (a) { return filter === '全部' || a.sentiment === filter; });
    if (ui.search) { list = list.filter(function (a) { return a.content.indexOf(ui.search) >= 0; }); }
    var catData = fb.issues.map(function (i) { return { label: i.name, value: i.count, pct: fb.total ? (i.count / fb.total) * 100 : 0 }; });
    return [
      '<div class="page-head"><h1>反馈分析</h1><p class="sub">把散乱的用户声音变成结构化需求：情感判定 → 问题分类 → 高频问题 → 带优先级的需求清单。</p></div>',
      '<div class="toolbar"><span class="chip na">数据范围：全部反馈 ' + fb.total + ' 条</span>',
      '<button class="btn" data-act="feedback-ledger">写入台账</button>',
      '<button class="btn ghost" data-act="download" data-dl="feedback">下载报告 Markdown</button>',
      '<button class="btn ghost" data-act="download" data-dl="feedback-csv">导出明细 CSV</button>',
      fb.smallSample ? '<span class="chip warn">样本 &lt; 10 条，结论仅供参考</span>' : '',
      '</div>',
      '<div class="grid k4">',
      statCard('反馈总量', fb.total + ' 条', '覆盖 ' + Object.keys(byDateOf(state.feedback)).length + ' 天', 'na'),
      statCard('负面', fb.negativeCount + ' 条', '占比 ' + fb.negativeRate + '%', fb.negativeRate >= 50 ? 'bad' : 'ok'),
      statCard('高频问题', fb.issues[0] ? fb.issues[0].name : '—', fb.issues[0] ? fb.issues[0].count + ' 条 / ' + fb.issues[0].users + ' 位用户' : '', 'warn'),
      statCard('P0 需求', fb.requirements.filter(function (r) { return r.level === 'P0'; }).length + ' 条', 'P1 ' + fb.requirements.filter(function (r) { return r.level === 'P1'; }).length + ' 条', 'bad'),
      '</div>',
      '<div class="grid k2 mt">',
      '<div class="card"><h3>情感分布</h3><div class="donut-wrap">' +
        C.donut([{ label: '负面', value: fb.sentiment['负面'], color: '#e5484d' }, { label: '中性', value: fb.sentiment['中性'], color: '#a2a0b8' }, { label: '正面', value: fb.sentiment['正面'], color: '#12a870' }], { centerLabel: '反馈条数' }) +
        '<div class="legend">' + ['负面', '中性', '正面'].map(function (k, i) {
          return '<span><i style="background:' + ['#c0392b', '#8e9aa8', '#1f9d6f'][i] + '"></i>' + k + ' ' + fb.sentiment[k] + '（' + fb.sentimentPct[k] + '%）</span>';
        }).join('') + '</div></div></div>',
      '<div class="card"><h3>问题类型分布</h3>' + C.barRows(catData) + '</div>',
      '</div>',
      '<div class="card mt"><h3>高频问题 Top5</h3><table class="tbl"><thead><tr><th>#</th><th>问题类型</th><th>提及</th><th>涉及用户</th><th>代表原话</th></tr></thead><tbody>' +
        fb.issues.map(function (i, idx) {
          return '<tr><td>' + (idx + 1) + '</td><td><b>' + esc(i.name) + '</b></td><td>' + i.count + '</td><td>' + i.users + '</td><td class="quote">' + esc(i.samples[0] || '') + '</td></tr>';
        }).join('') + '</tbody></table></div>',
      '<div class="card mt"><h3>需求建议（带优先级）</h3><table class="tbl"><thead><tr><th>优先级</th><th>需求</th><th>依据</th><th>建议动作</th></tr></thead><tbody>' +
        fb.requirements.map(function (r) {
          return '<tr><td><span class="chip ' + (r.level === 'P0' ? 'bad' : r.level === 'P1' ? 'warn' : 'na') + '">' + r.level + '</span></td>' +
            '<td><b>' + esc(r.title) + '</b><br><small class="muted">' + esc(r.category) + '</small></td>' +
            '<td class="sm">' + esc(r.reason) + '</td><td>' + esc(r.action) + '</td></tr>';
        }).join('') + '</tbody></table></div>',
      '<div class="card mt"><div class="card-head"><h3>反馈明细</h3><div class="row">',
      ['全部', '负面', '中性', '正面'].map(function (k) {
        return '<button class="btn tiny' + (filter === k ? ' primary' : '') + '" data-act="fb-filter" data-v="' + k + '">' + k + (k === '全部' ? ' ' + fb.total : ' ' + (fb.sentiment[k] || 0)) + '</button>';
      }).join(''),
      '<input class="search" placeholder="搜索内容" data-act="fb-search" value="' + esc(ui.search) + '">',
      '</div></div>',
      '<table class="tbl"><thead><tr><th>日期</th><th>渠道</th><th>用户</th><th>内容</th><th>情感</th><th>类型</th><th>依据词</th></tr></thead><tbody>' +
      list.slice(0, 200).map(function (a) {
        return '<tr><td>' + esc(a.date) + '</td><td>' + esc(a.channel || '—') + '</td><td>' + esc(a.userId || '—') + '</td><td>' + esc(a.content) + '</td>' +
          '<td>' + chip(a.sentiment === '负面' ? '异常' : a.sentiment === '正面' ? '正常' : '无数据').replace('异常', '负面').replace('正常', '正面').replace('无数据', '中性') + '</td>' +
          '<td>' + esc(a.category) + '</td><td class="sm muted">' + esc((a.evidence || []).join('、')) + '</td></tr>';
      }).join('') + '</tbody></table>',
      '<p class="muted sm">显示 ' + Math.min(list.length, 200) + ' / ' + list.length + ' 条。情感判定基于可编辑词表（口径设置），建议对边界样本人工复核。</p></div>'
    ].join('');
  }

  // ---------------- 页面：指标分析 ----------------
  function viewMetrics() {
    if (!daily().length && !weekly().length) { return emptyBig('指标分析', '还没有指标数据。去「数据」页导入日指标或周指标 CSV，或载入示例数据。'); }
    var an = analyzePicked();
    ui.last.metrics = an;
    if (!ui.metricPick || !an.rows.filter(function (r) { return r.metric === ui.metricPick; }).length) {
      ui.metricPick = (an.anomalies[0] && an.anomalies[0].metric) || (an.rows[0] && an.rows[0].metric) || '';
    }
    var pick = an.rows.filter(function (r) { return r.metric === ui.metricPick; })[0];
    var thr = pick && pick.rule ? (pick.rule.better === 'up' ? (pick.rule.warnMin !== undefined ? pick.rule.warnMin : pick.rule.goodMin) : (pick.rule.warnMax !== undefined ? pick.rule.warnMax : pick.rule.goodMax)) : null;
    return [
      '<div class="page-head"><h1>指标分析</h1><p class="sub">趋势识别 → 异常标注 → 归因假设。<b>日</b>看今天要不要处理，<b>周</b>看这周发生了什么，粒度不要混用。</p></div>',
      '<div class="toolbar">',
      '<div class="seg">' + ['日', '周'].map(function (g) {
        return '<button data-act="gran" data-v="' + g + '"' + (ui.gran === g ? ' class="on"' : '') + '>' + g + '粒度</button>';
      }).join('') + '</div>',
      '<span class="chip na">指标 ' + an.rows.length + ' 项</span>',
      '<span class="chip bad">异常 ' + an.rows.filter(function (r) { return r.status === '异常'; }).length + '</span>',
      '<span class="chip warn">需关注 ' + an.rows.filter(function (r) { return r.status === '需关注'; }).length + '</span>',
      '<span class="spacer"></span>',
      '<button class="btn" data-act="metrics-ledger">写入台账</button>',
      '<button class="btn ghost" data-act="download" data-dl="metrics">下载报告 Markdown</button>',
      '<button class="btn ghost" data-act="download" data-dl="board">导出 HTML 看板</button>',
      '</div>',
      '<div class="card"><div class="card-head"><h3>核心指标概览</h3></div>' +
      '<table class="tbl"><thead><tr><th>指标</th><th>当期</th><th>对比基准</th><th>变化</th><th>状态</th><th>近 14 期</th><th>趋势</th></tr></thead><tbody>' +
      an.rows.map(function (r) {
        var t = r.trend.streak >= 3 ? '连续 ' + r.trend.streak + ' 期' + (r.trend.dir === 'up' ? '↑' : '↓') : '—';
        return '<tr><td>' + esc(r.metric) + '</td><td><b>' + esc(r.value) + '</b></td><td>' + (r.prevDate ? esc(r.prevDate) + ' ' : '') + (r.prev === null ? '—' : esc(r.prev)) + '</td>' +
          '<td>' + (r.change === null ? '—' : signed(r.change) + (r.changePct === null ? '' : '（' + signed(r.changePct, '%') + '）')) + '</td>' +
          '<td>' + chip(r.status, r.near) + '</td><td>' + C.sparkline(r.series.map(function (p) { return p.value; }), { color: C.STATUS_COLOR[r.status] }) + '</td>' +
          '<td class="sm">' + esc(t) + '</td></tr>';
      }).join('') + '</tbody></table></div>',
      '<div class="grid k2 mt">',
      '<div class="card"><div class="card-head"><h3>趋势图</h3><select data-act="metric-pick">' + an.rows.map(function (r) {
        return '<option value="' + esc(r.metric) + '"' + (r.metric === ui.metricPick ? ' selected' : '') + '>' + esc(r.metric) + '</option>';
      }).join('') + '</select></div>' + (pick ? C.lineChart(pick.series, { threshold: thr, color: C.STATUS_COLOR[pick.status] }) : '') + '</div>',
      '<div class="card"><h3>异常标注</h3>' + (an.anomalies.length ? an.anomalies.map(function (r) {
        return '<div class="anomaly ' + (r.status === '异常' ? 'bad' : 'warn') + '"><b>' + esc(r.metric) + ' ' + esc(r.value) + '</b> ' + chip(r.status, r.near) +
          '<small>' + esc(r.reason) + '</small>' + (r.hypothesis[0] ? '<small>首要假设：' + esc(r.hypothesis[0].text) + '</small>' : '') + '</div>';
      }).join('') : '<p class="muted">本期没有异常项。</p>') + '</div>',
      '</div>',
      '<div class="card mt"><h3>归因假设（按可能性排序）</h3>' + (an.anomalies.length ? an.anomalies.map(function (r) {
        return '<div class="hypo"><b>' + esc(r.metric) + '</b><ol>' + r.hypothesis.map(function (h) {
          return '<li>' + esc(h.text) + '<br><small class="muted">依据：' + esc(h.basis) + '　｜　验证：' + esc(h.verify) + '</small></li>';
        }).join('') + '</ol></div>';
      }).join('') : '<p class="muted">无异常，无需归因。</p>') + '</div>',
      '<div class="card mt"><h3>趋势与拐点</h3>' + (an.trends.length ? '<ul class="list">' + an.trends.map(function (r) {
        return '<li><b>' + esc(r.metric) + '</b>：连续 ' + r.trend.streak + ' 期' + (r.trend.dir === 'up' ? '上升' : '下降') + '，' + r.trend.from + ' → ' + r.trend.to + '</li>';
      }).join('') + '</ul>' : '<p class="muted">未发现连续 3 期以上的同向趋势（或样本不足）。</p>') + '</div>'
    ].join('');
  }
  // ---------------- 页面：用户分层 ----------------
  function runTags() {
    return E.tagUsers(state.users, cfg, { today: todayStr(), prevTags: S.prevTags() });
  }
  function viewTags() {
    if (!state.users.length) { return emptyBig('用户分层', '还没有用户数据。去「数据」页导入用户行为 CSV（含 注册日期 / 最近活跃日期 / 累计付费金额 / 反馈次数），或载入示例数据。'); }
    var tg = runTags();
    ui.last.tags = tg;
    var list = tg.rows.filter(function (r) { return !ui.search || (r.id + r.life + r.value + r.behavior).indexOf(ui.search) >= 0; });
    var dims = ['生命周期', '价值', '反馈行为'];
    return [
      '<div class="page-head"><h1>用户分层</h1><p class="sub">按生命周期 · 价值 · 反馈行为三个维度打标，输出带优先级的跟进名单与建议动作。「回流」通过台账历史自动识别。</p></div>',
      '<div class="toolbar"><span class="chip na">用户 ' + tg.rows.length + ' 位</span>' +
      '<span class="chip warn">高/中价值且沉默或流失 ' + tg.riskRows.length + ' 位</span><span class="spacer"></span>' +
      '<button class="btn primary" data-act="tag-ledger">写入台账</button>' +
      '<button class="btn ghost" data-act="download" data-dl="tags">下载 Markdown</button>' +
      '<button class="btn ghost" data-act="download" data-dl="tags-csv">导出标签 CSV</button></div>',
      '<div class="grid k3">',
      dims.map(function (d) {
        var items = tg.overview.filter(function (o) { return o.dim === d; });
        return '<div class="card"><h3>' + d + '</h3>' + C.barRows(items.map(function (o) {
          return { label: o.label, value: o.count + ' 人（' + o.pct + '%）', pct: o.pct };
        })) + '</div>';
      }).join(''),
      '</div>',
      '<div class="card mt"><div class="card-head"><h3>标签清单</h3><input class="search" placeholder="搜索用户 / 标签" data-act="tag-search" value="' + esc(ui.search) + '"><span class="muted sm">' + list.length + ' 人</span></div>',
      '<table class="tbl"><thead><tr><th>用户ID</th><th>生命周期</th><th>价值</th><th>反馈行为</th><th>变化</th><th>建议动作</th><th>依据</th></tr></thead><tbody>' +
      list.map(function (r) {
        return '<tr><td><b>' + esc(r.id) + '</b></td><td>' + esc(r.life) + '</td><td>' + esc(r.value) + '</td><td>' + esc(r.behavior) +
          (r.note ? '<br><small class="muted">' + esc(r.note) + '</small>' : '') + '</td>' +
          '<td>' + (r.changed ? '<span class="chip warn">' + esc(r.changed) + '</span>' : '—') + '</td>' +
          '<td>' + esc(r.action) + (r.extra ? '<br><small class="muted">+ ' + esc(r.extra) + '</small>' : '') + '</td>' +
          '<td class="sm muted">' + esc(r.lifeBasis || '') + '</td></tr>';
      }).join('') + '</tbody></table></div>',
      '<div class="card mt"><h3>优先跟进 Top5</h3><table class="tbl"><thead><tr><th>用户</th><th>分层</th><th>理由</th><th>建议动作</th></tr></thead><tbody>' +
      tg.followups.map(function (r) {
        return '<tr><td><b>' + esc(r.id) + '</b></td><td>' + esc(r.life + ' / ' + r.value + ' / ' + r.behavior) + '</td>' +
          '<td class="sm">距最近活跃 ' + (r.dAct === null ? '未知' : r.dAct + ' 天') + '，累计付费 ' + esc(r.user.amount) + ' 元</td>' +
          '<td>' + esc(r.action) + (r.extra ? '<br><small class="muted">+ ' + esc(r.extra) + '</small>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>',
      tg.riskRows.length ? '<div class="card mt notice"><b>流失风险提醒</b><p>' + tg.riskRows.map(function (r) {
        return esc(r.id + '（' + r.life + ' / ' + r.value + '）');
      }).join('、') + ' 属于高 / 中价值但已沉默或流失，建议本周进入挽回名单。</p></div>' : ''
    ].join('');
  }

  // ---------------- 页面：整合分析 ----------------
  function runIntegrated() {
    var fb = E.analyzeFeedback(feedbackInScope(), cfg);
    var rows = combinedRows();
    var trends = analyzeDaily().trends.concat(analyzeWeekly().trends).sort(function (a, b) { return b.trend.streak - a.trend.streak; });
    var tags = state.users.length ? runTags() : null;
    return E.integrated({
      cfg: cfg, feedback: fb, metrics: { rows: rows, trends: trends, granularity: ui.gran === '周' ? '周' : '日 + 周' },
      tags: tags, ledger: state.ledgers.ledger, consistency: consistency(),
      metricDates: Object.keys(byDateOf(daily())).sort(), feedbackDates: Object.keys(byDateOf(state.feedback)).sort()
    });
  }
  function viewIntegrated() {
    if (!daily().length && !weekly().length) { return emptyBig('整合分析', '先导入指标数据，再去「反馈分析」页确认反馈可用。整合分析需要两边都有数据才能做交叉验证。'); }
    if (!state.feedback.length) { return emptyBig('整合分析', '还没有反馈数据。交叉验证需要「数据证据」和「用户声音」两边都有内容，先去导入反馈 txt。'); }
    var it = runIntegrated();
    ui.last.integrated = it;
    return [
      '<div class="page-head"><h1>整合分析</h1><p class="sub">把反馈结论与指标结论放在同一张表里逐条对照：<b>印证</b>说明用户声音在数据上有体现，<b>背离</b>说明问题没被用户表达出来或口径覆盖不到。</p></div>',
      '<div class="toolbar"><span class="chip ok">印证 ' + it.counts.ok + '</span><span class="chip warn">背离 ' + it.counts.warn + '</span>' +
      '<span class="chip na">无法判断 ' + it.counts.na + '</span><span class="spacer"></span>' +
      '<button class="btn primary" data-act="integrated-ledger">写入台账</button>' +
      '<button class="btn ghost" data-act="download" data-dl="integrated">下载报告 Markdown</button></div>',
      '<div class="card"><h3>本期核心发现</h3><ol class="findings">' + it.findings.map(function (f) {
        return '<li>' + esc(f).replace(/\*\*/g, '<b>').replace(/\*\*/g, '</b>') + '</li>';
      }).join('') + '</ol></div>',
      '<div class="card mt"><h3>交叉验证表</h3><table class="tbl"><thead><tr><th>#</th><th>用户声音（反馈结论）</th><th>数据证据（指标结论）</th><th>结论</th><th>说明</th></tr></thead><tbody>' +
      it.cvRows.map(function (r, i) {
        var cls = r.concl.indexOf('印证') >= 0 ? 'ok' : r.concl.indexOf('背离') >= 0 ? 'warn' : 'na';
        return '<tr><td>' + (i + 1) + '</td><td>' + esc(r.voice) + '</td><td>' + esc(r.evidence) + '</td>' +
          '<td><span class="chip ' + cls + '">' + esc(r.concl) + '</span></td><td class="sm muted">' + esc(r.note) + '</td></tr>';
      }).join('') + '</tbody></table></div>',
      '<div class="card mt"><h3>产品策略建议</h3><table class="tbl"><thead><tr><th>优先级</th><th>动作</th><th>依据</th><th>预期效果</th><th>验证方式</th></tr></thead><tbody>' +
      it.strategies.map(function (s) {
        return '<tr><td><span class="chip ' + (s.level === 'P0' ? 'bad' : s.level === 'P1' ? 'warn' : 'na') + '">' + s.level + '</span></td>' +
          '<td><b>' + esc(s.action) + '</b></td><td class="sm">' + esc(s.basis) + '</td><td class="sm">' + esc(s.effect) + '</td><td class="sm">' + esc(s.verify) + '</td></tr>';
      }).join('') + '</tbody></table></div>',
      '<div class="grid k2 mt">',
      '<div class="card"><h3>下周监控重点</h3><table class="tbl"><thead><tr><th>指标</th><th>阈值</th><th>触发动作</th><th>负责人</th></tr></thead><tbody>' +
      it.monitoring.map(function (m) {
        return '<tr><td>' + esc(m.metric) + '</td><td>' + esc(m.threshold) + '</td><td class="sm">' + esc(m.action) + '</td><td>' + esc(m.owner) + '</td></tr>';
      }).join('') + '</tbody></table></div>',
      '<div class="card"><h3>数据缺口与补数清单</h3>' + (it.gaps.length ? '<ul class="list">' + it.gaps.map(function (g) { return '<li>' + esc(g) + '</li>'; }).join('') + '</ul>' : '<p class="muted">本期无数据缺口。</p>') + '</div>',
      '</div>'
    ].join('');
  }

  // ---------------- 页面：台账 ----------------
  function viewLedgers() {
    var kinds = ['ledger', 'metrics', 'tags'];
    var names = { ledger: '分析台账 ledger.csv', metrics: '指标台账 metrics-ledger.csv', tags: '标签台账 tag-ledger.csv' };
    var kind = ui.ledgerTab;
    var def = S.LEDGER_DEF[kind];
    var rows = state.ledgers[kind] || [];
    var list = rows.map(function (r, i) { return { r: r, i: i }; }).filter(function (x) {
      return !ui.search || JSON.stringify(x.r).indexOf(ui.search) >= 0;
    });
    return [
      '<div class="page-head"><h1>台账</h1><p class="sub">跨会话留痕：每次分析后自动追加，支持导出 CSV 与在 Excel 中继续分析。只追加，不建议覆盖。</p></div>',
      '<div class="toolbar"><div class="seg">' + kinds.map(function (k) {
        return '<button data-act="ledger-tab" data-v="' + k + '"' + (k === kind ? ' class="on"' : '') + '>' + esc(names[k].split(' ')[0]) + '（' + (state.ledgers[k] || []).length + '）</button>';
      }).join('') + '</div><span class="spacer"></span>' +
      '<input class="search" placeholder="搜索台账" data-act="ledger-search" value="' + esc(ui.search) + '">' +
      '<button class="btn ghost" data-act="ledger-export" data-kind="' + kind + '">导出 CSV</button>' +
      '<button class="btn ghost danger" data-act="ledger-clear" data-kind="' + kind + '">清空</button></div>',
      '<div class="card">' + (rows.length ? '<table class="tbl"><thead><tr><th>#</th>' + def.head.map(function (hh) { return '<th>' + esc(hh) + '</th>'; }).join('') + '<th></th></tr></thead><tbody>' +
        list.map(function (x) {
          return '<tr><td class="muted sm">' + (x.i + 1) + '</td>' + def.head.map(function (hh) { return '<td>' + esc(x.r[hh]) + '</td>'; }).join('') +
            '<td><button class="btn tiny ghost danger" data-act="ledger-del" data-kind="' + kind + '" data-i="' + x.i + '">删除</button></td></tr>';
        }).join('') + '</tbody></table>' : '<p class="muted">该台账还没有记录。运行对应分析后会自动写入。</p>') + '</div>'
    ].join('');
  }
  // ---------------- 页面：口径设置 ----------------
  function metricInput(label, key, val, width) {
    return '<label class="mini"><span>' + label + '</span><input type="number" step="0.1" style="width:' + (width || 64) + 'px" data-cfg="metric" data-metric="' + esc(key) + '" data-field="' + label + '" value="' + (val === undefined || val === null ? '' : val) + '"></label>';
  }
  function viewConfig() {
    var f = cfg.feedback, t = cfg.tags;
    return [
      '<div class="page-head"><h1>口径设置</h1><p class="sub">所有判定标准都在这里。改完点「保存设置」立即生效，设置随工作区一起保存在本机浏览器。</p></div>',
      '<div class="toolbar"><button class="btn primary" data-act="cfg-save">保存设置</button>' +
      '<button class="btn ghost" data-act="cfg-reset">恢复默认口径</button>' +
      '<button class="btn ghost" data-act="cfg-export">导出配置 JSON</button>' +
      '<label class="btn ghost">导入配置 JSON<input type="file" accept=".json" data-file="config" hidden></label></div>',
      '<div class="card"><h3>指标口径</h3><p class="muted sm">上升型指标填「正常 ≥ / 关注 ≥」，下降型填「正常 ≤ / 关注 ≤」；只有环比规则的指标填环比阈值（负数为下降）。留空表示不启用。</p>',
      '<div class="table-wrap"><table class="tbl cfg"><thead><tr><th>指标</th><th>方向</th><th>正常</th><th>关注</th><th>环比关注%</th><th>环比异常%</th><th>说明</th></tr></thead><tbody>',
      cfg.metrics.map(function (m) {
        return '<tr><td><b>' + esc(m.key) + '</b><br><small class="muted">' + esc(m.freq) + '</small></td>' +
          '<td>' + (m.better === 'up' ? '越大越好' : '越小越好') + '</td>' +
          '<td>' + (m.better === 'up' ? metricInput('≥', m.key, m.goodMin) : metricInput('≤', m.key, m.goodMax)) + '</td>' +
          '<td>' + (m.better === 'up' ? metricInput('≥', m.key, m.warnMin) : metricInput('≤', m.key, m.warnMax)) + '</td>' +
          '<td>' + metricInput('', m.key, m.momWarn, 72) + '</td>' +
          '<td>' + metricInput('', m.key, m.momBad, 72) + '</td>' +
          '<td class="sm muted">' + esc(m.note || '') + '</td></tr>';
      }).join('') + '</tbody></table></div></div>',
      '<div class="grid k2 mt">',
      '<div class="card"><h3>反馈判定词表</h3>' +
      '<label class="block"><span>负面特征词（逗号分隔）</span><textarea rows="3" data-cfg="fb" data-field="negative">' + esc(f.negativePatterns.join(',')) + '</textarea></label>' +
      '<label class="block"><span>正面特征词（逗号分隔）</span><textarea rows="2" data-cfg="fb" data-field="positive">' + esc(f.positivePatterns.join(',')) + '</textarea></label>' +
      '<label class="block"><span>问题分类（每行：分类名 = 关键词1,关键词2）</span><textarea rows="6" data-cfg="fb" data-field="categories">' +
      esc(f.categories.map(function (c) { return c.name + ' = ' + c.keywords.join(','); }).join('\n')) + '</textarea></label>' +
      '<p class="muted sm">按顺序匹配，先命中先归类；「其他」放最后且不填关键词。</p></div>',
      '<div class="card"><h3>用户标签阈值</h3>',
      '<div class="grid k2">',
      '<label class="block"><span>新用户（注册 ≤ N 天）</span><input type="number" data-cfg="tag" data-field="newUserDays" value="' + t.lifecycle.newUserDays + '"></label>',
      '<label class="block"><span>活跃（最近活跃 ≤ N 天）</span><input type="number" data-cfg="tag" data-field="activeDays" value="' + t.lifecycle.activeDays + '"></label>',
      '<label class="block"><span>沉默（≤ N 天）</span><input type="number" data-cfg="tag" data-field="silentDays" value="' + t.lifecycle.silentDays + '"></label>',
      '<label class="block"><span>流失风险（≤ N 天）</span><input type="number" data-cfg="tag" data-field="churnRiskDays" value="' + t.lifecycle.churnRiskDays + '"></label>',
      '<label class="block"><span>高价值（累计付费 ≥）</span><input type="number" data-cfg="tag" data-field="highMin" value="' + t.value.highMin + '"></label>',
      '<label class="block"><span>中价值（≥）</span><input type="number" data-cfg="tag" data-field="midMin" value="' + t.value.midMin + '"></label>',
      '<label class="block"><span>高频反馈（近 30 天 ≥ N 次）</span><input type="number" data-cfg="tag" data-field="highFreqCount" value="' + t.behavior.highFreqCount + '"></label>',
      '<label class="block"><span>问题反馈（最近反馈 ≤ N 天）</span><input type="number" data-cfg="tag" data-field="recentDays" value="' + t.behavior.recentDays + '"></label>',
      '</div>',
      '<label class="block"><span>建议动作矩阵（生命周期|价值 = 动作，每行一条）</span><textarea rows="6" data-cfg="tag" data-field="actions">' +
      esc(Object.keys(t.actions).map(function (k) { return k + ' = ' + t.actions[k]; }).join('\n')) + '</textarea></label></div>',
      '</div>',
      '<div class="card mt"><h3>AI 解读（可选）</h3><p class="muted sm">默认关闭。开启后，各模块会出现「AI 解读」按钮：把已算好的事实交给大模型写成一段解读。<b>Key 只保存在本机浏览器</b>，不会上传到本工作台之外的地方。不填也能用——所有分析都由本地规则引擎完成。</p>',
      '<div class="grid k3">',
      '<label class="block"><span>接口地址（OpenAI 兼容）</span><input type="text" data-cfg="llm" data-field="baseUrl" value="' + esc(state.llm.baseUrl) + '"></label>',
      '<label class="block"><span>模型名</span><input type="text" data-cfg="llm" data-field="model" value="' + esc(state.llm.model) + '"></label>',
      '<label class="block"><span>API Key</span><input type="password" data-cfg="llm" data-field="apiKey" value="' + esc(state.llm.apiKey) + '"></label>',
      '</div>',
      '<label class="inline"><input type="checkbox" data-cfg="llm" data-field="enabled"' + (state.llm.enabled ? ' checked' : '') + '> 启用 AI 解读按钮</label></div>'
    ].join('');
  }

  // ---------------- 通用小组件 ----------------
  function emptyBig(title, msg) {
    return '<div class="page-head"><h1>' + esc(title) + '</h1></div><div class="card empty"><p>' + esc(msg) + '</p>' +
      '<div class="row"><button class="btn primary" data-act="load-sample">载入示例数据</button>' +
      '<button class="btn" data-act="go" data-view="data">去导入数据</button></div></div>';
  }
  function aiCard(kind) {
    if (!state.llm.enabled) { return ''; }
    var txt = ui.ai && ui.ai[kind];
    return '<div class="card mt ai"><div class="card-head"><h3>AI 解读</h3>' +
      '<button class="btn tiny primary" data-act="ai" data-kind="' + kind + '">' + (txt ? '重新生成' : '生成解读') + '</button></div>' +
      (txt ? '<div class="ai-body">' + esc(txt).replace(/\n/g, '<br>') + '</div>' : '<p class="muted sm">把上面已算好的事实交给大模型润色成一段解读（需要先在「口径设置」里填 Key）。</p>') + '</div>';
  }
  // ---------------- 报告与导出 ----------------
  function computeCheck() {
    var s = summary();
    var d = ui.last.checkDate || s.latestDate || todayStr();
    return E.dailyCheck({ cfg: cfg, date: d, metrics: daily(), feedback: state.feedback.filter(function (f) { return f.date === d; }) });
  }
  function annotatedCSV() {
    var fb = E.analyzeFeedback(feedbackInScope(), cfg);
    var head = ['日期', '时间', '渠道', '用户ID', '内容', '情感', '问题类型', '关键词'];
    var esc2 = function (v) { var s = String(v === undefined || v === null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return [head.join(',')].concat(fb.annotated.map(function (a) {
      return [a.date, a.time, a.channel, a.userId, a.content, a.sentiment, a.category, (a.keywords || []).join(' ')].map(esc2).join(',');
    })).join('\r\n');
  }
  function tagsCSV() {
    var tg = ui.last.tags || runTags();
    var head = ['用户ID', '生命周期', '价值', '反馈行为', '变化', '建议动作'];
    return [head.join(',')].concat(tg.rows.map(function (r) {
      return [r.id, r.life, r.value, r.behavior, r.changed, r.action + (r.extra ? ' + ' + r.extra : '')].join(',');
    })).join('\r\n');
  }
  function boardHTML() {
    var an = analyzePicked();
    var rows = an.rows.map(function (r) {
      return '<tr><td>' + esc(r.metric) + '</td><td><b>' + esc(r.value) + '</b></td><td>' + (r.changePct === null ? '—' : signed(r.changePct, '%')) + '</td>' +
        '<td>' + esc(r.status) + '</td><td>' + C.sparkline(r.series.map(function (p) { return p.value; }), { color: C.STATUS_COLOR[r.status] }) + '</td></tr>';
    }).join('');
    var chart = an.anomalies.length ? C.lineChart(an.anomalies[0].series, { threshold: an.anomalies[0].rule.better === 'up' ? an.anomalies[0].rule.warnMin : an.anomalies[0].rule.warnMax, color: '#e5484d', width: 760, height: 260 }) : '';
    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>运营指标看板 · ' + todayStr() + '</title>' +
      '<style>body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;background:#f5f4fb;color:#1c1b2e;margin:0;padding:28px}' +
      '.wrap{max-width:1000px;margin:0 auto}h1{font-size:23px;margin:0 0 4px;color:#1c1b2e}.sub{color:#7a7a92;font-size:13px;margin:0 0 20px}' +
      '.card{background:#fff;border-radius:16px;padding:18px 22px;margin-bottom:16px;box-shadow:0 1px 2px rgba(28,27,46,.05),0 14px 30px -18px rgba(28,27,46,.18)}' +
      'table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:8px 10px;border-bottom:1px solid #eeecf7;text-align:left}' +
      'th{color:#a2a0b8;font-weight:600;text-transform:none}h3{font-size:15px;margin:0 0 12px}.kpi{display:flex;gap:14px}.kpi div{flex:1;background:#fff;border-radius:16px;padding:16px 18px;box-shadow:0 1px 2px rgba(28,27,46,.05)}' +
      '.kpi b{display:block;font-size:26px;margin:2px 0;letter-spacing:-.02em}.kpi span{font-size:12px;color:#7a7a92}</style></head><body><div class="wrap">' +
      '<h1>运营指标看板</h1><p class="sub">生成时间 ' + new Date().toLocaleString('zh-CN') + '　·　粒度 ' + esc(an.granularity) + '　·　由运营工作台 Web 版导出</p>' +
      '<div class="kpi"><div><span>指标数</span><b>' + an.rows.length + '</b></div><div><span>异常</span><b>' + an.rows.filter(function (r) { return r.status === '异常'; }).length + '</b></div>' +
      '<div><span>需关注</span><b>' + an.rows.filter(function (r) { return r.status === '需关注'; }).length + '</b></div><div><span>连续趋势项</span><b>' + an.trends.length + '</b></div></div>' +
      (chart ? '<div class="card"><h3>重点异常走势：' + esc(an.anomalies[0].metric) + '</h3>' + chart + '</div>' : '') +
      '<div class="card"><h3>核心指标概览</h3><table><thead><tr><th>指标</th><th>当期</th><th>变化</th><th>状态</th><th>近 14 期</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="card"><h3>异常与归因假设</h3>' + (an.anomalies.length ? an.anomalies.map(function (r) {
        return '<p><b>' + esc(r.metric) + ' ' + esc(r.value) + '（' + esc(r.status) + '）</b><br><span style="color:#7a7a92;font-size:12px">' +
          (r.hypothesis || []).map(function (h) { return esc(h.text); }).join('；') + '</span></p>';
      }).join('') : '<p>本期无异常</p>') + '</div></div></body></html>';
  }
  function buildReport(kind) {
    var s = summary();
    if (kind === 'check') { var r = computeCheck(); return { name: '晨检简报-' + r.date + '.md', text: '# 晨检简报 ' + r.date + '\n\n' + r.report + '\n' }; }
    if (kind === 'feedback') {
      var fb = E.analyzeFeedback(feedbackInScope(), cfg);
      return { name: '反馈分析-' + todayStr() + '.md', text: '# 反馈分析报告（' + todayStr() + '）\n\n数据范围：全部反馈 ' + fb.total + ' 条\n\n' + fb.report + '\n' };
    }
    if (kind === 'feedback-csv') { return { name: '反馈明细-' + todayStr() + '.csv', text: annotatedCSV(), mime: 'text/csv' }; }
    if (kind === 'metrics') { var an = analyzePicked();
      return { name: '指标分析-' + an.granularity + '-' + todayStr() + '.md', text: '# 指标分析报告（' + an.granularity + '粒度）\n\n' + an.report + '\n' }; }
    if (kind === 'board') { return { name: '指标看板-' + todayStr() + '.html', text: boardHTML(), mime: 'text/html' }; }
    if (kind === 'tags') { var tg = ui.last.tags || runTags(); return { name: '用户标签-' + todayStr() + '.md', text: '# 用户标签清单（' + tg.today + '）\n\n' + tg.report + '\n' }; }
    if (kind === 'tags-csv') { return { name: '用户标签-' + todayStr() + '.csv', text: tagsCSV(), mime: 'text/csv' }; }
    if (kind === 'integrated') { var it = ui.last.integrated || runIntegrated();
      return { name: '整合分析-' + todayStr() + '.md', text: '# 运营整合分析（' + todayStr() + '）\n\n' + it.report + '\n' }; }
    return null;
  }

  // ---------------- 事件 ----------------
  function go(v) {
    view = v; ui.search = ''; render(); window.scrollTo(0, 0);
    var sb = document.getElementById('sidebar'); if (sb) { sb.classList.remove('open'); }
  }
  function refocus(sel) {
    var el = $(sel);
    if (el && el.tagName === 'INPUT') { el.focus(); try { el.selectionStart = el.selectionEnd = el.value.length; } catch (e) { } }
  }
  function handleFiles(kind, files) {
    if (!files || !files.length) { return; }
    var n = 0, total = files.length, added = 0;
    Array.prototype.forEach.call(files, function (f) {
      var fr = new FileReader();
      fr.onload = function () {
        var text = String(fr.result);
        var date = (f.name.match(/\d{4}-\d{2}-\d{2}/) || [])[0] || todayStr();
        try {
          if (kind === 'daily') { added += S.addDaily(E.parseDailyCSV(text, date)); }
          else if (kind === 'weekly') { added += S.addWeekly(E.parseWeeklyCSV(text)); }
          else if (kind === 'users') { added += S.addUsers(E.parseUsersCSV(text)); }
          else if (kind === 'feedback') { added += S.addFeedback(E.parseFeedbackTXT(text, date)); }
        } catch (e) { toast('解析失败：' + f.name); }
        if (++n === total) { toast('已导入 ' + added + ' 条'); render(); }
      };
      fr.readAsText(f, 'UTF-8');
    });
  }
  function importPaste(kind) {
    var ta = $('[data-text="' + kind + '"]');
    if (!ta || !ta.value.trim()) { toast('请先粘贴内容'); return; }
    var text = ta.value.trim();
    var date = todayStr();
    var added = 0;
    if (kind === 'daily') { added = S.addDaily(E.parseDailyCSV(text, date)); }
    else if (kind === 'weekly') { added = S.addWeekly(E.parseWeeklyCSV(text)); }
    else if (kind === 'users') { added = S.addUsers(E.parseUsersCSV(text)); }
    else if (kind === 'feedback') { added = S.addFeedback(E.parseFeedbackTXT(text, date)); }
    ta.value = '';
    toast(added ? '已导入 ' + added + ' 条' : '没有解析到有效数据，请检查表头与分隔符');
    render();
  }
  function saveConfig() {
    var group = {};
    $$('input[data-cfg="metric"]').forEach(function (inp) {
      var k = inp.getAttribute('data-metric');
      (group[k] = group[k] || []).push(inp);
    });
    var setOrDel = function (obj, key, val) { if (val === null || val === undefined || isNaN(val)) { delete obj[key]; } else { obj[key] = val; } };
    Object.keys(group).forEach(function (k) {
      var m = cfg.metrics.filter(function (x) { return x.key === k; })[0];
      if (!m) { return; }
      var ins = group[k];
      var v = function (i) { if (!ins[i]) { return null; } var s = String(ins[i].value).trim(); return s === '' ? null : Number(s); };
      if (m.better === 'up') { setOrDel(m, 'goodMin', v(0)); setOrDel(m, 'warnMin', v(1)); delete m.goodMax; delete m.warnMax; }
      else { setOrDel(m, 'goodMax', v(0)); setOrDel(m, 'warnMax', v(1)); delete m.goodMin; delete m.warnMin; }
      setOrDel(m, 'momWarn', v(2)); setOrDel(m, 'momBad', v(3));
    });
    var neg = $('textarea[data-cfg="fb"][data-field="negative"]'); if (neg) { cfg.feedback.negativePatterns = neg.value.split(/[,，\n]/).map(function (x) { return x.trim(); }).filter(Boolean); }
    var pos = $('textarea[data-cfg="fb"][data-field="positive"]'); if (pos) { cfg.feedback.positivePatterns = pos.value.split(/[,，\n]/).map(function (x) { return x.trim(); }).filter(Boolean); }
    var cat = $('textarea[data-cfg="fb"][data-field="categories"]');
    if (cat) {
      var cats = cat.value.split('\n').map(function (line) {
        var p = line.split('=');
        if (p.length < 2) { return null; }
        return { name: p[0].trim(), keywords: p.slice(1).join('=').split(/[,，]/).map(function (x) { return x.trim(); }).filter(Boolean), severity: (cfg.feedback.categories.filter(function (c) { return c.name === p[0].trim(); })[0] || {}).severity || 2 };
      }).filter(Boolean);
      if (cats.length) { cfg.feedback.categories = cats; }
    }
    var tset = function (field, group) {
      var el = $('input[data-cfg="tag"][data-field="' + field + '"]');
      if (!el || el.value === '') { return; }
      var v = Number(el.value);
      if (!isNaN(v)) { cfg.tags[group][field] = v; }
    };
    tset('newUserDays', 'lifecycle'); tset('activeDays', 'lifecycle'); tset('silentDays', 'lifecycle'); tset('churnRiskDays', 'lifecycle');
    tset('highMin', 'value'); tset('midMin', 'value');
    tset('highFreqCount', 'behavior'); tset('recentDays', 'behavior');
    var act = $('textarea[data-cfg="tag"][data-field="actions"]');
    if (act) {
      var map = {};
      act.value.split('\n').forEach(function (line) {
        var p = line.split('=');
        if (p.length >= 2 && p[0].indexOf('|') > 0) { map[p[0].trim()] = p.slice(1).join('=').trim(); }
      });
      if (Object.keys(map).length) { cfg.tags.actions = map; }
    }
    $$('input[data-cfg="llm"]').forEach(function (el) {
      var f = el.getAttribute('data-field');
      if (!f) { return; }
      state.llm[f] = el.type === 'checkbox' ? el.checked : el.value;
    });
    S.save();
    toast('设置已保存');
    render();
  }
  // ---------------- AI 解读（可选） ----------------
  function factsFor(kind) {
    if (kind === 'check') { var r = computeCheck(); return '【晨检简报】\n' + r.brief + '\n\n待办：\n' + r.todos.map(function (t) { return t.text + '（依据：' + t.basis + '）'; }).join('\n'); }
    if (kind === 'feedback') { var fb = E.analyzeFeedback(feedbackInScope(), cfg); return fb.report + '\n\n需求优先级：\n' + fb.requirements.map(function (x) { return x.level + ' ' + x.title + '：' + x.reason; }).join('\n'); }
    if (kind === 'metrics') { var an = analyzePicked(); return an.report; }
    if (kind === 'tags') { var tg = ui.last.tags || runTags(); return tg.report; }
    if (kind === 'integrated') { var it = ui.last.integrated || runIntegrated(); return it.report; }
    return '';
  }
  function runAI(kind) {
    if (!window.OpsLLM) { toast('AI 模块未加载'); return; }
    toast('正在生成 AI 解读…');
    window.OpsLLM.enhance({ llm: state.llm, task: kind, facts: factsFor(kind) }).then(function (text) {
      ui.ai = ui.ai || {}; ui.ai[kind] = text; render(); toast('AI 解读已生成');
    }).catch(function (e) { toast('AI 解读失败：' + (e && e.message ? e.message : e)); });
  }
  function readJSONFile(file, cb) {
    var fr = new FileReader();
    fr.onload = function () { try { cb(JSON.parse(String(fr.result))); } catch (e) { toast('JSON 解析失败'); } };
    fr.readAsText(file, 'UTF-8');
  }

  // ---------------- 渲染 ----------------
  var VIEWS = { dashboard: viewDashboard, data: viewData, check: viewCheck, feedback: viewFeedback, metrics: viewMetrics, tags: viewTags, integrated: viewIntegrated, ledgers: viewLedgers, config: viewConfig };
  function render() {
    var nav = $('#nav');
    if (nav) {
      var navGroup = '';
      nav.innerHTML = NAV.map(function (n) {
        var head = '';
        if (n.group !== navGroup) { head = '<div class="nav-group">' + esc(n.group) + '</div>'; navGroup = n.group; }
        return head + '<button class="nav-item' + (view === n.id ? ' on' : '') + '" data-act="go" data-view="' + n.id + '">' +
          '<span class="nav-ico">' + n.icon + '</span><span class="nav-txt"><b>' + esc(n.label) + '</b><small>' + esc(n.hint) + '</small></span></button>';
      }).join('');
    }
    var box = $('#view');
    if (box) { box.innerHTML = (VIEWS[view] || viewDashboard)() + aiCard(view); }
    var s = summary();
    var st = $('#statusBar');
    if (st) {
      st.textContent = '日指标 ' + (s.dailyRows ? s.dailyDates.length + ' 天' : '—') + '　反馈 ' + s.feedback + ' 条　用户 ' + s.users +
        ' 位　台账 ' + (state.ledgers.ledger.length + state.ledgers.metrics.length + state.ledgers.tags.length) + ' 条　同步 ' +
        (state.sync && state.sync.last ? (state.sync.last.ok ? '正常' : '异常') : '未同步');
    }
  }

  // ---------------- 事件绑定 ----------------
  function onClick(e) {
    var t = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!t) { return; }
    var act = t.getAttribute('data-act');
    var kind = t.getAttribute('data-kind') || t.getAttribute('data-dl');
    if (act === 'go') { go(t.getAttribute('data-view')); }
    else if (act === 'rerender') { render(); }
    else if (act === 'sync-now') { doSync(false); }
    else if (act === 'sync-check') { doSync(true); }
    else if (act === 'sync-source-save') { var su = $('[data-input="sync-source"]'); var sv = (su && su.value.trim()) ? su.value.trim() : 'data/'; SY.setConfig({ baseUrl: sv }); toast('数据源地址已保存：' + sv); render(); }
    else if (act === 'sync-forget') { if (window.confirm('清空同步记录？下次同步会重新下载全部文件（已入库的数据不受影响）。')) { SY.forget(); toast('已清空同步记录'); render(); } }
    else if (act === 'load-sample') { S.loadSample(); toast('示例数据已载入'); view = 'dashboard'; render(); }
    else if (act === 'clear') {
      if (window.confirm('确认清空该数据？此操作不可撤销。')) { S.clearData(kind); toast('已清空'); render(); }
    }
    else if (act === 'toggle-paste') { var p = $('[data-paste="' + kind + '"]'); if (p) { p.hidden = !p.hidden; } }
    else if (act === 'import-paste') { importPaste(kind); }
    else if (act === 'export-all') { download('ops-workbench-' + todayStr() + '.json', S.exportJSON(), 'application/json'); }
    else if (act === 'check-ledger') { var n1 = writeCheckLedger(computeCheck()); toast('已写入台账 ' + n1 + ' 条'); render(); }
    else if (act === 'feedback-ledger') { var n2 = writeFeedbackLedger(E.analyzeFeedback(feedbackInScope(), cfg), '全部反馈 ' + state.feedback.length + ' 条'); toast('已写入台账 ' + n2 + ' 条'); render(); }
    else if (act === 'metrics-ledger') { var n3 = writeMetricsLedger(analyzePicked(), ui.gran === '周' ? 'data/weekly' : 'data/daily'); toast('已写入台账 ' + n3 + ' 条'); render(); }
    else if (act === 'tag-ledger') { var n4 = writeTagLedger(ui.last.tags || runTags()); toast('已写入台账 ' + n4 + ' 条'); render(); }
    else if (act === 'integrated-ledger') { var n5 = writeIntegratedLedger(ui.last.integrated || runIntegrated()); toast('已写入台账 ' + n5 + ' 条'); render(); }
    else if (act === 'download') { var r = buildReport(kind); if (r) { download(r.name, r.text, r.mime || 'text/markdown'); toast('已下载 ' + r.name); } }
    else if (act === 'copy') { var box = $('#briefBox'); if (box && navigator.clipboard) { navigator.clipboard.writeText(box.textContent).then(function () { toast('已复制'); }); } }
    else if (act === 'fb-filter') { ui.fbFilter = t.getAttribute('data-v'); render(); refocus('[data-act="fb-search"]'); }
    else if (act === 'gran') { ui.gran = t.getAttribute('data-v'); render(); }
    else if (act === 'ledger-tab') { ui.ledgerTab = t.getAttribute('data-v'); ui.search = ''; render(); }
    else if (act === 'ledger-del') { S.removeLedger(kind, Number(t.getAttribute('data-i'))); toast('已删除 1 条'); render(); }
    else if (act === 'ledger-export') { var csv = S.toCSV(kind); download(S.LEDGER_DEF[kind].file, '\ufeff' + csv, 'text/csv'); toast('已导出 CSV'); }
    else if (act === 'ledger-clear') { if (window.confirm('确认清空该台账？')) { state.ledgers[kind] = []; S.save(); render(); } }
    else if (act === 'cfg-save') { saveConfig(); }
    else if (act === 'cfg-reset') { if (window.confirm('恢复默认口径？已保存的自定义设置会丢失。')) { cfg = JSON.parse(JSON.stringify(D.DEFAULT_CONFIG)); state.config = cfg; S.save(); toast('已恢复默认'); render(); } }
    else if (act === 'cfg-export') { download('ops-config-' + todayStr() + '.json', JSON.stringify(cfg, null, 2), 'application/json'); }
    else if (act === 'ai') { runAI(kind); }
  }
  function onChange(e) {
    var t = e.target;
    if (t.matches('input[data-input="sync-auto"]')) { SY.setConfig({ auto: t.checked }); toast(t.checked ? '已开启自动同步：打开页面即拉取后台数据' : '已关闭自动同步'); return; }
    if (t.matches('select[data-act="pick-date"]')) { ui.last.checkDate = t.value; render(); return; }
    if (t.matches('select[data-act="metric-pick"]')) { ui.metricPick = t.value; render(); return; }
    if (t.type === 'file' && t.getAttribute('data-file')) {
      var kind = t.getAttribute('data-file');
      if (kind === 'workspace') {
        readJSONFile(t.files[0], function (obj) { S.importJSON(JSON.stringify(obj)); cfg = state.config; toast('工作区已导入'); render(); });
      } else if (kind === 'config') {
        readJSONFile(t.files[0], function (obj) { if (!obj || !obj.metrics) { toast('配置格式不正确'); return; } cfg = obj; state.config = obj; S.save(); toast('配置已导入'); render(); });
      } else { handleFiles(kind, t.files); }
      t.value = '';
    }
  }
  function onInput(e) {
    var t = e.target, act = t.getAttribute && t.getAttribute('data-act');
    if (act === 'fb-search') { ui.search = t.value; render(); refocus('[data-act="fb-search"]'); }
    else if (act === 'tag-search') { ui.search = t.value; render(); refocus('[data-act="tag-search"]'); }
    else if (act === 'ledger-search') { ui.search = t.value; render(); refocus('[data-act="ledger-search"]'); }
  }
  function filterNav(q) {
    var s = String(q || '').trim().toLowerCase();
    var items = document.querySelectorAll('#nav .nav-item');
    var groups = document.querySelectorAll('#nav .nav-group');
    for (var i = 0; i < items.length; i++) {
      var txt = (items[i].textContent || '').toLowerCase();
      var show = !s || txt.indexOf(s) >= 0;
      items[i].classList[show ? 'remove' : 'add']('off');
    }
    for (var g = 0; g < groups.length; g++) { groups[g].style.display = s ? 'none' : ''; }
  }
  function init() {
    var nt = document.getElementById('navToggle');
    if (nt) { nt.addEventListener('click', function () { var sb = document.getElementById('sidebar'); if (sb) { sb.classList.toggle('open'); } }); }
    var rf = document.getElementById('topRefresh');
    if (rf) { rf.addEventListener('click', function () { ui.last = {}; render(); toast('已刷新'); }); }
    var bl = document.getElementById('topBell');
    if (bl) { bl.addEventListener('click', function () { go('check'); }); }
    var gs = document.getElementById('globalSearch');
    if (gs) {
      gs.addEventListener('input', function () { filterNav(gs.value); });
      gs.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          var first = document.querySelector('#nav .nav-item:not(.off)');
          if (first) { go(first.getAttribute('data-view')); gs.value = ''; filterNav(''); }
        } else if (e.key === 'Escape') { gs.value = ''; filterNav(''); }
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName || '')) { e.preventDefault(); gs.focus(); }
      });
    }
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    document.addEventListener('input', onInput);
    render();
    autoSyncOnce();
  }
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }
})();