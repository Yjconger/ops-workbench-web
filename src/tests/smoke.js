/* smoke.js — 浏览器端到端冒烟测试（开发用，不参与线上页面）
   用法：在 src 目录起静态服务器后，用浏览器打开 tests/smoke.html 或 tests/smoke.html：
   页面会把 PASS/FAIL 清单写入 <pre id="smokeResult"> 与 document.title（SMOKE_OK / SMOKE_FAIL_n）。 */
(function () {
  'use strict';
  var out = [], errors = [];
  window.addEventListener('error', function (e) { errors.push('window.error: ' + (e.message || e.type)); });
  window.addEventListener('unhandledrejection', function (e) { errors.push('unhandled: ' + (e.reason && e.reason.message ? e.reason.message : e.reason)); });

  function ok(name, cond, extra) { out.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : '')); }
  function q(s) { return document.querySelector(s); }
  function qa(s) { return document.querySelectorAll(s); }
  function click(el) { if (el) { el.click(); return true; } return false; }
  function text(s) { var el = q(s); return el ? el.textContent || '' : ''; }
  function html(s) { var el = q(s); return el ? el.innerHTML : ''; }
  function clickDl(viewId, kind) {
    click(q('#nav [data-view="' + viewId + '"]'));
    return click(q('#view [data-act="download"][data-dl="' + kind + '"]'));
  }

  // 拦截下载：无头浏览器里真实 a.click() 会挂住进程，这里只记录文件名与体积
  function installDownloadSpy() {
    window.__exports = [];
    var last = null;
    URL.createObjectURL = function (blob) { last = blob; return 'blob:spy'; };
    URL.revokeObjectURL = function () { };
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) { window.__exports.push({ name: this.download, size: last ? last.size : 0 }); }
    };
  }
  function exportNames() { return (window.__exports || []).map(function (x) { return x.name; }); }
  function exportOf(re) { var hit = (window.__exports || []).filter(function (x) { return re.test(x.name); }); return hit[0] || null; }

  function run() {
    try { window.localStorage.removeItem('ops-workbench-web-v1'); } catch (e) { }
    installDownloadSpy();

    // 1. 空态
    ok('空态渲染无报错', html('#view').length > 50, 'len=' + html('#view').length);
    ok('导航渲染 9 项', qa('#nav .nav-item').length === 9, 'n=' + qa('#nav .nav-item').length);

    // 2. 载入示例数据
    click(q('#sidebar [data-act="load-sample"]'));
    var st = window.OpsStore.state();
    ok('示例数据 日指标行数 = 126', st.daily.length === 126, 'rows=' + st.daily.length);
    ok('示例数据 周指标行数 = 48', st.weekly.length === 48, 'rows=' + st.weekly.length);
    ok('示例数据 用户 = 12', st.users.length === 12, 'n=' + st.users.length);
    ok('示例数据 反馈 = 24', st.feedback.length === 24, 'n=' + st.feedback.length);
    ok('顶栏状态栏显示统计', text('#statusBar').indexOf('日指标') >= 0, text('#statusBar').trim());

    // 3. 九个视图逐个渲染
    var views = [['dashboard', '概览'], ['data', '导入'], ['check', '每日晨检'], ['feedback', '情感'], ['metrics', '指标'], ['tags', '标签'], ['integrated', '交叉验证'], ['ledgers', '台账'], ['config', '口径']];
    views.forEach(function (v) {
      click(q('#nav [data-view="' + v[0] + '"]'));
      var h = html('#view');
      ok('视图 ' + v[0] + ' 渲染有内容', h.length > 400, 'len=' + h.length);
      ok('视图 ' + v[0] + ' 含关键词「' + v[1] + '」', h.indexOf(v[1]) >= 0);
    });

    // 4. 每日晨检
    click(q('#nav [data-view="check"]'));
    var l0 = window.OpsStore.state().ledgers.ledger.length;
    click(q('#view [data-act="check-ledger"]'));
    ok('晨检写入台账', window.OpsStore.state().ledgers.ledger.length > l0, l0 + ' -> ' + window.OpsStore.state().ledgers.ledger.length);
    var brief = text('#briefBox').replace(/\s/g, '');
    ok('晨检简报 20-200 字', brief.length > 20 && brief.length <= 200, 'len=' + brief.length);
    ok('晨检待办 2-3 条', qa('#view .todo').length >= 2 && qa('#view .todo').length <= 3, 'n=' + qa('#view .todo').length);
    ok('晨检指标表含异常状态', qa('#view .chip.bad').length >= 1, 'n=' + qa('#view .chip.bad').length);
    ok('晨检表有迷你走势线', qa('#view svg.spark').length >= 3, 'n=' + qa('#view svg.spark').length);

    // 5. 反馈分析
    click(q('#nav [data-view="feedback"]'));
    var l1 = window.OpsStore.state().ledgers.ledger.length;
    click(q('#view [data-act="feedback-ledger"]'));
    ok('反馈写入台账', window.OpsStore.state().ledgers.ledger.length > l1);
    ok('反馈有环形图', qa('#view .donut-wrap svg').length === 1, 'n=' + qa('#view .donut-wrap svg').length);
    ok('反馈有图例', qa('#view .legend').length === 1);
    ok('反馈有高频问题 Top5', html('#view').indexOf('高频问题 Top5') >= 0);
    ok('反馈有需求建议表', html('#view').indexOf('需求建议') >= 0);

    // 6. 指标分析
    click(q('#nav [data-view="metrics"]'));
    var m0 = window.OpsStore.state().ledgers.metrics.length;
    click(q('#view [data-act="metrics-ledger"]'));
    ok('指标写入台账', window.OpsStore.state().ledgers.metrics.length > m0, 'n=' + window.OpsStore.state().ledgers.metrics.length);
    ok('指标有折线趋势图', qa('#view svg.line').length >= 1, 'n=' + qa('#view svg.line').length);
    ok('指标有异常标注卡', qa('#view .anomaly').length >= 1, 'n=' + qa('#view .anomaly').length);
    ok('指标有归因假设', qa('#view .hypo').length >= 1, 'n=' + qa('#view .hypo').length);
    ok('指标有迷你走势线（>=3）', qa('#view svg.spark').length >= 3, 'n=' + qa('#view svg.spark').length);

    // 7. 用户分层
    click(q('#nav [data-view="tags"]'));
    var t0 = window.OpsStore.state().ledgers.tags.length;
    click(q('#view [data-act="tag-ledger"]'));
    ok('标签写入台账', window.OpsStore.state().ledgers.tags.length > t0, 'n=' + window.OpsStore.state().ledgers.tags.length);
    ok('标签页有条形图', qa('#view .bar-row').length >= 1, 'n=' + qa('#view .bar-row').length);

    // 8. 整合分析
    click(q('#nav [data-view="integrated"]'));
    var g0 = window.OpsStore.state().ledgers.ledger.length;
    click(q('#view [data-act="integrated-ledger"]'));
    ok('整合写入台账', window.OpsStore.state().ledgers.ledger.length > g0);
    var ih = html('#view');
    ok('整合含「印证」结论', ih.indexOf('印证') >= 0);
    ok('整合含「背离」结论', ih.indexOf('背离') >= 0);
    ok('整合含「无法判断」结论', ih.indexOf('无法判断') >= 0);
    ok('整合有核心发现列表', qa('#view ol.findings').length >= 1, 'n=' + qa('#view ol.findings').length);

    // 9. 台账页
    click(q('#nav [data-view="ledgers"]'));
    ok('台账页有表格', qa('#view table.tbl').length >= 1, 'n=' + qa('#view table.tbl').length);
    ok('台账页有数据行（>=2）', qa('#view table.tbl tbody tr').length >= 2, 'n=' + qa('#view table.tbl tbody tr').length);

    // 10. 导出：真实点击下载按钮，断言文件名与体积
    click(q('#view [data-act="ledger-tab"][data-v="metrics"]'));
    click(q('#view [data-act="ledger-export"]'));
    ok('导出台账 CSV', !!exportOf(/^metrics-ledger\.csv$/), exportNames().join(','));

    clickDl('check', 'check');
    var e1 = exportOf(/^晨检简报-\d{4}-\d{2}-\d{2}\.md$/);
    ok('导出晨检简报 Markdown', !!e1 && e1.size > 100, e1 ? e1.name + ' ' + e1.size + 'B' : exportNames().join(','));

    clickDl('feedback', 'feedback');
    var e2 = exportOf(/^反馈分析-\d{4}-\d{2}-\d{2}\.md$/);
    ok('导出反馈分析 Markdown', !!e2 && e2.size > 100, e2 ? e2.name + ' ' + e2.size + 'B' : exportNames().join(','));
    clickDl('feedback', 'feedback-csv');
    ok('导出反馈明细 CSV', !!exportOf(/^反馈明细-\d{4}-\d{2}-\d{2}\.csv$/), exportNames().join(','));

    clickDl('metrics', 'metrics');
    var e3 = exportOf(/^指标分析-.+-\d{4}-\d{2}-\d{2}\.md$/);
    ok('导出指标分析 Markdown', !!e3 && e3.size > 100, e3 ? e3.name + ' ' + e3.size + 'B' : exportNames().join(','));
    clickDl('metrics', 'board');
    var e4 = exportOf(/^指标看板-\d{4}-\d{2}-\d{2}\.html$/);
    ok('导出 HTML 看板', !!e4 && e4.size > 500, e4 ? e4.name + ' ' + e4.size + 'B' : exportNames().join(','));

    clickDl('tags', 'tags');
    ok('导出用户标签 Markdown', !!exportOf(/^用户标签-\d{4}-\d{2}-\d{2}\.md$/), exportNames().join(','));
    clickDl('tags', 'tags-csv');
    ok('导出用户标签 CSV', !!exportOf(/^用户标签-\d{4}-\d{2}-\d{2}\.csv$/), exportNames().join(','));

    clickDl('integrated', 'integrated');
    ok('导出整合分析 Markdown', !!exportOf(/^整合分析-\d{4}-\d{2}-\d{2}\.md$/), exportNames().join(','));

    click(q('#nav [data-view="config"]'));
    click(q('#view [data-act="cfg-export"]'));
    ok('导出口径配置 JSON', !!exportOf(/^ops-config-\d{4}-\d{2}-\d{2}\.json$/), exportNames().join(','));
    ok('导出文件总数 >= 9', (window.__exports || []).length >= 9, 'n=' + (window.__exports || []).length);

    click(q('#sidebar [data-act="export-all"]'));
    ok('导出整个工作区 JSON', !!exportOf(/^ops-workbench-\d{4}-\d{2}-\d{2}\.json$/), exportNames().join(','));

    // 11. 持久化
    var raw = null;
    try { raw = window.localStorage.getItem('ops-workbench-web-v1'); } catch (e) { }
    ok('localStorage 已持久化', !!raw && raw.length > 1000, 'len=' + (raw ? raw.length : 0));
    if (raw) {
      var parsed = JSON.parse(raw);
      ok('持久化含台账记录', parsed.ledgers.ledger.length >= 2, 'n=' + parsed.ledgers.ledger.length);
      ok('持久化含三项台账', !!(parsed.ledgers.ledger && parsed.ledgers.metrics && parsed.ledgers.tags));
      ok('持久化含口径配置', !!parsed.config && parsed.config.metrics.length === 11, 'metrics=' + (parsed.config && parsed.config.metrics ? parsed.config.metrics.length : 0));
    }

    // 12. 口径设置页可编辑
    click(q('#nav [data-view="config"]'));
    ok('口径页有指标表格', qa('#view table.tbl.cfg tbody tr').length === 11, 'n=' + qa('#view table.tbl.cfg tbody tr').length);
    ok('口径页有反馈词表', html('#view').indexOf('反馈') >= 0);
  }

  function finish() {
    try { run(); } catch (e) { out.push('FAIL | 运行期异常: ' + e.message + ' @ ' + String(e.stack || '').split('\n')[1]); }
    errors.forEach(function (e) { out.push('FAIL | ' + e); });
    var totalFailed = out.filter(function (l) { return l.indexOf('FAIL') === 0; }).length;
    out.push('SUMMARY | total=' + out.length + ' failed=' + totalFailed);
    var box = document.getElementById('smokeResult');
    if (box) { box.textContent = out.join('\n'); }
    document.title = totalFailed === 0 ? 'SMOKE_OK' : 'SMOKE_FAIL_' + totalFailed;
  }

  if (document.readyState === 'complete') { finish(); } else { window.addEventListener('load', finish); }
})();