// ── Independent Baseball Projections — Shared Utilities ──────────────────────────────────────────
// Loaded by index.html, history.html, and performance.html via:
//   <script src="ibp-utils.js"></script>
// Place that tag just before each page's own inline <script> block.

// ── ESPN abbreviation map ─────────────────────────────────────────────────────
// Maps ESPN team abbreviations → model abbreviations where they differ.
const ESPN_ABBR_MAP = {
  'CWS': 'CHW',   // White Sox: ESPN=CWS, model=CHW
  'NYM': 'MET',   // Mets: ESPN=NYM, model=MET
  'ATH': 'OAK',   // Athletics: ESPN=ATH (rebranded), model=OAK
};

// Survives transient network errors: updated on every successful fetch,
// returned as fallback when the request fails.
let _espnScoresCache = {};

// Fetch today's MLB scoreboard from ESPN. Returns a map of
// "AWAY @ HOME" → { status: 'final'|'live'|'scheduled', awayScore, homeScore }.
//
// The ?dates=YYYYMMDD param is critical: without it, ESPN returns the most
// recently completed games (yesterday's when called before today's games start).
// That would attach yesterday's final scores to today's same-series matchups.
function _espnTodayDate() {
  // YYYYMMDD for the CT slate date — must match today.json's "date" (also CT).
  // The browser's local date would fetch the wrong day's scoreboard for visitors
  // in a later timezone (e.g. already past midnight in Europe) → no games match
  // and live badges silently never appear. en-CA gives YYYY-MM-DD.
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return ymd.replace(/-/g, '');
}

