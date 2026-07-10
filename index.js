// formatOdds, fetchESPNScores, ESPN_ABBR_MAP, _showDebugBanner → ibp-utils.js
// ── Global state ─────────────────────────────────────────────────────────────
const picksMap = {};
// _bankroll: user's total betting bankroll in dollars. Kelly dollar amounts are
// calculated as kelly_units × bankroll / 100  (since 1 unit = bankroll / 100 = 1% of bankroll).
let _bankroll = parseFloat(localStorage.getItem('ibp_bankroll') || '0');
// Legacy migration: if old unit-size key exists, convert it to bankroll (×10)
if (!_bankroll && localStorage.getItem('ibp_unit_size')) {
  _bankroll = parseFloat(localStorage.getItem('ibp_unit_size') || '0') * 10;
  if (_bankroll > 0) localStorage.setItem('ibp_bankroll', String(_bankroll));
}
let _unitSize = _bankroll / 100;  // kept for any legacy references; derived from bankroll
let _histRef  = null; // history data reference for tracker result lookup
let _mainPicksRef = []; // today's main picks for share-all
let _scoresRef = {};    // latest ESPN scores, for settled result share cards
let _lastGameStatus = {};   // per-game ESPN status last seen — detects live/final transitions
const _warnedNoMatch = new Set();   // games already warned about (no ESPN match) — avoids console spam
let _perfRef = null;    // performance.json (edge tiers) for share-card credibility
let _mdActiveId = null; // card whose details are currently expanded inline
let _histContextFn = null;      // set in render() — returns hist-context HTML for a pick
let _countdownTimerStarted = false;
let _lastBucketSig = null;      // section-bucket signature; re-render when a game changes state

// ── Book-odds sanitizer ───────────────────────────────────────────────────────
// _BOOK_NAMES, _impliedFromAmerican and sanitizeBookOdds moved VERBATIM to
// ibp-utils.js (loaded before this file) so bets.js shares the exact same
// best-price behavior. Edit them there, never re-add copies here.

// ── Share on X/Twitter ────────────────────────────────────────────────────────
// Open an X share with the post text PLUS a UTM-tagged link back to the site, so every
// share renders a link card (OG image) and the click-throughs are attributable in GA.
function _shareIntent(text, campaign) {
  const url = 'https://independentbaseballprojections.net/?utm_source=twitter&utm_medium=social&utm_campaign=' + campaign;
  window.open(
    `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
    '_blank', 'width=550,height=420');
}

function shareOnX(id) {
  const p = picksMap[id];
  if (!p) return;
  const edge  = (p.edge * 100).toFixed(1);
  const model = p.model_prob  ? (p.model_prob  * 100).toFixed(1) : null;
  const mkt   = p.market_prob ? (p.market_prob * 100).toFixed(1) : null;
  let text = `🎯 Independent Baseball Projections: ${p.pick} ${formatOdds(p.odds)} (+${edge}% edge)`;
  if (model && mkt) text += `\nModel ${model}% vs. Pinnacle ${mkt}%`;
  if (p.pitcher) text += `\n⚾ ${p.pitcher}`;
  _shareIntent(text, 'pick_share');
}

// ── Share card: state ────────────────────────────────────────────────────────
let _shareCardPickId = null;

// ── Build V5 square card HTML from real pick data ────────────────────────────
// MLB team accent colors (vivid primary; a few dark-primary teams use a brighter
// secondary so the accent bar reads on the dark card).
const TEAM_COLORS = {
  ARI:'#A71930', ATL:'#CE1141', BAL:'#DF4601', BOS:'#BD3039', CHC:'#0E3386',
  CHW:'#C4CED4', CIN:'#C6011F', CLE:'#0C2340', COL:'#5E3A98', DET:'#1f6feb',
  HOU:'#EB6E1F', KC:'#1f6feb', LAA:'#BA0021', LAD:'#1f6feb', MIA:'#00A3E0',
  MIL:'#FFC52F', MIN:'#D31145', MET:'#FF5910', NYY:'#1f6feb', OAK:'#EFB21E',
  PHI:'#E81828', PIT:'#FDB827', SD:'#FFC425', SF:'#FD5A1E', SEA:'#005C5C',
  STL:'#C41E3A', TB:'#8FBCE6', TEX:'#C0111F', TOR:'#1D78CE', WSH:'#AB0003',
};

function _buildShareCardHTML(p, isBest) {
  // The shareable image IS the expanded pick card (prDrawerHTML), wrapped in a slim
  // brand header + disclaimer/URL footer. Single source of truth — no parallel design.
  const gr = (typeof getPickResult === 'function') ? getPickResult(p, _scoresRef) : null;
  const drawer = prDrawerHTML(p, !!isBest, gr, true);   // forShare=true -> no action buttons
  let dateStr = '';
  try {
    const d = (typeof _todayDataRef !== 'undefined' && _todayDataRef && _todayDataRef.date)
      ? new Date(_todayDataRef.date + 'T12:00:00') : new Date();
    if (!isNaN(d)) dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch (e) {}
  return `<div class="sc-wrap" id="share-card-el">
    <div class="sc-wrap-hdr">
      <svg class="sc-wrap-logo" width="22" height="22" viewBox="0 0 88 88" xmlns="http://www.w3.org/2000/svg"><circle cx="44" cy="44" r="32" fill="rgba(99,102,241,0.1)"/><circle cx="44" cy="44" r="32" stroke="rgba(255,255,255,0.82)" stroke-width="1.8" fill="none"/><text x="19" y="52" font-family="system-ui,sans-serif" font-size="22" font-weight="900" fill="white">IB</text><text x="44" y="52" font-family="system-ui,sans-serif" font-size="22" font-weight="900" fill="#60a5fa">P</text><line x1="56" y1="60" x2="64" y2="50" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round"/><circle cx="64" cy="50" r="3.3" fill="#22c55e"/></svg>
      <span class="sc-wrap-name"><b>INDEPENDENT BASEBALL</b> PROJECTIONS</span>
      <span class="sc-wrap-date">${dateStr}</span>
    </div>
    <div class="sc-wrap-body">${drawer}</div>
    <div class="sc-wrap-ftr">
      <div class="sc-wrap-disc">Informational only — not financial advice. Verify current odds and lineup before placing any bet. Past performance does not guarantee future results.</div>
      <div class="sc-wrap-url">independentbaseballprojections.net</div>
    </div>
  </div>`;
}


// ── Show share modal ─────────────────────────────────────────────────────────
function sharePickCard(id, isBest) {
  const p = picksMap[id];
  if (!p) return;
  _shareCardPickId = id;

  const modal   = document.getElementById('share-modal');
  const preview = document.getElementById('share-modal-preview');
  if (!modal || !preview) return;

  // Build card HTML and inject — the exact expanded drawer + slim brand/disclaimer frame
  preview.innerHTML = _buildShareCardHTML(p, isBest);

  // Scale the natural-size card to fit the modal preview (card is portrait, not 1080²)
  const scaledEl = document.getElementById('share-card-el');
  if (scaledEl) {
    const modalBox = document.querySelector('.share-modal-box');
    const boxW  = modalBox ? modalBox.offsetWidth : Math.min(window.innerWidth * 0.92, 700);
    const maxH  = window.innerHeight * 0.65; // leave room for toolbar + actions
    const cardW = scaledEl.offsetWidth  || 680;
    const cardH = scaledEl.offsetHeight || 680;
    const scale = Math.min(boxW / cardW, maxH / cardH, 1); // never upscale
    scaledEl.style.transform       = `scale(${scale})`;
    scaledEl.style.transformOrigin = 'top center';
    const scaledH = Math.round(cardH * scale);
    preview.style.height    = scaledH + 'px';
    preview.style.minHeight = scaledH + 'px';
  }

  // Show native share button if available (mobile)
  const nativeBtn = document.getElementById('share-native-btn');
  if (nativeBtn) {
    nativeBtn.style.display = (navigator.share && navigator.canShare) ? 'inline-flex' : 'none';
  }

  // Show modal
  _shareTrigger = document.activeElement;
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  modal.querySelector('.share-modal-close')?.focus();  // move focus into the dialog

  // Escape closes; Tab is trapped within the dialog
  document.addEventListener('keydown', _shareModalEscHandler);
}

let _shareTrigger = null;
function _shareModalEscHandler(e) {
  if (e.key === 'Escape') { closeShareModal(); return; }
  if (e.key === 'Tab') {
    const modal = document.getElementById('share-modal');
    if (!modal) return;
    const focusable = Array.from(modal.querySelectorAll('button, [href], input, [tabindex]:not([tabindex=\"-1\"])'))
      .filter(el => el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
}

function closeShareModal() {
  const modal = document.getElementById('share-modal');
  if (modal) modal.classList.add('hidden');
  document.body.style.overflow = '';
  document.removeEventListener('keydown', _shareModalEscHandler);
  _shareCardPickId = null;
  if (_shareTrigger && _shareTrigger.focus) { _shareTrigger.focus(); _shareTrigger = null; }
}

function closeShareModalOnBackdrop(e) {
  // Only close if clicking the overlay itself, not the modal box
  if (e.target === document.getElementById('share-modal')) closeShareModal();
}

// ── Download PNG via html2canvas ─────────────────────────────────────────────
async function downloadShareCard() {
  const el  = document.getElementById('share-card-el');
  const btn = document.getElementById('share-dl-btn');
  const hint = document.getElementById('share-modal-hint');
  if (!el || !btn) return;

  if (typeof html2canvas === 'undefined') {
    alert('html2canvas not loaded — please refresh the page.');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Rendering…';
  if (hint) hint.textContent = 'Generating PNG…';

  try {
    // Temporarily reset transform so html2canvas captures full 1080×1080
    const savedTransform = el.style.transform;
    const savedOrigin    = el.style.transformOrigin;
    el.style.transform = 'none';
    el.style.transformOrigin = 'top left';

    const canvas = await html2canvas(el, {
      scale: 2,
      useCORS: true,
      allowTaint: true,
      backgroundColor: '#0b0e16',
      logging: false,
    });

    // Restore scale
    el.style.transform = savedTransform;
    el.style.transformOrigin = savedOrigin;

    // Trigger download
    const p   = picksMap[_shareCardPickId] || {};
    const team = (p.pick || 'pick').replace(/\s/g, '-').toLowerCase();
    const link = document.createElement('a');
    link.download = `ibp-${team}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();

    btn.textContent = '✓ Downloaded';
    if (hint) hint.textContent = 'PNG saved';
    setTimeout(() => {
      btn.disabled = false;
      btn.innerHTML = ibpIcon('download', 13) + ' Download PNG';
      if (hint) hint.textContent = 'Ready to share';
    }, 2500);
  } catch (err) {
    console.error('[Independent Baseball Projections] html2canvas error:', err);
    btn.disabled = false;
    btn.innerHTML = ibpIcon('download', 13) + ' Download PNG';
    if (hint) hint.textContent = 'Error — try again';
  }
}

// ── Native Web Share (mobile) — share as image blob ──────────────────────────
async function nativeShareCard() {
  const el  = document.getElementById('share-card-el');
  const btn = document.getElementById('share-native-btn');
  if (!el || !btn) return;
  if (typeof html2canvas === 'undefined') { alert('html2canvas not loaded.'); return; }

  btn.disabled = true;
  btn.textContent = 'Preparing…';

  try {
    const savedTransform = el.style.transform;
    const savedOrigin    = el.style.transformOrigin;
    el.style.transform = 'none';
    el.style.transformOrigin = 'top left';

    const canvas = await html2canvas(el, {
      scale: 2,
      useCORS: true, allowTaint: true,
      backgroundColor: '#0b0e16', logging: false,
    });

    el.style.transform = savedTransform;
    el.style.transformOrigin = savedOrigin;

    canvas.toBlob(async (blob) => {
      if (!blob) { btn.disabled = false; btn.innerHTML = ibpIcon('share', 13) + ' Share Image'; return; }
      const p    = picksMap[_shareCardPickId] || {};
      const team = (p.pick || 'pick').replace(/\s/g, '-').toLowerCase();
      const file = new File([blob], `ibp-${team}.png`, { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            files: [file],
            title: `Independent Baseball Projections — ${p.pick || 'Value Bet'}`,
            text:  'Bet the number, not the noise. independentbaseballprojections.net',
          });
          btn.textContent = '✓ Shared';
        } catch(e) {
          if (e.name !== 'AbortError') btn.innerHTML = ibpIcon('share', 13) + ' Share Image';
        }
      } else {
        // Fallback: download
        const link = document.createElement('a');
        link.download = `ibp-${team}.png`;
        link.href = URL.createObjectURL(blob);
        link.click();
        btn.textContent = '✓ Downloaded';
      }
      setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = ibpIcon('share', 13) + ' Share Image';
      }, 2500);
    }, 'image/png');
  } catch (err) {
    console.error('[Independent Baseball Projections] nativeShareCard error:', err);
    btn.disabled = false;
    btn.innerHTML = ibpIcon('share', 13) + ' Share Image';
  }
}

function shareAllPicks() {
  const picks = _mainPicksRef;
  if (!picks || picks.length === 0) return;
  const lines = picks.map(p => `• ${p.pick} ${formatOdds(p.odds)} +${(p.edge*100).toFixed(1)}% edge`);
  let text = `⚾ Independent Baseball Projections Picks:\n` + lines.join('\n');
  _shareIntent(text, 'slate_share');
}

// Bankroll widget init
// _onBankrollChange: called whenever the bankroll input changes.
// Uses targeted DOM updates only — never replaces the full card innerHTML,
// which would destroy the input element and reset focus after every keystroke.
function _onBankrollChange(val) {
  _bankroll = parseFloat(val) || 0;
  _unitSize = _bankroll / 100;
  localStorage.setItem('ibp_bankroll', String(_bankroll));
  refreshKellyUSD();
  _updateTotalDollarStat();   // update Total $ value in place
  _updatePhbHelper();          // update helper text in place
}

// Targeted update for the Total $ stat — patches the two spans by ID
// without re-rendering the card (which would reset focus on the bankroll input).
function _updateTotalDollarStat() {
  const valEl = document.getElementById('phb-total-dollar-val');
  const subEl = document.getElementById('phb-total-dollar-sub');
  if (!valEl || !subEl || !_todayDataRef) return;

  let dollarStr, dollarSub, dollarCol;
  if (_indexPnlMode === 'kelly') {
    // Kelly: pnl_units × bankroll ÷ 100
    const ks     = _histDataRef && _histDataRef.rows ? _kellyStatsFromHist(_histDataRef.rows) : null;
    const uPnl   = ks ? ks.season.units : ((_todayDataRef.season || {}).units || 0);
    if (_bankroll > 0) {
      const d    = Math.round(uPnl * _bankroll / 100);
      dollarStr  = (d >= 0 ? '+$' : '-$') + Math.abs(d).toLocaleString();
      dollarSub  = `at $${_bankroll.toLocaleString()} bankroll`;
      dollarCol  = d >= 0 ? 'green' : 'red';
    } else {
      dollarStr  = '—';
      dollarSub  = 'enter bankroll above';
      dollarCol  = 'muted';
    }
  } else {
    // Flat: pnl_units × $100 (flat bet size, bankroll-independent)
    const flatPnl = ((_todayDataRef.season || {}).units || 0);
    const d       = Math.round(flatPnl * 100);
    dollarStr = (d >= 0 ? '+$' : '-$') + Math.abs(d).toLocaleString();
    dollarSub = 'at $100/bet';
    dollarCol = d >= 0 ? 'green' : 'red';
  }

  valEl.textContent = dollarStr;
  valEl.className   = `phb-stat-val ${dollarCol}`;
  subEl.textContent = dollarSub;
}

function _updatePhbHelper() {
  const el = document.getElementById('phb-helper-text');
  const bkWrap = document.getElementById('phb-bankroll-wrap');
  if (!el) return;
  if (_indexPnlMode === 'flat') {
    el.innerHTML = 'Each pick sized at <strong>$100 flat</strong> regardless of edge size.';
    if (bkWrap) bkWrap.classList.add('flat-mode');
  } else if (_bankroll > 0) {
    // Find a representative Kelly stake from today's picks to show the conversion
    const samplePick = Object.values(picksMap).find(p => kellyStakeUnits(p) != null);
    const _exU = samplePick ? kellyStakeUnits(samplePick) : 1.3;
    const exUnits = _exU.toFixed(1);
    const exDollar = Math.round(_exU * _bankroll / 100);
    el.innerHTML = `<strong>${exUnits}u = $${exDollar}</strong> at $${_bankroll.toLocaleString()} bankroll`;
    if (bkWrap) bkWrap.classList.remove('flat-mode');
  } else {
    el.innerHTML = 'Enter your bankroll to see <strong>Kelly dollar amounts</strong> on each pick.';
    if (bkWrap) bkWrap.classList.remove('flat-mode');
  }
}

/* ── Email capture: POST to Cloudflare Worker proxy → Beehiiv API ── */
// handleEmailSubmit → ibp-utils.js (shared across pages)

window.addEventListener('DOMContentLoaded', () => {
  // Bankroll input is now in the picks-header-block (rendered by JS after data loads).
  // Use event delegation on the page container instead of direct getElementById.
  document.getElementById('picks')?.addEventListener('input', e => {
    if (e.target.id === 'phb-bankroll-input') {
      _onBankrollChange(e.target.value);
    }
  });
});

function refreshKellyUSD() {
  // Update dollar amounts inside the Details collapse
  document.querySelectorAll('.kelly-usd').forEach(el => {
    const units = parseFloat(el.dataset.units || 0);
    el.textContent = (_bankroll > 0 && units > 0) ? `$${Math.round(units * _bankroll / 100)}` : '';
  });
  // Update the always-visible Kelly badge on every pick card
  document.querySelectorAll('.uph-kelly-badge[data-kelly-units]').forEach(el => {
    const units = parseFloat(el.dataset.kellyUnits || 0);
    if (!units) return;
    el.textContent = (_bankroll > 0)
      ? `${units.toFixed(1)}u · $${Math.round(units * _bankroll / 100)}`
      : `${units.toFixed(1)}u Kelly`;
  });
}

// ── Copy pick to clipboard ────────────────────────────────────────────────────
// copyPick removed — the Copy button was retired (share now produces the full card image)

// ── Game state — ESPN status is authoritative; the clock is only a fallback ────
// _scoresRef (set in render() before rows are built, refreshed every 5 min) holds
// real ESPN status. Trusting it avoids two failure modes the pure-clock heuristic
// had: long/extra-inning games marked "Final" at +3.5h while still playing, and
// delayed games that look pregame-bettable. Falls back to the clock only when ESPN
// has no entry for the game.
function _espnStatus(p) {
  const sr = (typeof _scoresRef !== 'undefined') ? _scoresRef : null;
  const g = (typeof resolveScore === 'function') ? resolveScore(p, sr) : (sr ? sr[p.game] : null);
  return g && g.status ? g.status : null;
}

function isLiveGame(p) {
  const st = _espnStatus(p);
  if (st) return st === 'live';
  // Fallback: no ESPN data — first pitch → +3.5h window.
  if (!p.game_time) return false;
  const start = new Date(p.game_time).getTime();
  if (isNaN(start)) return false;
  const now   = Date.now();
  return now > start && now < start + 3.5 * 60 * 60 * 1000;
}

function isGameOver(p) {
  const st = _espnStatus(p);
  if (st) return st === 'final';
  // Fallback: no ESPN data — >3.5h past first pitch.
  if (!p.game_time) return false;
  const start = new Date(p.game_time).getTime();
  if (isNaN(start)) return false;
  return Date.now() > start + 3.5 * 60 * 60 * 1000;
}

// Postponed / canceled — game won't be played today, so the pick is no-action.
// Only knowable from ESPN; there's no clock fallback.
function isPostponed(p) {
  return _espnStatus(p) === 'postponed';
}

