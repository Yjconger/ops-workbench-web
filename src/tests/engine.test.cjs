/* engine.test.cjs — 引擎自测（node src/tests/engine.test.cjs） */
var path = require('path');
var D = require(path.join(__dirname, '..', 'assets', 'js', 'data.js'));
var E = require(path.join(__dirname, '..', 'assets', 'js', 'engine.js'));

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

var files = D.buildSampleFiles();
var cfg = D.DEFAULT_CONFIG;
var daily = [], weekly = [], feedback = [], users = [];
files.daily.forEach(function (f) { daily = daily.concat(E.parseDailyCSV(f.text, f.name.slice(0, 10))); });
files.weekly.forEach(function (f) { weekly = weekly.concat(E.parseWeeklyCSV(f.text)); });
files.feedback.forEach(function (f) { feedback = feedback.concat(E.parseFeedbackTXT(f.text, f.name.slice(0, 10))); });
files.users.forEach(function (f) { users = users.concat(E.parseUsersCSV(f.text)); });

console.log('\n== 解析 ==');
ok('日指标 14 天 × 9 指标 = 126 行', daily.length === 126, daily.length);
ok('周指标 8 周 × 6 指标 = 48 行', weekly.length === 48, weekly.length);
ok('用户 12 位', users.length === 12, users.length);
ok('反馈 24 条', feedback.length === 24, feedback.length);

console.log('\n== 反馈分析 ==');
var fb = E.analyzeFeedback(feedback, cfg);
ok('总条数 24', fb.total === 24, fb.total);
ok('负面 20 条', fb.negativeCount === 20, fb.negativeCount);
ok('负面占比 83.3%', fb.negativeRate === 83.3, fb.negativeRate);
ok('负面占比 > 80%', fb.negativeRate > 80);
ok('最高频问题 = 计费问题', fb.issues[0].name === '计费问题', fb.issues.map(function (i) { return i.name + ':' + i.count; }));
ok('计费问题 10 条 / 7 位用户', fb.issues[0].count === 10 && fb.issues[0].users === 7, fb.issues[0]);
ok('性能问题 7 条', fb.issues[1].name === '性能问题' && fb.issues[1].count === 7, fb.issues[1]);
ok('首条需求为 P0', fb.requirements[0].level === 'P0', fb.requirements.map(function (r) { return r.level + ':' + r.category + ':' + r.score; }));
ok('「其他」被降档到 P2', fb.requirements[fb.requirements.length - 1].level === 'P2', fb.requirements[fb.requirements.length - 1].level);
ok('每条需求都有建议动作', fb.requirements.every(function (r) { return r.action.length > 0; }));

console.log('\n== 指标分析（日） ==');
var md = E.analyzeMetrics(daily, cfg, { granularity: '日' });
function row(list, m) { return list.filter(function (r) { return r.metric === m; })[0]; }
var pay = row(md.rows, '支付成功率(%)');
ok('支付成功率 93.2 判异常', pay.status === '异常' && pay.value === 93.2, pay);
ok('支付成功率连续下降 ≥5 天', pay.trend.dir === 'down' && pay.trend.streak >= 5, pay.trend);
ok('接口响应 2050 判异常', row(md.rows, '接口平均响应时长(ms)').status === '异常');
ok('负面反馈数 14 判异常', row(md.rows, '负面反馈数').status === '异常');
ok('订单转化率 2.78 判需关注', row(md.rows, '订单转化率(%)').status === '需关注', row(md.rows, '订单转化率(%)').status);
ok('DAU 环比 -4.1% 判正常', row(md.rows, '日活跃用户数').status === '正常');
ok('核心功能使用率 40.3 判正常但临界', row(md.rows, '核心功能使用率(%)').status === '正常' && row(md.rows, '核心功能使用率(%)').near === true, row(md.rows, '核心功能使用率(%)'));
ok('异常项都带归因假设', md.anomalies.every(function (r) { return r.hypothesis.length > 0; }));

console.log('\n== 指标分析（周） ==');
var mw = E.analyzeMetrics(weekly, cfg, { granularity: '周' });
ok('退款率 3.2 判异常', row(mw.rows, '退款率(%)').status === '异常');
ok('周活跃 66800 判正常（环比 -3.5%）', row(mw.rows, '周活跃用户数').status === '正常', row(mw.rows, '周活跃用户数').changePct);

