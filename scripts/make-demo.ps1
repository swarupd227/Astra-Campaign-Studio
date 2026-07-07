# Converts the recorded Playwright demo (.webm) to a shareable MP4 (H.264/MPEG-4).
# Captions are burned in by the recording itself (a caption bar rendered in-page).
$ErrorActionPreference = "Stop"

$webm = Get-ChildItem -Path "test-results-demo" -Recurse -Filter "*.webm" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $webm) { Write-Error "No recorded .webm found under test-results-demo - run the demo config first."; exit 1 }

New-Item -ItemType Directory -Force -Path "demo" | Out-Null
$out = "demo/astra-demo.mp4"

ffmpeg -y -i $webm.FullName -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -movflags +faststart -an $out

$duration = & ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $out
$sizeMb = [math]::Round((Get-Item $out).Length / 1MB, 1)
Write-Output ("Demo ready: " + $out + " - " + [math]::Round([double]$duration) + "s, " + $sizeMb + " MB")
