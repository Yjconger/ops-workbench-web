<#
  collect.e2e.ps1 — 「后台 → 采集器 → 数据源」端到端测试

  用本地 Mock 后台（模拟产品后台接口）真跑一遍 collect-daily.ps1：
    1) 能按字段映射把接口返回转成工作台口径；
    2) 生成的 manifest.json 与文件一致；
    3) 同样数据再采一次不产生任何改动（幂等，不会污染提交历史）。

  Mock 后台以独立进程启动，结束用 Stop-Process 强制回收
  （不用 Start-Job/Stop-Job：job 线程阻塞在 Accept 上时 Stop-Job 会挂住）。

  运行：pwsh -File src/tests/collect.e2e.ps1
#>
$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$pass = 0; $fail = 0
function Ok($cond, $name) { if ($cond) { $script:pass++; Write-Host "  PASS  $name" } else { $script:fail++; Write-Host "  FAIL  $name" -ForegroundColor Red } }
function Eq($a, $b, $name) { Ok ($a -eq $b) ("$name（期望 $b，实际 $a）") }

$pwshExe = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $pwshExe) { $pwshExe = (Get-Command powershell -ErrorAction Stop).Source }
$tmp = Join-Path $env:TEMP ('ops-collect-e2e-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$Port = 8111
$proc = $null

Write-Host "== 启动 Mock 后台（127.0.0.1:$Port）=="
$mockScript = Join-Path $RepoRoot 'scripts\mock-backend.ps1'
$mockRoot = Join-Path $RepoRoot 'tests\fixtures\backend'
$proc = Start-Process -FilePath $pwshExe -PassThru -WindowStyle Hidden -ArgumentList @(
  '-NoProfile', '-File', $mockScript, '-Port', "$Port", '-Root', $mockRoot
)

$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  try { $null = Invoke-WebRequest "http://127.0.0.1:$Port/health" -TimeoutSec 2 -UseBasicParsing; $ready = $true; break } catch { }
}
Ok $ready 'Mock 后台就绪'

try {
  if (-not $ready) { throw 'Mock 后台未启动，跳过后续断言' }

  Write-Host "== 第一次采集 =="
  $out1 = & $pwshExe -NoProfile -File (Join-Path $RepoRoot 'scripts\collect-daily.ps1') `
    -Config 'tests/fixtures/sources.test.json' -DataRoot $tmp -Date '2026-10-04' -NoCommit 2>&1 | Out-String
  Write-Host $out1.Trim()

  $dailyCsv = Join-Path $tmp 'daily\2026-10-04-metrics.csv'
  $fbTxt = Join-Path $tmp 'daily\2026-10-04-feedback.txt'
  $manPath = Join-Path $tmp 'manifest.json'

  Ok (Test-Path $dailyCsv) '生成日指标文件'
  Ok (Test-Path $fbTxt) '生成反馈文件'
  Ok (Test-Path $manPath) '生成 manifest.json'

  $csv = Get-Content $dailyCsv -Encoding UTF8
  Eq $csv.Count 10 '日指标 = 表头 + 9 行'
  Eq $csv[0] '指标,数值,对比值,对比口径' '日指标表头符合口径'
  Ok ($csv -contains '日活跃用户数,12480,13010,昨日') '字段映射正确（metric_name/value/prev_value/compare_basis → 指标/数值/对比值/对比口径）'
  Ok ($csv -contains '支付成功率(%),93.2,93.8,昨日') '百分比类指标原样保留'

  $fb = Get-Content $fbTxt -Encoding UTF8
  Eq $fb.Count 14 '反馈 = 14 行'
  Ok ($fb[0] -eq '08:12 | 客服工单 | U10231 | 支付的时候一直失败，试了三次都不行') '反馈行格式：时间 | 渠道 | 用户ID | 内容'
  Ok (($fb -join "`n") -match '退款什么时候到账') '中文内容未乱码'

  $man = Get-Content $manPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Eq $man.counts.daily 1 '清单：日指标 1 个文件'
  Eq $man.counts.feedback 1 '清单：反馈 1 个文件'
  Eq $man.latest.daily '2026-10-04' '清单：最新日期正确'
  Eq $man.source '本地 Mock 后台（端到端测试）' '清单：来源标注正确'
  $f0 = $man.files[0]
  $sha = (Get-FileHash (Join-Path $tmp $f0.path) -Algorithm SHA256).Hash.ToLower()
  Eq $f0.sha256 $sha '清单哈希与实际文件一致'

  Write-Host "== 第二次采集（应完全幂等）=="
  $hashBefore = (Get-FileHash $dailyCsv -Algorithm SHA256).Hash
  $out2 = & $pwshExe -NoProfile -File (Join-Path $RepoRoot 'scripts\collect-daily.ps1') `
    -Config 'tests/fixtures/sources.test.json' -DataRoot $tmp -Date '2026-10-04' -NoCommit 2>&1 | Out-String
  $hashAfter = (Get-FileHash $dailyCsv -Algorithm SHA256).Hash
  Ok ($out2 -match 'unchanged') '第二次全部判定为 unchanged'
  Ok ($out2 -notmatch '\[written\]') '第二次没有重写任何文件'
  Eq $hashAfter $hashBefore '文件内容与时间戳未被无谓改动'

  Write-Host "== DryRun（只拉取不落盘）=="
  $tmp2 = Join-Path $tmp 'dry'
  $out3 = & $pwshExe -NoProfile -File (Join-Path $RepoRoot 'scripts\collect-daily.ps1') `
    -Config 'tests/fixtures/sources.test.json' -DataRoot $tmp2 -Date '2026-10-05' -DryRun 2>&1 | Out-String
  Ok ($out3 -match 'would-write') 'DryRun 报告将写入'
  Ok (-not (Test-Path (Join-Path $tmp2 'daily\2026-10-05-metrics.csv'))) 'DryRun 不落盘'
}
finally {
  if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  Write-Host "（测试目录：$tmp）"
}

Write-Host ""
Write-Host "SUMMARY | pass=$pass fail=$fail"
if ($fail -gt 0) { exit 1 }