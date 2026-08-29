param(
  [ValidateRange(1, 11)]
  [int]$Batch = 1,
  [string]$PrivateRoot = '',
  [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($PrivateRoot)) {
  $mathFolder = -join @(
    [char]0x6578, [char]0x5B78, [char]0x6A94, [char]0x6848
  )
  $PrivateRoot = Join-Path ([Environment]::GetFolderPath('Desktop')) $mathFolder
}
$batchText = '{0:D2}' -f $Batch
$folderName = "matha-starter-v4-batch-$batchText-combined-v2-resumable-hashbound-20260829"
$reviewRoot = Join-Path $PrivateRoot $folderName
$packetFile = Join-Path $reviewRoot 'review-packet.json'
$reviewFile = Join-Path $reviewRoot 'review.html'
$serverFile = Join-Path $reviewRoot 'serve-review.py'

foreach ($required in @($packetFile, $reviewFile, $serverFile)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Missing authoritative review file: $required"
  }
}

$packet = Get-Content -LiteralPath $packetFile -Raw -Encoding UTF8 | ConvertFrom-Json
$expectedQuestions = if ($Batch -eq 11) { 14 } else { 35 }
if ($packet.kind -ne 'starter-combined-human-review-packet' -or
    [int]$packet.version -ne 2 -or
    [int]$packet.combinedReviewVersion -ne 2 -or
    $packet.structuredAnswerRequired -ne $true -or
    $packet.releaseAuthority -ne $false -or
    [int]$packet.questions -ne $expectedQuestions -or
    [string]$packet.packetSha256 -notmatch '^[0-9a-f]{64}$' -or
    [string]$packet.localUrl -notmatch '^http://127\.0\.0\.1:\d+/.+/review\.html$') {
  throw 'The review packet version, count, or safety fields are invalid.'
}

$reviewHtml = Get-Content -LiteralPath $reviewFile -Raw -Encoding UTF8
foreach ($marker in @(
  [string]$packet.packetSha256,
  'starter-combined-review-checkpoint',
  'structuredAnswerRequired'
)) {
  if (-not $reviewHtml.Contains($marker)) {
    throw "The review page is missing a safety marker: $marker"
  }
}

$summary = [ordered]@{
  batch = $Batch
  questions = [int]$packet.questions
  packetSha256 = [string]$packet.packetSha256
  localUrl = [string]$packet.localUrl
  reviewRoot = $reviewRoot
  validated = $true
}
if ($ValidateOnly) {
  $summary | ConvertTo-Json
  exit 0
}

$server = $null
try {
  $server = Start-Process -FilePath 'python' -ArgumentList 'serve-review.py' `
    -WorkingDirectory $reviewRoot -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 1
  if ($server.HasExited) {
    throw 'The local review server failed to start; the port may be occupied.'
  }
  $response = Invoke-WebRequest -Uri $packet.localUrl -UseBasicParsing -TimeoutSec 10
  if ($response.StatusCode -ne 200 -or -not $response.Content.Contains($packet.packetSha256)) {
    throw 'The localhost response is not the expected hash-bound review page.'
  }
  Start-Process ([string]$packet.localUrl)
  Write-Host "Opened batch $Batch with $expectedQuestions questions in the default browser."
  Write-Host 'Progress is stored in batch-scoped localStorage. Download a checkpoint regularly.'
  [void](Read-Host 'Press Enter when finished or pausing to stop the local server')
}
finally {
  if ($null -ne $server -and -not $server.HasExited) {
    Stop-Process -Id $server.Id -Force
  }
}
