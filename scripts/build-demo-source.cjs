/* build-demo-source.cjs — 生成「数据源目录」的演示数据（模拟后台已自动采集好的结果）
 *
 * 用途：本地/线上演示「零手动上传」的完整链路 —— 站点打开时从 <src>/data/ 自动拉取并入库。
 * 真实环境由 scripts/collect-daily.ps1 每日定时写入同一目录与同一清单格式。
 *
 * 用法：node scripts/build-demo-source.cjs [--out src/data] [--source "产品后台 API（演示）"]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const dataJs = require(path.join(ROOT, 'src/assets/js/data.js'));
const manifest = require(path.join(ROOT, 'scripts/lib/manifest.cjs'));

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const outRoot = path.resolve(ROOT, get('--out', 'src/data'));
const source = get('--source', '产品后台 API（演示数据）');

function writeFile(rel, text) {
  const abs = path.join(outRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text.replace(/\r?\n/g, '\n'), 'utf8');
  return rel;
}

function main() {
  const files = dataJs.buildSampleFiles();
  const written = [];
  files.daily.forEach((f) => written.push(writeFile('daily/' + f.name, f.text)));
  files.feedback.forEach((f) => written.push(writeFile('daily/' + f.name, f.text)));
  files.weekly.forEach((f) => written.push(writeFile('weekly/' + f.name, f.text)));
  files.users.forEach((f) => written.push(writeFile('users/' + f.name, f.text)));

  const m = manifest.build(outRoot, { source: source, generator: 'build-demo-source.cjs@1.0' });
  const r = manifest.writeManifest(outRoot, m);

  console.log('已写入 ' + written.length + ' 个数据文件 → ' + outRoot);
  console.log('清单: ' + r.path + '（' + (r.changed ? '已更新' : '无变化') + '）');
  console.log('统计: ' + JSON.stringify(m.counts) + '  最新: ' + JSON.stringify(m.latest));
}

main();