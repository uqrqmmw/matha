param(
  [string]$PrivateEvalRoot = '',
  [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($PrivateEvalRoot)) {
  $mathFolder = -join @([char]0x6578, [char]0x5B78, [char]0x6A94, [char]0x6848)
  $PrivateEvalRoot = Join-Path (Join-Path ([Environment]::GetFolderPath('Desktop')) $mathFolder) 'matha-private-evals'
}
$reviewRoot = Join-Path $PrivateEvalRoot 'paper-mock-1-detail-gold-human-review-v1-20260829'
$packetFile = Join-Path $reviewRoot 'review-packet.json'
$reviewFile = Join-Path $reviewRoot 'review.html'
$serverFile = Join-Path $reviewRoot 'serve-review.py'
foreach ($required in @($packetFile, $reviewFile, $serverFile)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Missing authoritative detail-gold review file: $required"
  }
}
$packet = Get-Content -LiteralPath $packetFile -Raw -Encoding UTF8 | ConvertFrom-Json
$packetSha = (Get-FileHash -LiteralPath $packetFile -Algorithm SHA256).Hash.ToLowerInvariant()
$expected = @(3, 4, 11, 12, 13, 14, 16)
$actual = @($packet.questionNos | ForEach-Object { [int]$_ })
if ($packet.kind -ne 'matha-paper-detail-gold-review-packet' -or
    [int]$packet.version -ne 1 -or $packet.releaseAuthority -ne $false -or
    [string]$packet.unsignedGoldSha256 -notmatch '^[0-9a-f]{64}$' -or
    ($actual -join ',') -ne ($expected -join ',')) {
  throw 'The detail-gold review packet contract is invalid.'
}
$reviewHtml = Get-Content -LiteralPath $reviewFile -Raw -Encoding UTF8
foreach ($marker in @($packetSha, [string]$packet.unsignedGoldSha256, 'matha-paper-detail-gold-signoff')) {
  if (-not $reviewHtml.Contains($marker)) {
    throw "The detail-gold review page is missing a hash-bound marker: $marker"
  }
}
$url = 'http://127.0.0.1:8775/review.html'
$summary = [ordered]@{ questions = $actual.Count; packetSha256 = $packetSha; localUrl = $url; reviewRoot = $reviewRoot; validated = $true }
if ($ValidateOnly) {
  $summary | ConvertTo-Json
  exit 0
}
$server = $null
try {
  $server = Start-Process -FilePath 'python' -ArgumentList 'serve-review.py' `
    -WorkingDirectory $reviewRoot -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 1
  if ($server.HasExited) { throw 'The local detail-gold review server failed to start.' }
  $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 10
  if ($response.StatusCode -ne 200 -or -not $response.Content.Contains($packetSha)) {
    throw 'The localhost response is not the expected hash-bound detail-gold review page.'
  }
  Start-Process $url
  Write-Host 'Opened the seven-question detail-gold review in the default browser.'
  [void](Read-Host 'Press Enter when finished or pausing to stop the local server')
}
finally {
  if ($null -ne $server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
}