// ── Mini sparkline SVG ────────────────────────────────────────────────────────
function miniSparkline(curve) {
  if (!curve || curve.length < 3) return '';
  const data = [0, ...curve];
  const minV = Math.min(...data, 0);
  const maxV = Math.max(...data, 0);
  const range = maxV - minV || 1;
  const W = 80, H = 28;
  const xFor = i => (i / (data.length - 1)) * W;
  const yFor = v => H * (1 - (v - minV) / range);
  const pts  = data.map((v, i) => `${xFor(i).toFixed(1)},${yFor(v).toFixed(1)}`).join(' ');
  const col  = curve[curve.length - 1] >= 0 ? '#22c55e' : '#ef4444';
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block">
    <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

// ── Compute current streak from history ───────────────────────────────────────
function computeStreak(hist) {
  if (!hist || !hist.rows) return null;
  const settled = hist.rows
    .filter(r => r.result === 'W' || r.result === 'L')
    .sort((a, b) => b.date.localeCompare(a.date));
  if (settled.length === 0) return null;
  let count = 0;
  const dir = settled[0].result;
  for (const r of settled) {
    if (r.result === dir) count++;
    else break;
  }
  return { dir, count };
}

// (Removed: personal 'I bet this' tracker — its Track buttons were no longer
// rendered by any code path, so the panel could never populate. If a bet
// journal returns, rebuild it as a first-class feature, not a leftover.)

// (Removed: renderTodayTrackingIndex — dead code. Its target DOM nodes
// (#idx-tracking-section / #idx-tracking-card) never existed in the page, so it
// always early-returned. The compact pick rows now serve this live-status role.)

// renderBrandBar removed — brand identity merged into renderPicksHeaderBlock

// ── Evidence section: 3 data-backed claims for new visitors ──────────────────
// ── Calibration (reliability) chart ───────────────────────────────────────────
// Bins settled picks by predicted win probability and plots the actual win rate
// against the prediction. Points on the diagonal = the model's probabilities are
// accurate. Sparse tail bins (n < 12) are dropped to avoid noise.
function buildCalibrationChart(rows) {
  if (!rows || !rows.length) return '';
  const bins = {};
  rows.forEach(r => {
    const mp = r.model_prob, res = r.result;
    if (mp == null || (res !== 'W' && res !== 'L')) return;
    const b = Math.floor(mp * 100 / 5) * 5;
    (bins[b] = bins[b] || { w: 0, n: 0 });
    bins[b].n++; if (res === 'W') bins[b].w++;
  });
  const pts = Object.keys(bins).map(Number).sort((a, b) => a - b)
    .filter(b => bins[b].n >= 12)
    .map(b => ({ pred: b + 2.5, obs: bins[b].w / bins[b].n * 100, n: bins[b].n }));
  if (pts.length < 3) return '';

  const W = 320, H = 240, padL = 34, padB = 30, padT = 10, padR = 12;
  const x0 = padL, x1 = W - padR, y0 = H - padB, y1 = padT;
  const dmin = 35, dmax = 70;
  const sx = v => x0 + (Math.max(dmin, Math.min(dmax, v)) - dmin) / (dmax - dmin) * (x1 - x0);
  const sy = v => y0 - (Math.max(dmin, Math.min(dmax, v)) - dmin) / (dmax - dmin) * (y0 - y1);
  const ticks = [40, 50, 60, 70];

  const grid = ticks.map(t =>
    `<line x1="${sx(t)}" y1="${y0}" x2="${sx(t)}" y2="${y1}" stroke="rgba(255,255,255,.05)"/>` +
    `<line x1="${x0}" y1="${sy(t)}" x2="${x1}" y2="${sy(t)}" stroke="rgba(255,255,255,.05)"/>`).join('');
  const diag = `<line x1="${sx(dmin)}" y1="${sy(dmin)}" x2="${sx(dmax)}" y2="${sy(dmax)}" stroke="rgba(255,255,255,.22)" stroke-dasharray="4 3" stroke-width="1"/>`;
  const xlabels = ticks.map(t => `<text x="${sx(t)}" y="${y0 + 13}" fill="var(--text-4)" font-size="9" text-anchor="middle" font-family="var(--font-mono)">${t}%</text>`).join('');
  const ylabels = ticks.map(t => `<text x="${x0 - 5}" y="${sy(t) + 3}" fill="var(--text-4)" font-size="9" text-anchor="end" font-family="var(--font-mono)">${t}%</text>`).join('');
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.pred).toFixed(1)} ${sy(p.obs).toFixed(1)}`).join(' ');
  const line = `<path d="${path}" fill="none" stroke="var(--indigo-lt)" stroke-width="2"/>`;
  const dots = pts.map(p => {
    const r = Math.max(3, Math.min(7, Math.sqrt(p.n) / 1.7));
    const dev = Math.abs(p.obs - p.pred);
    const col = dev <= 2.5 ? 'var(--green)' : dev <= 5 ? 'var(--amber)' : 'var(--red)';
    return `<circle cx="${sx(p.pred).toFixed(1)}" cy="${sy(p.obs).toFixed(1)}" r="${r.toFixed(1)}" fill="${col}" stroke="#0b0e16" stroke-width="1.5"><title>Predicted ~${p.pred}% · won ${p.obs.toFixed(0)}% (n=${p.n})</title></circle>`;
  }).join('');
  const axisTitles =
    `<text x="${((x0 + x1) / 2).toFixed(0)}" y="${H - 1}" fill="var(--text-3)" font-size="9" text-anchor="middle">Model predicted win probability</text>` +
    `<text x="9" y="${((y0 + y1) / 2).toFixed(0)}" fill="var(--text-3)" font-size="9" text-anchor="middle" transform="rotate(-90 9 ${((y0 + y1) / 2).toFixed(0)})">Actual win rate</text>`;
  const totalN = pts.reduce((a, p) => a + p.n, 0);

  return `
    <div class="calib-block">
      <div class="calib-hdr">Model Calibration</div>
      <div class="calib-sub">Each dot is a group of picks at a given predicted win probability, plotted against how often they actually won. Dots on the dashed line mean the model's probabilities are accurate — not just profitable. Based on ${totalN} settled picks; dot size = sample size.</div>
      <svg class="calib-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Model calibration: predicted vs actual win rate">
        ${grid}${diag}${line}${dots}${xlabels}${ylabels}${axisTitles}
      </svg>
    </div>`;
}

function renderEvidenceSection(data, perf, hist) {
  const section = document.getElementById('evidence-section');
  const grid    = document.getElementById('evidence-grid');
  if (!section || !grid || !data.season) return;

  const s         = data.season;
  const roi       = s.roi != null ? (s.roi >= 0 ? '+' : '') + (s.roi * 100).toFixed(1) + '%' : null;
  const clv       = data.avg_clv != null ? (data.avg_clv >= 0 ? '+' : '') + (data.avg_clv * 100).toFixed(2) + '%' : null;
  const clvCount  = data.clv_count  || 0;
  const posPct    = data.clv_positive_pct != null ? Math.round(data.clv_positive_pct * 100) + '%' : null;

  // CLV trend from performance.json monthly series
  let trendStr = '';
  if (perf && perf.clv_series && perf.clv_series.length >= 3) {
    const cs = perf.clv_series;
    const n = cs.length;
    const firstAvg = cs.slice(0, Math.floor(n / 3)).reduce((a, b) => a + b, 0) / Math.floor(n / 3);
    const lastAvg  = cs.slice(-Math.floor(n / 3)).reduce((a, b) => a + b, 0) / Math.floor(n / 3);
    trendStr = lastAvg > firstAvg + 0.001 ? 'Trend: improving in 2026.'
             : lastAvg < firstAvg - 0.001 ? 'Trend: declining — monitor.'
             : 'Trend: stable across 2026.';
  }

  if (!roi && !clv) return;  // no settled data yet
  section.style.display = 'block';

  // CLV claim is gated by sample size: only make the causal "identifies edge
  // before it's priced in" claim once the sample is meaningful (>=100 picks).
  // Below that, lead with the honest hit-rate + a "still building sample" caveat.
  // Operator decision 2026-07-10 (revised): while window._clvSuppressed is set
  // the CLV evidence card is OMITTED entirely (no placeholder). NOTE: this
  // whole section is currently dead code — renderEvidenceSection is not
  // invoked and index.html has no evidence-section element.
  const _clvDesc = 'Tracked against validated market closes.';

  grid.innerHTML = `
    ${window._clvSuppressed ? '' : `<div class="evidence-claim">
      <div class="ec-stat">${clv || '—'}</div>
      <div class="ec-label">Average Closing Line Value</div>
      <div class="ec-desc">${_clvDesc}</div>
    </div>`}
    <div class="evidence-claim">
      <div class="ec-stat">${roi || '—'}</div>
      <div class="ec-label">${s.bets || ''} tracked picks, 2026 season</div>
      <div class="ec-desc">Every pick is logged with a timestamp before first pitch. Results are never deleted or retroactively modified. Live season results reported separately from any historical backtesting.</div>
    </div>
    <div class="evidence-claim">
      <div class="ec-stat amber">33</div>
      <div class="ec-label">Model adjustments per game</div>
      <div class="ec-desc">Dual-Poisson base with 33 log-odds adjustments: pitcher quality (xFIP), lineup confirmation, park factors, weather, umpire tendencies, bullpen quality, BvP matchups, arsenal fit, line movement, and more. Platt-calibrated monthly on 2026 live data.</div>
    </div>`;

  const calibEl = document.getElementById('calibration-block');
  if (calibEl) calibEl.innerHTML = buildCalibrationChart(hist && hist.rows ? hist.rows : null);
}

// ── Evening preview section ───────────────────────────────────────────────────
function togglePreview() {
  const el = document.getElementById('preview-section');
  if (el) el.classList.toggle('open');
}

function renderPreview(preview) {
  const container = document.getElementById('preview-container');
  if (!container) return;

  // Only show if preview.json is for tomorrow
  if (!preview || !preview.picks || preview.picks.length === 0) {
    container.innerHTML = '';
    return;
  }
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);
  if (preview.date !== tomorrowStr) {
    container.innerHTML = '';  // stale preview — hide it
    return;
  }

  const rows = preview.picks.map(p => {
    const oddsStr  = p.odds ? formatOdds(p.odds) : '—';
    const edgeStr  = p.edge ? `+${(p.edge * 100).toFixed(1)}%` : '';
    const pitchers = [p.pitcher, p.opp_pitcher].filter(Boolean).join(' vs. ');
    return `<div class="preview-row">
      <div>
        <span class="preview-pick-name">${p.pick || '—'}</span>
        <span class="preview-odds" style="margin-left:6px">${oddsStr}</span>
      </div>
      <div class="preview-meta" title="${p.game}">${p.game}${pitchers ? ' · ' + pitchers : ''}</div>
      ${edgeStr ? `<span class="preview-edge">${edgeStr}</span>` : ''}
    </div>`;
  }).join('');

  const count = preview.picks.length;
  const genAt = preview.generated_at || '';

  container.innerHTML = `
    <div class="section">
      <div class="preview-section" id="preview-section">
        <div class="preview-header" onclick="togglePreview()">
          <div class="preview-header-left">
            <span class="preview-title">${ibpIcon('search', 13)} Tomorrow's Preview · ${count} pick${count !== 1 ? 's' : ''}</span>
            <span class="preview-subtitle">Opening line · Projected lineup · Posted ${genAt}</span>
          </div>
          <span class="preview-chevron">▼</span>
        </div>
        <div class="preview-body">
          <div class="preview-disclaimer">
            ⚠️ Lineups not yet confirmed. Model uses projected rosters with lineup certainty shrinkage applied.
            Always verify starting pitchers and lineups before betting.
          </div>
          ${rows}
        </div>
      </div>
    </div>`;
}

// ── Week strip toggle ─────────────────────────────────────────────────────────
// ── Picks page P&L mode toggle (Flat ↔ Kelly) ────────────────────────────────
let _indexPnlMode = 'flat';  // 'flat' | 'kelly'
let _todayDataRef = null;    // saved so toggle can re-render without re-fetching
let _histDataRef  = null;

// Kelly stake for one pick/settled row, in UNITS — the single derivation shared by
// every Kelly-mode P&L computation on this page. kelly_units preferred: it's
// pre-calculated by calculate_stake_sizing() in model.py with all fractions
// applied — used directly, no multiplier. Legacy fallback: kelly_pct =
// final_kelly_pct (base × verdict_multiplier, display_fraction NOT yet applied)
// → × 0.5 × 100 converts to half-Kelly units. Returns null when neither exists —
// callers must surface "—" (or fall back EXPLICITLY), never treat missing sizing
// as 0u or 1u.
function kellyStakeUnits(r) {
  if (!r) return null;
  if (r.kelly_units != null) return r.kelly_units;
  if (r.kelly_pct   != null) return Math.round(r.kelly_pct * 0.5 * 100 * 1000) / 1000;
  return null;
}

// Kelly-sized P&L (units) across settled rows ({result, pnl_u, kelly_units…}).
// Pushes / zero-pnl rows contribute 0 without needing a stake; any W/L row with no
// derivable stake makes the whole aggregate null so callers show "—" instead of a
// silently-understated number (the "Kelly secretly flat" bug class).
function kellyPnlUnits(rows) {
  let u = 0;
  for (const r of rows || []) {
    const pnl = (typeof r.pnl_u === 'number') ? r.pnl_u : 0;
    if (!pnl) continue;
    const st = kellyStakeUnits(r);
    if (st == null) return null;
    u += pnl * st;
  }
  return u;
}

// Compute Kelly-sized season/last30/last7 stats from history.json rows.
// Uses all settled rows — same population as flat mode, just different sizing.
function _kellyStatsFromHist(histRows) {
  // history.json rows are sorted newest-first (descending by date).
  // Sort ascending before any slice() so "last N" means "most recent N".
  const settled = (histRows || [])
    .filter(r => r.result === 'W' || r.result === 'L')
    .sort((a, b) => a.date.localeCompare(b.date));   // oldest → newest
  const season  = settled.filter(r => r.date && r.date.startsWith('2026'));

  const getKu = kellyStakeUnits;   // shared derivation (see kellyStakeUnits above)

  function kellySum(rows) {
    return rows.reduce((s, r) => {
      const ku = getKu(r);
      return ku != null ? s + ku * (r.pnl_u || 0) : s;
    }, 0);
  }
  function staked(rows) {
    return rows.reduce((s, r) => {
      const ku = getKu(r);
      return ku != null ? s + ku : s;
    }, 0);
  }

  const sPnl    = kellySum(season);
  const sStaked = staked(season);
  const sRoi    = sStaked > 0 ? sPnl / sStaked : 0;
  const sW      = season.filter(r => r.result === 'W').length;
  const sL      = season.filter(r => r.result === 'L').length;

  // settled is now ascending — slice(-30) correctly gives the most recent 30
  const last30  = settled.slice(-30);
  const l30Pnl  = kellySum(last30);
  const l30W    = last30.filter(r => r.result === 'W').length;
  const l30L    = last30.filter(r => r.result === 'L').length;

  const sevenAgo = new Date(); sevenAgo.setDate(sevenAgo.getDate() - 7);
  const cutoff   = sevenAgo.toISOString().slice(0, 10);
  const last7    = season.filter(r => r.date >= cutoff);
  const l7Pnl    = kellySum(last7);
  const l7Staked = staked(last7);
  const l7Roi    = l7Staked > 0 ? l7Pnl / l7Staked : 0;
  const l7W      = last7.filter(r => r.result === 'W').length;
  const l7L      = last7.filter(r => r.result === 'L').length;

  // Build a date+pick lookup for week chip Kelly pnl
  const pickLookup = {};
  for (const r of last7) {
    const ku = getKu(r);
    if (ku != null) {
      const key = `${r.date}|${r.pick}|${r.game}`;
      pickLookup[key] = ku * (r.pnl_u || 0);
    }
  }

  return {
    season:     { wins: sW, losses: sL, units: sPnl, roi: sRoi, bets: season.length },
    last30:     { wins: l30W, losses: l30L, units: l30Pnl },
    last7:      { wins: l7W, losses: l7L, units: l7Pnl, roi: l7Roi, bets: l7W + l7L },
    pickLookup,
  };
}

// setPicksPnlMode: called by the header block toggle buttons.
// Re-render the picks list while preserving which drawers are open + keyboard
// focus. A bare render() rebuilds #picks-container, which otherwise collapses
// every expanded drawer mid-read and drops focus to <body> — bad for keyboard/SR
// users. Used by the Flat/Kelly toggle and the bucket-change countdown re-render.
function rerenderPicks() {
  if (!_todayDataRef) return;
  const openIds = Array.from(document.querySelectorAll('.pr-details'))
    .filter(d => !d.hasAttribute('hidden'))
    .map(d => d.dataset.cardId).filter(Boolean);
  let focusId = null;
  const a = document.activeElement;
  if (a && a.classList && a.classList.contains('pr-row') && a.parentElement) {
    const d = a.parentElement.querySelector('.pr-details');
    if (d) focusId = d.dataset.cardId;
  }
  render(_todayDataRef, _histRef, _scoresRef, _perfRef);
  openIds.forEach(id => {
    const det = document.querySelector('.pr-details[data-card-id="' + id + '"]');
    if (det && det.hasAttribute('hidden')) {
      const row = det.parentElement.querySelector('.pr-row');
      if (row) prToggle(row);
    }
  });
  if (focusId) {
    const det = document.querySelector('.pr-details[data-card-id="' + focusId + '"]');
    const row = det && det.parentElement.querySelector('.pr-row');
    if (row) row.focus();
  }
}

function setPicksPnlMode(mode) {
  _indexPnlMode = mode;
  // Re-render so per-pick stakes AND exposure recompute for the new mode
  // (Flat = $100/pick; Kelly = bankroll-sized), preserving open drawers + focus.
  // Falls back to a header-only refresh if data hasn't loaded yet.
  if (_todayDataRef) {
    rerenderPicks();
  } else {
    const flatBtn  = document.getElementById('phb-flat-btn');
    const kellyBtn = document.getElementById('phb-kelly-btn');
    if (flatBtn)  flatBtn.classList.toggle('active',  mode === 'flat');
    if (kellyBtn) kellyBtn.classList.toggle('active', mode === 'kelly');
    _updatePhbHelper();
  }
}

// Keep old name as alias so any stray references still work
function toggleIndexPnlMode() { setPicksPnlMode(_indexPnlMode === 'flat' ? 'kelly' : 'flat'); }

// ── Main data loader ──────────────────────────────────────────────────────────
async function loadPicks() {
  try {
    const v = Date.now();
    const [todayRes, histRes, perfRes, scores, previewRes] = await Promise.all([
      fetch('data/today.json?v='   + v),
      fetch('data/history.json?v=' + v),
      fetch('data/performance.json?v=' + v),
      fetchESPNScores(),
      fetch('data/preview.json?v=' + v).catch(() => null),
    ]);
    const data    = todayRes.ok    ? await todayRes.json()    : null;
    const hist    = histRes.ok     ? await histRes.json()     : null;
    const perf    = perfRes.ok     ? await perfRes.json()     : null;
    // Unified close-suppression flag for every close-derived path on this page.
    window._clvSuppressed = !!((data && window._clvSuppressed) ||
                               (perf && perf.clv_suppressed) ||
                               (hist && hist.clv_suppressed));
    const preview = (previewRes && previewRes.ok) ? await previewRes.json() : null;
    _histRef = hist;
    if (data) render(data, hist, scores, perf);
    else { renderEmptyState(null, hist); renderStatusStrip([], true, null); }
    // Tomorrow's preview now lives on its own page (preview.html) — kept off the
    // Today's Picks page so the actionable picks lead. renderPreview(preview);
  } catch (e) {
    console.error('[Independent Baseball Projections] loadPicks error:', e);
    document.getElementById('picks-container').innerHTML = `
      <div class="state-card error-state">
        <div class="state-icon">⚠️</div>
        <div class="state-title">Unable to load today's picks.</div>
        <div class="state-sub">Please refresh the page or check back later.</div>
      </div>`;
  }
}

// renderPerfCharts removed — monthly ROI chart and CLV trend removed from Today's Picks page

function renderEmptyState(data, hist, marginal = []) {
  const s = data && data.season ? data.season : null;

  const stripHTML = s ? `
    <div class="record-strip" style="margin-bottom:16px">
      <div class="stat-pill"><div class="stat-lbl">2026 Season</div><div class="stat-val white">${s.wins}W–${s.losses}L</div><div class="stat-sub">${s.units >= 0 ? '+' : ''}${(s.units||0).toFixed(1)}u</div></div>
    </div>` : '';

  // Near-miss panel: show signals that nearly cleared the 4% threshold
  let nearMissHTML = '';
  if (marginal.length > 0) {
    const rows = marginal.map(p => `
      <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-top:1px solid rgba(255,255,255,0.04);font-size:11px">
        <span style="font-family:var(--font-display);font-size:13px;font-weight:600;color:var(--text-2)">${p.pick}</span>
        <span style="color:var(--text-4)">${p.game}</span>
        <span style="margin-left:auto;font-family:var(--font-mono);color:var(--amber)">${formatOdds(p.odds)}</span>
        <span style="font-weight:600;color:var(--text-4)">+${(p.edge*100).toFixed(1)}pp edge</span>
      </div>`).join('');
    nearMissHTML = `
      <div style="margin-top:20px;padding:14px 16px;background:rgba(245,158,11,0.05);border:1px solid rgba(245,158,11,0.15);border-radius:10px">
        <div style="font-size:9px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:var(--amber);margin-bottom:8px">
          ⚠️ ${marginal.length} Signal${marginal.length > 1 ? 's' : ''} Below 4pp Threshold
        </div>
        ${rows}
        <div style="font-size:10px;color:var(--text-4);margin-top:8px">Model found signals — none cleared the 4pp minimum edge for a recommended bet.</div>
      </div>`;
  }

  // Determine if we're before 9 AM CT (picks not yet posted) or just no picks today
  const nowCT = new Date(new Date().toLocaleString('en-US', {timeZone: 'America/Chicago'}));
  const isPre9AM = nowCT.getHours() < 9;

  const onwardCTA = `<div style="display:flex;flex-wrap:wrap;gap:14px;justify-content:center;margin-top:16px;font-size:12px">
        <a href="performance.html" style="color:var(--indigo-lt);text-decoration:none;font-weight:600">${ibpIcon('trendup', 13)} See the track record →</a>
        <a href="#email-capture" onclick="event.preventDefault();document.getElementById('email-capture')?.scrollIntoView({behavior:'smooth'})" style="color:var(--indigo-lt);text-decoration:none;font-weight:600">${ibpIcon('mail', 13)} Email me when picks post →</a>
      </div>`;
  // ── Season-aware empty state ──────────────────────────────────────────────
  // No-games / off-season / stale-delay all outrank the pre-9AM and no-edge cards,
  // which are misleading when there's no baseball. Trigger on an EXPLICIT
  // games_today===0 on a fresh slate, OR a stale feed inside the off-season window
  // (covers a pipeline paused over winter). A calendar window decides only the
  // WORDING (off-season vs in-season off-day), never the trigger. Absent games_today
  // is treated as unknown (not zero) → falls through to the existing logic.
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const ctToday  = ymd(nowCT);
  const dataDate = (data && data.date) ? String(data.date) : null;
  const games    = (data && typeof data.games_today === 'number') ? data.games_today : null;
  const isStale  = !!(dataDate && dataDate < ctToday);
  const staleDays = isStale ? Math.round((new Date(ctToday) - new Date(dataDate)) / 86400000) : 0;
  const _m = nowCT.getMonth() + 1, _d = nowCT.getDate();
  const offseasonWindow = (_m === 12) || (_m === 1) || (_m === 2) || (_m === 11 && _d >= 10) || (_m === 3 && _d < 25);

  const noGamesFresh   = (games === 0 && (!dataDate || dataDate === ctToday));
  const offseasonStale = (isStale && offseasonWindow && staleDays >= 2);
  const staleDelayed   = (isStale && !offseasonStale);   // pipeline lag mid-season ≠ off-season

  const card = (icon, title, sub, extra = '') =>
    `<div class="state-card empty-state">
        <div class="state-icon">${icon}</div>
        <div class="state-title">${title}</div>
        <div class="state-sub">${sub}</div>
        ${extra}${onwardCTA}
      </div>`;
  const offseasonCard = card(ibpIcon('baseball', 34), 'MLB is between seasons.',
    'Daily value picks return for the 2027 season. The full 2026 track record stays public — and founding subscribers lock in early pricing before then.');
  const offDayCard = card(ibpIcon('baseball', 34), 'No MLB games scheduled today.',
    'The slate is empty today — value picks resume on the next game day.');
  const delayedCard = card(ibpIcon('clock', 34), "Today's slate is still updating.",
    'Fresh picks are taking a little longer than usual to post — check back shortly.');
  const pendingCard = `<div class="picks-pending-card">
        <div class="ppc-time">${ibpIcon('clock', 26)}</div>
        <div class="ppc-title">Today's Picks Post at 9:00 AM CT</div>
        <div class="ppc-sub">
          The model runs each morning after overnight data and opening lines are confirmed.<br>
          Picks are locked before first pitch and every result is graded publicly.
        </div>
        <a class="ppc-preview-link" href="preview.html">${ibpIcon('search', 13)} View tomorrow's opening line estimates →</a>
        ${onwardCTA}
      </div>`;
  const noEdgeCard = card(ibpIcon('chart', 34), 'No picks clear the edge threshold today.',
    'The model found no bets with sufficient edge vs. Pinnacle no-vig lines.');

  let emptyCard;
  if (noGamesFresh)        emptyCard = offseasonWindow ? offseasonCard : offDayCard;
  else if (offseasonStale) emptyCard = offseasonCard;
  else if (staleDelayed)   emptyCard = delayedCard;
  else if (isPre9AM)       emptyCard = pendingCard;
  else                     emptyCard = noEdgeCard;

  document.getElementById('picks-container').innerHTML = `
    ${emptyCard}
    ${nearMissHTML}
    ${stripHTML}`;
}

// formatOdds → ibp-utils.js

function formatGameTime(utcStr) {
  if (!utcStr) return null;
  try {
    const d = new Date(utcStr);
    if (isNaN(d)) return null;
    return d.toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'
    }) + ' ET';
  } catch(e) { return null; }
}

// Returns "3h 24m" style string when game is within 5h, null otherwise
function countdownText(gameTimeStr) {
  if (!gameTimeStr) return null;
  const start = new Date(gameTimeStr).getTime();
  if (isNaN(start)) return null;
  const diff = start - Date.now();
  if (diff <= 0 || diff > 5 * 3600000) return null;
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return 'soon';
}

// "Xh Ym before first pitch" — how far ahead the pick was posted
function getPostedBeforeGame(p) {
  if (!p.game_time || !p.posted_at) return null;
  const gameStart = new Date(p.game_time);
  if (isNaN(gameStart.getTime())) return null;
  const mo = p.posted_at.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!mo) return null;
  let h = parseInt(mo[1]);
  const min = parseInt(mo[2]);
  if (mo[3].toUpperCase() === 'PM' && h < 12) h += 12;
  if (mo[3].toUpperCase() === 'AM' && h === 12) h = 0;
  // CDT = UTC−5 (baseball season Apr–Oct)
  const postedMs = Date.UTC(
    gameStart.getUTCFullYear(), gameStart.getUTCMonth(), gameStart.getUTCDate(),
    h + 5, min, 0
  );
  const diffMs = gameStart.getTime() - postedMs;
  if (diffMs <= 0 || diffMs > 20 * 3600000) return null;
  const dh = Math.floor(diffMs / 3600000);
  const dm = Math.floor((diffMs % 3600000) / 60000);
  return dh > 0
    ? `${dh}h ${dm > 0 ? dm + 'm ' : ''}before first pitch`
    : `${dm}m before first pitch`;
}

function windCompass(degrees) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(degrees / 22.5) % 16];
}

function formatWeather(p) {
  if (p.is_domed) return { text: '🏟 Indoor (Dome) — weather neutral', highWind: false };
  if (p.temp_f == null && p.wind_speed_mph == null) return null;
  const parts = [];
  if (p.temp_f != null) parts.push(`${Math.round(p.temp_f)}°F`);
  if (p.wind_speed_mph != null) {
    const spd = Math.round(p.wind_speed_mph);
    const dir = p.wind_dir_degrees != null ? windCompass(p.wind_dir_degrees) : '';
    parts.push(spd > 0 ? `${spd}mph ${dir}` : 'Calm');
  }
  const highWind = (p.wind_speed_mph || 0) >= 15;
  if (highWind) parts.push('High wind');
  return { text: parts.join(' · '), highWind };
}

function tierLabel(edge, verdict) {
  // v2+: use the explicit verdict from today.json when available
  if (verdict) {
    if (verdict.includes('STRONG'))      return ['STRONG',        'strong'];
    if (verdict.includes('REDUCED'))     return ['REDUCED CONF.', 'reduced'];
    if (verdict.includes('FLAGGED'))     return ['FLAGGED',       'flagged'];
    if (verdict.includes('CONDITIONAL')) return ['CONDITIONAL',   'conditional'];
    if (verdict.includes('VALUE'))       return ['VALUE',         'value'];
    if (verdict.includes('MARGINAL'))    return ['MARGINAL',      'marginal'];
  }
  // Pre-v2 fallback: derive from edge (picks without verdict field)
  if (edge >= 0.08) return ['STRONG VALUE', 'strong'];
  if (edge >= 0.06) return ['VALUE',        'value'];
  if (edge >= 0.04) return ['CONDITIONAL',  'conditional'];
  return ['MARGINAL', 'marginal'];
}

// ── Parlay odds math ─────────────────────────────────────────────────────────
function mlToDecimal(ml) {
  return ml > 0 ? ml / 100 + 1 : 100 / Math.abs(ml) + 1;
}
function decimalToML(dec) {
  if (dec >= 2) return '+' + Math.round((dec - 1) * 100);
  return String(Math.round(-100 / (dec - 1)));
}

// ── Historical context lookup ─────────────────────────────────────────────────
// Returns a function: pick → HTML string (or null if not enough data)
function buildHistContextFn(histRows) {
  const settled = (histRows || []).filter(r => r.result === 'W' || r.result === 'L');
  if (settled.length < 10) return () => null;
  return function(pick) {
    const isDog  = (pick.odds || 0) > 0;
    const isHome = (pick.side || '').toUpperCase() === 'HOME';
    const matches = settled.filter(r => {
      if ((r.odds > 0) !== isDog) return false;
      if (r.side && pick.side && (r.side.toUpperCase() === 'HOME') !== isHome) return false;
      return Math.abs((r.odds || 0) - (pick.odds || 0)) <= 40;
    });
    if (matches.length < 5) return null;
    const w      = matches.filter(r => r.result === 'W').length;
    const l      = matches.length - w;
    const pnl    = matches.reduce((s, r) => s + (r.pnl_u || 0), 0);
    const winPct = (w / matches.length * 100).toFixed(0);
    const side   = isHome ? 'Home' : 'Road';
    const type   = isDog  ? 'dog'  : 'fav';
    function fmtO(o) {
      const r5 = Math.round(o / 5) * 5;
      return r5 >= 0 ? '+' + r5 : String(r5);
    }
    const lo = fmtO(pick.odds - 40);
    const hi = fmtO(pick.odds + 40);
    const pnlStr = (pnl >= 0 ? '+' : '') + pnl.toFixed(1) + 'u';
    const pnlCol = pnl >= 0 ? 'var(--green)' : 'var(--red)';
    return `<div class="hist-context">${ibpIcon('chart', 12)} <strong>${side} ${type} ${lo}–${hi}</strong> this season: ` +
      `<span style="color:var(--text-2);font-weight:600">${w}W–${l}L</span> ` +
      `<span style="color:var(--text-4)">(${winPct}%)</span> · ` +
      `<span style="color:${pnlCol};font-weight:600">${pnlStr}</span> ` +
      `<span style="color:var(--text-4);font-size:9px">n=${matches.length}</span></div>`;
  };
}

// ── Parse SP info from meta string ───────────────────────────────────────────
function parseSP(meta) {
  if (!meta) return null;
  // Handles formats like "SP: Nola vs. Fried · Break-even 52%" or "⚾ Nola vs. Fried"
  const m = meta.match(/SP[:\s]+([^·\n]+)/i) || meta.match(/⚾\s*([^·\n]+)/);
  if (m) return m[1].trim().replace(/\s*·.*$/, '');
  // Fallback: if meta mentions " vs." treat the whole thing before · as SP info
  if (meta.includes(' vs.')) return meta.split('·')[0].trim();
  return null;
}

// ── v8 details panel: build complete HTML ────────────────────────────────

// ── Details panel toggle — inline expansion below the pick card ──────────────

function closeExpandPanel() {
  if (_mdActiveId) {
    const panel = document.getElementById(_mdActiveId + '-det');
    if (panel) panel.classList.remove('open');
  }
  _mdActiveId = null;
  document.querySelectorAll('.details-toggle').forEach(b => {
    b.textContent = 'Full matchup breakdown ▾'; b.classList.remove('open');
  });
}

// Escape key closes any open inline panel
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && _mdActiveId) closeExpandPanel();
});

// ── Narrative preview: full text if short; 2 sentences if long ────────────────

// ── One-line driver for the collapsed card ────────────────────────────────────
// The model's primary reason, stated concisely WITHOUT repeating the bar's
// probability numbers (those already live in the edge bar above). Prefers the
// starter xFIP matchup; falls back to the top model factor; then a trimmed
// clause of the narrative. Full prose lives in the Details panel.
function oneLineDriverV8(p) {
  const rs = p.raw_stats || {};
  const pPit = p.pitcher, oPit = p.opp_pitcher;
  const pX = typeof rs.pick_xfip === 'number' ? rs.pick_xfip : null;
  const oX = typeof rs.opp_xfip  === 'number' ? rs.opp_xfip  : null;
  if (pPit && oPit && pX != null && oX != null) {
    return `<strong>SP</strong> ${pPit} ${pX.toFixed(2)} xFIP · ${oPit} ${oX.toFixed(2)} xFIP`;
  }
  const adjs = p.adj_breakdown && p.adj_breakdown.adjustments;
  if (adjs && adjs.length) {
    const a = adjs[0];
    const sign = (a.positive !== false && (a.pp || 0) >= 0) ? '+' : '';
    return `<strong>${a.label}</strong> ${sign}${(a.pp || 0).toFixed(1)}pp`;
  }
  if (p.narrative) {
    const clause = p.narrative.trim().replace(/<[^>]+>/g, '').split(/\s—\s|:\s|\.\s/)[0].trim();
    return clause.length > 4 ? clause : '';
  }
  return '';
}

// ── Expanded decision drawer (Phase 3) ────────────────────────────────────────
// Card-based decision view: Official play → Edge → Why it rates → Risk checks +
// Best price → short summary, with the FULL existing card tucked behind a
// "View full model rationale" toggle (preserves all its hooks: kelly-$, bet
// buttons, share/copy — refreshKellyUSD uses querySelectorAll).
// Lean "full model rationale" for the drawer — ONLY net-new content vs the
// drawer's own cards: full narrative prose, Matchup Quality (raw starter/defense
// metrics, distinct from the model adjustments in "Why it rates"), and line
// movement + CLV. Replaces embedding the entire legacy pickCardHTML (which
// re-rendered the edge/books/stake/factors a 2nd–3rd time in the old styling).
// Small inline line graph for price movement. Takes a generic array of points
// — [{ label, odds }] — so when the backend starts persisting intraday odds
// snapshots, the same renderer just receives more points (only the x-spacing /
// label density would change). Price is plotted on the "cents" scale. Colour is by
// VALUE TO THE BETTOR, not price direction: green when we're ahead (current/closing
// line is WORSE than the price we locked -> positive CLV), red when behind, neutral if flat.
function prLineGraph(points) {
  const pts = (points || []).filter(p => p.odds != null && !isNaN(p.odds));
  if (pts.length < 2) return '';
  const W = 900, H = 160, padX = 64, padTop = 44, padBot = 78;  // wide viewBox → fills the section; padBot leaves room for a
                                                                // two-line x-axis (label + clock time) at mobile font sizes (see style.css .dw-lg @media)
  const plotW = W - padX * 2, plotH = H - padTop - padBot;
  const cents = pts.map(p => _oddsToCents(p.odds));
  let lo = Math.min(...cents), hi = Math.max(...cents);
  if (hi === lo) { hi += 1; lo -= 1; }
  const padY = (hi - lo) * 0.18 || 1; lo -= padY; hi += padY;
  // x position — time-proportional when every point has a timestamp (so a move
  // shows *when* it happened); otherwise evenly spaced.
  const tms = pts.map(p => p.t ? Date.parse(p.t) : NaN);
  const useTime = tms.every(t => !isNaN(t)) && tms[tms.length - 1] > tms[0];
  const span = useTime ? (tms[tms.length - 1] - tms[0]) : 1;
  const xs = pts.map((p, i) => useTime ? padX + plotW * (tms[i] - tms[0]) / span : padX + plotW * i / (pts.length - 1));
  const y = c => padTop + plotH - ((c - lo) / (hi - lo)) * plotH;
  const baseIdx = pts.findIndex(p => /posted|open/i.test(p.label || ''));
  const baseC = cents[baseIdx >= 0 ? baseIdx : 0], lastC = cents[cents.length - 1];
  // "ahead" = current/closing number is WORSE than the line we locked (market moved our way -> CLV+)
  const dir = lastC < baseC - 0.5 ? 'ahead' : lastC > baseC + 0.5 ? 'behind' : 'flat';
  const col = dir === 'ahead' ? 'var(--green)' : dir === 'behind' ? 'var(--red)' : 'var(--text-4)';
  const poly = pts.map((p, i) => xs[i].toFixed(1) + ',' + y(cents[i]).toFixed(1)).join(' ');
  let svg = '<svg class="dw-lg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Line movement graph">';
  svg += '<polyline points="' + poly + '" fill="none" stroke="' + col + '" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>';
  pts.forEach((p, i) => {
    const px = xs[i].toFixed(1), py = y(cents[i]);
    const labeled = !!p.label;   // only key points get a dot label; the rest are plain vertices
    // C: native tooltip on every point (hover desktop / long-press) — "time · odds"
    const _od = (p.odds > 0 ? '+' + p.odds : '' + p.odds);
    const _tip = (p.clock ? p.clock + ' · ' : '') + _od;
    svg += '<circle cx="' + px + '" cy="' + py.toFixed(1) + '" r="' + (labeled ? '3.4' : '1.8') + '" fill="' + col + '"><title>' + _tip + '</title></circle>';
    if (labeled) {
      svg += '<text x="' + px + '" y="' + (py - 20).toFixed(1) + '" class="dw-lg-val" text-anchor="middle">' + _od + '</text>';
      svg += '<text x="' + px + '" y="' + (H - 36) + '" class="dw-lg-lbl" text-anchor="middle">' + p.label + '</text>';
      if (p.clock) svg += '<text x="' + px + '" y="' + (H - 12) + '" class="dw-lg-time" text-anchor="middle">' + p.clock + '</text>';  // A: clock time under the anchor
    }
  });
  // C: interactive hit targets, drawn last (on top) with a generous radius so each
  // point is tappable on mobile; the delegated handler shows a "time · odds" tooltip.
  pts.forEach((p, i) => {
    const _od = (p.odds > 0 ? '+' + p.odds : '' + p.odds);
    const _tip = (p.clock ? p.clock + ' · ' : '') + _od;
    svg += '<circle class="dw-lg-hit" cx="' + xs[i].toFixed(1) + '" cy="' + y(cents[i]).toFixed(1) + '" r="18" fill="transparent" data-tip="' + _tip + '"/>';
  });
  return svg + '</svg>';
}

// ── Line-movement point tooltip (tap on mobile / hover on desktop) ────────────
// One shared element + one delegated listener (cards are built lazily, so we can't
// bind per-graph). Each .dw-lg-hit circle carries data-tip = "time · odds".
function _lgTipEl() {
  let el = document.getElementById('lg-tip');
  if (!el) {
    el = document.createElement('div');
    el.id = 'lg-tip'; el.className = 'lg-tip'; el.hidden = true;
    document.body.appendChild(el);
  }
  return el;
}
function _showLgTip(hit) {
  const el = _lgTipEl();
  el.textContent = hit.getAttribute('data-tip') || '';
  el.hidden = false;
  const r = hit.getBoundingClientRect();
  el.style.left = (r.left + r.width / 2) + 'px';
  el.style.top  = (r.top - 8) + 'px';
  const t = el.getBoundingClientRect(), m = 6;          // clamp to viewport
  if (t.left < m) el.style.left = (parseFloat(el.style.left) + (m - t.left)) + 'px';
  else if (t.right > window.innerWidth - m) el.style.left = (parseFloat(el.style.left) - (t.right - (window.innerWidth - m))) + 'px';
}
function _hideLgTip() { const el = document.getElementById('lg-tip'); if (el) el.hidden = true; }
(function _initLgTips() {
  if (window._lgTipsInit) return; window._lgTipsInit = true;
  const hitOf = e => (e.target && e.target.closest) ? e.target.closest('.dw-lg-hit') : null;
  document.addEventListener('click', e => { const h = hitOf(e); if (h) _showLgTip(h); else _hideLgTip(); });
  document.addEventListener('mouseover', e => { const h = hitOf(e); if (h) _showLgTip(h); });
  document.addEventListener('mouseout',  e => { const h = hitOf(e); if (h && !('ontouchstart' in window)) _hideLgTip(); });
  window.addEventListener('scroll', _hideLgTip, true);
  window.addEventListener('resize', _hideLgTip);
})();

// odds_history timestamps are UTC (run_timestamp); format to a CT clock for labels.
function _clockFromT(t) {
  if (!t) return '';
  let s = String(t).trim();
  if (/T\d{2}:\d{2}$/.test(s)) s += ':00Z';
  else if (/T\d{2}:\d{2}:\d{2}$/.test(s)) s += 'Z';
  const d = new Date(s);
  if (isNaN(d)) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });
}

// "What changed since posting" — renders p.model_change (built server-side): the
// exact prob-level decomposition (model side vs market side) plus the biggest
// per-factor signal shifts. Returns '' when nothing material moved.
function prWhatChanged(p) {
  const mc = p.model_change;
  if (!mc) return '';
  const abbr = (p.pick || '').toUpperCase();
  const pp  = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + 'pp';
  const pct = v => v != null ? (v * 100).toFixed(1) + '%' : '—';
  const ppRaw = v => (v >= 0 ? '+' : '') + v.toFixed(1);

  const ed = mc.edge_delta, md = mc.model_delta, kd = mc.market_delta;
  // Market's contribution to EDGE = −Δ(market prob): a lower market prob on our side
  // is a better price, which helps the edge.
  const mktToEdge = kd != null ? -kd : null;

  const headline = 'Edge <b>' + pp(mc.posted.edge) + '</b> → <b>' + pp(mc.current.edge) + '</b>'
    + ' <span class="dwc-d ' + (ed < 0 ? 'bad' : 'good') + '">' + pp(ed) + '</span>';

  const modelLine = (md != null)
    ? '<div class="dwc-row"><span class="dwc-k">Model</span><span class="dwc-v">' + abbr + ' ' + pct(mc.posted.model_prob) + ' → ' + pct(mc.current.model_prob)
      + ' <b class="' + (md < 0 ? 'bad' : 'good') + '">' + pp(md) + '</b></span></div>' : '';
  const marketLine = (kd != null && mc.posted.market_prob != null)
    ? '<div class="dwc-row"><span class="dwc-k">Market</span><span class="dwc-v">' + abbr + ' ' + pct(mc.posted.market_prob) + ' → ' + pct(mc.current.market_prob)
      + ' <b class="' + (mktToEdge >= 0 ? 'good' : 'bad') + '">' + pp(mktToEdge) + ' to edge</b></span></div>' : '';
  const starterLine = mc.starter_changed
    ? '<div class="dwc-row"><span class="dwc-k">Starter</span><span class="dwc-v">' + mc.starter_changed.from + ' → ' + mc.starter_changed.to + '</span></div>' : '';

  const fd = mc.factor_deltas || [];
  const fdHTML = fd.length
    ? '<div class="dwc-fh">Biggest signal shifts</div>'
      + fd.map(f => '<div class="dwc-frow"><b class="' + (f.delta_pp < 0 ? 'bad' : 'good') + '">' + ppRaw(f.delta_pp) + '</b>'
          + '<span class="dwc-fl">' + f.label + '</span>'
          + '<span class="dwc-fdd">' + ppRaw(f.posted_pp) + ' → ' + ppRaw(f.current_pp) + '</span></div>').join('')
      + '<div class="dw-cap">Approximate — signal shifts don’t sum exactly to the model move.</div>'
    : '';

  return '<details class="dwc"><summary class="dwc-sum"><span class="dwc-t">What changed since posting</span>'
    + '<span class="dwc-hl">' + headline + '</span><span class="am-chevron">▾</span></summary>'
    + '<div class="dwc-body">' + modelLine + marketLine + starterLine + fdHTML
    + (mc.refreshed_at ? '<div class="dw-cap">Re-rated ' + mc.refreshed_at + '</div>' : '')
    + '</div></details>';
}

// Expanded pick drawer — decision-first, in order: should I bet it? · price &
// stake? · why does the model like it? · what data supports it? · did the line
// move favourably? Two-column body (sparse picks collapse to one). Two accent
// colours only: green = helps the pick, red = hurts it.
function prDrawerHTML(p, isBest, gameResult, forShare) {
  const cardId = prCardId(p);
  const rs = p.raw_stats || {};
  const parts = String(p.game || '').split('@').map(s => s.trim());
  const away = parts[0] || '', home = parts[1] || '';
  const pickAbbr = (p.pick || '').toUpperCase();
  const oppAbbr = (away.toUpperCase() === pickAbbr ? home : away).toUpperCase();
  const typeLabel = p.pick_type === 'MONEYLINE' ? 'ML' : p.pick_type === 'RUN_LINE' ? 'RL' : (p.pick_type || '').replace(/_/g, ' ');
  const fmtO = o => (o == null ? '—' : (o > 0 ? '+' + o : String(o)));
  const live = isLiveGame(p), over = isGameOver(p), postponed = isPostponed(p);
  const inactive = live || over || postponed;   // no actionable current price/play-to
  const scoreStr = gameResult && gameResult.score ? ' ' + gameResult.score : '';
  const sb = sanitizeBookOdds(p);

  // Lead the drawer with the CURRENT model read (re-rated every ~30 min); fall back
  // to posted before the first intraday refresh. Posted stays visible in the band/note.
  const _c = prCur(p);
  const mp = _c.mp, bp = _c.bp;
  const mpPct = mp != null ? (mp * 100).toFixed(1) + '%' : '—';
  const bpPct = bp != null ? (bp * 100).toFixed(1) + '%' : '—';
  const bpW = bp != null ? Math.max(2, Math.min(100, bp * 100)) : 0;
  const mpW = mp != null ? Math.max(2, Math.min(100, mp * 100)) : 0;
  const gapW = Math.max(0, mpW - bpW);
  const ev = _c.edge || 0;
  const edgeStr = (ev >= 0 ? '+' : '') + (ev * 100).toFixed(1) + 'pp';
  const _postedEv = _c.postedEdge;
  const ptStr = fmtO(_c.playTo);
  const _postedPtStr = fmtO(_c.postedPlayTo);

  // current best price + book
  let curStr, curBook = '', curGood = false;
  if (inactive) { curStr = '—'; }
  else if (sb.best) { curStr = fmtO(sb.best.odds); curBook = sb.best.book; const capImp = _impliedFromAmerican(p.odds); curGood = capImp != null && sb.best.implied < capImp - 0.005; }
  else { curStr = fmtO(p.best_odds != null ? p.best_odds : p.odds); curBook = p.best_book || ''; }

  const isKelly = _indexPnlMode === 'kelly';
  const _dwStakeU = kellyStakeUnits(p);   // shared derivation incl. kelly_pct fallback
  const stakeUnits = isKelly ? (_dwStakeU != null ? _dwStakeU.toFixed(1) + 'u' : '—') : '1.0u';
  const stakeSub = isKelly ? '<span class="kelly-usd" data-units="' + (_dwStakeU || 0) + '"></span>' : '$100';

  // ── verdict (cites the numbers) ────────────────────────────────────────
  const cushion = prCushion(p);
  let pill, pCls, detail;
  if (postponed) { pill = 'Postponed'; pCls = 'neu'; detail = 'game postponed — no action'; }
  else if (over) { const r = gameResult && gameResult.result; pill = 'Final'; pCls = r === 'W' ? 'good' : r === 'L' ? 'bad' : 'neu'; detail = (r === 'W' ? 'Won' : r === 'L' ? 'Lost' : 'Settled') + scoreStr; }
  else if (live) { pill = 'Live'; const _lead = gameResult && gameResult.lead; pCls = _lead === 'ahead' ? 'good' : _lead === 'behind' ? 'bad' : 'neu'; const inn = (gameResult && gameResult.detail) ? gameResult.detail : 'in-play'; detail = inn + scoreStr + ' — odds have moved off this pick'; }
  else if (p.current_recommendation === 'flipped') {
    pill = 'Model flipped'; pCls = 'bad';
    detail = 'model now favors ' + (p.current_flipped_team || 'the other side')
      + (p.current_flipped_edge != null ? ' (+' + (p.current_flipped_edge * 100).toFixed(1) + 'pp)' : '') + ' — pass';
  }
  else if (ev < 0.04) {
    // Edge below threshold. Distinguish a live re-rate (was a play, model dropped it)
    // from a pick that never cleared the bar — the price is NOT the reason here.
    if (_c.hasCur && _postedEv >= 0.04) {
      pill = 'No longer playable'; pCls = 'bad';
      detail = 'model re-rated this pick — current edge ' + (ev * 100).toFixed(1) + 'pp is below our 4pp cutoff (posted ' + (_postedEv >= 0 ? '+' : '') + (_postedEv * 100).toFixed(1) + 'pp)';
    } else {
      pill = 'Below threshold'; pCls = 'neu';
      detail = 'model edge is under our 4pp cutoff — not a recommended bet';
    }
  }
  else if (cushion != null && cushion <= 0) { pill = 'No longer playable'; pCls = 'bad'; detail = 'current ' + curStr + ' is past Play to ' + ptStr; }
  else if (p.current_lineup_confirmed === false) { pill = 'Playable'; pCls = 'neu'; detail = 'lineup not yet confirmed — re-check before betting'; }
  else { pill = 'Still playable'; pCls = 'good'; detail = 'current ' + curStr + ' beats Play to ' + ptStr; }

  const headHTML = '<div class="dw-head"><span class="dw-head-name">' + pickAbbr + ' ' + typeLabel + '</span>'
    + '<span class="dw-pill ' + pCls + '">' + pill + '</span>'
    + '<span class="dw-head-detail">— ' + detail + '</span></div>';

  // ── TL;DR — the one-sentence answer a bettor came for, before any analysis ──
  const _tldrOK = !inactive && (pill === 'Still playable' || pill === 'Playable');
  const tldrHTML = _tldrOK
    ? '<div class="dw-tldr">Bet <b>' + pickAbbr + '</b> at <b>' + ptStr + '</b> or better · <b>'
      + (isKelly ? stakeUnits : '$100') + '</b> · model <b>' + mpPct + '</b> vs market <b>' + bpPct + '</b>'
      + (pill === 'Playable' ? ' — confirm the lineup first' : '') + '.</div>'
    : '';

  // ── Risk flags — the feed's downgrade_reasons were mapped (FLAG_COPY) but
  //    never rendered; a trimmed stake deserves a stated reason.
  const _flags = String(p.downgrade_reasons || '').split(/[,;|]+/)
    .map(s => s.trim()).filter(Boolean)
    .map(c => FLAG_COPY[c] || _escHTML(c.replace(/_/g, ' ')));
  const flagsHTML = _flags.length
    ? '<div class="dw-flags">⚠ Heads-up: ' + _flags.join(' · ') + '</div>'
    : '';

  // ── decision band: current · posted · play-to · stake ──────────────────
  const bandHTML = '<div class="dw-band">'
    + '<div class="dw-bi"><span class="dw-bi-k">Current odds</span><span class="dw-bi-v' + (curGood ? ' good' : '') + '">' + (inactive ? '—' : curStr) + '</span>' + ((!inactive && curBook) ? '<span class="dw-bi-s">' + curBook + '</span>' : '') + '</div>'
    + '<div class="dw-bi"><span class="dw-bi-k">Posted line</span><span class="dw-bi-v">' + fmtO(p.odds) + '</span>' + (p.posted_at ? '<span class="dw-bi-s">at ' + p.posted_at + '</span>' : '') + '</div>'
    + '<div class="dw-bi"><span class="dw-bi-k">Play to</span><span class="dw-bi-v">' + (inactive ? '—' : ptStr) + '</span>' + ((!inactive && _c.moved && _postedPtStr !== ptStr) ? '<span class="dw-bi-s">posted ' + _postedPtStr + '</span>' : '') + '</div>'
    + '<div class="dw-bi"><span class="dw-bi-k">Stake</span><span class="dw-bi-v">' + stakeUnits + '</span><span class="dw-bi-s">' + stakeSub + '</span></div>'
    + '</div>';

  // ── Why the model likes it (left) ──────────────────────────────────────
  // Freshness + posted→now note: when the live edge has moved off posted, say so
  // explicitly (with the time of the last refresh); otherwise just stamp the refresh.
  const _updNote = _c.moved
    ? '<div class="dw-cap dw-upd">Re-rated ' + (p.current_refresh_time || 'intraday')
        + ' · posted ' + (_postedEv >= 0 ? '+' : '') + (_postedEv * 100).toFixed(1) + 'pp → now ' + edgeStr + '</div>'
    : (p.current_refresh_time ? '<div class="dw-cap">Model updated ' + p.current_refresh_time + '</div>' : '');
  const meterHTML = (mp != null && bp != null)
    ? '<div class="dw-meter-cap"><span>Market <b>' + bpPct + '</b></span><span class="dw-arr">→</span><span>Model <b>' + mpPct + '</b></span><span class="g">Edge ' + edgeStr + '</span></div>'
      + '<div class="dw-meter"><i class="m-mkt" style="width:' + bpW.toFixed(1) + '%"></i><i class="m-gap" style="left:' + bpW.toFixed(1) + '%;width:' + gapW.toFixed(1) + '%"></i><i class="m-tick" style="left:calc(' + mpW.toFixed(1) + '% - 1px)"></i></div>'
      + '<div class="dw-cap">Bar shows implied win probability.</div>' + _updNote
    : '';
  const adjs = (p.adj_breakdown && p.adj_breakdown.adjustments) || [];
  const pos = adjs.filter(a => a.positive).sort((a, b) => Math.abs(b.pp) - Math.abs(a.pp)).slice(0, 5);
  const neg = adjs.filter(a => !a.positive).sort((a, b) => Math.abs(b.pp) - Math.abs(a.pp)).slice(0, 5);
  const frow = a => '<div class="dw-frow"><b class="' + (a.positive ? 'good' : 'bad') + '">' + (a.pp >= 0 ? '+' : '') + a.pp.toFixed(1) + '</b><span>' + a.label + '</span></div>';
  const driversCol = pos.length ? '<div class="dw-fcol"><div class="dw-fh good">Key Drivers</div>' + pos.map(frow).join('') + '</div>' : '';
  const offsetsCol = neg.length ? '<div class="dw-fcol"><div class="dw-fh bad">Offsets</div>' + neg.map(frow).join('') + '</div>' : '';
  // The reconciling caveat ships in the feed (explanation.attribution_note) and was
  // never rendered — without it, drivers that sum negative under a positive edge
  // read as the model contradicting itself.
  const _attrNote = _escHTML((p.explanation && p.explanation.attribution_note)
    || 'Driver impacts are approximate probability-point contributions and do not sum to the edge.');
  const factorsHTML = (driversCol || offsetsCol)
    ? '<div class="dw-factors">' + driversCol + offsetsCol + '</div><div class="dw-cap">' + _attrNote + '</div>'
    : '';
  const listJoin = arr => arr.length <= 1 ? (arr[0] || '') : arr.slice(0, -1).join(', ') + ' and ' + arr[arr.length - 1];
  const tp = pos.slice(0, 2).map(a => a.label.toLowerCase()), tn = neg.slice(0, 2).map(a => a.label.toLowerCase());
  let readTxt = '';
  if (tp.length) { readTxt = pickAbbr + ' is undervalued mainly on ' + listJoin(tp) + (tn.length ? ', partly offset by ' + listJoin(tn) : '') + '.'; }
  const readHTML = readTxt ? '<div class="dw-h3">Model Read</div><div class="dw-read">' + readTxt + '</div>' : '';
  // Engine prose (already in the feed) — the most newcomer-friendly content. Strip any
  // tags. The live drawer shows the full prose: the explanation engine caps itself at
  // 6 sentences (~700 chars today), so the 1200-char guard only trips on a runaway feed
  // value. The share card keeps the short ~2-sentence lead so the exported PNG stays
  // compact (matches forShare stripping actions + "What changed").
  let _narr = String(p.narrative || '').trim().replace(/<[^>]+>/g, '');
  const _narrCap = forShare ? [300, 2] : [1200, 6];
  if (_narr.length > _narrCap[0]) {
    _narr = _narr.split('. ').slice(0, _narrCap[1]).join('. ');
    if (!/[.!?]$/.test(_narr)) _narr += '.';
  }
  const narrativeHTML = _narr ? '<div class="dw-narrative">' + _narr + '</div>' : '';
  const whyInner = '<div class="dw-h2">Why The Model Likes It</div>' + narrativeHTML + meterHTML + factorsHTML + readHTML;

  // ── Matchup data + status (right) ──────────────────────────────────────
  const mqRows = [];
  function mqAdd(label, dir, pv, ov, betterHigh, fmt) {
    if (pv == null || ov == null || isNaN(pv) || isNaN(ov)) return;
    const pBetter = betterHigh ? pv > ov : pv < ov;
    mqRows.push('<tr><td class="dw-mt-metric">' + label + ' <span class="dw-dir">' + dir + '</span></td>'
      + '<td>' + fmt(pv) + '</td><td>' + fmt(ov) + '</td>'
      + '<td class="' + (pBetter ? 'good' : 'bad') + '">' + (pBetter ? pickAbbr : oppAbbr) + '</td></tr>');
  }
  mqAdd('Starter xFIP', 'lower better', rs.pick_xfip, rs.opp_xfip, false, x => x.toFixed(2));
  mqAdd('K-BB%', 'higher better', rs.pick_kbb_pct != null ? rs.pick_kbb_pct * 100 : null, rs.opp_kbb_pct != null ? rs.opp_kbb_pct * 100 : null, true, x => x.toFixed(1) + '%');
  mqAdd('Defense (OAA)', 'higher better', rs.pick_oaa, rs.opp_oaa, true, x => (x > 0 ? '+' : '') + x);
  mqAdd('Arsenal fit', 'higher better', rs.pick_arsenal_fit, rs.opp_arsenal_fit, true, x => (x > 0 ? '+' : '') + x.toFixed(2));
  mqAdd('Proj. IP', 'higher better', rs.pick_proj_ip, rs.opp_proj_ip, true, x => x.toFixed(1));
  const pickPit = p.pitcher ? '<span>' + p.pitcher + '</span>' : '';
  const oppPit = p.opp_pitcher ? '<span>' + p.opp_pitcher + '</span>' : '';
  const tableHTML = mqRows.length
    ? '<table class="dw-mtable"><thead><tr><th>Metric</th><th>' + pickAbbr + pickPit + '</th><th>' + oppAbbr + oppPit + '</th><th>Adv.</th></tr></thead><tbody>' + mqRows.join('') + '</tbody></table>'
    : '<div class="dw-cap">No paired matchup metrics for this game.</div>';

  const lc = p.current_lineup_confirmed != null ? p.current_lineup_confirmed : rs.pick_lineup_confirmed;
  let weatherTxt;
  if (p.is_domed) weatherTxt = 'Roof closed';
  else {
    const t = p.temp_f != null ? Math.round(p.temp_f) + '°F' : '';
    const w = p.wind_speed_mph != null ? ', wind ' + Math.round(p.wind_speed_mph) + ' mph' : '';
    const d = p.wind_dir_degrees != null ? ' ' + windCompass(p.wind_dir_degrees) : '';
    weatherTxt = (t + w + d).trim() || '—';
  }
  const runEnv = [];
  if (rs.park_factor != null) runEnv.push('Park ' + rs.park_factor.toFixed(2));
  if (rs.ump_name) runEnv.push('HP ump ' + rs.ump_name);
  // The pick's starter is already named in the table header — only repeat it here
  // on sparse picks where the table isn't shown.
  const starterRow = mqRows.length ? '' : '<div class="dw-rc"><span class="dw-rk">Starter</span><span class="dw-rv">' + (p.pitcher || '—') + '</span></div>';
  const projStarterRow = p.projected_starter
    ? '<div class="dw-rc"><span class="dw-rk">Starter</span><span class="dw-rv" style="color:#fbbf24" title="A starting pitcher here was filled from a consensus of ESPN + multiple sportsbooks because MLB has not posted the official probable yet. Re-confirm before betting.">Projected (consensus)</span></div>'
    : '';
  const statusHTML = '<div class="dw-h3">Status &amp; Context</div><div class="dw-rows">'
    + '<div class="dw-rc"><span class="dw-rk">Lineup</span><span class="dw-rv ' + (lc === true ? 'good' : '') + '">' + (lc === true ? 'Confirmed' : 'Projected') + '</span></div>'
    + projStarterRow
    + starterRow
    + '<div class="dw-rc"><span class="dw-rk">Weather</span><span class="dw-rv">' + weatherTxt + '</span></div>'
    + (runEnv.length ? '<div class="dw-rc"><span class="dw-rk">Run env.</span><span class="dw-rv">' + runEnv.join(' · ') + '</span></div>' : '')
    + '</div>';
  const dataInner = '<div class="dw-h2">Matchup Data</div>' + tableHTML + statusHTML;

  // Share cards keep the classic two-column layout (html2canvas can't lay out
  // <details>); the live drawer instead shows the "why" and collapses the deep
  // matchup/line-movement analysis — decision first, evidence on demand.
  const twoCol = mqRows.length > 0;
  const bodyHTML = twoCol
    ? '<div class="dw-cols"><div class="dw-col">' + whyInner + '</div><div class="dw-col">' + dataInner + '</div></div>'
    : '<div class="dw-sec">' + whyInner + '</div><div class="dw-sec">' + dataInner + '</div>';

  // ── Line movement — real intraday curve from odds_history; fall back to the
  //    Opened → Posted → Current/Closed 3-point graph when the series is absent.
  let lgPts;
  const _hist = Array.isArray(p.odds_history) ? p.odds_history.filter(h => h && h.odds != null) : [];
  const _endLabel = (live || over) ? 'Close' : 'Now';
  if (_hist.length >= 2) {
    // Anchor "Posted" at the snapshot when we locked the line (match posted_at's CT
    // clock); fall back to the start of the tracked curve. Last point = Now/Close.
    // Every point carries its CT clock for the axis time + per-point tooltip.
    const _postClock = String(p.posted_at || '').replace(/\s*CT$/i, '').trim();
    let _postedIdx = _postClock ? _hist.findIndex(h => _clockFromT(h.t) === _postClock) : -1;
    if (_postedIdx < 0) _postedIdx = 0;
    lgPts = _hist.map((h, i) => ({
      odds: h.odds, t: h.t, clock: _clockFromT(h.t),
      label: i === _hist.length - 1 ? _endLabel : (i === _postedIdx ? 'Posted' : '')
    }));
  } else {
    // Fallback (no real series): Posted → Now/Close only — no "Open"/Pinnacle point.
    const _nowClock = String(p.current_refresh_time || '').replace(/\s*CT$/i, '').trim();
    lgPts = [{ label: 'Posted', odds: p.odds, clock: String(p.posted_at || '').replace(/\s*CT$/i, '').trim() }];
    if (!inactive && sb.best) lgPts.push({ label: _endLabel, odds: sb.best.odds, clock: _nowClock });
    else if (!window._clvSuppressed && (live || over) && p.closing_prob != null) lgPts.push({ label: _endLabel, odds: _americanFromImplied(p.closing_prob), clock: _nowClock });
  }
  const graphHTML = prLineGraph(lgPts) || '<div class="dw-cap">Not enough line data to chart.</div>';
  let lgCap = '';
  if (_hist.length >= 2) {
    lgCap = '<div class="dw-lg-cap">Tracked ' + _clockFromT(_hist[0].t) + ' \u2192 ' + _clockFromT(_hist[_hist.length - 1].t)
          + ' CT \u00b7 ' + _hist.length + ' snapshots \u00b7 <span style="color:var(--green)">green</span> = current line is worse than what we locked (you\'re ahead)</div>';
  }
  let clvHTML = '';
  if (!window._clvSuppressed && p.clv != null && (live || over)) {   // close-based drawer line — unified suppression gate
    const clvpp = p.clv * 100;
    const cls = clvpp >= 0.5 ? 'g' : clvpp <= -0.5 ? 'r' : '';
    const note = clvpp >= 0.5 ? 'beat the close' : clvpp <= -0.5 ? 'closed past us' : 'matched close';
    clvHTML = '<div class="dw-clv"><span class="dw-clv-k">CLV</span><b class="' + cls + '">' + (clvpp >= 0 ? '+' : '') + clvpp.toFixed(1) + 'pp</b><span class="dw-clv-s">' + note + '</span></div>';
  }
  const moveHTML = '<div class="dw-sec"><div class="dw-move-head"><div class="dw-h2">Line Movement</div>' + clvHTML + '</div>'
    + '<div class="dw-lgwrap">' + graphHTML + lgCap + '</div></div>';

  // Hide Share for a PREGAME pick re-rated below the 4% threshold (or whose price
  // moved past the floor) — promoting a downgraded pick is odd. Live/final/postponed
  // keep Share (those are legitimate result cards).
  const _notShareable = !inactive && !prActionable(p);
  const actionsHTML = (forShare || _notShareable) ? '' : ('<div class="dw-actions">'
    + '<button type="button" class="dw-act" onclick="sharePickCard(\'' + cardId + '\', ' + (isBest ? 1 : 0) + ')">Share</button>'
    + '</div>');

  // Omit from share cards: the "What changed" block is a collapsed <details>, which
  // html2canvas lays out incorrectly (its body overlaps the sections below), and the
  // intraday re-rate detail isn't share-card material anyway.
  const changedHTML = forShare ? '' : prWhatChanged(p);
  if (forShare) {
    return '<div class="dw">' + headHTML + bandHTML + bodyHTML + moveHTML + actionsHTML + '</div>';
  }
  // Per-book price comparison — the feed ships up to 12 books and the site showed
  // only one; "shop the best price" needs the shelf, and the best price is often
  // an exchange the visitor can't use.
  const bookRowHTML = (!inactive && sb.entries.length >= 2)
    ? '<div class="dw-books"><span class="dw-books-k">Prices</span>'
      + sb.entries.slice(0, 6).map((e, i) =>
          '<span class="dw-book' + (i === 0 ? ' best' : '') + '">' + _escHTML(e.book) + ' <b>' + fmtO(e.odds) + '</b></span>').join('')
      + (sb.entries.length > 6 ? '<span class="dw-books-more">+' + (sb.entries.length - 6) + ' more</span>' : '')
      + '</div>'
    : '';
  const fullAnalysisHTML = '<details class="dw-full"><summary>Full analysis — matchup data &amp; line movement <span class="am-chevron">▾</span></summary>'
    + '<div class="dw-sec">' + dataInner + '</div>' + moveHTML + '</details>';
  return '<div class="dw">' + headHTML + tldrHTML + flagsHTML + bandHTML + bookRowHTML + changedHTML
    + '<div class="dw-sec">' + whyInner + '</div>' + fullAnalysisHTML + actionsHTML + '</div>';
}

// ── Pick card HTML ────────────────────────────────────────────────────────────

// Map raw model downgrade codes → reader-friendly phrases for the UI.
const FLAG_COPY = {
  short_rest_sp:     'starter pitching on short rest',
  away_worse_sp_fip: 'road pick — opposing starter has the projected xFIP edge',
};

// ── Main render ───────────────────────────────────────────────────────────────
// ── Status strip ──────────────────────────────────────────────────────────────
function renderStatusStrip(picks, noPicksYet, generatedAt, gamesToday) {
  const strip = document.getElementById('status-strip');
  if (!strip) return;
  strip.style.display = 'flex';

  if (noPicksYet || !picks || picks.length === 0) {
    const nowCT  = new Date(new Date().toLocaleString('en-US',{timeZone:'America/Chicago'}));
    const pre9   = nowCT.getHours() < 9;
    strip.className = 'status-strip ss-pending';
    strip.innerHTML = `
      <span class="ss-badge ss-badge-pending">${pre9 ? ibpIcon('clock', 11) + ' PENDING' : ibpIcon('chart', 11) + ' NO PICKS'}</span>
      <span class="ss-text">${pre9 ? 'Picks post at 9:00 AM CT after lineup confirmation' : 'No picks clear the 4pp edge threshold today'}</span>
      <a class="ss-link" href="preview.html">Tomorrow's opening lines →</a>`;
    return;
  }

  // Match the recap's allDone basis: posted picks (≥4pp), counting POSTPONED as
  // graded so a PPD pick doesn't suppress the FINAL strip.
  const posted      = (picks || []).filter(p => (p.edge || 0) >= 0.04);
  const gradedCount = posted.filter(p => isGameOver(p) || isPostponed(p)).length;
  const ppdCount    = posted.filter(p => isPostponed(p)).length;

  // Active days (locked / live / partial) are now covered by the consolidated
  // summary line under the picks heading — only surface the strip for the
  // all-graded recap (pending / no-picks are handled above). With the card
  // graded, route forward to tomorrow (mirrors the no-picks branch).
  if (!posted.length || gradedCount !== posted.length) { strip.style.display = 'none'; return; }

  const _txt = ppdCount > 0
    ? 'All posted picks graded'
    : `All ${posted.length} game${posted.length !== 1 ? 's' : ''} complete`;
  strip.className = 'status-strip ss-done';
  strip.innerHTML = `
    <span class="ss-badge ss-badge-done">✓ FINAL</span>
    <span class="ss-text">${_txt}</span>
    <a class="ss-link" href="preview.html">Tomorrow's opening lines →</a>`;
}

