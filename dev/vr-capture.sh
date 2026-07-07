#!/usr/bin/env bash
# Visual-regression capture: serves a copy of the site with PINNED data (so
# before/after diffs reflect CSS changes, not data drift), screenshots all 5
# pages at 3 widths in headless Chrome, into dev/vr-out/<label>/.
# Usage: bash dev/vr-capture.sh <label>   (e.g. "baseline", "after-fonts")
# Webfonts are ALLOWED (font changes must be visible); GA/ESPN/subscribe blocked.
set -e
LABEL="${1:?usage: vr-capture.sh <label>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVE="${TMPDIR:-/tmp}/ibp_vr"; PORT=8807
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OUT="$ROOT/dev/vr-out/$LABEL"
PIN="$ROOT/dev/vr-pinned-data"

rm -rf "$SERVE"; cp -R "$ROOT" "$SERVE"
# Pin the data: first run snapshots current data/ into dev/vr-pinned-data; every
# capture serves THAT copy so all labels see identical data.
if [ ! -d "$PIN" ]; then mkdir -p "$PIN"; cp -R "$ROOT/data/." "$PIN/"; echo "pinned data snapshot created"; fi
rm -rf "$SERVE/data"; cp -R "$PIN" "$SERVE/data"
# Re-date today.json + preview.json so stale guards don't blank pages
python3 - "$SERVE/data/today.json" "$SERVE/data/preview.json" <<'PY'
import sys, json, datetime
tp, pp = sys.argv[1], sys.argv[2]
today = datetime.date.today().isoformat()
future = (datetime.datetime.utcnow() + datetime.timedelta(hours=6)).strftime("%Y-%m-%dT%H:%M:%SZ")
d = json.load(open(tp)); d["date"] = today
for pk in d.get("picks", []): pk["game_time"] = future
json.dump(d, open(tp, "w"))
try:
    pv = json.load(open(pp)); pv["date"] = (datetime.date.today() + datetime.timedelta(days=1)).isoformat()
    json.dump(pv, open(pp, "w"))
except Exception: pass
print("data re-dated to " + today)
PY

( cd "$SERVE" && python3 -m http.server "$PORT" ) >/dev/null 2>&1 &
SRV=$!; trap 'kill $SRV 2>/dev/null' EXIT; sleep 1
BLOCK='MAP www.googletagmanager.com 127.0.0.1,MAP site.api.espn.com 127.0.0.1,MAP ibp-subscribe.ibprojections.workers.dev 127.0.0.1,MAP cdnjs.cloudflare.com 127.0.0.1'
mkdir -p "$OUT"
shot() {  # shot <page> <width> — watchdog-killed Chrome screenshot, one retry
  local f=$1 w=$2 attempt out prof cpid t
  out="$OUT/${f}_${w}.png"
  for attempt in 1 2; do
    prof="$(mktemp -d)"
    ( "$CHROME" --headless --disable-gpu --no-sandbox --user-data-dir="$prof" \
        --host-resolver-rules="$BLOCK" --hide-scrollbars --force-prefers-reduced-motion \
        --window-size="$w,2400" --virtual-time-budget=6000 \
        --screenshot="$out" "http://localhost:$PORT/$f.html" 2>/dev/null ) &
    cpid=$!; t=0
    while kill -0 $cpid 2>/dev/null && [ $t -lt 30 ]; do sleep 1; t=$((t+1)); done
    kill -9 $cpid 2>/dev/null || true; wait $cpid 2>/dev/null || true
    rm -rf "$prof"
    [ -s "$out" ] && return 0
    echo "  RETRY ${f}_${w} (attempt $attempt timed out)"
  done
  echo "  FAILED ${f}_${w}"
}
for f in index performance history model preview; do
  for w in 375 768 1280; do shot "$f" "$w"; done
  echo "  $f captured (3 widths)"
done
echo "done → $OUT"
