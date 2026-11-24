param(
  [string]$Root = "$env:USERPROFILE\Downloads",
  [switch]$Watch,
  [switch]$DeleteOriginals,
  [switch]$IncludeDuplicates,
  [int]$PollSeconds = 5,
  [string]$Ffmpeg = 'ffmpeg'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Root)) {
  throw "Folder not found: $Root"
}
$root = (Resolve-Path -LiteralPath $Root).Path

$cmd = Get-Command $Ffmpeg -ErrorAction SilentlyContinue
if (-not $cmd) {
  throw "ffmpeg was not found. Install it with: winget install yt-dlp.FFmpeg  (or pass -Ffmpeg with the full path to ffmpeg.exe)."
}

function Test-StillWriting([System.IO.FileInfo]$File) {
  # Chrome writes downloads progressively. Skip files touched in the last few
  # seconds, and confirm the size is stable before remuxing.
  if ((Get-Date) - $File.LastWriteTime -lt [TimeSpan]::FromSeconds(3)) { return $true }
  $before = $File.Length
  Start-Sleep -Milliseconds 700
  $file.Refresh()
  return $file.Length -ne $before
}

function Convert-Ts([System.IO.FileInfo]$File) {
  $name = $File.Name

  # Chrome adds (1), (2) ... when a lesson is saved more than once.
  if (-not $IncludeDuplicates -and $name -match '\(\d+\)\.ts$') { return 'skipped' }

  $output = Join-Path $File.DirectoryName ($File.BaseName + '.mp4')
  if (Test-Path -LiteralPath $output) { return 'skipped' }
  if (Test-StillWriting $File) { return 'waiting' }

  Write-Host "Remux: $($File.FullName.Substring($root.Length + 1))"
  # -c copy = remux only. No quality loss, no re-encoding.
  & $cmd.Source -hide_banner -loglevel error -y -i $File.FullName `
    -c copy -bsf:a aac_adtstoasc -movflags +faststart $output

  if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $output) -and
      (Get-Item -LiteralPath $output).Length -gt 0) {
    if ($DeleteOriginals) { Remove-Item -LiteralPath $File.FullName -Force }
    return 'converted'
  }

  Write-Warning "Could not remux: $name"
  if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Force }
  return 'failed'
}

function Run-Pass {
  $files = @(Get-ChildItem -LiteralPath $root -Recurse -File -Filter '*.ts' -ErrorAction SilentlyContinue)
  $stats = @{ converted = 0; skipped = 0; waiting = 0; failed = 0 }
  foreach ($file in $files) {
    $result = Convert-Ts $file
    $stats[$result]++
  }
  return $stats
}

if (-not $Watch) {
  $stats = Run-Pass
  Write-Host ""
  Write-Host "Done: $($stats.converted) converted, $($stats.skipped) skipped, $($stats.waiting) still downloading, $($stats.failed) failed."
  if ($stats.converted -gt 0 -and -not $DeleteOriginals) {
    Write-Host "Original .ts files kept. Re-run with -DeleteOriginals to remove them."
  }
  return
}

Write-Host "Watching $root for .ts files - press Ctrl+C to stop."
try {
  while ($true) {
    $stats = Run-Pass
    if ($stats.converted -gt 0) {
      Write-Host "Pass complete: $($stats.converted) converted, $($stats.skipped) skipped, $($stats.waiting) waiting, $($stats.failed) failed."
    }
    Start-Sleep -Seconds $PollSeconds
  }
} finally {
  Write-Host ""
  Write-Host "Watcher stopped."
}