// ════════════════════════════════════════════════════════════════════════════
//  Pick ROWS (dense, sortable analytics table). FRONT-END ONLY — reuse the SAME
//  pick fields. No model / data / filtering / classification change.
//    · prSetSort / prSortPicks / prActionable → sort + actionable-first ordering
//    · prRowCollapsed       → one collapsed analytics row
//    · prRowHTML            → row wrapper = collapsed row + lazy-built drawer slot
//    · prRows / prTableHead → rows + sortable column header
//    · prToggle / prKey     → expand-collapse a row (builds prDrawerHTML on demand)
//    · prDrawerHTML        → the expanded decision-first drawer
// ════════════════════════════════════════════════════════════════════════════


// CT clock for the matchup subline (matches the card's game-time format).
function prGameTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('en-US',
      { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' }) + ' CT';
  } catch (e) { return ''; }
}

// Value pill — DISPLAY ONLY; mirrors the existing edge tiers (does not change
// classification). A flagged pick or unconfirmed pick-side lineup → "Conditional".

// ── Pick-table sort + status helpers ──────────────────────────────────────────
// One flat, sortable table. Rows are grouped by an action-status rank (PLAY first,
// then WAIT, PASS, LIVE, FINAL, WATCH) and sorted within each band by the active
// key (default edge desc; Matchup sorts by time, Mkt→Model by model %).
let _picksSort = { key: 'edge', dir: -1 };   // dir: -1 desc, +1 asc
function prSetSort(key) {
  if (_picksSort.key === key) _picksSort.dir = -_picksSort.dir;
  else _picksSort = { key, dir: key === 'time' ? 1 : -1 };  // time ascends, values descend
  rerenderPicks();
}
function prHeadKey(e, key) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); prSetSort(key); } }
// Current-vs-posted display set. The model re-rates picks every ~30 min; the row
// and drawer LEAD with the current read so "which picks to take" reflects now.
// The posted edge/line/timestamp are never altered (picks_log + CLV untouched) and
// stay visible in the drawer. Falls back to posted before the first intraday refresh.
// `bp` (current no-vig market prob) = model − edge, since edge is defined vs the
// no-vig benchmark.
function prCur(p) {
  const hasCur = p.current_edge != null && p.current_model_prob != null;
  const edge   = hasCur ? p.current_edge : (p.edge || 0);
  const mp     = hasCur ? p.current_model_prob : p.model_prob;
  const bp     = hasCur ? (p.current_model_prob - p.current_edge) : p.market_prob;
  const playTo = (hasCur && p.current_playable_to != null) ? p.current_playable_to : p.playable_to;
  const postedEdge = p.edge || 0;
  const moved  = hasCur && p.edge != null && Math.abs(edge - postedEdge) >= 0.01;   // ≥1pp move
  return { hasCur, edge, mp, bp, playTo, postedEdge, postedPlayTo: p.playable_to,
           moved, dir: moved ? Math.sign(edge - postedEdge) : 0 };
}
function _curEdge(p) { return (p.current_edge != null ? p.current_edge : p.edge) || 0; }

