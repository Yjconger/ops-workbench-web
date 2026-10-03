# serve.ps1 — 本地起一个静态服务器并打开运营分析工作台 Web 版
# 用法：在项目文件夹下执行
#   powershell -ExecutionPolicy Bypass -File scripts\serve.ps1
# 可选参数：-Port 8080（默认）  -NoBrowser（只起服务，不开浏览器）
param([int]$Port = 8080, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$projectRoot = Split-Path -Parent $PSScriptRoot
$src = Join-Path $projectRoot 'src'
if (-not (Test-Path (Join-Path $src 'index.html'))) {
  throw "找不到 $src\index.html，请确认本脚本位于项目的 scripts 目录下。"
}

$url = "http://127.0.0.1:$Port/index.html"
Write-Host "运营分析工作台 Web 版" -ForegroundColor Cyan
Write-Host "地址：$url" -ForegroundColor Green
Write-Host "按 Ctrl+C 停止服务。" -ForegroundColor DarkGray

# ---------- 优先用 Python；没有 Python（或没装）就用内置的多线程静态服务器 ----------
# 注意：Windows 上 PATH 里的 python 可能是应用商店的占位程序（一运行就退出），
# 所以必须真的调用一次确认它是个可用的 Python 解释器。
$python = $null
foreach ($c in @('python', 'python3', 'py')) {
  $cmd = Get-Command $c -ErrorAction SilentlyContinue
  if (-not $cmd) { continue }
  try {
    $probe = & $cmd.Source -c "import sys; print(sys.version_info[0])" 2>$null
    if ($LASTEXITCODE -eq 0 -and ("$probe".Trim() -eq '3')) { $python = $cmd.Source; break }
  } catch { }
}

if (-not $NoBrowser) { Start-Process $url }

if ($python) {
  & $python -m http.server $Port --bind 127.0.0.1 --directory $src
  return
}

# 内置服务器：用 Add-Type 编译一小段 C#，多线程处理请求，不依赖任何外部程序。
# （不能用单线程 TcpListener：浏览器会先开一个静默的预连接，把单线程循环卡死。）
Write-Host "（未检测到 Python，使用内置服务器）" -ForegroundColor DarkGray

$csharp = @"
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

public class OpsMiniServer
{
    private readonly string root;
    private readonly int port;
    private TcpListener listener;
    private volatile bool running;

    public OpsMiniServer(string rootPath, int listenPort) { root = Path.GetFullPath(rootPath); port = listenPort; }

    public void Start()
    {
        listener = new TcpListener(IPAddress.Loopback, port);
        listener.Start();
        running = true;
        Thread t = new Thread(new ThreadStart(AcceptLoop));
        t.IsBackground = true;
        t.Start();
    }

    public void Stop()
    {
        running = false;
        try { if (listener != null) { listener.Stop(); } } catch { }
    }

    private void AcceptLoop()
    {
        while (running)
        {
            TcpClient client = null;
            try { client = listener.AcceptTcpClient(); }
            catch { break; }
            Thread worker = new Thread(new ParameterizedThreadStart(Handle));
            worker.IsBackground = true;
            worker.Start(client);
        }
    }

    private void Handle(object state)
    {
        TcpClient client = (TcpClient)state;
        try
        {
            using (client)
            using (NetworkStream stream = client.GetStream())
            {
                client.ReceiveTimeout = 5000;
                client.SendTimeout = 5000;
                StreamReader reader = new StreamReader(stream, Encoding.ASCII, false, 1024, true);
                string requestLine = reader.ReadLine();
                if (requestLine == null || requestLine.Length == 0) { return; }
                string line;
                while (!string.IsNullOrEmpty(line = reader.ReadLine())) { }

                string[] parts = requestLine.Split(' ');
                string urlPath = parts.Length >= 2 ? parts[1] : "/";
                int q = urlPath.IndexOf('?');
                if (q >= 0) { urlPath = urlPath.Substring(0, q); }
                string rel = Uri.UnescapeDataString(urlPath).TrimStart('/');
                if (rel.Length == 0) { rel = "index.html"; }
                rel = rel.Replace('/', Path.DirectorySeparatorChar);

                string target = Path.GetFullPath(Path.Combine(root, rel));
                if (Directory.Exists(target)) { target = Path.Combine(target, "index.html"); }

                byte[] body;
                string status;
                string ctype;
                if (target.StartsWith(root, StringComparison.OrdinalIgnoreCase) && File.Exists(target))
                {
                    body = File.ReadAllBytes(target);
                    status = "200 OK";
                    ctype = MimeOf(Path.GetExtension(target).ToLowerInvariant());
                }
                else
                {
                    body = Encoding.UTF8.GetBytes("404 Not Found: " + urlPath);
                    status = "404 Not Found";
                    ctype = "text/plain; charset=utf-8";
                }

                string header = "HTTP/1.1 " + status + "\r\nContent-Type: " + ctype +
                                "\r\nContent-Length: " + body.Length +
                                "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
                byte[] hb = Encoding.ASCII.GetBytes(header);
                stream.Write(hb, 0, hb.Length);
                stream.Write(body, 0, body.Length);
                stream.Flush();
            }
        }
        catch { }
    }

    private static string MimeOf(string ext)
    {
        switch (ext)
        {
            case ".html": case ".htm": return "text/html; charset=utf-8";
            case ".css": return "text/css; charset=utf-8";
            case ".js": return "application/javascript; charset=utf-8";
            case ".json": case ".map": return "application/json; charset=utf-8";
            case ".svg": return "image/svg+xml";
            case ".csv": return "text/csv; charset=utf-8";
            case ".txt": return "text/plain; charset=utf-8";
            case ".md": return "text/markdown; charset=utf-8";
            case ".png": return "image/png";
            case ".jpg": case ".jpeg": return "image/jpeg";
            case ".gif": return "image/gif";
            case ".ico": return "image/x-icon";
            case ".woff2": return "font/woff2";
            default: return "application/octet-stream";
        }
    }
}
"@

Add-Type -TypeDefinition $csharp -Language CSharp
$server = New-Object OpsMiniServer($src, $Port)
$server.Start()
Write-Host "服务已启动（后台多线程，Ctrl+C 停止）。" -ForegroundColor DarkGray
try {
  while ($true) { Start-Sleep -Seconds 3600 }
} finally {
  $server.Stop()
  Write-Host "服务已停止。" -ForegroundColor DarkGray
}