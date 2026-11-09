#!/usr/bin/env bash
# Puts the Kaggle results into the HyperFrames project.
# Usage (from reel2/): bash free_pipeline/ingest.sh incoming/ahzab_out.zip
set -euo pipefail
zip="${1:-incoming/ahzab_out.zip}"
tmp=$(mktemp -d); unzip -q -o "$zip" -d "$tmp"; src="$tmp/ahzab_out"
mkdir -p assets/shots assets/voice assets/portraits
cp "$src"/portraits/CHR-027_APPROVED.png assets/portraits/ 2>/dev/null || true
# upscale 480x832 shots to 1080x1920 (lanczos, light sharpen), 30 fps
for f in "$src"/shots/B*.mp4; do
  ffmpeg -nostdin -v error -y -i "$f" -vf "scale=1080:1920:flags=lanczos:force_original_aspect_ratio=increase,crop=1080:1920,unsharp=5:5:0.4,fps=30" \
    -c:v libx264 -crf 16 -preset slow -pix_fmt yuv420p -an "assets/shots/$(basename "$f")"
done
cp "$src"/voice/N*.mp3 assets/voice/
# fit each narration slot to its real length
for f in assets/voice/N*.mp3; do
  id=$(basename "$f" .mp3 | tr 'N' 'n'); d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")
  python3 - "$id" "$d" <<'PY'
import re,sys
i,d=sys.argv[1],float(sys.argv[2]); p="index.html"; s=open(p).read()
s=re.sub(rf'(<audio id="{i}"[^>]*data-duration=")[0-9.]+',lambda m:m.group(1)+f"{d:.2f}",s); open(p,"w").write(s)
if d>3.9: print(f"WARNING {i} is {d:.2f}s: longer than its beat, retime the beat")
PY
done
rm -rf "$tmp"; echo "ingested; now run: npx hyperframes check && npx hyperframes snapshot --review"