function prSortVal(p, key) {
  if (key === 'model') return (p.current_model_prob != null ? p.current_model_prob : p.model_prob) || 0;
  if (key === 'time')  return p.game_time ? (Date.parse(p.game_time) || 0) : Number.POSITIVE_INFINITY;
  return _curEdge(p);
}
function prSortPicks(arr) {
  const { key, dir } = _picksSort;
  return arr.slice().sort((a, b) => {
    const aa = prActionable(a) ? 0 : 1, bb = prActionable(b) ? 0 : 1;
    if (aa !== bb) return aa - bb;                  // actionable plays lead
    const d = (prSortVal(a, key) - prSortVal(b, key)) * dir;
    return d || (_curEdge(b) - _curEdge(a));        // then active key (default current edge desc)
  });
}

// _oddsToCents moved VERBATIM to ibp-utils.js (shared with bets.js).

// Implied win probability → American odds (used for the closing-line point on the
// movement graph). Inverse of _impliedFromAmerican.
function _americanFromImplied(prob) {
  if (prob == null || prob <= 0 || prob >= 1) return null;
  return prob >= 0.5 ? -Math.round(prob / (1 - prob) * 100) : Math.round((1 - prob) / prob * 100);
}

// Cents of room between the current best price and the playable floor. Negative
// means the price has already moved past the floor — the edge is gone. Returns
// null when either input is missing.
function prCushion(p) {
  const sb = sanitizeBookOdds(p);
  const cur = sb.best ? sb.best.odds : (p.best_odds != null ? p.best_odds : p.odds);
  // Floor is the CURRENT model's playable price when available — a re-rated model
  // tightens (or loosens) the floor, so a stale posted floor would mis-judge cushion.
  const floor = p.current_playable_to != null ? p.current_playable_to : p.playable_to;
  const cc = _oddsToCents(cur), ptc = _oddsToCents(floor);
  return (cc != null && ptc != null) ? Math.round(cc - ptc) : null;
}

