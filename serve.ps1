$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:8123/")
$listener.Start()
$root = "C:\Users\Argie\Documents\HappyBDayYana"
Write-Output "Serving $root at http://localhost:8123/"
while ($listener.IsListening) {
  try {
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response
    $path = $request.Url.LocalPath.TrimStart('/')
    if ([string]::IsNullOrWhiteSpace($path)) { $path = "index.html" }
    $file = Join-Path $root $path
    $full = [System.IO.Path]::GetFullPath($file)
    if (-not $full.StartsWith($root)) {
      $response.StatusCode = 403
      $response.Close()
      continue
    }
    if (Test-Path $full -PathType Leaf) {
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $ext = [System.IO.Path]::GetExtension($full).ToLower()
      $mime = switch ($ext) {
        ".html" { "text/html; charset=utf-8" }
        ".css" { "text/css; charset=utf-8" }
        ".js" { "text/javascript; charset=utf-8" }
        ".json" { "application/json; charset=utf-8" }
        ".jpg" { "image/jpeg" }
        ".jpeg" { "image/jpeg" }
        ".png" { "image/png" }
        ".svg" { "image/svg+xml" }
        ".woff2" { "font/woff2" }
        ".woff" { "font/woff" }
        default { "application/octet-stream" }
      }
      $response.ContentType = $mime
      $response.ContentLength64 = $bytes.Length
      $response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $response.StatusCode = 404
      $msg = [System.Text.Encoding]::UTF8.GetBytes("Not found")
      $response.ContentLength64 = $msg.Length
      $response.OutputStream.Write($msg, 0, $msg.Length)
    }
    $response.Close()
  } catch {
    if ($listener.IsListening) { Write-Warning $_.Exception.Message }
  }
}
