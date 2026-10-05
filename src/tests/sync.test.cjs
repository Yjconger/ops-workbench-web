/* sync.test.cjs — 数据源自动同步的自测
 * 运行：node src/tests/sync.test.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_ROOT = path.join(ROOT, 'src', 'data');
const JS = path.join(ROOT, 'src', 'assets', 'js');

const manifestLib = require(path.join(ROOT, 'scripts', 'lib', 'manifest.cjs'));

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + name); } }
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }

// ---------- 1. 清单构建器 ----------
console.log('清单构建器');
eq(manifestLib.classify('daily/2026-10-03-metrics.csv', '2026-10-03-metrics.csv'), { kind: 'daily', date: '2026-10-03' }, '日指标命名解析');
eq(manifestLib.classify('daily/2026-10-03-feedback.txt', '2026-10-03-feedback.txt'), { kind: 'feedback', date: '2026-10-03' }, '反馈命名解析');
eq(manifestLib.classify('weekly/2026-W40-metrics.csv', '2026-W40-metrics.csv'), { kind: 'weekly', period: '2026-W40' }, '周指标命名解析');
eq(manifestLib.classify('users/2026-10-users.csv', '2026-10-users.csv'), { kind: 'users', period: '2026-10' }, '用户命名解析');
eq(manifestLib.classify('daily/乱命名.csv', '乱命名.csv'), null, '非法命名被忽略');
eq(manifestLib.countRows('指标,数值\nA,1\nB,2\n#注释\n'), 2, '行数统计跳过表头与注释');

const m1 = manifestLib.build(DATA_ROOT, { source: 'test' });
const m2 = manifestLib.build(DATA_ROOT, { source: 'test' });
eq(manifestLib.sameContent(m1, m2), true, '相同数据 → 清单视为未变化（不会产生空提交）');
ok(m1.files.length >= 18, '清单至少包含 18 个数据文件');
ok(manifestLib.selfTest(DATA_ROOT).length === 0, '清单自检通过（sha256 格式 / 日期 / 无重复 id）');

// ---------- 2. 发布出来的 manifest.json 与实际文件一致 ----------
console.log('发布清单一致性');
const published = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'manifest.json'), 'utf8'));
eq(published.schema, 1, 'schema=1');
let staleCount = 0, missing = 0;
published.files.forEach((f) => {
  const abs = path.join(DATA_ROOT, f.path);
  if (!fs.existsSync(abs)) { missing++; return; }
  const sha = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  if (sha !== f.sha256) { staleCount++; }
});
eq(missing, 0, '清单里的文件都存在');
eq(staleCount, 0, '清单哈希与实际文件一致（清单没过期）');
eq(published.counts.daily, 14, 'counts.daily=14');
eq(published.latest.daily, '2026-10-03', 'latest.daily=2026-10-03');

// ---------- 3. 浏览器侧同步器（注入 fetch 走真实文件） ----------
console.log('同步器');
const S = require(path.join(JS, 'store.js'));
S.load();
let fetched = [];
globalThis.fetch = function (url) {
  fetched.push(url);
  const marker = url.indexOf('/data/');
  const rel = marker >= 0 ? url.slice(marker + 6) : url.replace(/^.*\/data\//, '');
  const abs = path.join(DATA_ROOT, rel);
  const exists = fs.existsSync(abs);
  return Promise.resolve({
    ok: exists, status: exists ? 200 : 404,
    text: function () { return Promise.resolve(exists ? fs.readFileSync(abs, 'utf8') : ''); }
  });
};

const SY = require(path.join(JS, 'sync.js'));
const BASE = 'http://localhost/ops-workbench-web/data/';

ok(/\/data\/$/.test(SY.resolveBase('data/')) || SY.resolveBase('data/').indexOf('data/') >= 0, '相对地址可解析');
eq(SY.resolveBase('https://cdn.example.com/ops-data'), 'https://cdn.example.com/ops-data/', '绝对地址补尾斜杠');

let threw = false;
try { SY.validate({ schema: 2, files: [] }); } catch (e) { threw = true; }
ok(threw, 'schema 不匹配时明确报错');
threw = false;
try { SY.validate({ schema: 1, files: [{}] }); } catch (e) { threw = true; }
ok(threw, '清单条目缺字段时明确报错');

S.reset();
SY.setConfig({ baseUrl: BASE, auto: false });
SY.forget();
fetched = [];

SY.run({}).then(function (r) {
  ok(r.ok, '第一次同步成功：' + r.message);
  eq(r.newFiles, published.files.length, '第一次全部视为新文件');
  ok(r.rows > 0, '第一次同步写入了记录：' + r.rows + ' 条');
  const s1 = S.summary();
  eq(s1.dailyDates.length, 14, '日指标入库 14 天');
  eq(s1.feedbackDates.length, 2, '反馈入库 2 天');
  ok(s1.users > 0 && s1.weeklyRows > 0, '用户与周指标一并入库');

  const firstPassCount = fetched.length;
  ok(firstPassCount > published.files.length, '文件是逐个按需下载的（含 manifest）');

  return SY.run({});
}).then(function (r2) {
  ok(r2.ok, '第二次同步成功');
  eq(r2.newFiles, 0, '第二次没有新文件');
  eq(r2.changed, 0, '第二次没有变更文件');
  eq(r2.unchanged, published.files.length, '第二次全部命中哈希缓存');
  ok(r2.message.indexOf('最新') >= 0, '第二次提示已是最新：' + r2.message);

  return SY.run({ dryRun: true });
}).then(function (r3) {
  ok(r3.ok && r3.dryRun, '检查更新（dryRun）可用');
  eq(r3.newFiles, 0, 'dryRun 不产生下载');

  // 模拟后台新增一天的数据：只在内存里改哈希，验证「变更会被重新拉取」
  const target = published.files.filter((f) => f.kind === 'daily').sort(function (a, b) { return a.date < b.date ? 1 : -1; })[0];
  const c = SY.config();
  c.files[target.id] = { sha256: 'deadbeef', at: '', rows: 0 };
  S.save();
  return SY.run({});
}).then(function (r4) {
  ok(r4.ok, '第三次同步成功');
  eq(r4.changed, 1, '只有哈希变化的那 1 个文件被重新下载');
  eq(r4.newFiles, 0, '没有误判为新文件');
  const c = SY.config();
  ok(c.last && c.last.ok, '同步结果记录进 last');
  ok(c.log.length >= 3, '同步日志被追加：' + c.log.length + ' 条');

  const s = S.summary();
  eq(s.dailyDates.length, 14, '重复同步不会产生重复记录（按 日期+指标 覆盖）');

  console.log('\nSUMMARY | pass=' + pass + ' fail=' + fail);
  process.exit(fail ? 1 : 0);
}).catch(function (e) {
  console.error('测试异常：', e);
  process.exit(1);
});