// A pick is actionable when it's pregame, still clears the 4% edge threshold, and
// its current price hasn't moved past the playable floor. Live, final, edge-gone,
// and near-miss picks are informational — faded and sorted below the live plays.
function prActionable(p) {
  if (isLiveGame(p) || isGameOver(p) || isPostponed(p)) return false;
  if ((p.edge || 0) < 0.04) return false;                                  // near-miss
  if (p.current_edge != null && p.current_edge < 0.04) return false;       // edge moved off
  const c = prCushion(p);
  if (c != null && c <= 0) return false;                                   // price past the floor
  return true;
}

function prSortArrow(key) {
  if (_picksSort.key !== key) return `<span class="pr-sortarr inactive">↕</span>`;  // persistent "sortable" cue
  return `<span class="pr-sortarr">${_picksSort.dir < 0 ? '▾' : '▴'}</span>`;
}
function _prHsort(key, label, cls, title) {
  const active = _picksSort.key === key ? ' active' : '';
  const sort = active ? (_picksSort.dir < 0 ? 'descending' : 'ascending') : 'none';
  return `<span class="pr-h ${cls} sortable${active}" role="button" tabindex="0" aria-sort="${sort}" `
    + (title ? `title="${title}" ` : '')
    + `onclick="prSetSort('${key}')" onkeydown="prHeadKey(event,'${key}')">${label}${prSortArrow(key)}</span>`;
}
function _prH(label, cls, title) {
  return `<span class="pr-h ${cls}"${title ? ` title="${title}"` : ''}>${label}</span>`;
}
function prTableHead() {
  return `<div class="pr-cols pr-head">`
    + _prHsort('time', 'Matchup', 'h-mu')
    + _prH('Pick', 'h-pick')
    + _prHsort('model', 'Mkt → Model', 'h-mm', "The market's implied win probability vs our model's. We bet when our number is higher.")
    + _prHsort('edge', 'Edge', 'h-edge', 'How much higher our win probability is than the price implies — our expected advantage, in percentage points.')
    + _prH('Current odds', 'h-odds', 'Best moneyline price we currently see across books, and where.')
    + _prH('Play to', 'h-play', "The worst price still worth betting — below this the edge is gone. Don't chase past it.")
    + _prH('Stake', 'h-stake', 'Suggested bet size — flat 1 unit, or Kelly-scaled when the Kelly toggle is on. A unit is whatever you choose it to be.')
    + `<span class="pr-h h-chev"></span>`
    + `</div>`;
}

// ── Live/final state for the collapsed row ────────────────────────────────────
// Once a game starts we surface a pick-oriented score chip in the empty space at
// the right of the matchup column (the odds column keeps showing odds). The score
// is already pick-first (getPickResult), so prefixing the pick's abbr → "LAA 1–0"
// reads unambiguously: the number next to LAA is always LAA's, colour shows whether
// the pick is ahead. The inning / Final label lives in the matchup subline.
//   gr = getPickResult(p, scores) — may be null when ESPN has no match for the game.
function prStateCellText(p, gr) {
  if (!gr) return '';
  const pickAbbr = (p.pick || '').toUpperCase();
  const sc = gr.score ? pickAbbr + ' ' + gr.score : pickAbbr;
  if (gr.status === 'live')      return sc;
  if (gr.status === 'final')     return (gr.result === 'W' ? '✓ ' : gr.result === 'L' ? '✗ ' : '') + sc;
  if (gr.status === 'postponed') return 'PPD';
  return '';
}
function prStateMod(gr) {
  if (!gr) return '';
  if (gr.status === 'live')       return gr.lead === 'ahead' ? 'sc-ahead' : gr.lead === 'behind' ? 'sc-behind' : 'sc-tied';
  if (gr.status === 'final')      return gr.result === 'W' ? 'sc-win' : gr.result === 'L' ? 'sc-loss' : 'sc-tied';
  if (gr.status === 'postponed')  return 'sc-ppd';
  return '';
}
// The live/final score chip, placed at the right edge of the matchup column.
function prStateChipHTML(p, gr) {
  if (!gr || (gr.status !== 'live' && gr.status !== 'final')) return '';
  const _sa = prStateCellAria(p, gr);
  return `<div class="pr-mu-score ${prStateMod(gr)}" data-live-state aria-live="polite"${_sa ? ` aria-label="${_sa}"` : ''}>${prStateCellText(p, gr)}</div>`;
}
function prStateCellAria(p, gr) {
  if (!gr) return '';
  const pickAbbr = (p.pick || '').toUpperCase();
  if (gr.status === 'live')      return 'Live' + (gr.detail ? ', ' + gr.detail : '') + ', ' + pickAbbr + ' ' + (gr.score || '') + (gr.lead ? ', ' + gr.lead : '');
  if (gr.status === 'final')     return 'Final, pick ' + (gr.result === 'W' ? 'won' : gr.result === 'L' ? 'lost' : 'settled') + ', ' + pickAbbr + ' ' + (gr.score || '');
  if (gr.status === 'postponed') return 'Postponed, no action';
  return '';
}
// Matchup subline shown in place of the (now-meaningless) start time.
function prStateSub(gr) {
  if (!gr) return null;
  if (gr.status === 'live')      return { txt: '● ' + (gr.detail || 'Live'), cls: 'pr-sub pr-sub-live' };
  if (gr.status === 'final')     return { txt: 'Final', cls: 'pr-sub pr-sub-final' };
  if (gr.status === 'postponed') return { txt: 'Postponed', cls: 'pr-sub pr-sub-ppd' };
  return null;
}
// Row modifier class: live/final get their own (un-faded, accented) treatment so
// an in-play pick never looks like a "passed / edge-gone" row; ppd + edge-gone fade.
// Final rows take a green/red left bar (from gr) so won/lost reads at a glance.
function prRowStateClass(p, gr) {
  if (isLiveGame(p))  return 'pr-state-live';
  if (isGameOver(p))  return 'pr-state-final' + (gr && gr.result === 'W' ? ' pr-final-win' : gr && gr.result === 'L' ? ' pr-final-loss' : '');
  if (isPostponed(p)) return 'pr-state-ppd';
  return prActionable(p) ? '' : 'pr-faded';
}

