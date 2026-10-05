/* manifest.cjs — 数据源清单（manifest.json）构建器
 *
 * 唯一实现：演示数据生成脚本与每日采集器都调用它，避免两套逻辑漂移。
 * 扫描 <dataRoot>/<kind>/ 下的 CSV / TXT，按命名解析日期，计算 sha256 / bytes / rows。
 *
 * 用法：
 *   node scripts/lib/manifest.cjs <dataRoot> [--source "产品后台 API"] [--generator "collect-daily@1.0"]
 *   node scripts/lib/manifest.cjs src/data --check     # 只校验，不写文件
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA = 1;

// 文件名 → 类型/日期 的唯一映射规则（与 docs/03-数据自动采集.md 的约定一致）
function classify(relPath, name) {
  const dir = relPath.split('/')[0];
  let m;
  if (dir === 'daily') {
    if ((m = name.match(/^(\d{4}-\d{2}-\d{2})-metrics\.csv$/i))) return { kind: 'daily', date: m[1] };
    if ((m = name.match(/^(\d{4}-\d{2}-\d{2})-feedback\.txt$/i))) return { kind: 'feedback', date: m[1] };
    return null;
  }
  if (dir === 'weekly') {
    if ((m = name.match(/^(\d{4}-W\d{2})-metrics\.csv$/i))) return { kind: 'weekly', period: m[1] };
    return null;
  }
  if (dir === 'users') {
    if ((m = name.match(/^(\d{4}-\d{2})-users\.csv$/i))) return { kind: 'users', period: m[1] };
    return null;
  }
  return null;
}

function countRows(text) {
  return text.split(/\r?\n/).filter((l) => {
    const s = l.trim();
    return s && !s.startsWith('#');
  }).length - 1; // 去掉表头
}

function walk(root, sub, out) {
  const dir = path.join(root, sub);
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    if (!fs.statSync(abs).isFile()) continue;
    const rel = sub + '/' + name;
    const cls = classify(rel, name);
    if (!cls) continue;
    const buf = fs.readFileSync(abs);
    const text = buf.toString('utf8');
    out.push({
      id: rel,
      kind: cls.kind,
      name,
      path: rel,
      date: cls.date || '',
      period: cls.period || '',
      bytes: buf.length,
      rows: Math.max(0, countRows(text)),
      sha256: crypto.createHash('sha256').update(buf).digest('hex')
    });
  }
  return out;
}

function build(dataRoot, opts) {
  opts = opts || {};
  const files = [];
  walk(dataRoot, 'daily', files);
  walk(dataRoot, 'weekly', files);
  walk(dataRoot, 'users', files);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const counts = { daily: 0, feedback: 0, weekly: 0, users: 0 };
  const latest = { daily: '', feedback: '', weekly: '', users: '' };
  for (const f of files) {
    counts[f.kind] = (counts[f.kind] || 0) + 1;
    const key = f.date || f.period;
    if (key && key > (latest[f.kind] || '')) latest[f.kind] = key;
  }

  return {
    schema: SCHEMA,
    generatedAt: opts.generatedAt || new Date().toISOString(),
    generator: opts.generator || 'manifest.cjs@1.0',
    source: opts.source || '未标注来源',
    basePath: 'data/',
    counts,
    latest,
    files
  };
}

// 内容比较时忽略 generatedAt —— 数据没变就不该产生新的提交
function sameContent(a, b) {
  if (!a || !b) return false;
  const strip = (m) => JSON.stringify(Object.assign({}, m, { generatedAt: '' }));
  return strip(a) === strip(b);
}

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function writeManifest(dataRoot, manifest) {
  const p = path.join(dataRoot, 'manifest.json');
  const prev = readJSON(p);
  if (sameContent(prev, manifest)) {
    manifest.generatedAt = prev.generatedAt;
  }
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { path: p, changed: !sameContent(prev, manifest) };
}

function selfTest(dataRoot) {
  const m = build(dataRoot, {});
  const errs = [];
  if (m.schema !== SCHEMA) errs.push('schema');
  const ids = new Set();
  for (const f of m.files) {
    if (ids.has(f.id)) errs.push('重复 id: ' + f.id);
    ids.add(f.id);
    if (!/^[0-9a-f]{64}$/.test(f.sha256)) errs.push('sha256 格式: ' + f.id);
    if (f.rows < 0) errs.push('rows 负数: ' + f.id);
    if (!f.date && !f.period) errs.push('缺日期: ' + f.id);
  }
  return errs;
}

function main(argv) {
  const args = argv.slice(2);
  const dataRoot = args[0];
  if (!dataRoot) { console.error('用法: node scripts/lib/manifest.cjs <dataRoot> [--source ...]'); process.exit(2); }
  const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const checkOnly = args.includes('--check');
  const errs = selfTest(dataRoot);
  if (errs.length) { console.error('校验失败: ' + errs.join('; ')); process.exit(1); }
  const m = build(dataRoot, { source: get('--source'), generator: get('--generator') });
  if (checkOnly) {
    console.log('OK files=' + m.files.length + ' counts=' + JSON.stringify(m.counts) + ' latest=' + JSON.stringify(m.latest));
    return;
  }
  const r = writeManifest(dataRoot, m);
  console.log((r.changed ? 'UPDATED' : 'UNCHANGED') + ' ' + r.path + ' files=' + m.files.length +
    ' rows=' + m.files.reduce((a, f) => a + f.rows, 0));
}

module.exports = { SCHEMA, build, classify, countRows, sameContent, writeManifest, selfTest };
if (require.main === module) main(process.argv);