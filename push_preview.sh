#!/bin/bash
# Generates tomorrow's opening-line preview picks and pushes to GitHub Pages.
# Schedule this as the evening cron (e.g. 10-11 PM CT) instead of push_site.sh.
#
# Requires export_site_data.py to support --preview, which must:
#   1. Target tomorrow's games (date.today() + timedelta(days=1))
#   2. Write output to data/preview.json (not data/today.json)
#   3. Set preview.json "date" to tomorrow's YYYY-MM-DD (CT timezone)

export PATH="/usr/local/bin:/usr/bin:/bin"

MODEL_DIR="/Users/bradleybartel/Desktop/MLB - Model"
SITE_DIR="/Users/bradleybartel/Desktop/fairline-site"
LOG="$MODEL_DIR/logs/site_preview_$(date +%Y-%m-%d).log"

echo "=== $(date) ===" >> "$LOG"

# 1. Export tomorrow's preview picks
/usr/bin/python3 "$MODEL_DIR/export_site_data.py" \
  --site-dir "$SITE_DIR" --preview >> "$LOG" 2>&1
echo "Preview export exit: $?" >> "$LOG"

# 2. Push to GitHub — stage all tracked changes
cd "$SITE_DIR" && \
  git add -u && \
  git diff --cached --quiet || \
  (git commit -m "preview: $(date '+%Y-%m-%d %H:%M') PT" && git push origin main) >> "$LOG" 2>&1
echo "Push exit: $?" >> "$LOG"
