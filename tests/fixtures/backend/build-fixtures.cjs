/* build-fixtures.cjs — 生成 Mock 后台的接口响应样本
 *
 * 字段故意用「后台风格」的命名（metric_name / created_at / uid…），
 * 由 config/sources.json 的 fields 映射成工作台口径 —— 这样才真正验证了映射能力。
 *
 * 用法：node tests/fixtures/backend/build-fixtures.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const D = require(path.join(ROOT, 'src/assets/js/data.js'));

const outDir = __dirname;

function main() {
  const dates = D.SAMPLE_DATES;
  const last = dates[dates.length - 1];
  const prev = dates[dates.length - 2];
  const li = dates.indexOf(last);
  const pi = dates.indexOf(prev);

  const dailyKeys = D.DEFAULT_CONFIG.metrics.filter((m) => m.freq === '日').map((m) => m.key);
  const list = dailyKeys.map((k) => ({
    metric_name: k,
    value: D.SAMPLE_DAILY[k][li],
    prev_value: D.SAMPLE_DAILY[k][pi],
    compare_basis: '昨日'
  }));

  fs.writeFileSync(path.join(outDir, 'metrics.json'), JSON.stringify({
    code: 0,
    msg: 'ok',
    data: { date: '{{date}}', list: list }
  }, null, 2) + '\n', 'utf8');

  const rows = (D.SAMPLE_FEEDBACK[last] || []).map((line) => {
    const p = line.split('|').map((s) => s.trim());
    return { created_at: p[0] || '', source: p[1] || '', uid: p[2] || '', text: p[3] || '' };
  });

  fs.writeFileSync(path.join(outDir, 'feedback.json'), JSON.stringify({
    code: 0,
    msg: 'ok',
    data: { date: '{{date}}', list: rows }
  }, null, 2) + '\n', 'utf8');

  console.log('fixtures: 日指标 ' + list.length + ' 条（源日期 ' + last + '），反馈 ' + rows.length + ' 条');
}

main();