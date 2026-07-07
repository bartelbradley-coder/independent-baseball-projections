#!/usr/bin/env bash
# Functional-QA runner: serves a copy of the site with dev/qa-inject.js injected
# before each page's main script, drives the page in headless Chrome, and extracts
# the JSON result blob. Blocks the email worker (no real signup) + gtag/fonts;
# ALLOWS cdnjs (html2canvas) so share infra loads. ESPN seeded-off (clock fallback).
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVE="${TMPDIR:-/tmp}/ibp_qa"; PORT=8801
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
rm -rf "$SERVE"; cp -R "$ROOT" "$SERVE"
# inject the probe before each page's first <script src=...> (so error capture is armed first)
for f in index performance history model preview; do
  python3 - "$SERVE/$f.html" <<'PY'
import sys,re
p=sys.argv[1]; s=open(p).read()
tag='<script src="dev/qa-inject.js"></script>\n'
# put it just before the first external page script
m=re.search(r'<script src="(ibp-utils|index|performance|history|model|preview)\b', s)
if m: s=s[:m.start()]+tag+s[m.start():]
else: s=s.replace('</body>', tag+'</body>',1)
open(p,'w').write(s)
PY
done
cp "$ROOT/dev/qa-inject.js" "$SERVE/dev/qa-inject.js"
# Re-date today.json to the current local date so the stale-slate guard doesn't
# blank the homepage when QA runs after midnight (the real feed regenerates in
# the morning; QA should exercise the rendered table at any hour).
python3 - "$SERVE/data/today.json" <<'PY'
import sys, json, datetime
p = sys.argv[1]
try:
    d = json.load(open(p))
    today = datetime.date.today().isoformat()
    if d.get("date") != today:
        d["date"] = today
        future = (datetime.datetime.utcnow() + datetime.timedelta(hours=6)).strftime("%Y-%m-%dT%H:%M:%SZ")
        for pk in d.get("picks", []): pk["game_time"] = future
        json.dump(d, open(p, "w"))
        print("re-dated today.json to " + today)
except Exception as e:
    print("today seed skipped:", e)
PY
# Seed a POPULATED, tomorrow-dated preview.json so the preview "cards" path is exercised
# (the live feed is often empty in the morning). Uses today's picks as the shape.
python3 - "$SERVE/data/preview.json" "$SERVE/data/today.json" <<'PY'
import sys, json, datetime
prev_p, today_p = sys.argv[1], sys.argv[2]
try:
    t = json.load(open(today_p))
    tmr = (datetime.date.today() + datetime.timedelta(days=1)).isoformat()
    out = {"date": tmr, "generated_at": "7:00 PM CT", "picks": t.get("picks", [])[:6]}
    json.dump(out, open(prev_p, "w"))
    print("seeded populated preview.json date=" + tmr + " picks=" + str(len(out["picks"])))
except Exception as e:
    print("preview seed skipped:", e)
PY
( cd "$SERVE" && python3 -m http.server "$PORT" ) >/dev/null 2>&1 &
SRV=$!; trap 'kill $SRV 2>/dev/null' EXIT; sleep 1
BLOCK='MAP fonts.googleapis.com 127.0.0.1,MAP fonts.gstatic.com 127.0.0.1,MAP www.googletagmanager.com 127.0.0.1,MAP site.api.espn.com 127.0.0.1,MAP ibp-subscribe.ibprojections.workers.dev 127.0.0.1'
mkdir -p "$ROOT/dev/qa-out"
for f in index performance history model preview; do
  dom="$ROOT/dev/qa-out/$f.html"; prof="$(mktemp -d)"; rm -f "$dom"
  # Chrome doesn't reliably self-exit on --dump-dom; run it in the background, wait
  # for the QA blob (the probe fires at 5.5s) to land in the file, then kill it.
  ( "$CHROME" --headless --disable-gpu --no-sandbox --user-data-dir="$prof" --host-resolver-rules="$BLOCK" \
      --virtual-time-budget=9000 --dump-dom "http://localhost:$PORT/$f.html" 2>/dev/null > "$dom" ) &
  cpid=$!; w=0
  while ! grep -q '@@END@@' "$dom" 2>/dev/null && [ $w -lt 20 ]; do sleep 1; w=$((w+1)); done
  sleep 1; kill $cpid 2>/dev/null; wait $cpid 2>/dev/null || true
  blob=$(grep -oE '@@QA@@.*@@END@@' "$dom" | head -1 | sed 's/@@QA@@//; s/@@END@@//')
  if [ -n "$blob" ]; then echo "$blob" > "$ROOT/dev/qa-out/$f.json"; echo "  $f: captured (${w}s)"; else echo "  $f: NO QA BLOB (${w}s — page may not have hydrated)"; fi
done
echo "done"
