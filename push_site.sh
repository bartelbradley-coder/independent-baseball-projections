#!/bin/bash
# Exports fresh JSON data and pushes the site to GitHub Pages.
# Called by run_daily.sh and run_settle.sh after each cron run.

export PATH="/usr/local/bin:/usr/bin:/bin"

MODEL_DIR="/Users/bradleybartel/Desktop/MLB - Model"
SITE_DIR="/Users/bradleybartel/Desktop/fairline-site"
LOG="$MODEL_DIR/logs/site_push_$(date +%Y-%m-%d).log"

echo "=== $(date) ===" >> "$LOG"

# 1. Export fresh JSON
/usr/bin/python3 "$MODEL_DIR/export_site_data.py" \
  --site-dir "$SITE_DIR" >> "$LOG" 2>&1
echo "Export exit: $?" >> "$LOG"

# 2. Push to GitHub — stage all tracked changes (data, HTML, CSS, images)
cd "$SITE_DIR" && \
  git add -u && \
  git diff --cached --quiet || \
  (git commit -m "site: $(date '+%Y-%m-%d %H:%M') PT" && git push origin main) >> "$LOG" 2>&1
echo "Push exit: $?" >> "$LOG"
