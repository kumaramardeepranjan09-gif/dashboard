<#
.SYNOPSIS
    Lightweight zero-dependency local HTTP static server for SmartPredict Dashboard.
#>

$port = 8080
$dashboardDir = Join-Path $PSScriptRoot "dashboard"
$url = "http://localhost:$port/"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($url)

try {
    $listener.Start()
} catch {
    Write-Warning "Could not bind port $port. Opening directly in browser instead..."
    Start-Process (Join-Path $dashboardDir "index.html")
    exit
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " SmartPredict Local Dashboard Server Running at:          " -ForegroundColor Cyan
Write-Host " $url" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop the server." -ForegroundColor Yellow
Write-Host ""

# Launch default browser
Start-Process $url

$mimeMap = @{
    ".html" = "text/html; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".png"  = "image/png"
    ".jpg"  = "image/jpeg"
    ".svg"  = "image/svg+xml"
    ".ico"  = "image/x-icon"
}

while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response

    $rawPath = $request.Url.LocalPath.TrimStart('/')
    if ([string]::IsNullOrEmpty($rawPath) -or $rawPath -eq "/") {
        $rawPath = "index.html"
    }

    $filePath = [System.IO.Path]::GetFullPath((Join-Path $dashboardDir $rawPath))
    $allowedRoot = [System.IO.Path]::GetFullPath($dashboardDir) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $filePath.StartsWith($allowedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        $response.StatusCode = 403
        $response.Close()
        continue
    }

    if (Test-Path $filePath -PathType Leaf) {
        $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
        $contentType = $mimeMap[$ext]
        if (-not $contentType) { $contentType = "application/octet-stream" }
        $response.ContentType = $contentType
        
        $bytes = [System.IO.File]::ReadAllBytes($filePath)
        $response.ContentLength64 = $bytes.Length
        $response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
        $response.StatusCode = 404
        $notFoundMsg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
        $response.OutputStream.Write($notFoundMsg, 0, $notFoundMsg.Length)
    }
    $response.OutputStream.Close()
}
