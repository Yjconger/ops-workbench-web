<#
.SYNOPSIS
  运营工作台 · 每日数据采集器

.DESCRIPTION
  按 config/sources.json 的配置，从产品后台（开放接口 / 定时导出文件 / 本地导出目录）
  拉取当天数据，规范化成工作台口径，写入数据源目录并重建 manifest.json。

  采集完成后可选地提交并推送 —— 站点（GitHub Pages 等）重新发布后，
  浏览器端打开页面就会自动同步，不再需要任何手动上传。

.PARAMETER Date
  采集哪一天的数据，格式 yyyy-MM-dd，默认「昨天」（凌晨定时任务采集刚结束的一天）。

.PARAMETER DryRun
  只拉取与校验，不写文件、不提交。

.PARAMETER NoCommit
  写文件但不 git 提交（本地调试用）。

.EXAMPLE
  pwsh -File scripts/collect-daily.ps1
  pwsh -File scripts/collect-daily.ps1 -Date 2026-10-04 -DryRun
#>
[CmdletBinding()]
param(
  [string]$Config = 'config/sources.json',
  [string]$DataRoot = 'src/data',
  [string]$Date = '',
  [switch]$DryRun,
  [switch]$NoCommit
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $RepoRoot

if (-not $Date) { $Date = (Get-Date).AddDays(-1).ToString('yyyy-MM-dd') }
if ($Date -notmatch '^\d{4}-\d{2}-\d{2}$') { throw "日期格式应为 yyyy-MM-dd，收到：$Date" }

# 允许外部传绝对路径（CI / 临时目录 / 测试用），相对路径按仓库根解析
$DataRootAbs = if ([System.IO.Path]::IsPathRooted($DataRoot)) { $DataRoot } else { Join-Path $RepoRoot $DataRoot }
$ConfigPath = if ([System.IO.Path]::IsPathRooted($Config)) { $Config } else { Join-Path $RepoRoot $Config }
# git 只认仓库内路径，绝对路径先转回相对
$DataRel = $DataRootAbs
if ($DataRel.StartsWith($RepoRoot, [System.StringComparison]::OrdinalIgnoreCase)) { $DataRel = $DataRel.Substring($RepoRoot.Length).TrimStart('\', '/') }
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Line2([string]$msg) { Write-Host $msg }

function Normalize-Text([string]$t) { return ($t -replace "`r`n", "`n") }

function ConvertTo-CsvLine([object[]]$fields) {
  $out = foreach ($f in $fields) {
    $s = if ($null -eq $f) { '' } else { [string]$f }
    if ($s -match '[",\r\n]') { '"' + $s.Replace('"', '""') + '"' } else { $s }
  }
  return ($out -join ',')
}

# 从对象里按 "a.b.c" 取值（支持数组下标：a.b.0.c）
function Get-PathValue($obj, [string]$pathStr) {
  if (-not $pathStr) { return $obj }
  $cur = $obj
  foreach ($seg in $pathStr.Split('.')) {
    if ($null -eq $cur) { return $null }
    if ($seg -match '^\d+$') { $cur = $cur[[int]$seg] }
    else { $cur = $cur.$seg }
  }
  return $cur
}

# 日期占位符：{date}=yyyy-MM-dd，{week}=ISO 周（2026-W40），{month}=yyyy-MM
function Get-IsoWeek([datetime]$d) {
  $cal = [System.Globalization.CultureInfo]::InvariantCulture.Calendar
  $w = $cal.GetWeekOfYear($d, [System.Globalization.CalendarWeekRule]::FirstFourDayWeek, [System.DayOfWeek]::Monday)
  return ('{0}-W{1:d2}' -f $d.Year, $w)
}
function Expand-Tokens([string]$s, [string]$date) {
  $d = [datetime]::ParseExact($date, 'yyyy-MM-dd', $null)
  return $s.Replace('{date}', $date).Replace('{week}', (Get-IsoWeek $d)).Replace('{month}', $d.ToString('yyyy-MM'))
}
function Get-AuthHeaders($auth) {
  $h = @{}
  if (-not $auth) { return $h }
  $envName = $auth.tokenEnv
  $token = if ($envName) { [Environment]::GetEnvironmentVariable($envName) } else { $null }
  if (-not $token) { return $h }
  switch ($auth.scheme) {
    'bearer' { $h['Authorization'] = "Bearer $token" }
    'apikey' { $h[[string]$auth.header] = $token }
    'basic'  { $h['Authorization'] = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($token)) }
    default  { $h['Authorization'] = "Bearer $token" }
  }
  return $h
}

function Save-Canonical([string]$rel, [string]$text, [switch]$WhatIfOnly) {
  $abs = Join-Path $DataRootAbs $rel
  $norm = Normalize-Text $text
  $prev = if (Test-Path $abs) { Normalize-Text ([System.IO.File]::ReadAllText($abs, [Text.Encoding]::UTF8)) } else { $null }
  if ($prev -eq $norm) { return @{ status = 'unchanged'; path = $rel } }
  if ($WhatIfOnly) { return @{ status = 'would-write'; path = $rel } }
  $dir = Split-Path $abs -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($abs, $norm, $Utf8NoBom)
  return @{ status = 'written'; path = $rel }
}

# ---------- 各适配器 ----------
function Invoke-HttpJson($src, [string]$date) {
  $url = Expand-Tokens ([string]$src.url) $date
  $headers = Get-AuthHeaders $src.auth
  $resp = Invoke-RestMethod -Uri $url -Headers $headers -TimeoutSec 30 -Method Get
  $rows = Get-PathValue $resp $src.rowsPath
  if ($null -eq $rows) { throw "接口未返回数据（rowsPath=$($src.rowsPath)）" }
  $rows = @($rows)
  $f = $src.fields
  $lines = New-Object System.Collections.Generic.List[string]
  if ($src.kind -eq 'daily') {
    $lines.Add((ConvertTo-CsvLine @('指标', '数值', '对比值', '对比口径')))
    foreach ($r in $rows) {
      $basis = if ($f.basis) { [string](Get-PathValue $r $f.basis) } else { '昨日' }
      $lines.Add((ConvertTo-CsvLine @((Get-PathValue $r $f.metric), (Get-PathValue $r $f.value), (Get-PathValue $r $f.compare), $basis)))
    }
    return @{ rel = "daily/$date-metrics.csv"; text = ($lines -join "`n") + "`n"; rows = $rows.Count }
  }
  elseif ($src.kind -eq 'feedback') {
    foreach ($r in $rows) {
      $parts = @((Get-PathValue $r $f.time), (Get-PathValue $r $f.channel), (Get-PathValue $r $f.userId), (Get-PathValue $r $f.content))
      $lines.Add(($parts | ForEach-Object { if ($null -eq $_) { '' } else { ([string]$_).Trim() } }) -join ' | ')
    }
    return @{ rel = "daily/$date-feedback.txt"; text = ($lines -join "`n") + "`n"; rows = $rows.Count }
  }
  elseif ($src.kind -eq 'weekly') {
    $lines.Add((ConvertTo-CsvLine @('周', '指标', '数值', '环比', '同比')))
    foreach ($r in $rows) {
      $lines.Add((ConvertTo-CsvLine @((Get-PathValue $r $f.period), (Get-PathValue $r $f.metric), (Get-PathValue $r $f.value), (Get-PathValue $r $f.mom), (Get-PathValue $r $f.yoy))))
    }
    return @{ rel = "weekly/$($src.period)-metrics.csv"; text = ($lines -join "`n") + "`n"; rows = $rows.Count }
  }
  elseif ($src.kind -eq 'users') {
    $lines.Add((ConvertTo-CsvLine @('用户ID', '注册日期', '最近活跃日期', '累计订单数', '累计付费金额', '反馈次数', '最近反馈日期', '渠道', '备注')))
    foreach ($r in $rows) {
      $lines.Add((ConvertTo-CsvLine @((Get-PathValue $r $f.id), (Get-PathValue $r $f.regDate), (Get-PathValue $r $f.lastActive), (Get-PathValue $r $f.orders), (Get-PathValue $r $f.amount), (Get-PathValue $r $f.fbCount), (Get-PathValue $r $f.lastFbDate), (Get-PathValue $r $f.channel), (Get-PathValue $r $f.note))))
    }
    return @{ rel = "users/$($src.period)-users.csv"; text = ($lines -join "`n") + "`n"; rows = $rows.Count }
  }
  throw "http-json 不支持的类型：$($src.kind)"
}

function Invoke-HttpFile($src, [string]$date) {
  $url = Expand-Tokens ([string]$src.url) $date
  $headers = Get-AuthHeaders $src.auth
  $resp = Invoke-WebRequest -Uri $url -Headers $headers -TimeoutSec 30 -Method Get -UseBasicParsing
  $text = [string]$resp.Content
  $name = if ($src.saveAs) { Expand-Tokens ([string]$src.saveAs) $date } else { Split-Path $url -Leaf }
  $dir = switch ($src.kind) { 'daily' { 'daily' } 'feedback' { 'daily' } 'weekly' { 'weekly' } 'users' { 'users' } default { 'daily' } }
  return @{ rel = "$dir/$name"; text = $text; rows = ($text.Split("`n").Count - 1) }
}

function Invoke-LocalExport($src, [string]$date) {
  $path = Expand-Tokens ([string]$src.path) $date
  if (-not (Test-Path $path)) { throw "本地导出文件不存在：$path" }
  $text = [System.IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
  $name = if ($src.saveAs) { Expand-Tokens ([string]$src.saveAs) $date } else { Split-Path $path -Leaf }
  $dir = switch ($src.kind) { 'daily' { 'daily' } 'feedback' { 'daily' } 'weekly' { 'weekly' } 'users' { 'users' } default { 'daily' } }
  return @{ rel = "$dir/$name"; text = $text; rows = ($text.Split("`n").Count - 1) }
}

# ---------- 主流程 ----------
if (-not (Test-Path $ConfigPath)) { throw "找不到数据源配置：$ConfigPath" }
$cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$sources = @($cfg.sources | Where-Object { $_.enabled -ne $false })

Write-Line2 "== 采集日期 $Date ；数据源目录 $DataRoot ；配置 $Config =="

if (-not $sources.Count) {
  Write-Line2 "没有启用任何数据源（config/sources.json 里 enabled 均为 false）。"
  Write-Line2 "→ 这是初始状态：填好后台地址与 Secret 后即可自动运行。"
} else {
  $failed = 0
  foreach ($src in $sources) {
    $label = if ($src.name) { $src.name } else { "$($src.type)/$($src.kind)" }
    try {
      switch ($src.type) {
        'http-json'    { $res = Invoke-HttpJson $src $Date }
        'http-file'    { $res = Invoke-HttpFile $src $Date }
        'local-export' { $res = Invoke-LocalExport $src $Date }
        default        { throw "未知的数据源类型：$($src.type)" }
      }
      $w = Save-Canonical $res.rel $res.text -WhatIfOnly:$DryRun
      Write-Line2 ("  [{0}] {1} → {2} （{3} 行）" -f $w.status, $label, $res.rel, $res.rows)
    } catch {
      $failed++
      Write-Line2 ("  [failed] {0} → {1}" -f $label, $_.Exception.Message)
    }
  }
  if ($failed -gt 0) { Write-Line2 "有 $failed 个数据源采集失败，请检查地址 / 凭据 / 网络。" }
}

# ---------- 重建清单 ----------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  $bundled = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
  if (Test-Path $bundled) { $node = @{ Source = $bundled } }
}
if ($DryRun) {
  Write-Line2 "（DryRun：跳过清单写入与提交）"
  exit 0
}
if ($node) {
  $nodeExe = if ($node.Source) { $node.Source } else { $node.Path }
  & $nodeExe (Join-Path $RepoRoot 'scripts/lib/manifest.cjs') $DataRootAbs --source $cfg.source
} else {
  Write-Line2 '警告：未找到 node，跳过 manifest 重建（数据文件已更新，但站点不会感知到）。'
}

# ---------- 提交 ----------
if ($NoCommit) { Write-Line2 '（-NoCommit：跳过提交）'; exit 0 }

$git = 'git'
Push-Location $RepoRoot
try {
  $null = & $git add -- $DataRel 2>&1
  & $git diff --cached --quiet -- $DataRel
  if ($LASTEXITCODE -eq 0) {
    Write-Line2 '数据无变化，无需提交。'
    exit 0
  }
  & $git -c user.name='ops-workbench' -c user.email='ops-workbench@localhost' commit -m "chore(data): 自动采集 $Date 数据" -q
  Write-Line2 '已提交；开始推送…'
  & $git -c http.version=HTTP/1.1 push
  Write-Line2 '推送完成，站点将自动重新发布。'
} finally { Pop-Location }