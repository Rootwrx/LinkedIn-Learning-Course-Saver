Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'icons'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$size = 256
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.Clear([System.Drawing.Color]::Transparent)

# blue rounded square
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 10, 102, 194))
$rect = New-Object System.Drawing.Rectangle(8, 8, ($size - 16), ($size - 16))
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$radius = 52
$path.AddArc($rect.Left, $rect.Top, $radius, $radius, 180, 90)
$path.AddArc($rect.Right - $radius, $rect.Top, $radius, $radius, 270, 90)
$path.AddArc($rect.Right - $radius, $rect.Bottom - $radius, $radius, $radius, 0, 90)
$path.AddArc($rect.Left, $rect.Bottom - $radius, $radius, $radius, 90, 90)
$path.CloseFigure()
$g.FillPath($brush, $path)

# white download arrow (shaft + head)
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$shaft = New-Object System.Drawing.Rectangle(118, 70, 20, 78)
$g.FillRectangle($white, $shaft)
$head = New-Object System.Drawing.Drawing2D.GraphicsPath
$head.AddLine(88, 138, 128, 180)
$head.AddLine(168, 138, 128, 180)
$head.CloseFigure()
$g.FillPath($white, $head)
$base = New-Object System.Drawing.Rectangle(80, 186, 96, 14)
$g.FillRectangle($white, $base)

foreach ($s in @(16, 32, 48, 128)) {
  $small = New-Object System.Drawing.Bitmap($s, $s)
  $sg = [System.Drawing.Graphics]::FromImage($small)
  $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $sg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $sg.DrawImage($bmp, 0, 0, $s, $s)
  $small.Save((Join-Path $outDir "icon$s.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $sg.Dispose()
  $small.Dispose()
}

$g.Dispose()
$bmp.Dispose()
$brush.Dispose()
$white.Dispose()
$path.Dispose()
$head.Dispose()
Write-Output "Icons written to $outDir"
