// ── "Just Tell Me What To Bet (for Z and Kream)" — bets.html ─────────────────
// A deliberately bare presentation layer over the SAME official picks feed the
// main page renders (data/today.json). No model math, no new data source, no
// staking change: playability mirrors index.js prCur()/prCushion()/prActionable()
// via the shared helpers in ibp-utils.js (ibpZkFloor/ibpZkPrice/ibpZkCushion),
// and stake tiers are a DISPLAY-ONLY rounding of the exported kelly_units.
// Requires ibp-utils.js loaded first.

// ── Config ────────────────────────────────────────────────────────────────────
const ZK_EDGE_FLOOR = 0.04;            // same 4pp floor the main pick table uses
const ZK_UNIT_KEY   = 'zk_unit_size';  // localStorage: "10"|"25"|"50"|"100"|"custom:<n>"
const ZK_BOOKS = [
  { name: 'Novig',      url: 'https://novig.us' },
  { name: 'FanDuel',    url: 'https://sportsbook.fanduel.com/navigation/mlb' },
  { name: 'DraftKings', url: 'https://sportsbook.draftkings.com/leagues/baseball/mlb' },
];

// Model abbr → team nickname, for plain-English card names ("Brewers ML").
// Keys match the model's abbreviation set (see TEAM_COLORS in index.js).
const ZK_TEAM_NAMES = {
  ARI:'Diamondbacks', ATL:'Braves', BAL:'Orioles', BOS:'Red Sox', CHC:'Cubs',
  CHW:'White Sox', CIN:'Reds', CLE:'Guardians', COL:'Rockies', DET:'Tigers',
  HOU:'Astros', KC:'Royals', LAA:'Angels', LAD:'Dodgers', MIA:'Marlins',
  MIL:'Brewers', MIN:'Twins', MET:'Mets', NYY:'Yankees', OAK:'Athletics',
  PHI:'Phillies', PIT:'Pirates', SD:'Padres', SEA:'Mariners', SF:'Giants',
  STL:'Cardinals', TB:'Rays', TEX:'Rangers', TOR:'Blue Jays', WSH:'Nationals',
};
function zkTeamName(abbr) { return ZK_TEAM_NAMES[abbr] || abbr || '—'; }

function zkEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

// ── Stake tier (display-only) ─────────────────────────────────────────────────
// Snap the exported kelly_units to the nearest of {0.25, 0.50, 0.75, 1.00},
// floored at 0.25 and hard-capped at 1.00. This page never recommends more than
// 1 unit. These tiers are a simplified PRESENTATION of the model's sizing, not
// the model's real staking — the exact kelly_units stay on the main page.
// Missing/zero kelly → null (stake renders as "—", never a fabricated number).
function zkTier(k) {
  const n = typeof k === 'number' ? k : parseFloat(k);
  if (!isFinite(n) || n <= 0) return null;
  return Math.min(1.0, Math.max(0.25, Math.round(n * 4) / 4));
}

