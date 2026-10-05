<#
.SYNOPSIS
  模拟产品后台接口（仅用于本地端到端测试与演示）

  刻意不使用 System.Net.HttpListener：它依赖 http.sys 的 URL ACL，
  在普通用户或受限环境下 Start() 会直接报「句柄无效」。
  这里用纯 TcpListener 自己实现最小 HTTP/1.1 响应，无需管理员权限即可启动。

.EXAMPLE
  pwsh -File scripts/mock-backend.ps1 -Port 8111
#>
param(
  [int]$Port = 8111,
  [string]$Root = 'tests/fixtures/backend'
)

$ErrorActionPreference = 'Stop'
if (-not [System.IO.Path]::IsPathRooted($Root)) { $Root = Join-Path (Split-Path $PSScriptRoot -Parent) $Root }
$Root = (Resolve-Path $Root).Path

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse('127.0.0.1'), $Port)
$listener.Server.SetSocketOption([System.Net.Sockets.SocketOptionLevel]::Socket, [System.Net.Sockets.SocketOptionName]::ReuseAddress, $true)
$listener.Start()
Write-Host "mock backend listening on http://127.0.0.1:$Port/ (root: $Root)"

function Send-Response {
  param($Stream, [int]$Status, [string]$Body)
  $reason = switch ($Status) { 200 { 'OK' } 404 { 'Not Found' } 500 { 'Internal Server Error' } default { 'Status' } }
  $bytes = [Text.Encoding]::UTF8.GetBytes($Body)
  $head = "HTTP/1.1 $Status $reason`r`n" +
          "Content-Type: application/json; charset=utf-8`r`n" +
          "Content-Length: $($bytes.Length)`r`n" +
          "Access-Control-Allow-Origin: *`r`n" +
          "Connection: close`r`n`r`n"
  $headBytes = [Text.Encoding]::ASCII.GetBytes($head)
  $Stream.Write($headBytes, 0, $headBytes.Length)
  $Stream.Write($bytes, 0, $bytes.Length)
  $Stream.Flush()
}

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $client.ReceiveTimeout = 5000
      $stream = $client.GetStream()
      $stream.ReadTimeout = 5000

      $buf = New-Object byte[] 8192
      $sb = New-Object System.Text.StringBuilder
      while ($true) {
        $n = $stream.Read($buf, 0, $buf.Length)
        if ($n -le 0) { break }
        $null = $sb.Append([Text.Encoding]::ASCII.GetString($buf, 0, $n))
        if ($sb.ToString().Contains("`r`n`r`n")) { break }
      }

      $rawHead = $sb.ToString()
      $target = '/'
      if ($rawHead -match '^(?:GET|POST|HEAD)\s+(\S+)') { $target = $Matches[1] }
      $path = $target
      $date = ''
      if ($target.Contains('?')) {
        $path = $target.Substring(0, $target.IndexOf('?'))
        foreach ($pair in $target.Substring($target.IndexOf('?') + 1).Split('&')) {
          $kv = $pair.Split('=', 2)
          if ($kv.Length -eq 2 -and $kv[0] -eq 'date') { $date = [System.Uri]::UnescapeDataString($kv[1]) }
        }
      }

      $status = 200
      switch -Regex ($path) {
        '^/health'       { $body = '{"ok":true}' }
        '^/ops/metrics'  { $body = [System.IO.File]::ReadAllText((Join-Path $Root 'metrics.json'), [Text.Encoding]::UTF8) }
        '^/ops/feedback' { $body = [System.IO.File]::ReadAllText((Join-Path $Root 'feedback.json'), [Text.Encoding]::UTF8) }
        default          { $status = 404; $body = '{"error":"not found"}' }
      }
      if ($date) { $body = $body.Replace('{{date}}', $date) }

      Send-Response -Stream $stream -Status $status -Body $body
    }
    catch {
      Write-Host ("request failed: " + $_.Exception.Message)
    }
    finally {
      try { $client.Close() } catch { }
    }
  }
}
finally {
  $listener.Stop()
}