async function fetchESPNScores() {
  try {
    const r = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${_espnTodayDate()}`,
      { cache: 'no-store' }
    );
    const json = await r.json();
    const result = {};
    for (const ev of (json.events || [])) {
      const comp = (ev.competitions || [])[0];
      if (!comp) continue;
      let away, home, awayScore = 0, homeScore = 0;
      for (const c of (comp.competitors || [])) {
        const abbr  = ESPN_ABBR_MAP[c.team.abbreviation] || c.team.abbreviation;
        const score = parseInt(c.score || '0', 10) || 0;
        if (c.homeAway === 'away') { away = abbr; awayScore = score; }
        else                       { home = abbr; homeScore = score; }
      }
      if (!away || !home) continue;
      const sn = ev.status?.type?.name || '';
      const detail = ev.status?.type?.shortDetail || '';   // e.g. "Top 9th", "Delayed, Bot 2nd"
      // A game that has started but is paused (delay / suspension) is still in-play —
      // treat it as live, not scheduled, so it isn't shown as a bettable pregame.
      // Postponed / canceled games won't be played today → their own no-action state.
      let status;
      if (sn === 'STATUS_FINAL')                       status = 'final';
      else if (sn === 'STATUS_POSTPONED' ||
               sn === 'STATUS_CANCELED'  ||
               sn === 'STATUS_CANCELLED')              status = 'postponed';
      else if (sn.includes('IN_PROGRESS') ||
               sn.includes('DELAY')       ||           // STATUS_DELAYED / STATUS_RAIN_DELAY
               sn === 'STATUS_SUSPENDED')              status = 'live';
      else                                             status = 'scheduled';
      result[`${away} @ ${home}`] = { status, awayScore, homeScore, detail };
    }
    _espnScoresCache = result;
    return result;
  } catch(e) {
    return _espnScoresCache; // return last known scores on network failure
  }
}

// ── Today's live data merge ───────────────────────────────────────────────────

// Settle today's picks against live ESPN scores.
// todayDateStr must come from today.json's top-level "date" field (CT timezone —
// never use toISOString(), which returns UTC and rolls to the next calendar day
// after ~6 PM CT in summer). today.json picks have no per-pick date field.
// Per-pick try/catch: one bad ESPN score object won't wipe the entire merge.
function computeTodaySettled(picks, scores, todayDateStr) {
  return picks.map(p => {
    try {
      const g = scores[p.game];
      if (!g || g.status !== 'final') return null;
      const side = (p.side || '').toUpperCase();
      const pickWon = side === 'AWAY' ? g.awayScore > g.homeScore : g.homeScore > g.awayScore;
      const odds  = p.odds;
      const pnl_u = pickWon
        ? (odds > 0 ? odds / 100 : 100 / Math.abs(odds))
        : -1.0;
      return {
        date: todayDateStr, game: p.game, pick: p.pick, side: p.side,
        odds, edge: p.edge, model_prob: p.model_prob,
        result: pickWon ? 'W' : 'L',
        pnl_u: Math.round(pnl_u * 1000) / 1000,
        kelly_units: p.kelly_units || null,
      };
    } catch(e) {
      console.error('[Independent Baseball Projections] computeTodaySettled pick error:', e, p);
      return null;
    }
  }).filter(Boolean);
}

// Extend a historical P&L curve array with today's newly settled picks.
function extendPnlCurve(curve, newSettled) {
  if (!newSettled.length) return curve;
  const extended = [...curve];
  let running = extended.length > 0 ? extended[extended.length - 1] : 0;
  for (const r of newSettled) {
    running = Math.round((running + r.pnl_u) * 1000) / 1000;
    extended.push(running);
  }
  return extended;
}

// Deep-clone a performance.json object and merge today's settled picks into
// the season totals and current-month bucket.
function applyTodayToPerf(p, newSettled) {
  if (!newSettled.length || !p) return p;
  const updated = JSON.parse(JSON.stringify(p));
  const wins   = newSettled.filter(r => r.result === 'W').length;
  const losses = newSettled.filter(r => r.result === 'L').length;
  const units  = newSettled.reduce((s, r) => s + r.pnl_u, 0);
  if (updated.season) {
    updated.season.wins   = (updated.season.wins   || 0) + wins;
    updated.season.losses = (updated.season.losses || 0) + losses;
    updated.season.units  = Math.round(((updated.season.units || 0) + units) * 1000) / 1000;
    updated.season.bets   = (updated.season.bets   || 0) + newSettled.length;
    updated.season.roi    = updated.season.bets > 0
      ? updated.season.units / updated.season.bets : 0;
  }
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const currentMonth = monthNames[new Date().getMonth()];
  if (updated.season_roi_by_month) {
    const mo = updated.season_roi_by_month.find(m => m.month === currentMonth);
    if (mo) {
      mo.units = Math.round(((mo.units || 0) + units) * 1000) / 1000;
      mo.bets  = (mo.bets  || 0) + newSettled.length;
      mo.roi   = mo.bets > 0 ? mo.units / mo.bets : 0;
    } else {
      updated.season_roi_by_month.push({
        month: currentMonth, units, bets: newSettled.length,
        roi: newSettled.length > 0 ? units / newSettled.length : 0,
      });
    }
  }
  return updated;
}

// ── Formatting helpers ────────────────────────────────────────────────────────

// Format an American moneyline odds value (+150, -110, etc.).
function formatOdds(ml) {
  if (!ml && ml !== 0) return '—';
  return ml > 0 ? '+' + ml : String(ml);
}

// Format a decimal fraction as a signed percentage string (+4.2%, -1.0%).
function pct(v, d = 1) {
  if (v == null) return '—';
  return (v >= 0 ? '+' : '') + (v * 100).toFixed(d) + '%';
}

// ── Dev-only debug banner ─────────────────────────────────────────────────────
// Shows a red dismissible banner at top of page when a JS error is thrown.
// No-ops automatically on any non-localhost origin.
function _showDebugBanner(msg) {
  if (!location.hostname.match(/^(localhost|127\.0\.0\.1)$/)) return;
  let d = document.getElementById('fl-debug-banner');
  if (!d) {
    d = document.createElement('div');
    d.id = 'fl-debug-banner';
    d.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;' +
      'background:#ef4444;color:#fff;font-size:11px;font-family:monospace;' +
      'padding:5px 12px;cursor:pointer;line-height:1.5;white-space:pre-wrap';
    d.onclick = () => d.remove();
    document.body.prepend(d);
  }
  d.textContent = '[Independent Baseball Projections Error] ' + String(msg) + '  (click to dismiss)';
}
window.addEventListener('unhandledrejection', e => _showDebugBanner(e.reason));
window.addEventListener('error', e => _showDebugBanner(
  e.message + ' — ' + e.filename + ':' + e.lineno
));

// ── Email capture (daily-recap signup) — shared across all pages with an .email-bar ──
function handleEmailSubmit(e) {
  e.preventDefault();
  const form = document.getElementById('ec-form');
  const success = document.getElementById('ec-success');
  const btn = form ? form.querySelector('.ec-btn') : null;
  if (!form || !success) return;
  const email = (form.querySelector('input[type="email"]').value || '').trim();
  if (!email) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Subscribing…'; }
  fetch('https://ibp-subscribe.ibprojections.workers.dev/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  .then(r => r.json())
  .then(() => { form.style.display = 'none'; success.style.display = 'block'; })
  .catch(() => {
    if (btn) { btn.disabled = false; btn.textContent = 'Get Daily Recap →'; }
    alert('Something went wrong — please try again in a moment.');
  });
}