// ── Unit-size selector (persisted locally; never sent anywhere) ──────────────
function zkStoredSize() {
  try { return localStorage.getItem(ZK_UNIT_KEY) || '25'; } catch (e) { return '25'; }
}
function zkCurrentSize() {
  const v = zkStoredSize();
  if (v.indexOf('custom:') === 0) {
    const n = parseInt(v.slice(7), 10);
    return (n >= 1 && n <= 10000) ? n : 25;
  }
  const n = parseInt(v, 10);
  return (n >= 1 && n <= 10000) ? n : 25;
}
function zkSelectSize(btn) {
  document.querySelectorAll('.zk-unit-opts button').forEach(b =>
    b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
  const isCustom = btn.dataset.size === 'custom';
  document.getElementById('zk-custom-row').classList.toggle('show', isCustom);
  const inp = document.getElementById('zk-custom-input');
  try {
    localStorage.setItem(ZK_UNIT_KEY, isCustom ? 'custom:' + inp.value : btn.dataset.size);
  } catch (e) { /* private mode — selector still works for this visit */ }
  zkRenderStakes();
}
function zkInitUnitSelector() {
  const saved = zkStoredSize();
  const inp = document.getElementById('zk-custom-input');
  let target = null;
  if (saved.indexOf('custom:') === 0) {
    const n = parseInt(saved.slice(7), 10);
    if (n >= 1 && n <= 10000) inp.value = n;
    target = document.querySelector('.zk-unit-opts button[data-size="custom"]');
  } else {
    target = document.querySelector('.zk-unit-opts button[data-size="' + saved + '"]');
  }
  if (!target) target = document.querySelector('.zk-unit-opts button[data-size="25"]');
  document.querySelectorAll('.zk-unit-opts button').forEach(b => {
    b.setAttribute('aria-pressed', b === target ? 'true' : 'false');
    b.addEventListener('click', () => zkSelectSize(b));
  });
  document.getElementById('zk-custom-row').classList.toggle('show', target.dataset.size === 'custom');
  inp.addEventListener('input', () => {
    try { localStorage.setItem(ZK_UNIT_KEY, 'custom:' + inp.value); } catch (e) {}
    zkRenderStakes();
  });
}
// Re-price every rendered stake from data-units; dollars = units × size, nearest $.
function zkRenderStakes() {
  const size = zkCurrentSize();
  document.querySelectorAll('[data-units]').forEach(el => {
    const u = parseFloat(el.dataset.units);
    el.textContent = isFinite(u) ? '$' + Math.round(u * size) : '—';
  });
}

// ── Game state (same semantics as index.js isLiveGame/isGameOver/isPostponed:
// ESPN status when available, first-pitch clock fallback otherwise) ───────────
let _zkScores = {};
function zkGameState(p) {
  const g = resolveScore(p, _zkScores);
  const st = g && g.status ? g.status : null;
  if (st === 'postponed') return 'gone';
  if (st === 'live' || st === 'final') return 'gone';
  if (st === 'scheduled') return 'pregame';
  // No ESPN data — clock fallback (mirror index.js: live window = start→+3.5h).
  if (!p.game_time) return 'pregame';
  const start = new Date(p.game_time).getTime();
  if (isNaN(start)) return 'pregame';
  return Date.now() > start ? 'gone' : 'pregame';
}

// ── Classification ────────────────────────────────────────────────────────────
// Sort every pregame ML pick into exactly one bucket. Mirrors index.js
// prActionable(): posted edge ≥ 4pp, current edge (when present) ≥ 4pp, and the
// price is only disqualifying when the cushion is KNOWN-negative (null = missing
// data, never treated as gone). Explicit model reversals and stale-guarded
// prices are never rendered as BET THIS.
function zkClassify(p) {
  if (p.current_stale_market_guard === true) {
    return { bucket: 'skip', reason: 'guarded' };            // can't verify the price
  }
  if (p.current_recommendation === 'flipped') {
    return { bucket: 'skip', reason: 'flipped' };            // model no longer likes this side
  }
  if ((p.edge || 0) < ZK_EDGE_FLOOR) return { bucket: 'skip', reason: 'edge' };
  if (p.current_edge != null && p.current_edge < ZK_EDGE_FLOOR) {
    return { bucket: 'skip', reason: 'edge' };               // edge moved off intraday
  }
  const c = ibpZkCushion(p);
  if (c != null && c <= 0) return { bucket: 'skip', reason: 'price' };  // price past the floor
  return { bucket: 'bet' };
}

// ── Renderers ─────────────────────────────────────────────────────────────────
function zkBetCard(p) {
  const name    = zkTeamName(p.pick) + ' ML';
  const price   = ibpZkPrice(p);
  const floor   = ibpZkFloor(p);
  const tier    = zkTier(p.kelly_units);
  const floorTxt = floor != null ? formatOdds(floor) : null;
  const parts   = String(p.game || '').split('@').map(s => s.trim());
  const oppAbbr = parts.length === 2 ? (p.side === 'AWAY' ? parts[1] : parts[0]) : null;
  const vsTxt   = oppAbbr ? (p.side === 'AWAY' ? 'at the ' : 'vs the ') + zkTeamName(oppAbbr) : '';
  const stake = tier != null
    ? '<div class="zk-stake"><span class="zk-amt" data-units="' + tier + '">—</span>'
      + '<span class="zk-units">' + tier.toFixed(2) + ' units</span></div>'
    : '<div class="zk-stake"><span class="zk-amt">—</span>'
      + '<span class="zk-units">stake unavailable right now</span></div>';
  const instruction = floorTxt != null
    ? 'Only bet this if your sportsbook shows <strong>' + zkEsc(floorTxt)
      + ' or better</strong>. Worse than ' + zkEsc(floorTxt)
      + '? Skip it. The model likes it — the price still matters.'
    : 'We can’t confirm a playable price for this one right now — skip it unless the main picks page says otherwise.';
  return '<article class="zk-card">'
    + '<span class="zk-status">BET THIS</span>'
    + '<div class="zk-name">' + zkEsc(name) + '</div>'
    + '<div class="zk-game">' + zkEsc(vsTxt) + (p.game_time ? ' · ' + zkEsc(zkGameTime(p)) : '') + '</div>'
    + '<div class="zk-prices">'
    +   '<div class="zk-price"><div class="zk-k">Our last price check</div><div class="zk-v">' + zkEsc(formatOdds(price)) + '</div></div>'
    +   '<div class="zk-price limit"><div class="zk-k">Playable to</div><div class="zk-v">' + zkEsc(floorTxt != null ? floorTxt : '—') + '</div></div>'
    + '</div>'
    + '<div class="zk-stake-label">Recommended stake</div>'
    + stake
    + '<p class="zk-instruction">' + instruction + '</p>'
    + '<div class="zk-books"><span class="zk-bk-label">Check the price at your book</span>'
    +   ZK_BOOKS.map(b => '<a href="' + b.url + '" target="_blank" rel="noopener">' + b.name + '</a>').join('')
    + '</div>'
    + '</article>';
}

function zkGameTime(p) {
  try {
    return new Date(p.game_time).toLocaleTimeString('en-US',
      { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' }) + ' CT';
  } catch (e) { return ''; }
}

const ZK_SKIP_COPY = {
  price:   'Skip unless the price comes back.',
  edge:    'The number moved — this one no longer clears the bar.',
  flipped: 'The model changed its mind on this game. Sit it out.',
  guarded: 'We can’t verify this price right now. Sit it out.',
};
function zkSkipRow(p, reason) {
  const name  = zkTeamName(p.pick) + ' ML';
  const price = ibpZkPrice(p);
  const floor = ibpZkFloor(p);
  const nums = (reason === 'price' && floor != null)
    ? 'Current price <b>' + zkEsc(formatOdds(price)) + '</b> · needed <b>' + zkEsc(formatOdds(floor)) + '</b> or better'
    : 'Current price <b>' + zkEsc(formatOdds(price)) + '</b>';
  return '<div class="zk-skip-card">'
    + '<div class="zk-skip-row1"><span class="zk-skip-nm">' + zkEsc(name) + '</span><span class="zk-skip-tag">SKIP</span></div>'
    + '<div class="zk-skip-nums">' + nums + '</div>'
    + '<p class="zk-skip-why">' + ZK_SKIP_COPY[reason] + ' Skipping still counts in our '
    + '<a href="history.html">public record</a> — this is you being smart, not us hiding it.</p>'
    + '</div>';
}

// Collapsed skip section. Header matches the actual reasons: the spec's
// "Price moved" copy only when price is why, a neutral label otherwise.
function zkSkipSection(skips) {
  if (!skips.length) return '';
  const allPrice = skips.every(b => b.c.reason === 'price');
  const label = allPrice ? 'Price moved — skip these' : 'Skip these today';
  return '<details class="zk-skips"><summary><span class="zk-chev">▶</span> '
    + label + ' (' + skips.length + ')</summary>'
    + skips.map(b => zkSkipRow(b.p, b.c.reason)).join('') + '</details>';
}

function zkShow(id) {
  ['zk-bets', 'zk-nobets', 'zk-guarded', 'zk-pending'].forEach(x => {
    const el = document.getElementById(x);
    if (el) el.style.display = (x === id) ? 'block' : 'none';
  });
}

function zkRender(data) {
  const asof = document.getElementById('zk-asof');
  // Clear render targets first so a re-render never leaves stale cards behind.
  ['zk-cards', 'zk-skip-section', 'zk-nobets-skips'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  });

  // Staleness guard (same as index.js render()): before the morning run,
  // today.json still holds the PRIOR day's picks — never show yesterday's games.
  let pending = !!(data && data.no_picks_yet);
  try {
    const ctToday = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    if (data && data.date && String(data.date) < ctToday) pending = true;
  } catch (e) { /* fall through, render as-is */ }

  if (pending || !data || !Array.isArray(data.picks)) {
    zkShow('zk-pending');
    return;
  }

  // ML picks only (the only official, staked market — and the only one Z & Kream
  // need to know exists). Live/final/postponed games drop out entirely.
  const ml = data.picks.filter(p => (p.pick_type || 'MONEYLINE') === 'MONEYLINE');
  const pregame = ml.filter(p => zkGameState(p) === 'pregame');

  // Last price check strip — the export timestamp, not a liveness promise.
  if (asof && data.generated_at) {
    asof.innerHTML = '<span class="zk-dot">●</span> Prices last checked at '
      + zkEsc(data.generated_at) + '. Your book’s price is the one that counts.';
    asof.style.display = 'block';
  }

  if (!pregame.length) {
    // Nothing left to play today (slate underway/finished, or nothing posted).
    document.getElementById('zk-nobets-sub').textContent = ml.length
      ? 'Today’s playable window has passed. Whatever happened, it’s happening without you now.'
      : 'No current prices clear the model’s edge threshold.';
    zkShow('zk-nobets');
    return;
  }

  const buckets = pregame.map(p => ({ p, c: zkClassify(p) }));
  const bets  = buckets.filter(b => b.c.bucket === 'bet');
  const skips = buckets.filter(b => b.c.bucket === 'skip');

  // Guarded page state: only when every pregame candidate's price is unverifiable.
  if (pregame.length && pregame.every(p => p.current_stale_market_guard === true)) {
    zkShow('zk-guarded');
    return;
  }

  if (!bets.length) {
    document.getElementById('zk-nobets-sub').textContent =
      'No current prices clear the model’s edge threshold.';
    zkShow('zk-nobets');
    // Still show the skip list under the empty state so the "why" is visible.
    const skipHost = document.getElementById('zk-nobets-skips');
    if (skipHost) skipHost.innerHTML = zkSkipSection(skips);
    return;
  }

  // Sort playable bets by current edge, best first (same default as the pick table).
  bets.sort((a, b) => ((b.p.current_edge != null ? b.p.current_edge : b.p.edge) || 0)
                    - ((a.p.current_edge != null ? a.p.current_edge : a.p.edge) || 0));

  document.getElementById('zk-cards').innerHTML = bets.map(b => zkBetCard(b.p)).join('');
  document.getElementById('zk-skip-section').innerHTML = zkSkipSection(skips);
  zkShow('zk-bets');
  zkRenderStakes();
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function zkInit() {
  zkInitUnitSelector();
  let data = null;
  try {
    const r = await fetch('data/today.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    data = await r.json();
  } catch (e) {
    zkShow('zk-guarded');   // can't read the feed → never guess, never recommend
    return;
  }
  try { _zkScores = await fetchESPNScores(); } catch (e) { _zkScores = {}; }
  try {
    zkRender(data);
  } catch (e) {
    if (typeof _showDebugBanner === 'function') _showDebugBanner('bets.js: ' + (e && e.message));
    zkShow('zk-guarded');   // a render bug must fail safe, not fail confident
  }
}
document.addEventListener('DOMContentLoaded', zkInit);
