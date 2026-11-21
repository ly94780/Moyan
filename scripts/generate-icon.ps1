$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$resourceDirectory = Join-Path $PSScriptRoot '../resources'
New-Item -ItemType Directory -Force -Path $resourceDirectory | Out-Null
$bitmap = [System.Drawing.Bitmap]::new(256, 256)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)
$shape = [System.Drawing.Drawing2D.GraphicsPath]::new()
$shape.AddArc(8, 8, 80, 80, 180, 90)
$shape.AddArc(168, 8, 80, 80, 270, 90)
$shape.AddArc(168, 168, 80, 80, 0, 90)
$shape.AddArc(8, 168, 80, 80, 90, 90)
$shape.CloseFigure()
$brush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(65, 104, 212))
$graphics.FillPath($brush, $shape)
$pen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, 11)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$feather = [System.Drawing.Drawing2D.GraphicsPath]::new()
$feather.AddBezier(77, 177, 60, 129, 118, 66, 186, 62)
$feather.AddBezier(186, 62, 190, 119, 141, 172, 96, 171)
$graphics.DrawPath($pen, $feather)
$graphics.DrawLine($pen, 67, 193, 165, 90)
$graphics.DrawLine($pen, 111, 148, 111, 119)
$bitmap.Save((Join-Path $resourceDirectory 'moyan.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
$stream = [System.IO.File]::Create((Join-Path $resourceDirectory 'moyan.ico'))
try { $icon.Save($stream) } finally { $stream.Dispose() }
$icon.Dispose()
$feather.Dispose()
$pen.Dispose()
$brush.Dispose()
$shape.Dispose()
$graphics.Dispose()
$bitmap.Dispose()
