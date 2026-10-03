# init-git-repo.ps1 — 在本地把项目变成一个 git 仓库并提交（不推送、不联网）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\init-git-repo.ps1 `
#       -UserName "你的GitHub用户名" -UserEmail "你的邮箱" -RepoUrl "https://github.com/用户名/仓库名.git"
#
# 说明：
# - 所有配置都写在【本仓库内】(.git\config)，不改动你电脑的全局 git 配置；
# - 凭据助手指向本机自带的 Git Credential Manager，推送时会弹浏览器让你授权，
#   不需要在命令行里输入 Token；
# - 只做 init / add / commit / remote add，不会 push。推送由你或 Codex 在你确认后执行。

param(
  [Parameter(Mandatory = $true)][string]$UserName,
  [Parameter(Mandatory = $true)][string]$UserEmail,
  [Parameter(Mandatory = $true)][string]$RepoUrl,
  [string]$Branch = 'main'
)
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

# 1) 找一个可用的 git
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $git) { throw '找不到 git。请先安装 Git for Windows：https://git-scm.com/download/win' }
Write-Host "使用 git: $git" -ForegroundColor DarkGray

# 2) 初始化仓库（已在仓库里就跳过）
if (Test-Path (Join-Path $projectRoot '.git')) {
  Write-Host '已经是 git 仓库，跳过初始化。' -ForegroundColor DarkGray
} else {
  & $git init -b $Branch | Out-Null
  Write-Host "已初始化仓库，分支：$Branch" -ForegroundColor Green
}

# 3) 仓库级身份（只影响本仓库）
& $git config user.name  $UserName
& $git config user.email $UserEmail

# 4) 凭据助手：优先用 git 自带的 Git Credential Manager（弹浏览器授权，无需手工配 Token）
$gcm = $null
$gitDir = Split-Path -Parent (Split-Path -Parent $git)   # ...\native\git\cmd\git.exe -> ...\native\git
$candidates = @(
  (Join-Path $gitDir 'mingw64\bin\git-credential-manager.exe'),
  (Join-Path $gitDir 'mingw64\libexec\git-core\git-credential-manager.exe'),
  (Join-Path $gitDir 'mingw64\bin\git-credential-manager-core.exe')
)
foreach ($c in $candidates) { if (Test-Path $c) { $gcm = $c; break } }
if (-not $gcm) { $gcm = (Get-Command git-credential-manager -ErrorAction SilentlyContinue).Source }

if ($gcm) {
  & $git config credential.helper "`"$gcm`""
  Write-Host "凭据助手已指向 Git Credential Manager：$gcm" -ForegroundColor Green
  Write-Host '第一次推送时会弹出浏览器让你登录 GitHub，点授权即可；凭据会存进 Windows 凭据管理器。' -ForegroundColor DarkGray
} else {
  & $git config credential.helper manager-core
  Write-Host '未找到 GCM 可执行文件，已退回 manager-core（git 安装时通常自带）。' -ForegroundColor Yellow
}

# 5) 禁用换行符转换，保证文件原样存取
& $git config core.autocrlf false

# 6) 关联远程仓库
$existing = (& $git remote) 2>$null
if ($existing -contains 'origin') { & $git remote set-url origin $RepoUrl } else { & $git remote add origin $RepoUrl }
Write-Host "远程仓库：$RepoUrl" -ForegroundColor Green

# 7) 提交
& $git add -A
$count = (& $git diff --cached --name-only | Measure-Object).Count
if ($count -gt 0) {
  & $git commit -m "feat: 运营分析工作台 Web 版" | Out-Null
  Write-Host "已提交 $count 个文件。" -ForegroundColor Green
} else {
  Write-Host '没有需要提交的改动。' -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '本地准备完成。下一步（联网、需要你确认）：' -ForegroundColor Cyan
Write-Host "  git push -u origin $Branch" -ForegroundColor White