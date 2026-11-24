param(
  [string]$Folder = '.',
  [switch]$DeleteOriginals,
  [switch]$IncludeDuplicates,
  [string]$Ffmpeg = 'ffmpeg'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Folder)) {
  throw "Folder not found: $Folder"
}
$root = (Resolve-Path -LiteralPath $Folder).Path

$cmd = Get-Command $Ffmpeg -ErrorAction SilentlyContinue
if (-not $cmd) {
  throw "ffmpeg was not found. Install it (for example: winget install yt-dlp.FFmpeg) or pass -Ffmpeg with the full path to ffmpeg.exe."
}

$files = Get-ChildItem -LiteralPath $root -Recurse -File -Filter '*.ts'
$converted = 0
$skipped = 0
$failed = 0

foreach ($file in $files) {
  $name = $file.Name

  # Chrome adds (1), (2) ... when the same lesson is saved more than once.
  # Those are copies of the same video, so skip them unless asked otherwise.
  if (-not $IncludeDuplicates -and $name -match '\(\d+\)\.ts$') {
    $skipped++
    continue
  }

  $output = Join-Path $file.DirectoryName ($file.BaseName + '.mp4')
  if (Test-Path -LiteralPath $output) {
    Write-Host "Skip (MP4 already exists): $output"
    $skipped++
    continue
  }

  Write-Host "Remux: $name"
  # -c copy means no re-encoding: same quality, and usually a few seconds.
  & $cmd.Source -hide_banner -loglevel error -y -i $file.FullName `
    -c copy -bsf:a aac_adtstoasc -movflags +faststart $output

  if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $output) -and
      (Get-Item -LiteralPath $output).Length -gt 0) {
    $converted++
    if ($DeleteOriginals) {
      Remove-Item -LiteralPath $file.FullName -Force
    }
  } else {
    $failed++
    Write-Warning "Could not remux: $name"
    if (Test-Path -LiteralPath $output) {
      Remove-Item -LiteralPath $output -Force
    }
  }
}

Write-Host ""
Write-Host "Done: $converted converted, $skipped skipped, $failed failed."
if ($converted -gt 0 -and -not $DeleteOriginals) {
  Write-Host "Original .ts files kept. Re-run with -DeleteOriginals to remove them."
}