// One collapsed analytics row (simple, edge-sorted table).
// Columns: Matchup+time · Pick(team + captured line) · Mkt→Model · Edge ·
// Status[odds / live score] · Play-to · Stake · chevron.
// Escape feed strings before HTML interpolation — the feed is first-party, but
// raw insertion of narrative-adjacent fields is an avoidable class of bug.
function _escHTML(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Plain-English hover help for the tier chips (mobile gets the legend + help sheet).
const _TIER_HELP = {
  strong:      'Strong — 8pp+ model edge; the model\'s highest-conviction tier',
  value:       'Value — solid edge in the 6–8pp band',
  conditional: 'Conditional — edge in the 4–6pp band; a standard play, sized accordingly',
  reduced:     'Reduced confidence — a risk flag trimmed the suggested stake',
  flagged:     'Flagged — posted with a caution; open the pick for details before betting',
  marginal:    'Below the 4pp posting threshold — tracked for transparency, not a recommended bet',
};

function prRowCollapsed(p, isBest, gameResult) {
  const parts = String(p.game || '').split('@').map(s => s.trim());
  const away = parts[0] || '', home = parts[1] || '';
  const pickAbbr = (p.pick || '').toUpperCase();
  const live = isLiveGame(p), over = isGameOver(p), postponed = isPostponed(p);
  const inactive = live || over || postponed;
  const fmtO = o => (o == null ? '—' : (o > 0 ? '+' + o : String(o)));

  // Conviction tier — the feed's verdict (STRONG/VALUE/CONDITIONAL…) was computed
  // and never rendered; surface it as a chip + row stripe so conviction is
  // scannable without decoding "+X.Xpp".
  const [tierTxt, tierCls] = tierLabel(p.edge != null ? p.edge : 0, p.verdict);

  // Matchup — plain game label + time; the Pick column names the side.
  const timeStr = prGameTime(p.game_time);

  // Pick — team + the line the pick was captured at (run line shows its spread).
  let spread = '';
  if (p.pick_type === 'RUN_LINE' && p.run_line && p.run_line.spread) {
    const sp = String(p.run_line.spread);
    spread = ' ' + (sp.charAt(0) === '-' ? sp : '+' + sp);
  }
  const pickCell = `${pickAbbr}${spread}<span class="pr-bo">${fmtO(p.odds)}</span>`;

  // Market → Model win probabilities + edge — CURRENT read (falls back to posted).
  const _cur = prCur(p);
  const bp = _cur.bp, mp = _cur.mp;
  const bpPct = bp != null ? (bp * 100).toFixed(1) : '—';
  const mpPct = mp != null ? (mp * 100).toFixed(1) : '—';

  const ev = _cur.edge || 0;
  const edgeStr = (ev >= 0 ? '+' : '') + (ev * 100).toFixed(1) + 'pp';
  const edgeCls = ev >= 0 ? 'pos' : 'neg';
  // "re-rated" marker when the live edge has moved ≥1pp off the posted edge.
  const updMark = _cur.moved
    ? `<span class="pr-upd" title="Model re-rated since posting — showing current edge (posted ${(_cur.postedEdge >= 0 ? '+' : '') + (_cur.postedEdge * 100).toFixed(1)}pp)">${_cur.dir < 0 ? '▾' : '▴'}</span>`
    : '';

  // Current odds — pregame: best book price + ¢ movement vs the captured line.
  // Live/Final: the captured price (in-play odds aren't a bet you can make).
  let oddsCell;
  if (inactive) {
    oddsCell = `<span class="pr-o-main pr-o-na"><span class="pr-o-val">—</span><span class="pr-o-mv"></span></span>`;  // no actionable current price
  } else {
    const sb = sanitizeBookOdds(p);
    const cur  = sb.best ? sb.best.odds : (p.best_odds != null ? p.best_odds : p.odds);
    const cc = _oddsToCents(cur), pc = _oddsToCents(p.odds);
    let mv = '';
    if (cc != null && pc != null) {
      const val = Math.round(pc - cc);   // + = we locked a better number than the current line (ahead / CLV+)
      if (val >= 1)       mv = `<span class="pr-mv ahead" title="You locked ${val}¢ better than the current line — you're ahead (positive CLV)">+${val}¢</span>`;
      else if (val <= -1) mv = `<span class="pr-mv behind" title="A ${Math.abs(val)}¢ better price is available now than we locked">−${Math.abs(val)}¢</span>`;
    }
    oddsCell = `<span class="pr-o-main"><span class="pr-o-val">${fmtO(cur)}</span><span class="pr-o-mv">${mv}</span></span>`;  // book in the expanded card's Current odds
  }

  const ptStr = fmtO(_cur.playTo);

  // Stake — dollars first. A casual bettor's question is "how much?", and "$100"
  // answers it where "1.0u" requires knowing the unit convention.
  const _isKellyMode = _indexPnlMode === 'kelly';
  const _rowStakeU = kellyStakeUnits(p);   // shared derivation incl. kelly_pct fallback
  const units = _isKellyMode ? (_rowStakeU != null ? _rowStakeU.toFixed(1) + 'u' : '—') : '$100';
  const stakeSub = _isKellyMode
    ? `<span class="pr-st-usd kelly-usd" data-units="${_rowStakeU || 0}"></span>`
    : `<span class="pr-st-usd">1.0u flat</span>`;

  // Matchup subline — the start time is meaningless once a game starts, so live /
  // final / postponed games show their state there (inning, Final, Postponed).
  const _sub = inactive ? prStateSub(gameResult) : null;
  const tierChip = !inactive
    ? `<span class="pr-tierchip pt-${tierCls}" title="${_TIER_HELP[tierCls] || ''}">${tierTxt}</span>`
    : '';
  const subHTML = _sub
    ? `<div class="${_sub.cls}" data-live-sub>${_sub.txt.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`
    : `<div class="pr-time">${tierChip}${timeStr || '—'}</div>`;

  // Accessible name — colour/position cues are invisible to assistive tech. For
  // live/final games the play-to/stake tail is meaningless, so we read the state.
  const _stateAria = inactive ? prStateCellAria(p, gameResult) : '';
  const ariaLabel = `${away} at ${home}, pick ${pickAbbr}${spread} ${fmtO(p.odds)}, ${tierTxt} tier`
    + `${timeStr && !inactive ? ', ' + timeStr : ''}, market ${bpPct} percent, model ${mpPct} percent, edge ${edgeStr}`
    + (_cur.moved ? ` (re-rated from posted ${(_cur.postedEdge * 100).toFixed(1)}pp)` : '')
    + (inactive ? (_stateAria ? ', ' + _stateAria : '') : `, playable to ${ptStr}, stake ${units}.`);

  const _rowState = prRowStateClass(p, gameResult);
  return `<div class="pr-cols pr-row pr-t-${tierCls}${_rowState ? ' ' + _rowState : ''}" role="button" tabindex="0" data-pr-card="${prCardId(p)}" `
    + `aria-expanded="false" aria-label="${ariaLabel}" onclick="prToggle(this)" onkeydown="prKey(event,this)">`
    + `<div class="pr-mu"><div class="pr-mu-main"><div class="pr-match">${away} <span class="pr-at">@</span> ${home}</div>${subHTML}</div>${prStateChipHTML(p, gameResult)}</div>`
    + `<div class="pr-pick">${pickCell}</div>`
    + `<div class="pr-mm"><span class="pr-mm-mkt">${bpPct}</span><span class="pr-mm-arr">→</span><span class="pr-mm-mdl">${mpPct}</span></div>`
    + `<div class="pr-edge ${edgeCls}">${edgeStr}${updMark}</div>`
    + `<div class="pr-odds">${oddsCell}</div>`
    + `<div class="pr-play">${inactive ? '—' : ptStr}</div>`
    + `<div class="pr-stake">${units}${stakeSub}</div>`
    + `<div class="pr-chev" aria-hidden="true">›</div></div>`;
}

// ── Last-tracked price — honest "close" fallback. clv/closing_prob are null in
// the feed, so we show the most recent price we polled before the game, clearly
// labeled "Last tracked" (NOT an official closing line / CLV).
function prLastTracked(p) {
  const h = Array.isArray(p.odds_history) ? p.odds_history.filter(x => x && x.odds != null) : [];
  return h.length ? h[h.length - 1].odds : null;
}

// ── Recap (all-done) table ────────────────────────────────────────────────────
// Once every posted pick is final/postponed the live decision columns (current
// odds, play-to) are dead "—". This view replaces them with a results recap:
// posted line · last-tracked price · result · P&L · stake. Same drawer on expand.
function prTableHeadRecap() {
  return `<div class="pr-cols pr-recap pr-head">`
    + _prH('Matchup', 'h-mu')
    + _prH('Pick', 'h-pick')
    + _prH('Last tracked', 'h-last', 'Most recent price we tracked before the game — not an official closing line.')
    + _prH('Result', 'h-result')
    + _prH('P&L', 'h-pnl', 'Profit/loss in units — flat 1u per pick, or Kelly-scaled when the Kelly toggle is on.')
    + _prH('Stake', 'h-stake', 'Suggested bet size — flat 1 unit, or Kelly-scaled when the Kelly toggle is on.')
    + `<span class="pr-h h-chev"></span>`
    + `</div>`;
}

function prRowRecap(p, gr, settled, isKelly) {
  const parts = String(p.game || '').split('@').map(s => s.trim());
  const away = parts[0] || '', home = parts[1] || '';
  const pickAbbr = (p.pick || '').toUpperCase();
  const fmtO = o => (o == null ? '—' : (o > 0 ? '+' + o : String(o)));

  let spread = '';
  if (p.pick_type === 'RUN_LINE' && p.run_line && p.run_line.spread) {
    const sp = String(p.run_line.spread);
    spread = ' ' + (sp.charAt(0) === '-' ? sp : '+' + sp);
  }
  const pickCell = `${pickAbbr}${spread}<span class="pr-bo">${fmtO(p.odds)}</span>`;
  const lastTracked = fmtO(prLastTracked(p));

  // Result + P&L. P&L follows the Flat/Kelly toggle: flat = settled.pnl_u (1-unit
  // basis); Kelly = pnl_u × kelly_units (same basis as _kellyStatsFromHist).
  const ppd  = isPostponed(p) || (gr && gr.status === 'postponed');
  // getPickResult / computeTodaySettled grade the raw game winner, not the spread,
  // so a run-line pick would be mis-graded — leave it ungraded here rather than
  // publish a wrong W/L. (RUN_LINE isn't currently posted to the public main.)
  const isRL = p.pick_type === 'RUN_LINE';
  let resultHTML, pnlHTML, pnlAria;
  if (ppd) {
    resultHTML = `<span class="pr-result ppd">PPD</span>`;
    pnlHTML    = `<span class="pr-pnl">—</span>`;
    pnlAria    = 'no action';
  } else if (isRL && gr && gr.status === 'final') {
    resultHTML = `<span class="pr-result">—</span>`;
    pnlHTML    = `<span class="pr-pnl">—</span>`;
    pnlAria    = 'run line, see card';
  } else if (gr && gr.status === 'final' && settled && gr.result === 'P') {
    resultHTML = `<span class="pr-result ppd">P${gr.score ? ' ' + gr.score : ''}</span>`;
    pnlHTML    = `<span class="pr-pnl">0.0u</span>`;
    pnlAria    = 'push, stake returned';
  } else if (gr && gr.status === 'final' && settled) {
    const won  = gr.result === 'W';
    resultHTML = `<span class="pr-result ${won ? 'win' : 'loss'}">${won ? '✓ W' : '✗ L'}${gr.score ? ' ' + gr.score : ''}</span>`;
    // Kelly stake via the shared helper — an unsized bet shows "—", never a fake
    // 0.0u (the old `p.kelly_units || 0` multiplied missing sizing into zero P&L).
    const _st  = isKelly ? kellyStakeUnits(p) : 1;
    if (_st == null) {
      pnlHTML  = `<span class="pr-pnl">—</span>`;
      pnlAria  = 'Kelly stake unavailable';
    } else {
      const pnlU = settled.pnl_u * _st;
      const cls  = pnlU >= 0 ? 'pos' : 'neg';
      pnlHTML    = `<span class="pr-pnl ${cls}">${pnlU >= 0 ? '+' : ''}${pnlU.toFixed(1)}u</span>`;
      pnlAria    = `P&L ${pnlU >= 0 ? 'plus' : 'minus'} ${Math.abs(pnlU).toFixed(1)} units`;
    }
  } else {
    resultHTML = `<span class="pr-result">—</span>`;
    pnlHTML    = `<span class="pr-pnl">—</span>`;
    pnlAria    = '';
  }

  // Stake per toggle (mirrors the collapsed row). Shared helper so the stake
  // column can never show '—' while the P&L column computes from a fallback.
  const _stakeU = kellyStakeUnits(p);
  const units = isKelly ? (_stakeU != null ? _stakeU.toFixed(1) + 'u' : '—') : '1.0u';
  const stakeSub = isKelly ? `<span class="pr-st-usd kelly-usd" data-units="${_stakeU || 0}"></span>` : '';

  // Matchup subline = Final / Postponed state.
  const _sub = prStateSub(gr);
  const subHTML = _sub
    ? `<div class="${_sub.cls}" data-live-sub>${_sub.txt.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`
    : `<div class="pr-time">—</div>`;

  const resultWord = ppd ? 'postponed'
    : (gr && gr.status === 'final' ? (gr.result === 'W' ? 'won' : gr.result === 'P' ? 'push' : 'lost') : 'settled');
  const ariaLabel = `${away} at ${home}, pick ${pickAbbr}${spread} ${fmtO(p.odds)}, ${resultWord}`
    + (gr && gr.score ? ', ' + pickAbbr + ' ' + gr.score : '')
    + `, last tracked ${lastTracked}${pnlAria ? ', ' + pnlAria : ''}, stake ${units}.`;

  const _rowState = prRowStateClass(p, gr);
  return `<div class="pr-cols pr-recap pr-row${_rowState ? ' ' + _rowState : ''}" role="button" tabindex="0" data-pr-card="${prCardId(p)}" `
    + `aria-expanded="false" aria-label="${ariaLabel}" onclick="prToggle(this)" onkeydown="prKey(event,this)">`
    + `<div class="pr-mu"><div class="pr-mu-main"><div class="pr-match">${away} <span class="pr-at">@</span> ${home}</div>${subHTML}</div>${prStateChipHTML(p, gr)}</div>`
    + `<div class="pr-pick">${pickCell}</div>`
    + `<div class="pr-last">${lastTracked}</div>`
    + `<div class="pr-result-cell">${resultHTML}</div>`
    + `<div class="pr-pnl-cell">${pnlHTML}</div>`
    + `<div class="pr-stake">${units}${stakeSub}</div>`
    + `<div class="pr-chev" aria-hidden="true">›</div></div>`;
}

function prRecapRows(main, scores, date, isKelly) {
  // Mirror prRowHTML: register picksMap (floating results / today-tally / score
  // refresh read it) and wrap each row in the pr-wrap + pr-details drawer shell
  // so prToggle finds .pr-details and the expand still works.
  return main.map(p => {
    const cardId = prCardId(p);
    picksMap[cardId] = p;
    // Settle this pick alone (not via a game-keyed map) so doubleheaders don't
    // collide — resolveScore inside computeTodaySettled is game_time-aware.
    const settled = (typeof computeTodaySettled === 'function')
      ? ((computeTodaySettled([p], scores, date) || [])[0] || null) : null;
    return `<div class="pr-wrap">${prRowRecap(p, getPickResult(p, scores), settled, isKelly)}`
      + `<div class="pr-details" hidden data-card-id="${cardId}" data-best=""></div></div>`;
  }).join('');
}

// cardId mirrors pickCardHTML's own formula so picksMap stays populated WITHOUT
// eagerly building every (expensive, ~1000-line) card up front. We register the
// pick here so global consumers of picksMap (floating pill, score refresh, copy/
// share lookups) keep working; the heavy card HTML is built lazily on first
// expand in prToggle.
function prCardId(p) {
  return 'card-' + (p.pick || '').replace(/\s/g, '') + (p.game || '').replace(/\s/g, '');
}
// Row = collapsed summary + an EMPTY details slot the full card fills on expand.
function prRowHTML(p, isBest, gameResult) {
  const cardId = prCardId(p);
  picksMap[cardId] = p;
  return `<div class="pr-wrap">${prRowCollapsed(p, isBest, gameResult)}` +
    `<div class="pr-details" hidden data-card-id="${cardId}" data-best="${isBest ? '1' : ''}"></div></div>`;
}

// Plain rows (no column header / no table wrapper). `ordered` is already sorted
// by prSortPicks (actionable first, then by the active key).
function prRows(ordered, scores) {
  return ordered.map(p => prRowHTML(p, false, getPickResult(p, scores))).join('');
}

// Full-width divider label between row groups (actionable / no-longer-playable /
// near-miss). Sits between .pr-wrap rows in the table flow.
function prGroupLabel(text, n) {
  return `<div class="pr-group-label" role="separator" aria-label="${text}">`
    + `<span>${text}</span>${n ? `<span class="pgl-n">${n}</span>` : ''}</div>`;
}
function prToggle(row) {
  const det = row.parentElement && row.parentElement.querySelector('.pr-details');
  if (!det) return;
  if (det.hasAttribute('hidden')) {
    if (!det.dataset.built) {                 // lazy-build the full card on first expand
      const p = picksMap[det.dataset.cardId];
      if (p) {
        det.innerHTML = prDrawerHTML(p, det.dataset.best === '1', getPickResult(p, _scoresRef || {}));
        det.dataset.built = '1';
        refreshKellyUSD();                    // wire up the newly-injected card's $ amounts
      }
    }
    det.removeAttribute('hidden'); row.classList.add('open'); row.setAttribute('aria-expanded', 'true');
  } else {
    det.setAttribute('hidden', ''); row.classList.remove('open'); row.setAttribute('aria-expanded', 'false');
  }
}
function prKey(e, row) {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); prToggle(row); }
}

// Inject schema.org ItemList of today's posted picks for SEO rich-result eligibility.
// Rebuilt each render; no-ops (and clears) when there are no posted picks.
function renderItemListSchema(data) {
  const prev = document.getElementById('picks-itemlist');
  if (prev) prev.remove();
  const picks = (data && Array.isArray(data.picks)) ? data.picks.filter(p => (p.edge || 0) >= 0.04) : [];
  if (!picks.length) return;
  const ld = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": `Independent Baseball Projections — today's MLB value picks${data.date ? ' (' + data.date + ')' : ''}`,
    "numberOfItems": picks.length,
    "itemListElement": picks.map((p, i) => ({
      "@type": "ListItem",
      "position": i + 1,
      "name": `${p.pick || p.team || ''} ${formatOdds(p.odds)} — ${p.game || ''}`.trim(),
      "description": `Model edge +${((p.edge || 0) * 100).toFixed(1)}pp vs the market on ${p.game || 'this game'}.`
    }))
  };
  const s = document.createElement('script');
  s.type = 'application/ld+json';
  s.id = 'picks-itemlist';
  s.textContent = JSON.stringify(ld);
  document.head.appendChild(s);
}

