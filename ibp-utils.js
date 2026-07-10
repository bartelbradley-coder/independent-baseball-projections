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
    Object.defineProperty(result, '__dh', { value: {}, enumerable: false });  // matchup → [entries]; non-enumerable so it never leaks into key lookups
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
      const key   = `${away} @ ${home}`;
      const start = Date.parse(ev.date || comp.date || '') || null;   // first-pitch (UTC), for DH disambiguation
      const entry = { status, awayScore, homeScore, detail, start };
      // Doubleheaders return the same matchup twice. Keep ALL of them under __dh so
      // a pick can be matched to the right game by start time; result[key] keeps the
      // last one for back-compat callers that look up by matchup string alone.
      (result.__dh[key] = result.__dh[key] || []).push(entry);
      result[key] = entry;
    }
    _espnScoresCache = result;
    return result;
  } catch(e) {
    return _espnScoresCache; // return last known scores on network failure
  }
}

// Resolve the ESPN entry for a pick, disambiguating doubleheaders by start time.
// Most matchups have one game → plain lookup. When ESPN returned two games for the
// same matchup (a DH), pick the one whose first pitch is closest to the pick's
// game_time so a game-1 pick never settles against game-2's score.
function resolveScore(p, scores) {
  if (!scores || !p) return null;
  const dh = scores.__dh && scores.__dh[p.game];
  if (dh && dh.length > 1 && p.game_time) {
    const t = Date.parse(p.game_time);
    if (!isNaN(t)) {
      return dh.slice().sort((a, b) =>
        Math.abs((a.start || 0) - t) - Math.abs((b.start || 0) - t))[0];
    }
  }
  return scores[p.game] || null;
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
      const g = resolveScore(p, scores);
      if (!g || g.status !== 'final') return null;
      const side = (p.side || '').toUpperCase();
      const push = g.awayScore != null && g.awayScore === g.homeScore;  // tie → push (stake returned)
      const pickWon = side === 'AWAY' ? g.awayScore > g.homeScore : g.homeScore > g.awayScore;
      const odds  = p.odds;
      const pnl_u = push ? 0
        : pickWon ? (odds > 0 ? odds / 100 : 100 / Math.abs(odds))
        : -1.0;
      return {
        date: todayDateStr, game: p.game, pick: p.pick, side: p.side,
        odds, edge: p.edge, model_prob: p.model_prob,
        result: push ? 'P' : pickWon ? 'W' : 'L',
        pnl_u: Math.round(pnl_u * 1000) / 1000,
        // Pass sizing through untouched (`!= null`, not `||` — a real 0-stake must
        // survive) incl. the legacy kelly_pct so kellyStakeUnits() can fall back.
        kelly_units: p.kelly_units != null ? p.kelly_units : null,
        kelly_pct:   p.kelly_pct   != null ? p.kelly_pct   : null,
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

// ── Shared odds stack (moved verbatim from index.js, 2026-07-07) ──────────────
// Used by index.js (pick table + drawer) AND bets.js ("For Z & Kream" page).
// Book-odds sanitizer (trust fix): shared by every place that renders per-book
// lines. Fixes two long-standing display bugs: (1) raw book_odds were shown
// unfiltered, so a stale / wrong-signed line (e.g. a MyBookie -833 on a +183
// underdog) rendered verbatim and looked like a data error; (2) "best price" was
// picked with a raw descending-American sort / Math.max, which is only valid when
// every line has the same sign. Here we convert to implied probability, drop books
// that are off-market vs the field median (robust to a single bad book), and rank
// by payout (lowest implied prob = best).
const _BOOK_NAMES = {novig:'Novig',prophetx:'ProphetX',pinnacle:'Pinnacle',lowvig:'LowVig',
  betonlineag:'BetOnline',draftkings:'DraftKings',fanduel:'FanDuel',betmgm:'BetMGM',
  betrivers:'BetRivers',espnbet:'ESPN Bet',hardrockbet:'Hard Rock',betway:'Betway',
  bovada:'Bovada',mybookieag:'MyBookie',betus:'BetUS'};
function _impliedFromAmerican(ml) {
  const n = typeof ml === 'number' ? ml : parseInt(ml);
  if (!isFinite(n) || n === 0) return null;
  return n > 0 ? 100 / (n + 100) : (-n) / ((-n) + 100);
}
// Returns { entries:[{book,odds,implied}], best:{...}|null, dropped:N }, entries
// ranked best-payout-first. Two filters: (1) ANCHOR — drop books whose implied
// prob is far from the pick's OWN posted price (opts.anchorPp, default 0.22);
// catches a whole field quoting the wrong side / corrupted values (e.g. -1275
// books on a +183 underdog). (2) MEDIAN — drop a lone outlier within an
// otherwise-consistent field (opts.outlierPp, default 0.15).
function sanitizeBookOdds(p, opts) {
  const outlierPp = (opts && opts.outlierPp != null) ? opts.outlierPp : 0.15;
  const anchorPp  = (opts && opts.anchorPp  != null) ? opts.anchorPp  : 0.22;
  const raw = (() => {
    const src = (typeof p.book_odds === 'object' && p.book_odds) ? p.book_odds
              : (typeof p.books === 'object' && p.books) ? p.books : null;
    if (src) return src;
    try { return JSON.parse(p.book_odds || p.books || '{}'); } catch (e) { return {}; }
  })();
  let entries = Object.entries(raw || {})
    .map(([k, v]) => {
      const odds = typeof v === 'number' ? v : parseInt(v);
      return { book: _BOOK_NAMES[k.toLowerCase()] || k, odds: odds, implied: _impliedFromAmerican(odds) };
    })
    .filter(e => !isNaN(e.odds) && e.implied != null);
  const total = entries.length;
  // (1) anchor against the pick's own posted price; if the whole field is wrong-
  //     side/corrupted, this leaves entries empty → no (bad) current price shown.
  const anchor = _impliedFromAmerican(p.odds);
  if (anchor != null && entries.length) {
    entries = entries.filter(e => Math.abs(e.implied - anchor) <= anchorPp);
  }
  // (2) median filter for a lone outlier within an otherwise-consistent field.
  if (entries.length >= 3) {
    const imp = entries.map(e => e.implied).slice().sort((a, b) => a - b);
    const mid = Math.floor(imp.length / 2);
    const median = imp.length % 2 ? imp[mid] : (imp[mid - 1] + imp[mid]) / 2;
    entries = entries.filter(e => Math.abs(e.implied - median) <= outlierPp);
  }
  entries.sort((a, b) => a.implied - b.implied);   // best payout first
  return { entries: entries, best: entries.length ? entries[0] : null, dropped: total - entries.length };
}

// American odds → a continuous "cents" scale where +100 and -100 both map to 0 and
// higher = a better price for the bettor. Lets us measure line movement and cushion
// cleanly, even across the +/- boundary. (Moved verbatim from index.js.)
function _oddsToCents(o) {
  if (o == null || isNaN(o)) return null;
  return o > 0 ? o - 100 : -(Math.abs(o) - 100);
}

// ── "For Z & Kream" (bets.html) playability helpers ───────────────────────────
// These mirror index.js prCur()/prCushion()/prActionable() semantics EXACTLY:
// the current re-rated read leads with posted fallback, and a pick is only
// rejected on price when the cushion is KNOWN-negative (null cushion = missing
// data, never treated as 0). If index.js prActionable() changes, change these
// to match — same data, same verdicts, one presentation simpler.
function ibpZkFloor(p) {
  return p.current_playable_to != null ? p.current_playable_to : p.playable_to;
}
function ibpZkPrice(p) {
  const sb = sanitizeBookOdds(p);
  return sb.best ? sb.best.odds : (p.best_odds != null ? p.best_odds : p.odds);
}
function ibpZkCushion(p) {
  const cc = _oddsToCents(ibpZkPrice(p)), ptc = _oddsToCents(ibpZkFloor(p));
  return (cc != null && ptc != null) ? Math.round(cc - ptc) : null;
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

// ── Email capture (daily-picks signup) — shared across all pages with an .email-bar ──
function handleEmailSubmit(e) {
  e.preventDefault();
  // Form-relative (supports multiple capture points on one page): the submitted form is
  // e.target; its success message is the sibling .ec-success. Falls back to the legacy ids.
  const form = (e.target && e.target.tagName === 'FORM') ? e.target : document.getElementById('ec-form');
  if (!form) return;
  const scope = form.parentElement || document;
  const success = scope.querySelector('.ec-success') || document.getElementById('ec-success');
  const btn = form.querySelector('.ec-btn');
  const origLabel = btn ? btn.textContent : '';
  const input = form.querySelector('input[type="email"]');
  const email = ((input && input.value) || '').trim();
  if (!email) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Subscribing…'; }
  fetch('https://ibp-subscribe.ibprojections.workers.dev/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  .then(r => r.json())
  .then(() => {
    form.style.display = 'none'; if (success) success.style.display = 'block';
    // Subscribed — permanently suppress the sticky mobile capture prompt.
    try { localStorage.setItem('ibp_subscribed', '1'); document.getElementById('sticky-capture')?.remove(); } catch (err) {}
  })
  .catch(() => {
    if (btn) { btn.disabled = false; btn.textContent = origLabel || 'Get Daily Picks →'; }
    alert('Something went wrong — please try again in a moment.');
  });
}

// ── Inline SVG icon set (P4a) — replaces emoji in UI chrome. Monochrome,
// stroke=currentColor so icons inherit text color; size via the px argument.
const IBP_ICONS = {
  lock:      '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  chart:     '<path d="M5 20V10M12 20V4M19 20v-6"/>',
  trendup:   '<path d="M3 17l6-6 4 4 7-7"/><path d="M14 8h6v6"/>',
  trenddown: '<path d="M3 7l6 6 4-4 7 7"/><path d="M14 16h6v-6"/>',
  clock:     '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  search:    '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  mail:      '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  pin:       '<path d="M12 21s-6-5.1-6-10a6 6 0 1 1 12 0c0 4.9-6 10-6 10z"/><circle cx="12" cy="11" r="2"/>',
  download:  '<path d="M12 3v12M7 11l5 5 5-5M5 21h14"/>',
  share:     '<path d="M12 21V9M7 13l5-5 5 5M5 3h14"/>',
  info:      '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M12 11v5"/>',
  trophy:    '<path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0z"/><path d="M7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3"/>',
  calendar:  '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>',
  target:    '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  baseball:  '<circle cx="12" cy="12" r="9"/><path d="M5.5 6a12 12 0 0 1 0 12M18.5 6a12 12 0 0 0 0 12"/>',
  warn:      '<path d="M12 3L2 20h20L12 3z"/><path d="M12 9v5M12 17h.01"/>',
};
function ibpIcon(name, px, cls) {
  const p = IBP_ICONS[name];
  if (!p) return '';
  // width/height attrs are overridden by the .ibp-ic{width:1em;height:1em} rule
  // (which keeps text line-heights undisturbed) — the inline font-size makes
  // 1em equal the requested px in every context, so the argument stays authoritative.
  return '<svg class="ibp-ic' + (cls ? ' ' + cls : '') + '" style="font-size:' + (px || 14) + 'px" width="' + (px || 14) + '" height="' + (px || 14)
    + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + p + '</svg>';
}


/* ── Public CLV suppression (fail-closed) ─────────────────────────────────────
 * Operator policy 2026-07-10: public CLV renders ONLY when EVERY required
 * payload is present AND explicitly reports clv_suppressed === false.
 *  - a failed/missing feed        -> suppressed (fail closed)
 *  - a missing suppression field  -> suppressed (fail closed)
 *  - any payload reporting true   -> suppressed
 *  - stale non-null CLV values never override the state (renderers gate on
 *    the flag before reading any close-derived value)
 * Restoration requires every payload to support it under a separately
 * approved policy. Pure function — unit-tested in dev/test_clv_suppression.js.
 */
function computeClvSuppressed(payloads) {
  if (!Array.isArray(payloads) || payloads.length === 0) return true;
  for (const p of payloads) {
    if (!p || typeof p !== 'object') return true;          // feed failed
    if (p.clv_suppressed !== false) return true;           // missing or true
  }
  return false;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports.computeClvSuppressed = computeClvSuppressed;
}