console.log('\n== 每日晨检 ==');
var dc = E.dailyCheck({ cfg: cfg, date: '2026-10-03', metrics: daily, feedback: feedback.filter(function (f) { return f.date === '2026-10-03'; }) });
ok('简报 ≤200 字', dc.briefCount <= 200, dc.briefCount);
ok('待办 2–3 条', dc.todos.length >= 2 && dc.todos.length <= 3, dc.todos.length);
ok('待办含支付相关动作', dc.todos.some(function (t) { return /支付|退款/.test(t.text); }));
ok('待办都有依据与时间', dc.todos.every(function (t) { return t.basis && t.when; }));
ok('简报含日期与结论', dc.brief.indexOf('2026-10-03') >= 0 && dc.brief.indexOf('结论') >= 0);

console.log('\n== 用户打标签 ==');
var tg = E.tagUsers(users, cfg, { today: '2026-10-03', prevTags: [] });
function u(id) { return tg.rows.filter(function (r) { return r.id === id; })[0]; }
ok('U10231 = 活跃 / 高价值 / 高频反馈', u('U10231').life === '活跃' && u('U10231').value === '高价值' && u('U10231').behavior === '高频反馈', u('U10231'));
ok('U11023 = 已流失 / 中价值', u('U11023').life === '已流失' && u('U11023').value === '中价值', u('U11023'));
ok('U10455 = 新用户 / 低价值 / 问题反馈', u('U10455').life === '新用户' && u('U10455').behavior === '问题反馈', u('U10455'));
ok('U11107 = 活跃 / 未付费', u('U11107').life === '活跃' && u('U11107').value === '未付费');
ok('高价值 4 人', tg.rows.filter(function (r) { return r.value === '高价值'; }).length === 4);
ok('每人都建议动作', tg.rows.every(function (r) { return r.action && r.action.indexOf('未定义') < 0; }));
ok('首次打标：仅备注标注回流的用户判为回流', u('U11555').life === '回流' && u('U10231').life !== '回流', u('U11555').life);
ok('生命周期判定依据可追溯', u('U10231').lifeBasis.length > 0 && u('U11555').lifeBasis === '备注标注回流', u('U11555').lifeBasis);
var tg2 = E.tagUsers(users, cfg, { today: '2026-10-03', prevTags: [{ '用户ID': 'U11555', '生命周期阶段': '沉默', '价值标签': '中价值' }] });
ok('历史台账为沉默 → U11555 识别为回流', tg2.rows.filter(function (r) { return r.id === 'U11555'; })[0].life === '回流');
ok('有变化时标注迁移', tg2.rows.filter(function (r) { return r.id === 'U11555'; })[0].changed === '沉默 → 回流');

console.log('\n== 整合分析（交叉验证） ==');
var combined = {};
md.rows.forEach(function (r) { combined[r.metric] = r; });
mw.rows.forEach(function (r) { combined[r.metric] = r; });
var byDate = {};
fb.annotated.forEach(function (a) { byDate[a.date] = byDate[a.date] || { total: 0, negative: 0 }; byDate[a.date].total++; if (a.sentiment === '负面') { byDate[a.date].negative++; } });
var consistency = ['2026-10-02', '2026-10-03'].map(function (d) {
  var mr = daily.filter(function (x) { return x.metric === '负面反馈数' && x.date === d; })[0];
  return { date: d, metricValue: mr ? mr.value : null, textValue: byDate[d] ? byDate[d].negative : null };
});
var it = E.integrated({
  cfg: cfg, feedback: fb, metrics: { rows: Object.keys(combined).map(function (k) { return combined[k]; }), trends: md.trends, granularity: '日+周' },
  tags: tg, ledger: [], consistency: consistency,
  metricDates: D.SAMPLE_DATES, feedbackDates: Object.keys(D.SAMPLE_FEEDBACK)
});
ok('交叉验证表有内容', it.cvRows.length > 0, it.cvRows.length);
ok('存在印证项', it.counts.ok >= 1, it.counts);
ok('存在背离项', it.counts.warn >= 1, it.counts);
ok('存在无法判断项（口径不一致）', it.counts.na >= 1, it.counts);
ok('策略建议 3–5 条', it.strategies.length >= 3 && it.strategies.length <= 5, it.strategies.length);
ok('每条策略都可验证', it.strategies.every(function (s) { return s.verify && s.verify.length > 5; }));
ok('监控重点 3–5 项', it.monitoring.length >= 3 && it.monitoring.length <= 5, it.monitoring.length);
ok('补数清单含缺口', it.gaps.length > 0, it.gaps.length);
ok('核心发现 3–5 条', it.findings.length >= 3 && it.findings.length <= 5, it.findings.length);

console.log('\n================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);