function render(data, hist, scores = {}, perf = null) {
  // Staleness guard: before the morning pipeline run, today.json still holds the
  // PRIOR day's picks. If its date is behind "today" in CT, the new day's picks
  // haven't posted — clear them so the page shows the pending state ("Today's
  // Picks Post at 9:00 AM CT") instead of yesterday's games.
  try {
    const _ctToday = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    if (data && data.date && String(data.date) < _ctToday) {
      data = Object.assign({}, data, { picks: [], no_picks_yet: true });
    }
  } catch (e) { /* if date parsing fails, fall through and render as-is */ }

  _scoresRef = scores;   // stash so the share card can render settled results
  _perfRef = perf;       // stash edge-tier performance for share-card credibility
  // Build historical context lookup and start countdown timer (both idempotent)
  _histContextFn = buildHistContextFn((hist && hist.rows) ? hist.rows : []);
  startCountdownTimer();
  renderStatusStrip(data.picks, data.no_picks_yet, data.generated_at, data.games_today);

  // Date header — now used as the section label just above the picks
  if (data.date) {
    const d = new Date(data.date + 'T12:00:00');
    const shortDate = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    document.getElementById('page-date').textContent = `Today's Value Bets · ${shortDate}`;
    // Model refresh metadata — shown under the section header (moved from hero tile)
    if (data.generated_at) {
      const metaEl = document.getElementById('page-refresh-meta');
      if (metaEl) {
        metaEl.textContent = 'Model refresh: ' + data.generated_at;
        metaEl.style.display = 'block';
      }
    }
    const mainPicks = (data.picks || []).filter(p => (p.edge || 0) >= 0.04);
    const strongCount = mainPicks.filter(p => (p.edge || 0) >= 0.08).length;
    if (mainPicks.length > 0) {
      document.title = mainPicks.length + ' Value Bet' + (mainPicks.length !== 1 ? 's' : '') +
        (strongCount > 0 ? ' · ' + strongCount + ' Strong' : '') + ' — Independent Baseball Projections';
    }
  }

  // Context bar posted time — use earliest pick's posted_at (when picks went live)
  const _postedTimes = (data.picks || []).map(p => p.posted_at).filter(Boolean);
  const _postedEl = document.getElementById('ctx-posted-time');
  if (_postedEl && _postedTimes.length > 0) {
    _postedEl.textContent = _postedTimes[0];   // e.g. "9:21 AM CT"
  } else if (_postedEl && data.generated_at) {
    _postedEl.textContent = data.generated_at.split(' · ')[0];  // fallback: export time
  }

  if (data.generated_at) {
    document.getElementById('last-updated').textContent = 'Updated ' + data.generated_at;
  }

  // Freshness row
  // (Removed: freshness-row / signal-count / games-scanned updaters — their DOM
  // targets never existed on this page; the Action Today strip carries this info.)

  // Save refs for the P&L mode toggle
  _todayDataRef = data;
  _histDataRef  = hist;

  // Hero landing band: proof line (ROI + bet count) + today's pick count for the CTA.
  // Pulls from the same season data as the stats band so the claim never drifts.
  window.renderHeroProof = function(data) {
    const el = document.getElementById('hero-proof');
    const s  = data && data.season;
    if (el && s && s.roi != null && s.bets) {
      const roi = (s.roi >= 0 ? '+' : '') + (s.roi * 100).toFixed(1) + '%';
      // Brag + hedge in one breath: the ROI claim never ships without the CLV
      // caveat, so the hero can't overclaim what the dashboard won't certify.
      el.innerHTML = `<span class="hp-stat idx">${s.bets.toLocaleString()}</span> picks logged`
        + ` · <span class="hp-stat">${roi} ROI</span> so far`
        + ` — and we won't call the edge proven until a larger validated sample agrees.`;
      el.hidden = false;
    }

  };

  // Yesterday's settled result — recency proof. Reads today.json `yesterday_picks`
  // (each {result, pnl_u}); shows W–L and net units, links to the full record. Honest
  // on losing days too. Hidden when nothing settled yet.
  window.renderYesterdayRecap = function(data) {
    const el = document.getElementById('yesterday-recap');
    if (!el) return;
    const yp = data && Array.isArray(data.yesterday_picks) ? data.yesterday_picks : [];
    const settled = yp.filter(p => p && (p.result === 'W' || p.result === 'L' || p.result === 'P'));
    if (!settled.length) { el.hidden = true; return; }
    const w = settled.filter(p => p.result === 'W').length;
    const l = settled.filter(p => p.result === 'L').length;
    // Units follow the Flat/Kelly toggle (W–L never changes with mode). Kelly
    // applies only when the feed carries sizing for at least one pick — a feed
    // with NO sizing at all (pre-kelly_units export) keeps flat silently for
    // compatibility; PARTIAL sizing shows "—" rather than a silently-short sum.
    let u = settled.reduce((s, p) => s + (typeof p.pnl_u === 'number' ? p.pnl_u : 0), 0);
    let uStr = null;
    if (_indexPnlMode === 'kelly' && settled.some(p => kellyStakeUnits(p) != null)) {
      const ku = kellyPnlUnits(settled);
      if (ku == null) uStr = '—'; else u = ku;
    }
    const uCls = uStr ? 'yr-neu' : u > 0 ? 'yr-pos' : u < 0 ? 'yr-neg' : 'yr-neu';
    if (!uStr) uStr = (u >= 0 ? '+' : '−') + Math.abs(u).toFixed(1) + 'u';
    el.innerHTML = `<span class="yr-lbl">Yesterday</span> <span class="yr-rec">${w}–${l}</span>`
      + ` <span class="yr-u ${uCls}">${uStr}</span><span class="yr-link">see full record →</span>`;
    el.hidden = false;
  };

  // (Removed: renderHeroDemo — its #hd-* DOM targets never existed on this page.)

  // Record strip: season stats + streak + mini sparkline
  // Extracted into renderRecordStrip() so the Flat/Kelly toggle can re-render it.
  window.renderRecordStrip = window.renderPicksHeaderBlock = function(data, hist) {
    const container = document.getElementById('picks-header-block');
    if (!container) return;

    // W-L counts always from data (today.json). Only units/ROI swap on Kelly toggle.
    const isKelly  = _indexPnlMode === 'kelly';
    const ks = isKelly && hist && hist.rows ? _kellyStatsFromHist(hist.rows) : null;

    const flatSeason = data.season || {};

    const seasonUnits = isKelly && ks ? ks.season.units : (flatSeason.units || 0);
    const seasonRoi   = isKelly && ks ? ks.season.roi   : flatSeason.roi;
    const uPnl  = seasonUnits;
    const uCol  = uPnl  >= 0 ? 'green' : 'red';
    const roiCol = (seasonRoi || 0) >= 0 ? 'green' : 'red';

    // P&L — always in units for consistency
    const pnlDisplay  = (uPnl >= 0 ? '+' : '') + uPnl.toFixed(1) + 'u';
    const pnlLabel    = isKelly ? 'Kelly P&L' : 'P&L (flat)';
    const pnlSublabel = isKelly ? 'half-Kelly sized' : 'flat $100/bet';

    // Total $ — separate metric, mode-aware
    // Flat:  pnl_units × $100 (each flat bet is always $100)
    // Kelly: kelly_pnl_units × bankroll ÷ 100 (1 Kelly unit = 1% of bankroll)
    let totalDollarStr, totalDollarSub, totalDollarCol;
    if (isKelly) {
      if (_bankroll > 0) {
        const d = Math.round(uPnl * _bankroll / 100);
        totalDollarStr = (d >= 0 ? '+$' : '-$') + Math.abs(d).toLocaleString();
        totalDollarSub = `at $${_bankroll.toLocaleString()} bankroll`;
        totalDollarCol = d >= 0 ? 'green' : 'red';
      } else {
        totalDollarStr = '—';
        totalDollarSub = 'enter bankroll above';
        totalDollarCol = 'muted';
      }
    } else {
      // Flat: pnl_u × $100 (the flat bet size)
      const d = Math.round(uPnl * 100);
      totalDollarStr = (d >= 0 ? '+$' : '-$') + Math.abs(d).toLocaleString();
      totalDollarSub = 'at $100/bet';
      totalDollarCol = d >= 0 ? 'green' : 'red';
    }

    // CLV — always flat
    const clvStr  = data.avg_clv != null
      ? (data.avg_clv >= 0 ? '+' : '') + (data.avg_clv * 100).toFixed(2) + '%' : null;
    // NEUTRAL on Today — a flat/near-zero average CLV is not a proven edge, and the
    // homepage lacks the per-pick CLV sample to run the dashboard's significance test.
    // Never colour it green by sign (that would imply "we beat the market").
    const clvCol  = 'clv-flat';

    // Streak removed from Row 1 per user request

    // Today's in-play results chip (preserved, hidden until picks settle)
    // Today's W-L chip removed from the stats band — the floating results pill
    // and the LIVE status strip already cover today's status (deduped).
    const todayChip = '';

    // Row 2 helper text
    const helperText = _indexPnlMode === 'flat'
      ? 'Each pick sized at <strong>$100 flat</strong> · set bankroll to see Kelly sizing'
      : _bankroll > 0
        ? `Kelly amounts shown on each pick card · 1u = $${(_bankroll / 100).toLocaleString()}`
        : 'Enter your bankroll to see <strong>Kelly dollar amounts</strong> on each pick.';

    container.innerHTML = `
      <div class="phb-card">
        <!-- Stats only — sizing controls moved down to #sizing-bar by the picks. -->
        <div class="phb-stats-row">
          <div class="phb-stat-group">
            <span class="phb-stat-label">2026 Season</span>
            <span class="phb-stat-record">${flatSeason.wins ?? '—'}W–${flatSeason.losses ?? '—'}L</span>
          </div>
          <div class="phb-vdivider"></div>
          <div class="phb-stat-group">
            <span class="phb-stat-label">Season P&amp;L</span>
            <span class="phb-stat-val ${uCol}">${pnlDisplay}</span>
            <span class="phb-stat-sub">${pnlSublabel}</span>
          </div>
          ${window._clvSuppressed ? '' : `<div class="phb-vdivider"></div>
          <div class="phb-stat-group">
            <span class="phb-stat-label">Avg CLV</span>
            <span class="phb-stat-val muted">${data.avg_clv != null ? ((data.avg_clv>=0?'+':'')+(data.avg_clv*100).toFixed(2)+'%') : '—'}</span>
            <span class="phb-stat-sub">${data.clv_count || ''} picks</span>
          </div>`}
          <div class="phb-right-group">
            ${todayChip}
          </div>
        </div>
      </div>`;

    // Sizing + exposure bar — moved out of the stats card to sit just above the
    // picks. Re-rendered by setPicksPnlMode (which calls this fn), so the toggle,
    // helper, bankroll mode, and exposure stay in sync on mode change.
    const sizingEl = document.getElementById('sizing-bar');
    if (sizingEl) {
      // Exposure = what you can still place right now → actionable picks only,
      // matching the headline count (posted-but-inactive picks aren't bettable).
      const _smain = (data.picks || []).filter(p => (p.edge || 0) >= 0.04).filter(prActionable);
      let _sstake, _savgStr, _sShow;
      if (isKelly) {
        const _stotKU  = _smain.reduce((s, p) => s + (kellyStakeUnits(p) || 0), 0);
        const _savgKU  = _smain.length ? _stotKU / _smain.length : 0;
        const _stotDol = _bankroll > 0 ? Math.round(_stotKU * _bankroll / 100) : null;
        _sstake  = _stotDol != null ? '$' + _stotDol.toLocaleString() : _stotKU.toFixed(1) + 'u';
        _savgStr = _savgKU.toFixed(1) + 'u';
        _sShow   = _stotKU > 0;
      } else {
        _sstake  = '$' + (_smain.length * 100).toLocaleString();   // flat: $100 each
        _savgStr = '1.0u';
        _sShow   = _smain.length > 0;
      }
      const _expoHTML = _sShow
        ? `<span class="sizing-expo"><span class="se-lbl">Exposure</span><strong>${_sstake}</strong> · <strong>${_savgStr}</strong> avg</span>`
        : '';
      sizingEl.innerHTML = `
        <div class="sizing-bar">
          <div class="phb-toggle">
            <button class="phb-tog${!isKelly ? ' active' : ''}" id="phb-flat-btn" onclick="setPicksPnlMode('flat')">Flat $100</button>
            <button class="phb-tog${isKelly ? ' active' : ''}" id="phb-kelly-btn" onclick="setPicksPnlMode('kelly')">Kelly</button>
          </div>
          ${isKelly ? '<span class="phb-kelly-active"><span class="phb-ka-dot"></span>Kelly Sizing Active</span>' : ''}
          <div class="phb-bankroll${isKelly ? '' : ' flat-mode'}" id="phb-bankroll-wrap">
            <span class="phb-bk-label">Bankroll</span>
            <div class="phb-bk-input-wrap">
              <span class="phb-bk-dollar">$</span>
              <input class="phb-bk-input" id="phb-bankroll-input" type="number" min="0" step="100" placeholder="5,000" value="${_bankroll > 0 ? _bankroll : ''}">
            </div>
          </div>
          <span class="phb-helper" id="phb-helper-text">${helperText}</span>
          ${_expoHTML}
        </div>`;
    }
  }

  renderPicksHeaderBlock(data, hist);
  renderHeroProof(data);
  renderYesterdayRecap(data);
  renderItemListSchema(data);
  // Track-record evidence grid + calibration chart now live on the Model
  // Dashboard (performance.html). renderEvidenceSection(data, perf, hist);

  // CLV lives in the picks header block (Row 1), shown NEUTRAL — a flat/near-zero
  // average is not a proven edge. The significance-aware verdict (green only when a
  // 95% CI clears 0) lives on the Model Dashboard. The old renderCLVBanner() (which
  // claimed "market confirms edge") was dead code and has been removed to prevent
  // that overselling from regressing.

  const _mainForTracking = (data.picks || []).filter(p => (p.edge || 0) >= 0.04);


  // Correlated warning
  if (data.correlated_warning) {
    document.getElementById('corr-warning').style.display = 'flex';
    document.getElementById('corr-text').textContent = data.correlated_warning;
  }

  // Main picks
  // Sorted best-first (edge desc) so the strongest plays lead and main[0] is the
  // genuine top pick / Best Bet. Display ordering only — no filtering change.
  const main     = (data.picks || []).filter(p => p.edge >= 0.04).sort((a, b) => (b.edge || 0) - (a.edge || 0));
  const marginal = (data.picks || []).filter(p => p.edge < 0.04).sort((a, b) => (b.edge || 0) - (a.edge || 0));

  if (main.length === 0) {
    renderEmptyState(data, hist, marginal);
  } else {
    // ── Game-state counts ─────────────────────────────────────────────────────
    // POSTPONED is "done" for actionability — exclude it from "upcoming" so an
    // all-final (plus any PPD) slate correctly reaches allDone and shows the recap.
    const liveGroup      = main.filter(p => isLiveGame(p));
    const completedGroup = main.filter(p => isGameOver(p));
    const upcomingGroup  = main.filter(p => !isLiveGame(p) && !isGameOver(p) && !isPostponed(p));
    const allDone = main.length > 0 && upcomingGroup.length === 0 && liveGroup.length === 0;
    const _isKelly = _indexPnlMode === 'kelly';

    // Currently-actionable subset drives the headline metrics (count, top edge,
    // exposure, share) so posted-but-no-longer-playable picks (live / final /
    // edge-gone) aren't presented as live recommendations. `main` stays the
    // posted record for control flow (allDone / groups / rendered set / picksMap).
    const actionableMain = main.filter(prActionable);
    const inactivePosted = main.filter(p => !prActionable(p));
    _mainPicksRef = actionableMain;   // share-all shares only what's still playable

    // Share-all is hidden once the card is graded; offered only when ≥2 plays remain.
    const shareAllHTML = (!allDone && actionableMain.length >= 2)
      ? `<div class="share-all-row"><button class="share-all-btn" onclick="shareAllPicks()">𝕏 Share All ${actionableMain.length} Picks</button></div>`
      : '';

    let _stateInline = '';
    let _atNote = 'Odds &amp; starters captured at model run time — re-check current prices and lineups before betting.';
    if (liveGroup.length > 0 || completedGroup.length > 0 || allDone) {
      const _settledMain = (typeof computeTodaySettled === 'function')
        ? computeTodaySettled(completedGroup, scores, data.date || '') : [];
      const fw = _settledMain.filter(r => r.result === 'W').length;
      const fl = _settledMain.filter(r => r.result === 'L').length;
      // Record + running units as games go final. Units follow the Flat/Kelly
      // toggle (record never changes with mode): flat = 1u/pick; Kelly = pnl_u ×
      // kelly stake, "—" if any settled bet is unsized (never a silently-flat sum).
      const fu = _isKelly ? kellyPnlUnits(_settledMain)
                          : _settledMain.reduce((s, r) => s + (r.pnl_u || 0), 0);
      const _fuTxt = fu == null ? '—' : `${fu >= 0 ? '+' : ''}${fu.toFixed(1)}u`;
      const rec = (fw + fl) ? ` · ${fw}–${fl} · ${_fuTxt}` : '';
      if (allDone) {
        const _label = completedGroup.length
          ? `${completedGroup.length} game${completedGroup.length !== 1 ? 's' : ''}${rec}`
          : 'all games postponed';
        _stateInline = `<span class="pss-up">Today's results</span><span class="pss-sep">·</span><span class="pss-final">${_label}</span>`;
        _atNote = 'Today\'s card is graded. <a class="at-tmr" href="preview.html">See tomorrow\'s opening lines →</a>';
      } else {
        const parts = [];
        if (upcomingGroup.length)  parts.push(`<span class="pss-up">${upcomingGroup.length} Upcoming</span>`);
        if (liveGroup.length)      parts.push(`<span class="pss-live">${liveGroup.length} Live</span>`);
        if (completedGroup.length) parts.push(`<span class="pss-final">${completedGroup.length} Final${rec}</span>`);
        _stateInline = parts.join('<span class="pss-sep">·</span>');
      }
    }

    // ── Picks table — results recap once the card is graded, else the live ────
    // actionable table. Recap drops the dead current-odds/play-to columns and the
    // near-miss rows (those were never bets); same drawer expands on each row.
    let picksHTML;
    if (allDone) {
      picksHTML = `<div class="pr-table is-recap">${prTableHeadRecap()}${prRecapRows(main, scores, data.date || '', _isKelly)}</div>`;
    } else {
      // Actionable plays lead; posted-but-inactive and near-miss picks follow under
      // their own labels so "what to bet now" is never mixed with what's no longer playable.
      let _rows = prRows(prSortPicks(actionableMain), scores);
      if (inactivePosted.length) {
        _rows += prGroupLabel('Posted earlier — no longer playable', inactivePosted.length);
        _rows += prRows(prSortPicks(inactivePosted), scores);
      }
      if (marginal.length) {
        _rows += prGroupLabel('Near-miss — below 4pp threshold', marginal.length);
        _rows += prRows(prSortPicks(marginal), scores);
      }
      picksHTML = `<div class="pr-table">${prTableHead()}${_rows}</div>`
        + `<div class="pr-legend">Conviction tiers: `
        + `<span class="pr-tierchip pt-strong">STRONG</span> 8pp+ edge · `
        + `<span class="pr-tierchip pt-value">VALUE</span> 6–8pp · `
        + `<span class="pr-tierchip pt-conditional">CONDITIONAL</span> 4–6pp`
        + ` — tap any pick for the full read</div>`;
    }

    // ── Action Today strip — counts reflect what's PLAYABLE now, not just posted ─
    const _strongN = actionableMain.filter(p => p.edge >= 0.08).length;
    const _best    = actionableMain[0];
    // Graded card carries its summary in _stateInline ("Today's results…"), so the
    // "playable now / no longer playable" framing only applies while picks are live.
    const _hasInactive = !allDone && inactivePosted.length > 0;
    const _metaBits = [ _hasInactive
      ? `<strong>${actionableMain.length}</strong> playable now`
      : `<strong>${main.length}</strong> pick${main.length !== 1 ? 's' : ''}` ];
    if (_strongN) _metaBits.push(`<strong class="at-strong">${_strongN}</strong> strong`);
    if (_best) _metaBits.push(`top edge <strong class="g">+${(_best.edge * 100).toFixed(1)}pp</strong> <span class="at-bt">${_best.pick}</span>`);
    if (_hasInactive) _metaBits.push(`<span class="at-dim">${inactivePosted.length} no longer playable</span>`);
    // games_today can undercount when the export cache lags the pick list — never
    // print an "analyzed" figure smaller than the number of games we're showing.
    const _gamesShown = new Set((data.picks || []).map(p => p.game).filter(Boolean)).size;
    const _gamesAnalyzed = Math.max(data.games_today || 0, _gamesShown);
    if (_gamesAnalyzed) _metaBits.push(`<span class="at-dim">${_gamesAnalyzed} games analyzed</span>`);
    const _upd = data.generated_at ? `Updated ${String(data.generated_at).split(' · ')[0]}` : '';
    const _summaryEl = document.getElementById('picks-summary');
    if (_summaryEl) _summaryEl.innerHTML =
      `<div class="action-today">`
      + `<div class="at-row">`
        + `<span class="at-meta">${_metaBits.join('<span class="at-sep">·</span>')}</span>`
        + (_stateInline ? `<span class="picks-state-summary at-state">${_stateInline}</span>` : '')
        + (_upd ? `<span class="at-upd">${_upd}</span>` : '')
      + `</div>`
      + `<div class="at-note">${_atNote}</div>`
      + `</div>`;

    document.getElementById('picks-container').innerHTML = shareAllHTML + picksHTML;
    refreshKellyUSD();
    _updateTodayTally(scores);
    updateFloatingResults(scores);
  }

  // Near-miss picks now fold into the main table as WATCH rows — hide the old
  // standalone Marginal section.
  const _marSection = document.getElementById('marginal-section');
  if (_marSection) _marSection.style.display = 'none';

}

// ── Live countdown updater ────────────────────────────────────────────────────
function startCountdownTimer() {
  if (_countdownTimerStarted) return;
  _countdownTimerStarted = true;
  setInterval(() => {
    document.querySelectorAll('[data-game-time-utc]').forEach(el => {
      const gt    = el.dataset.gameTimeUtc;
      const start = new Date(gt).getTime();
      if (isNaN(start)) return;
      const now  = Date.now();
      const diff = start - now;
      if (now > start + 3.5 * 3600000) {
        el.textContent = '⏱ ✓ Final';
        el.classList.add('game-over');
        el.classList.remove('starting-soon');
      } else if (now > start) {
        el.textContent = '⏱ Live';
        el.style.color = 'var(--green)';
      } else if (diff <= 5 * 3600000) {
        const h = Math.floor(diff / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        const txt = h > 0 ? `Starts in ${h}h ${m}m` : (m > 0 ? `Starts in ${m}m` : 'Starting soon');
        el.textContent = '⏱ ' + txt;
        el.classList.toggle('starting-soon', h === 0 && m <= 30);
      }
      // > 5h away — leave as static time, don't touch
    });
    // Re-bucket the sections when any game crosses a state boundary
    // (upcoming→live→final), so a just-started game leaves "Upcoming" promptly
    // instead of waiting for the 30-min reload. Only re-renders on an actual
    // change (rare — a few times per slate) to avoid collapsing expanded cards.
    if (_todayDataRef && Array.isArray(_todayDataRef.picks)) {
      const sig = _todayDataRef.picks
        .map(p => isGameOver(p) ? '2' : isLiveGame(p) ? '1' : '0').join('');
      const changed = _lastBucketSig !== null && sig !== _lastBucketSig;
      _lastBucketSig = sig;
      if (changed && typeof render === 'function') {
        rerenderPicks();   // preserve open drawers + focus across the re-bucket
      }
    }
  }, 30 * 1000);
}

// ── Auto-refresh ──────────────────────────────────────────────────────────────
let _nextRefreshAt = null;
const REFRESH_MS = 30 * 60 * 1000;

function isLiveHour() {
  const h = parseInt(new Date().toLocaleString('en-US', {
    hour: 'numeric', hour12: false, timeZone: 'America/New_York'
  }));
  if (h >= 9 && h <= 23) return true;       // daytime / evening slate
  // Past midnight ET: keep polling only if ESPN confirms a game is still going
  // (a West-coast start can run past midnight ET). Bounded to ≤ 2 AM ET, and we
  // require an actual ESPN entry so a name mismatch can't cause overnight polling.
  if (h <= 2) {
    const picks = Object.values(picksMap);
    if (picks.length && _scoresRef && picks.some(p => {
      const g = _scoresRef[p.game];
      return g && (g.status === 'live' || g.status === 'scheduled');
    })) return true;
  }
  return false;
}

let _scorePollStarted = false;
function startAutoRefresh() {
  _nextRefreshAt = Date.now() + REFRESH_MS;
  setTimeout(async () => {
    if (isLiveHour()) await loadPicks();
    startAutoRefresh();
  }, REFRESH_MS);
  updateRefreshUI();

  // Start the score-badge poll exactly once (startAutoRefresh recurses every 30 min;
  // a fresh setInterval here would accumulate overlapping pollers).
  if (!_scorePollStarted) { _scorePollStarted = true; scheduleScorePoll(); }
}

// Score-badge poll cadence adapts to game state: ~75s while any game is in progress
// (so a completion shows within ~1 min), 5 min otherwise. Self-scheduling so the gap
// is recomputed from the freshest scores after every fetch.
const _SCORE_POLL_LIVE_MS = 75 * 1000;
const _SCORE_POLL_IDLE_MS = 5 * 60 * 1000;
function _anyGameLive() {
  return Object.values(picksMap).some(p => {
    const g = (typeof resolveScore === 'function') ? resolveScore(p, _scoresRef)
            : (_scoresRef ? _scoresRef[p.game] : null);
    return g && g.status === 'live';
  });
}
function scheduleScorePoll() {
  const gap = _anyGameLive() ? _SCORE_POLL_LIVE_MS : _SCORE_POLL_IDLE_MS;
  setTimeout(async () => {
    if (isLiveHour()) {
      const scores = await fetchESPNScores();
      _scoresRef = scores;   // keep fresh so a state-change re-render uses latest scores
      refreshScoreBadges(scores);
    }
    scheduleScorePoll();
  }, gap);
}

function updateRefreshUI() {
  const el = document.getElementById('refresh-indicator');
  if (!el || !_nextRefreshAt) return;
  const rem = Math.max(0, _nextRefreshAt - Date.now());
  const m = Math.floor(rem / 60000);
  const s = Math.floor((rem % 60000) / 1000);
  el.style.display = 'inline-flex';
  el.className = 'refresh-pill';
  el.innerHTML = `<span class="rp-dot"></span>Refreshes in ${m}:${s.toString().padStart(2,'0')}`;
  setTimeout(updateRefreshUI, 5000);
}

// ESPN_ABBR_MAP, _espnScoresCache, fetchESPNScores → ibp-utils.js

// Returns { status, result:'W'|'L', score:'5–3', lead:'ahead'|'behind'|'tied' } or null
function getPickResult(p, scores) {
  const g = (typeof resolveScore === 'function') ? resolveScore(p, scores) : (scores ? scores[p.game] : null);
  if (!g) return null;
  const side = (p.side || '').toUpperCase();
  // Pick-oriented score: our pick's team first, opponent second.
  const ps = side === 'AWAY' ? g.awayScore : g.homeScore;
  const os = side === 'AWAY' ? g.homeScore : g.awayScore;
  const score = (ps != null && os != null) ? `${ps}–${os}` : null;
  if (g.status === 'live') {
    const lead = (ps != null && os != null) ? (ps > os ? 'ahead' : ps < os ? 'behind' : 'tied') : null;
    return { status: 'live', score, detail: g.detail || '', lead };
  }
  if (g.status === 'postponed') return { status: 'postponed' };
  if (g.status === 'scheduled') return { status: 'scheduled' };
  // final — tie (suspended/called game) is a push, not a loss
  if (g.awayScore != null && g.awayScore === g.homeScore) return { status: 'final', result: 'P', score };
  const pickWon = side === 'AWAY' ? g.awayScore > g.homeScore : g.homeScore > g.awayScore;
  return { status: 'final', result: pickWon ? 'W' : 'L', score };
}

// ── Floating results indicator ────────────────────────────────────────────────
function updateFloatingResults(scores) {
  const pill    = document.getElementById('floating-results');
  const dotEl   = document.getElementById('fr-dot');
  const textEl  = document.getElementById('fr-text');
  if (!pill || !dotEl || !textEl) return;

  // Only consider today's picks (main-tier) — same population as the today tally,
  // so the two W–L readouts can never disagree. picksMap fallback pre-data-load.
  const picks = (_todayDataRef && Array.isArray(_todayDataRef.picks))
    ? _todayDataRef.picks.filter(p => (p.edge || 0) >= 0.04)
    : Object.values(picksMap);
  if (picks.length === 0) { pill.style.display = 'none'; return; }

  const results  = picks.map(p => getPickResult(p, scores)).filter(Boolean);
  const settled  = results.filter(r => r.status === 'final');
  const live     = results.filter(r => r.status === 'live').length;
  const ppd      = results.filter(r => r.status === 'postponed').length;
  const pending  = picks.length - settled.length - live - ppd;

  if (settled.length === 0) { pill.style.display = 'none'; return; }

  const wins   = settled.filter(r => r.result === 'W').length;
  const losses = settled.filter(r => r.result === 'L').length;  // exclude pushes (result 'P')

  let text = `${wins}W–${losses}L`;
  if (live > 0)          text += ` · ${live} live`;
  else if (pending > 0)  text += ` · ${pending} pending`;
  else                   text += ' · final';

  textEl.textContent = text;
  dotEl.className = 'fr-dot ' + (live > 0 ? 'live' : 'done');
  pill.style.display = 'inline-flex';
}

// Lightweight DOM update — refreshes result badges and card classes without re-rendering.
// On a *status transition* (scheduled→live→final / postponed) it does a full
// rerenderPicks instead, since that changes sort order, actionability, and the
// contents of any open drawer — none of which the lightweight badge update touches.
function refreshScoreBadges(scores) {
  let transition = false;
  for (const p of Object.values(picksMap)) {
    const gr = getPickResult(p, scores);
    if (!gr) {
      // ESPN lists every game for the date (incl. scheduled), so no match means a
      // team-abbr mapping gap or an unresolved doubleheader — the pick would never
      // show live/final state. Surface it once for the dev.
      if (!_warnedNoMatch.has(p.game)) {
        _warnedNoMatch.add(p.game);
        console.warn('[IBP] No ESPN scoreboard match for posted pick "' + p.game +
          '" — check ESPN_ABBR_MAP or a doubleheader; this pick will not show live/final state.');
      }
      continue;
    }
    const st = gr.status;
    const prev = _lastGameStatus[p.game];
    if (prev !== undefined && prev !== st) transition = true;   // a real change, not first sighting
    _lastGameStatus[p.game] = st;
  }
  // rerenderPicks re-sorts (live/final/postponed drop below actionable plays) and
  // rebuilds open drawers with fresh state; statuses are already recorded above so
  // the badge repaint below won't re-trigger it.
  if (transition) rerenderPicks();

  for (const [cardId, p] of Object.entries(picksMap)) {
    const gr = getPickResult(p, scores);
    if (!gr) continue;

    // Fade the row live as a game starts or finishes (full re-sort happens on the
    // next render). Present even when the drawer was never expanded.
    const rowEl = document.querySelector('.pr-row[data-pr-card="' + cardId + '"]');
    if (rowEl) {
      // Keep the row's state class in sync (live/final un-fade; ppd/edge-gone fade).
      rowEl.classList.remove('pr-faded', 'pr-state-live', 'pr-state-final', 'pr-state-ppd', 'pr-final-win', 'pr-final-loss');
      const _rs = prRowStateClass(p, gr);
      if (_rs) rowEl.classList.add(..._rs.split(' '));

      // Repaint the repurposed Status cell + matchup subline in place, flashing the
      // cell when the score/inning actually changes so a watcher catches the update.
      const stEl = rowEl.querySelector('[data-live-state]');
      if (stEl) {
        const _txt = prStateCellText(p, gr);
        const _changed = stEl.textContent !== _txt;
        stEl.textContent = _txt;
        stEl.className = 'pr-mu-score ' + prStateMod(gr) + (_changed ? ' pr-flash' : '');
        if (_changed) setTimeout(() => stEl.classList.remove('pr-flash'), 900);
        const _al = prStateCellAria(p, gr);
        if (_al) stEl.setAttribute('aria-label', _al);
      }
      const subEl = rowEl.querySelector('[data-live-sub]');
      const _sub2 = prStateSub(gr);
      if (subEl && _sub2) { subEl.textContent = _sub2.txt; subEl.className = _sub2.cls; }
    }

    const cardEl = document.getElementById(cardId);
    if (!cardEl) continue;

    // Update result badge (injected with data-result-badge attr)
    const badge = cardEl.querySelector('[data-result-badge]');
    if (badge) {
      if (gr.status === 'final') {
        badge.textContent = `${gr.result} ${gr.score}`;
        badge.className = `result-badge result-badge-${gr.result === 'W' ? 'win' : gr.result === 'P' ? 'push' : 'loss'}`;
        badge.style.display = '';
      } else if (gr.status === 'live') {
        // Surface the inning (and score) ESPN already gives us — e.g. "● LIVE · Top 9th · 4–6".
        const bits = [gr.detail, gr.score].filter(Boolean);
        badge.textContent = '● LIVE' + (bits.length ? ' · ' + bits.join(' · ') : '');
        // Color from the pick's perspective: ahead = green, behind = red, tied = neutral.
        badge.className = 'live-badge' + (gr.lead ? ' live-' + gr.lead : '');
        badge.style.display = '';
      } else if (gr.status === 'postponed') {
        badge.textContent = 'PPD';
        badge.className = 'ppd-badge';
        badge.style.display = '';
      }
    }

    // Update card border/opacity
    cardEl.classList.toggle('card-win',  gr.status === 'final' && gr.result === 'W');
    cardEl.classList.toggle('card-loss', gr.status === 'final' && gr.result === 'L');
  }

  // Refresh the today tally chip
  _updateTodayTally(scores);

  // Update floating results pill
  updateFloatingResults(scores);
}

function _updateTodayTally(scores) {
  const tally = document.getElementById('today-score-tally');
  if (!tally) return;
  // Main posted picks only (same population as the header strip): near-miss rows
  // are registered in picksMap for their drawers but were never bets, so they
  // don't belong in a W–L / P&L tally. picksMap fallback pre-data-load only.
  const picks = (_todayDataRef && Array.isArray(_todayDataRef.picks))
    ? _todayDataRef.picks.filter(p => (p.edge || 0) >= 0.04)
    : Object.values(picksMap);
  const results = picks.map(p => getPickResult(p, scores)).filter(Boolean);
  const done = results.filter(r => r.status === 'final');
  const wins = done.filter(r => r.result === 'W').length;
  const losses = done.filter(r => r.result === 'L').length;
  if (done.length === 0) { tally.style.display = 'none'; return; }
  tally.style.display = '';
  // Running units for today's finals — follows the Flat/Kelly toggle (same basis
  // and "—"-on-unsized rule as the header strip).
  let unitsHTML = '';
  try {
    const date = (_todayDataRef && _todayDataRef.date) || '';
    const settled = (typeof computeTodaySettled === 'function') ? computeTodaySettled(picks, scores, date) : [];
    if (settled.length) {
      const u = _indexPnlMode === 'kelly'
        ? kellyPnlUnits(settled)
        : settled.reduce((s, r) => s + (r.pnl_u || 0), 0);
      unitsHTML = u == null
        ? ' · <span style="color:var(--text-4)">—</span>'
        : ` · <span style="color:${u >= 0 ? 'var(--green)' : 'var(--red)'}">${u >= 0 ? '+' : ''}${u.toFixed(1)}u</span>`;
    }
  } catch (e) {}
  tally.querySelector('.tc-val').innerHTML = `${wins}W–${losses}L${unitsHTML}`;
  const ppd = results.filter(r => r.status === 'postponed').length;
  const pending = picks.length - done.length - ppd;
  tally.querySelector('.tc-lbl').textContent =
    `Today · ${pending > 0 ? pending + ' pending' : 'all done'}`;
}

// buildYesterdayHTML removed — yesterday results no longer shown on Today's Picks page

// _showDebugBanner, event listeners → ibp-utils.js

loadPicks();
startAutoRefresh();

// ── Mobile hamburger nav ──────────────────────────────────────────────────────
function toggleNav() {
  const links = document.querySelector('.nav-links');
  const btn   = document.getElementById('nav-hamburger');
  if (links) links.classList.toggle('open');
  if (btn) { btn.classList.toggle('open'); btn.setAttribute('aria-expanded', btn.classList.contains('open') ? 'true' : 'false'); }
}
// Close nav when a link is clicked on mobile
document.querySelectorAll('.nav-link').forEach(el => {
  el.addEventListener('click', () => {
    document.querySelector('.nav-links')?.classList.remove('open');
    document.getElementById('nav-hamburger')?.classList.remove('open');
  });
});

// ── Sticky mobile email capture — repeat visitors only ───────────────────────
// Shown ≤760px (CSS-gated) after 2+ distinct visit days; one dismissal = 30-day
// suppress; subscribing removes it permanently. No dark patterns: it never
// re-prompts within the window and never blocks content (bottom bar, real ✕).
(function initStickyCapture() {
  try {
    const today = new Date().toLocaleDateString('en-CA');
    if (localStorage.getItem('ibp_subscribed') === '1') return;
    const dismissedAt = parseInt(localStorage.getItem('ibp_sticky_dismissed') || '0', 10);
    if (dismissedAt && (Date.now() - dismissedAt) < 30 * 86400000) return;
    let visits = [];
    try { visits = JSON.parse(localStorage.getItem('ibp_visit_days') || '[]'); } catch (e) {}
    if (!visits.includes(today)) visits = visits.concat(today).slice(-10);
    localStorage.setItem('ibp_visit_days', JSON.stringify(visits));
    if (visits.length < 2) return;

    const bar = document.createElement('div');
    bar.id = 'sticky-capture';
    bar.className = 'sticky-capture show';
    bar.setAttribute('role', 'complementary');
    bar.innerHTML = '<span class="sc-cap-txt"><strong>The day\'s picks in your inbox every morning</strong> — free in 2026.</span>'
      + '<button type="button" class="sc-cap-btn">Sign up</button>'
      + '<button type="button" class="sc-cap-x" aria-label="Dismiss">✕</button>';
    bar.querySelector('.sc-cap-btn').onclick = () => {
      document.getElementById('email-capture')?.scrollIntoView({ behavior: 'smooth' });
      document.querySelector('#email-capture .ec-input')?.focus({ preventScroll: true });
      bar.remove();
    };
    bar.querySelector('.sc-cap-x').onclick = () => {
      localStorage.setItem('ibp_sticky_dismissed', String(Date.now()));
      bar.remove();
    };
    document.body.appendChild(bar);
  } catch (e) { /* capture prompt is optional */ }
})();

// ── "How to read a pick" help sheet ──────────────────────────────────────────
// The table's education lives in hover tooltips that don't exist on touch —
// this sheet is the tap-reachable equivalent (bottom sheet ≤760px, modal above).
let _helpPrevFocus = null;
function toggleHelpSheet(open) {
  const el = document.getElementById('help-sheet');
  if (!el) return;
  if (open) {
    _helpPrevFocus = document.activeElement;
    el.hidden = false;
    document.body.style.overflow = 'hidden';
    el.querySelector('.hs-close')?.focus();
  } else {
    el.hidden = true;
    document.body.style.overflow = '';
    if (_helpPrevFocus && _helpPrevFocus.focus) _helpPrevFocus.focus();
  }
}
document.addEventListener('keydown', e => {
  const sheet = document.getElementById('help-sheet');
  if (!sheet || sheet.hidden) return;
  if (e.key === 'Escape') { toggleHelpSheet(false); return; }
  // Focus trap — aria-modal promises the background is inert to keyboard users.
  if (e.key === 'Tab') {
    const focusables = sheet.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && (document.activeElement === first || !sheet.contains(document.activeElement))) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !sheet.contains(document.activeElement))) {
      e.preventDefault(); first.focus();
    }
  }
});
