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
let _perfRef = null;    // performance.json (edge tiers) for share-card credibility
let _mdActiveId = null; // card whose details are currently expanded inline
let _histContextFn = null;      // set in render() — returns hist-context HTML for a pick
let _countdownTimerStarted = false;
let _lastBucketSig = null;      // section-bucket signature; re-render when a game changes state

// ── Book-odds sanitizer (trust fix) ───────────────────────────────────────────
// Shared by every place that renders per-book lines. Fixes two long-standing
// display bugs: (1) raw book_odds were shown unfiltered, so a stale / wrong-signed
// line (e.g. a MyBookie -833 on a +183 underdog) rendered verbatim and looked like
// a data error; (2) "best price" was picked with a raw descending-American sort /
// Math.max, which is only valid when every line has the same sign. Here we convert
// to implied probability, drop books that are off-market vs the field median
// (robust to a single bad book), and rank by payout (lowest implied prob = best).
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

// ── Share on X/Twitter ────────────────────────────────────────────────────────
function shareOnX(id) {
  const p = picksMap[id];
  if (!p) return;
  const edge  = (p.edge * 100).toFixed(1);
  const model = p.model_prob  ? (p.model_prob  * 100).toFixed(1) : null;
  const mkt   = p.market_prob ? (p.market_prob * 100).toFixed(1) : null;
  let text = `🎯 Independent Baseball Projections: ${p.pick} ${formatOdds(p.odds)} (+${edge}% edge)`;
  if (model && mkt) text += `\nModel ${model}% vs. Pinnacle ${mkt}%`;
  if (p.pitcher) text += `\n⚾ ${p.pitcher}`;
  text += `\n📊 independentbaseballprojections.net/`;
  window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`, '_blank', 'width=550,height=420');
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
  btn.textContent = '⏳ Rendering…';
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
      btn.textContent = '⬇ Download PNG';
      if (hint) hint.textContent = 'Ready to share';
    }, 2500);
  } catch (err) {
    console.error('[Independent Baseball Projections] html2canvas error:', err);
    btn.disabled = false;
    btn.textContent = '⬇ Download PNG';
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
  btn.textContent = '⏳ Preparing…';

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
      if (!blob) { btn.disabled = false; btn.textContent = '⬆ Share Image'; return; }
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
          if (e.name !== 'AbortError') btn.textContent = '⬆ Share Image';
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
        btn.textContent = '⬆ Share Image';
      }, 2500);
    }, 'image/png');
  } catch (err) {
    console.error('[Independent Baseball Projections] nativeShareCard error:', err);
    btn.disabled = false;
    btn.textContent = '⬆ Share Image';
  }
}

function shareAllPicks() {
  const picks = _mainPicksRef;
  if (!picks || picks.length === 0) return;
  const lines = picks.map(p => `• ${p.pick} ${formatOdds(p.odds)} +${(p.edge*100).toFixed(1)}% edge`);
  let text = `⚾ Independent Baseball Projections Picks:\n` + lines.join('\n');
  text += `\n📊 independentbaseballprojections.net/`;
  window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`, '_blank', 'width=550,height=420');
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
  refreshPersonalTracker();
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
    // Find a representative kelly_units from today's picks to show the conversion
    const samplePick = Object.values(picksMap).find(p => p.kelly_units);
    const exUnits = samplePick ? samplePick.kelly_units.toFixed(1) : '1.3';
    const exDollar = samplePick ? Math.round(samplePick.kelly_units * _bankroll / 100) : Math.round(1.3 * _bankroll / 100);
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
  refreshPersonalTracker();
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

// ── Is game currently live? ───────────────────────────────────────────────────
function isLiveGame(p) {
  if (!p.game_time) return false;
  const start = new Date(p.game_time).getTime();
  if (isNaN(start)) return false;
  const now   = Date.now();
  return now > start && now < start + 3.5 * 60 * 60 * 1000;
}

// ── Is game finished? (>3.5h past start) ─────────────────────────────────────
function isGameOver(p) {
  if (!p.game_time) return false;
  const start = new Date(p.game_time).getTime();
  if (isNaN(start)) return false;
  return Date.now() > start + 3.5 * 60 * 60 * 1000;
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

// ── "I bet this" personal tracker ────────────────────────────────────────────
let _myBets = JSON.parse(localStorage.getItem('ibp_my_bets') || '{}');
const _TODAY_KEY = new Date().toISOString().slice(0, 10);

function toggleBet(id) {
  const p = picksMap[id];
  if (!p) return;
  const key = `${_TODAY_KEY}::${id}`;
  if (_myBets[key]) {
    delete _myBets[key];
  } else {
    _myBets[key] = {
      pick: p.pick, game: p.game, odds: p.odds,
      kelly: p.kelly_units, edge: p.edge, date: _TODAY_KEY,
    };
  }
  // Prune entries older than 14 days to avoid unbounded localStorage growth
  for (const k of Object.keys(_myBets)) {
    const d = k.split('::')[0];
    if (d && d < new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10)) {
      delete _myBets[k];
    }
  }
  localStorage.setItem('ibp_my_bets', JSON.stringify(_myBets));
  refreshBetButtons();
  refreshPersonalTracker();
}

function refreshBetButtons() {
  document.querySelectorAll('.bet-toggle').forEach(btn => {
    const id  = btn.dataset.betId;
    const key = `${_TODAY_KEY}::${id}`;
    const on  = !!_myBets[key];
    btn.textContent = on ? '✓ Tracking' : 'Track';
    btn.classList.toggle('tracking', on);
  });
}

function refreshPersonalTracker() {
  const todayBets = Object.entries(_myBets)
    .filter(([k]) => k.startsWith(_TODAY_KEY + '::'))
    .map(([, v]) => ({ ...v }));

  const panel = document.getElementById('personal-tracker');
  if (!panel) return;

  if (todayBets.length === 0) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';

  // Cross-reference with history to show settled results
  if (_histRef && _histRef.rows) {
    todayBets.forEach(b => {
      const match = _histRef.rows.find(r =>
        r.date === b.date && r.pick === b.pick && r.game === b.game
      );
      if (match && (match.result === 'W' || match.result === 'L')) {
        b.result = match.result;
        b.pnl_u  = match.pnl_u;
      }
    });
  }

  const settledBets = todayBets.filter(b => b.result);
  const totalKelly  = todayBets.reduce((s, b) => s + (b.kelly || 0), 0);
  const settledPnl  = settledBets.reduce((s, b) => s + (b.pnl_u || 0), 0);
  const usdStr      = (_bankroll > 0 && totalKelly > 0)
    ? ` · <strong style="color:var(--green)">$${Math.round(totalKelly * _bankroll / 100)} risked</strong>` : '';
  const pnlStr      = settledBets.length > 0
    ? ` · settled: <strong style="color:${settledPnl>=0?'var(--green)':'var(--red)'}">${settledPnl>=0?'+':''}${settledPnl.toFixed(1)}u</strong>`
    : '';

  document.getElementById('pt-summary').innerHTML =
    `${todayBets.length} bet${todayBets.length > 1 ? 's' : ''} tracked · ${totalKelly.toFixed(1)}u${usdStr}${pnlStr}`;

  document.getElementById('pt-rows').innerHTML = todayBets.map(b => {
    const resultHTML = b.result
      ? `<span class="pt-result ${b.result}">${b.result}${b.pnl_u != null ? ' ' + (b.pnl_u>=0?'+':'') + b.pnl_u.toFixed(1) + 'u' : ''}</span>`
      : `<span style="margin-left:auto;color:var(--text-4);font-size:10px">⏳ pending</span>`;
    const kellyStr = b.kelly ? `<span style="color:var(--green)">${b.kelly.toFixed(1)}u</span>` : '';
    return `<div class="pt-row">
      <span style="font-weight:600;color:var(--text-2)">${b.pick}</span>
      <span style="color:var(--amber);font-family:var(--font-mono)">${formatOdds(b.odds)}</span>
      <span style="color:var(--text-4);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${b.game}</span>
      ${kellyStr}
      ${resultHTML}
    </div>`;
  }).join('');
}

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
  const _clvDesc = clvCount >= 100
    ? `On average, posted picks have closed better than the release price across the tracked sample — an early sign the model may be finding edge before the market fully prices it.${posPct ? ' ' + posPct + ' of ' + clvCount + ' picks beat the close.' : ''} ${trendStr}`
    : `${posPct ? posPct + ' of ' + clvCount + ' picks have beaten the close so far' : 'Tracking whether our posted price beats the close'} — still building a sample before drawing conclusions about edge.${trendStr ? ' ' + trendStr : ''}`;

  grid.innerHTML = `
    <div class="evidence-claim">
      <div class="ec-stat">${clv || '—'}</div>
      <div class="ec-label">Average Closing Line Value</div>
      <div class="ec-desc">${_clvDesc}</div>
    </div>
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
            <span class="preview-title">🔭 Tomorrow's Preview · ${count} pick${count !== 1 ? 's' : ''}</span>
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

// Compute Kelly-sized season/last30/last7 stats from history.json rows.
// Uses all settled rows — same population as flat mode, just different sizing.
function _kellyStatsFromHist(histRows) {
  // history.json rows are sorted newest-first (descending by date).
  // Sort ascending before any slice() so "last N" means "most recent N".
  const settled = (histRows || [])
    .filter(r => r.result === 'W' || r.result === 'L')
    .sort((a, b) => a.date.localeCompare(b.date));   // oldest → newest
  const season  = settled.filter(r => r.date && r.date.startsWith('2026'));

  // Derive Kelly units from stored kelly_units (preferred) or legacy kelly_pct.
  // kelly_units is pre-calculated by calculate_stake_sizing() in model.py and
  // already has all fractions applied — use it directly, no multiplier.
  // Legacy fallback: kelly_pct = final_kelly_pct (base × verdict_multiplier,
  // display_fraction NOT yet applied). Apply 0.5 × 100 to convert to units.
  function getKu(r) {
    if (r.kelly_units != null) return r.kelly_units;
    if (r.kelly_pct  != null) return Math.round(r.kelly_pct * 0.5 * 100 * 1000) / 1000;
    return null;
  }

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
        <span style="font-weight:600;color:var(--text-4)">+${(p.edge*100).toFixed(1)}% edge</span>
      </div>`).join('');
    nearMissHTML = `
      <div style="margin-top:20px;padding:14px 16px;background:rgba(245,158,11,0.05);border:1px solid rgba(245,158,11,0.15);border-radius:10px">
        <div style="font-size:9px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:var(--amber);margin-bottom:8px">
          ⚠️ ${marginal.length} Signal${marginal.length > 1 ? 's' : ''} Below 4% Threshold
        </div>
        ${rows}
        <div style="font-size:10px;color:var(--text-4);margin-top:8px">Model found signals — none cleared the 4% minimum edge for a recommended bet.</div>
      </div>`;
  }

  // Determine if we're before 9 AM CT (picks not yet posted) or just no picks today
  const nowCT = new Date(new Date().toLocaleString('en-US', {timeZone: 'America/Chicago'}));
  const isPre9AM = nowCT.getHours() < 9;

  const onwardCTA = `<div style="display:flex;flex-wrap:wrap;gap:14px;justify-content:center;margin-top:16px;font-size:12px">
        <a href="performance.html" style="color:var(--indigo-lt);text-decoration:none;font-weight:600">📈 See the track record →</a>
        <a href="#email-capture" onclick="event.preventDefault();document.getElementById('email-capture')?.scrollIntoView({behavior:'smooth'})" style="color:var(--indigo-lt);text-decoration:none;font-weight:600">✉️ Email me when picks post →</a>
      </div>`;
  const emptyCard = isPre9AM
    ? `<div class="picks-pending-card">
        <div class="ppc-time">🕐</div>
        <div class="ppc-title">Today's Picks Post at 9:00 AM CT</div>
        <div class="ppc-sub">
          The model runs each morning after overnight data and opening lines are confirmed.<br>
          Picks are locked before first pitch and tracked to closing line value.
        </div>
        <a class="ppc-preview-link" href="preview.html">🔭 View tomorrow's opening line estimates →</a>
        ${onwardCTA}
      </div>`
    : `<div class="state-card empty-state">
        <div class="state-icon">📊</div>
        <div class="state-title">No picks clear the edge threshold today.</div>
        <div class="state-sub">The model found no bets with sufficient edge vs. Pinnacle no-vig lines.</div>
        ${onwardCTA}
      </div>`;

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
  if (highWind) parts.push('⚡ High wind');
  return { text: '🌤 ' + parts.join(' · '), highWind };
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
    return `<div class="hist-context">📊 <strong>${side} ${type} ${lo}–${hi}</strong> this season: ` +
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
// buttons, share/copy — refreshKellyUSD/refreshBetButtons use querySelectorAll).
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
  const W = 900, H = 84, padX = 64, padTop = 26, padBot = 24;  // wide viewBox → fills the section
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
    svg += '<circle cx="' + px + '" cy="' + py.toFixed(1) + '" r="' + (labeled ? '3.4' : '1.8') + '" fill="' + col + '"/>';
    if (labeled) {
      svg += '<text x="' + px + '" y="' + (py - 9).toFixed(1) + '" class="dw-lg-val" text-anchor="middle">' + (p.odds > 0 ? '+' + p.odds : p.odds) + '</text>';
      svg += '<text x="' + px + '" y="' + (H - 6) + '" class="dw-lg-lbl" text-anchor="middle">' + p.label + '</text>';
    }
  });
  return svg + '</svg>';
}

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
  const live = isLiveGame(p), over = isGameOver(p);
  const scoreStr = gameResult && gameResult.score ? ' ' + gameResult.score : '';
  const sb = sanitizeBookOdds(p);

  const mp = p.model_prob, bp = p.market_prob;
  const mpPct = mp != null ? (mp * 100).toFixed(1) + '%' : '—';
  const bpPct = bp != null ? (bp * 100).toFixed(1) + '%' : '—';
  const bpW = bp != null ? Math.max(2, Math.min(100, bp * 100)) : 0;
  const mpW = mp != null ? Math.max(2, Math.min(100, mp * 100)) : 0;
  const gapW = Math.max(0, mpW - bpW);
  const ev = p.edge || 0;
  const edgeStr = (ev >= 0 ? '+' : '') + (ev * 100).toFixed(1) + 'pp';
  const ptStr = fmtO(p.playable_to);

  // current best price + book
  let curStr, curBook = '', curGood = false;
  if (live || over) { curStr = '—'; }
  else if (sb.best) { curStr = fmtO(sb.best.odds); curBook = sb.best.book; const capImp = _impliedFromAmerican(p.odds); curGood = capImp != null && sb.best.implied < capImp - 0.005; }
  else { curStr = fmtO(p.best_odds != null ? p.best_odds : p.odds); curBook = p.best_book || ''; }

  const isKelly = _indexPnlMode === 'kelly';
  const stakeUnits = isKelly ? (p.kelly_units ? p.kelly_units.toFixed(1) + 'u' : '—') : '1.0u';
  const stakeSub = isKelly ? '<span class="kelly-usd" data-units="' + (p.kelly_units || 0) + '"></span>' : '$100';

  // ── verdict (cites the numbers) ────────────────────────────────────────
  const cushion = prCushion(p);
  let pill, pCls, detail;
  if (over) { const r = gameResult && gameResult.result; pill = 'Final'; pCls = r === 'W' ? 'good' : r === 'L' ? 'bad' : 'neu'; detail = (r === 'W' ? 'Won' : r === 'L' ? 'Lost' : 'Settled') + scoreStr; }
  else if (live) { pill = 'Live'; pCls = 'neu'; detail = 'in-play' + scoreStr + ' — odds have moved off this pick'; }
  else if ((p.edge || 0) < 0.04) { pill = 'Below threshold'; pCls = 'neu'; detail = 'model edge is under our 4% cutoff — not a recommended bet'; }
  else if (!prActionable(p)) { pill = 'No longer playable'; pCls = 'bad'; detail = 'current ' + curStr + ' is past Play to ' + ptStr; }
  else if (p.current_lineup_confirmed === false) { pill = 'Playable'; pCls = 'neu'; detail = 'lineup not yet confirmed — re-check before betting'; }
  else { pill = 'Still playable'; pCls = 'good'; detail = 'current ' + curStr + ' beats Play to ' + ptStr; }

  const headHTML = '<div class="dw-head"><span class="dw-head-name">' + pickAbbr + ' ' + typeLabel + '</span>'
    + '<span class="dw-pill ' + pCls + '">' + pill + '</span>'
    + '<span class="dw-head-detail">— ' + detail + '</span></div>';

  // ── decision band: current · posted · play-to · stake ──────────────────
  const bandHTML = '<div class="dw-band">'
    + '<div class="dw-bi"><span class="dw-bi-k">Current odds</span><span class="dw-bi-v' + (curGood ? ' good' : '') + '">' + ((live || over) ? '—' : curStr) + '</span>' + ((!live && !over && curBook) ? '<span class="dw-bi-s">' + curBook + '</span>' : '') + '</div>'
    + '<div class="dw-bi"><span class="dw-bi-k">Posted line</span><span class="dw-bi-v">' + fmtO(p.odds) + '</span>' + (p.posted_at ? '<span class="dw-bi-s">at ' + p.posted_at + '</span>' : '') + '</div>'
    + '<div class="dw-bi"><span class="dw-bi-k">Play to</span><span class="dw-bi-v">' + ((live || over) ? '—' : ptStr) + '</span></div>'
    + '<div class="dw-bi"><span class="dw-bi-k">Stake</span><span class="dw-bi-v">' + stakeUnits + '</span><span class="dw-bi-s">' + stakeSub + '</span></div>'
    + '</div>';

  // ── Why the model likes it (left) ──────────────────────────────────────
  const meterHTML = (mp != null && bp != null)
    ? '<div class="dw-meter-cap"><span>Market <b>' + bpPct + '</b></span><span class="dw-arr">→</span><span>Model <b>' + mpPct + '</b></span><span class="g">Edge ' + edgeStr + '</span></div>'
      + '<div class="dw-meter"><i class="m-mkt" style="width:' + bpW.toFixed(1) + '%"></i><i class="m-gap" style="left:' + bpW.toFixed(1) + '%;width:' + gapW.toFixed(1) + '%"></i><i class="m-tick" style="left:calc(' + mpW.toFixed(1) + '% - 1px)"></i></div>'
      + '<div class="dw-cap">Bar shows implied win probability.</div>'
    : '';
  const adjs = (p.adj_breakdown && p.adj_breakdown.adjustments) || [];
  const pos = adjs.filter(a => a.positive).sort((a, b) => Math.abs(b.pp) - Math.abs(a.pp)).slice(0, 5);
  const neg = adjs.filter(a => !a.positive).sort((a, b) => Math.abs(b.pp) - Math.abs(a.pp)).slice(0, 5);
  const frow = a => '<div class="dw-frow"><b class="' + (a.positive ? 'good' : 'bad') + '">' + (a.pp >= 0 ? '+' : '') + a.pp.toFixed(1) + '</b><span>' + a.label + '</span></div>';
  const driversCol = pos.length ? '<div class="dw-fcol"><div class="dw-fh good">Key Drivers</div>' + pos.map(frow).join('') + '</div>' : '';
  const offsetsCol = neg.length ? '<div class="dw-fcol"><div class="dw-fh bad">Offsets</div>' + neg.map(frow).join('') + '</div>' : '';
  const factorsHTML = (driversCol || offsetsCol) ? '<div class="dw-factors">' + driversCol + offsetsCol + '</div>' : '';
  const listJoin = arr => arr.length <= 1 ? (arr[0] || '') : arr.slice(0, -1).join(', ') + ' and ' + arr[arr.length - 1];
  const tp = pos.slice(0, 2).map(a => a.label.toLowerCase()), tn = neg.slice(0, 2).map(a => a.label.toLowerCase());
  let readTxt = '';
  if (tp.length) { readTxt = pickAbbr + ' is undervalued mainly on ' + listJoin(tp) + (tn.length ? ', partly offset by ' + listJoin(tn) : '') + '.'; }
  const readHTML = readTxt ? '<div class="dw-h3">Model Read</div><div class="dw-read">' + readTxt + '</div>' : '';
  const whyInner = '<div class="dw-h2">Why The Model Likes It</div>' + meterHTML + factorsHTML + readHTML;

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
    ? '<table class="dw-mtable"><thead><tr><th>Metric</th><th>' + pickAbbr + pickPit + '</th><th>' + oppAbbr + oppPit + '</th><th>Advantage</th></tr></thead><tbody>' + mqRows.join('') + '</tbody></table>'
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
  const statusHTML = '<div class="dw-h3">Status &amp; Context</div><div class="dw-rows">'
    + '<div class="dw-rc"><span class="dw-rk">Lineup</span><span class="dw-rv ' + (lc === true ? 'good' : '') + '">' + (lc === true ? 'Confirmed' : 'Projected') + '</span></div>'
    + starterRow
    + '<div class="dw-rc"><span class="dw-rk">Weather</span><span class="dw-rv">' + weatherTxt + '</span></div>'
    + (runEnv.length ? '<div class="dw-rc"><span class="dw-rk">Run env.</span><span class="dw-rv">' + runEnv.join(' · ') + '</span></div>' : '')
    + '</div>';
  const dataInner = '<div class="dw-h2">Matchup Data</div>' + tableHTML + statusHTML;

  // Two columns when there's a real matchup table; otherwise stack so the right
  // side never sits empty.
  const twoCol = mqRows.length > 0;
  const bodyHTML = twoCol
    ? '<div class="dw-cols"><div class="dw-col">' + whyInner + '</div><div class="dw-col">' + dataInner + '</div></div>'
    : '<div class="dw-sec">' + whyInner + '</div><div class="dw-sec">' + dataInner + '</div>';

  // ── Line movement — real intraday curve from odds_history; fall back to the
  //    Opened → Posted → Current/Closed 3-point graph when the series is absent.
  let lgPts;
  const _hist = Array.isArray(p.odds_history) ? p.odds_history.filter(h => h && h.odds != null) : [];
  if (_hist.length >= 2) {
    const _endLabel = (live || over) ? 'Close' : 'Now';   // label only the endpoints; intermediate points stay plain
    lgPts = _hist.map((h, i) => ({
      odds: h.odds, t: h.t,
      label: i === 0 ? 'Open' : i === _hist.length - 1 ? _endLabel : ''
    }));
  } else {
    lgPts = [];
    if (p.line_open != null) lgPts.push({ label: 'Opened', odds: p.line_open });
    lgPts.push({ label: 'Posted', odds: p.odds });
    if (!live && !over && sb.best) lgPts.push({ label: 'Current', odds: sb.best.odds });
    else if ((live || over) && p.closing_prob != null) lgPts.push({ label: 'Closed', odds: _americanFromImplied(p.closing_prob) });
  }
  const graphHTML = prLineGraph(lgPts) || '<div class="dw-cap">Not enough line data to chart.</div>';
  let lgCap = '';
  if (_hist.length >= 2) {
    lgCap = '<div class="dw-lg-cap">Tracked ' + _clockFromT(_hist[0].t) + ' \u2192 ' + _clockFromT(_hist[_hist.length - 1].t)
          + ' CT \u00b7 ' + _hist.length + ' snapshots \u00b7 <span style="color:var(--green)">green</span> = current line is worse than what we locked (you\'re ahead)</div>';
  }
  let clvHTML = '';
  if (p.clv != null && (live || over)) {   // CLV only exists once the line has closed (first pitch)
    const clvpp = p.clv * 100;
    const cls = clvpp >= 0.5 ? 'g' : clvpp <= -0.5 ? 'r' : '';
    const note = clvpp >= 0.5 ? 'beat the close' : clvpp <= -0.5 ? 'closed past us' : 'matched close';
    clvHTML = '<div class="dw-clv"><span class="dw-clv-k">CLV</span><b class="' + cls + '">' + (clvpp >= 0 ? '+' : '') + clvpp.toFixed(1) + 'pp</b><span class="dw-clv-s">' + note + '</span></div>';
  }
  const moveHTML = '<div class="dw-sec"><div class="dw-move-head"><div class="dw-h2">Line Movement</div>' + clvHTML + '</div>'
    + '<div class="dw-lgwrap">' + graphHTML + lgCap + '</div></div>';

  const actionsHTML = forShare ? '' : ('<div class="dw-actions">'
    + '<button type="button" class="dw-act" onclick="sharePickCard(\'' + cardId + '\', ' + (isBest ? 1 : 0) + ')">Share</button>'
    + '</div>');

  return '<div class="dw">' + headHTML + bandHTML + bodyHTML + moveHTML + actionsHTML + '</div>';
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
  const gamesStr = (gamesToday != null && gamesToday > 0)
    ? ` · ${gamesToday} game${gamesToday !== 1 ? 's' : ''} modeled` : '';

  if (noPicksYet || !picks || picks.length === 0) {
    const nowCT  = new Date(new Date().toLocaleString('en-US',{timeZone:'America/Chicago'}));
    const pre9   = nowCT.getHours() < 9;
    strip.className = 'status-strip ss-pending';
    strip.innerHTML = `
      <span class="ss-badge ss-badge-pending">${pre9 ? '🕐 PENDING' : '📊 NO PICKS'}</span>
      <span class="ss-text">${pre9 ? 'Picks post at 9:00 AM CT after lineup confirmation' : 'No picks clear the 4% edge threshold today'}</span>
      <a class="ss-link" href="preview.html">Tomorrow's opening lines →</a>`;
    return;
  }

  const liveCount    = picks.filter(p => isLiveGame(p)).length;
  const doneCount    = picks.filter(p => isGameOver(p)).length;
  const pendingCount = picks.length - liveCount - doneCount;
  const firstPitch   = picks
    .filter(p => !isLiveGame(p) && !isGameOver(p))
    .map(p => p.game_time).filter(Boolean).sort()[0];
  const fpStr = firstPitch
    ? ' · First pitch ' + (new Date(firstPitch).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/Chicago'})) + ' CT'
    : '';
  const postedStr = picks[0]?.posted_at ? ' · Posted ' + picks[0].posted_at : '';

  // Active days (locked / live / partial) are now covered by the consolidated
  // summary line under the picks heading — only surface the strip for the
  // all-complete recap (pending / no-picks are handled above).
  if (doneCount !== picks.length) { strip.style.display = 'none'; return; }

  if (liveCount > 0) {
    strip.className = 'status-strip ss-active';
    strip.innerHTML = `
      <span class="ss-badge ss-badge-live">● LIVE</span>
      <span class="ss-text">${liveCount} active · ${doneCount} final · ${pendingCount} upcoming</span>
      <span class="ss-time">${postedStr.replace(' · ','')}</span>`;
  } else if (doneCount === picks.length) {
    strip.className = 'status-strip ss-done';
    strip.innerHTML = `
      <span class="ss-badge ss-badge-done">✓ FINAL</span>
      <span class="ss-text">All ${picks.length} game${picks.length !== 1 ? 's' : ''} complete</span>
      <span class="ss-time">${postedStr.replace(' · ','')}</span>`;
  } else {
    strip.className = 'status-strip ss-locked';
    strip.innerHTML = `
      <span class="ss-badge ss-badge-locked">✓ LOCKED</span>
      <span class="ss-text">${picks.length} pick${picks.length !== 1 ? 's' : ''} for today${gamesStr}${fpStr}</span>
      <span class="ss-time">${postedStr.replace(' · ','')}</span>`;
  }
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
function prSortVal(p, key) {
  if (key === 'model') return p.model_prob || 0;
  if (key === 'time')  return p.game_time ? (Date.parse(p.game_time) || 0) : Number.POSITIVE_INFINITY;
  return p.edge || 0;
}
function prSortPicks(arr) {
  const { key, dir } = _picksSort;
  return arr.slice().sort((a, b) => {
    const aa = prActionable(a) ? 0 : 1, bb = prActionable(b) ? 0 : 1;
    if (aa !== bb) return aa - bb;                  // actionable plays lead
    const d = (prSortVal(a, key) - prSortVal(b, key)) * dir;
    return d || ((b.edge || 0) - (a.edge || 0));    // then active key (default edge desc)
  });
}

// American odds → a continuous "cents" scale where +100 and -100 both map to 0 and
// higher = a better price for the bettor. Lets us measure line movement and cushion
// cleanly, even across the +/- boundary.
function _oddsToCents(o) {
  if (o == null || isNaN(o)) return null;
  return o > 0 ? o - 100 : -(Math.abs(o) - 100);
}

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
  const cc = _oddsToCents(cur), ptc = _oddsToCents(p.playable_to);
  return (cc != null && ptc != null) ? Math.round(cc - ptc) : null;
}

// A pick is actionable when it's pregame, still clears the 4% edge threshold, and
// its current price hasn't moved past the playable floor. Live, final, edge-gone,
// and near-miss picks are informational — faded and sorted below the live plays.
function prActionable(p) {
  if (isLiveGame(p) || isGameOver(p)) return false;
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
function _prHsort(key, label, cls) {
  const active = _picksSort.key === key ? ' active' : '';
  const sort = active ? (_picksSort.dir < 0 ? 'descending' : 'ascending') : 'none';
  return `<span class="pr-h ${cls} sortable${active}" role="button" tabindex="0" aria-sort="${sort}" `
    + `onclick="prSetSort('${key}')" onkeydown="prHeadKey(event,'${key}')">${label}${prSortArrow(key)}</span>`;
}
function _prH(label, cls) {
  return `<span class="pr-h ${cls}">${label}</span>`;
}
function prTableHead() {
  return `<div class="pr-cols pr-head">`
    + _prHsort('time', 'Matchup', 'h-mu')
    + _prH('Pick', 'h-pick')
    + _prHsort('model', 'Mkt → Model', 'h-mm')
    + _prHsort('edge', 'Edge', 'h-edge')
    + _prH('Current odds', 'h-odds')
    + _prH('Play to', 'h-play')
    + _prH('Stake', 'h-stake')
    + `<span class="pr-h h-chev"></span>`
    + `</div>`;
}

// One collapsed analytics row (simple, edge-sorted table).
// Columns: Matchup+time · Pick(team + captured line) · Mkt→Model · Edge ·
// Current odds(+book, ¢move) · Play-to · Stake · chevron.
function prRowCollapsed(p, isBest, gameResult) {
  const parts = String(p.game || '').split('@').map(s => s.trim());
  const away = parts[0] || '', home = parts[1] || '';
  const pickAbbr = (p.pick || '').toUpperCase();
  const live = isLiveGame(p), over = isGameOver(p);
  const fmtO = o => (o == null ? '—' : (o > 0 ? '+' + o : String(o)));

  // Matchup — plain game label + time; the Pick column names the side.
  const timeStr = prGameTime(p.game_time);

  // Pick — team + the line the pick was captured at (run line shows its spread).
  let spread = '';
  if (p.pick_type === 'RUN_LINE' && p.run_line && p.run_line.spread) {
    const sp = String(p.run_line.spread);
    spread = ' ' + (sp.charAt(0) === '-' ? sp : '+' + sp);
  }
  const pickCell = `${pickAbbr}${spread}<span class="pr-bo">${fmtO(p.odds)}</span>`;

  // Market → Model win probabilities.
  const bp = p.market_prob, mp = p.model_prob;
  const bpPct = bp != null ? (bp * 100).toFixed(1) : '—';
  const mpPct = mp != null ? (mp * 100).toFixed(1) : '—';

  const ev = p.edge || 0;
  const edgeStr = (ev >= 0 ? '+' : '') + (ev * 100).toFixed(1) + 'pp';
  const edgeCls = ev >= 0 ? 'pos' : 'neg';

  // Current odds — pregame: best book price + ¢ movement vs the captured line.
  // Live/Final: the captured price (in-play odds aren't a bet you can make).
  let oddsCell;
  if (live || over) {
    oddsCell = `<span class="pr-o-main pr-o-na">—</span>`;  // no actionable current price
  } else {
    const sb = sanitizeBookOdds(p);
    const cur  = sb.best ? sb.best.odds : (p.best_odds != null ? p.best_odds : p.odds);
    const book = sb.best ? sb.best.book : (p.best_book || '');
    const cc = _oddsToCents(cur), pc = _oddsToCents(p.odds);
    let mv = '';
    if (cc != null && pc != null) {
      const val = Math.round(pc - cc);   // + = we locked a better number than the current line (ahead / CLV+)
      if (val >= 1)       mv = `<span class="pr-mv ahead" title="You locked ${val}¢ better than the current line — you're ahead (positive CLV)">✓ +${val}¢</span>`;
      else if (val <= -1) mv = `<span class="pr-mv behind" title="A ${Math.abs(val)}¢ better price is available now than we locked">−${Math.abs(val)}¢</span>`;
    }
    oddsCell = `<span class="pr-o-main">${fmtO(cur)}${mv}${book ? ' <span class="pr-o-book">' + book + '</span>' : ''}</span>`;
  }

  const ptStr = fmtO(p.playable_to);

  // Stake — units primary, $ secondary.
  const _isKellyMode = _indexPnlMode === 'kelly';
  const units = _isKellyMode ? (p.kelly_units ? p.kelly_units.toFixed(1) + 'u' : '—') : '1.0u';
  const stakeSub = _isKellyMode
    ? `<span class="pr-st-usd kelly-usd" data-units="${p.kelly_units || 0}"></span>`
    : '';  // flat mode: stake is 1.0u on every row — no need to repeat $100

  // Accessible name — colour/position cues are invisible to assistive tech.
  const ariaLabel = `${away} at ${home}, pick ${pickAbbr}${spread} ${fmtO(p.odds)}`
    + `${timeStr && !live && !over ? ', ' + timeStr : ''}, market ${bpPct} percent, model ${mpPct} percent, edge ${edgeStr}`
    + `, playable to ${ptStr}, stake ${units}.`;

  return `<div class="pr-cols pr-row${prActionable(p) ? '' : ' pr-faded'}" role="button" tabindex="0" data-pr-card="${prCardId(p)}" `
    + `aria-expanded="false" aria-label="${ariaLabel}" onclick="prToggle(this)" onkeydown="prKey(event,this)">`
    + `<div class="pr-mu"><div class="pr-match">${away} <span class="pr-at">@</span> ${home}</div><div class="pr-time">${timeStr || '—'}</div></div>`
    + `<div class="pr-pick">${pickCell}</div>`
    + `<div class="pr-mm"><span class="pr-mm-mkt">${bpPct}</span><span class="pr-mm-arr">→</span><span class="pr-mm-mdl">${mpPct}</span></div>`
    + `<div class="pr-edge ${edgeCls}">${edgeStr}</div>`
    + `<div class="pr-odds">${oddsCell}</div>`
    + `<div class="pr-play">${ptStr}</div>`
    + `<div class="pr-stake">${units}${stakeSub}</div>`
    + `<div class="pr-chev" aria-hidden="true">›</div></div>`;
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
function prToggle(row) {
  const det = row.parentElement && row.parentElement.querySelector('.pr-details');
  if (!det) return;
  if (det.hasAttribute('hidden')) {
    if (!det.dataset.built) {                 // lazy-build the full card on first expand
      const p = picksMap[det.dataset.cardId];
      if (p) {
        det.innerHTML = prDrawerHTML(p, det.dataset.best === '1', getPickResult(p, _scoresRef || {}));
        det.dataset.built = '1';
        refreshKellyUSD();                    // wire up the newly-injected card's $ + bet state
        refreshBetButtons();
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
  if (data.generated_at) {
    const fr = document.getElementById('freshness-row');
    if (fr) {
      document.getElementById('fr-model-run').textContent = 'Last model run: ' + data.generated_at + ' CT';
      fr.style.display = 'flex';
    }
  }
  if (data.signal_count != null) {
    const _sc = document.getElementById('signal-count');
    if (_sc) _sc.textContent = data.signal_count;
  }
  if (data.games_today != null) {
    const _gs = document.getElementById('games-scanned');
    if (_gs) _gs.textContent = data.games_today;
    // Also update the strip if games_today differs from signal_count
    const strip = document.getElementById('games-scanned-strip');
    if (strip && data.games_today > 0) {
      strip.textContent = ` · Today: ${data.games_today} games analyzed.`;
    }
  }

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
      el.innerHTML = `<span class="hp-stat">${roi} ROI</span> across `
        + `<span class="hp-stat idx">${s.bets.toLocaleString()}</span> logged bets`
        + ` — every pick posted before first pitch.`;
      el.hidden = false;
    }
    const cnt = document.getElementById('hero-pick-count');
    if (cnt && data && Array.isArray(data.picks)) {
      const n = data.picks.filter(p => (p.edge || 0) >= 0.04).length;
      if (n > 0) cnt.textContent = String(n);
    }

    renderHeroDemo(data);
  };

  // Populate the hero edge-bar demo with today's strongest RECOMMENDED pick.
  // "Recommended" = highest edge among non-flagged picks (the flagged/reduced
  // play can have the biggest raw edge but is a poor thing to lead with).
  // Falls back to the static generic markup when no qualifying pick exists.
  window.renderHeroDemo = function(data) {
    if (!data || !Array.isArray(data.picks)) return;
    const cand = data.picks
      .filter(p => !p.is_flagged && (p.edge || 0) >= 0.04 && p.model_prob != null && p.market_prob != null)
      .sort((a, b) => (b.edge || 0) - (a.edge || 0))[0];
    if (!cand) return; // keep generic sample

    const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    const o = cand.best_odds != null ? cand.best_odds : cand.odds;
    const oddsStr = o == null ? '—' : (o > 0 ? '+' + o : '−' + Math.abs(o));
    const mktV = cand.market_prob * 100;
    const mdlV = cand.model_prob * 100;
    const edgePp = (cand.edge * 100);

    set('hd-label', "Today's top edge · " + (cand.game || ''));
    set('hd-team', cand.pick || cand.side || '—');
    set('hd-odds', oddsStr);
    set('hd-mkt', 'Market ' + mktV.toFixed(0) + '%');
    set('hd-mdl', 'Model ' + mdlV.toFixed(0) + '%');
    set('hd-edge', '+' + edgePp.toFixed(1) + 'pp');

    // Same zoomed scale the pick cards use, so the gap reads identically.
    const lo = Math.max(0, mktV - 12);
    const hi = Math.min(100, mdlV + 12);
    const range = (hi - lo) || 1;
    const mktF  = (mktV - lo) / range * 100;
    const edgeF = edgePp / range * 100;
    const mf = document.getElementById('hd-mkt-fill');
    const ef = document.getElementById('hd-edge-fill');
    const tk = document.getElementById('hd-tick');
    if (mf) mf.style.width = mktF.toFixed(1) + '%';
    if (ef) { ef.style.left = mktF.toFixed(1) + '%'; ef.style.width = edgeF.toFixed(1) + '%'; }
    if (tk) tk.style.left = 'calc(' + (mktF + edgeF).toFixed(1) + '% - 1px)';
  };

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
    const clvCol  = (data.avg_clv || 0) >= 0 ? 'green' : 'red';

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
          <div class="phb-vdivider"></div>
          <div class="phb-stat-group">
            <span class="phb-stat-label">Avg CLV</span>
            <span class="phb-stat-val ${clvStr ? clvCol : 'muted'}">${clvStr || '—'}</span>
            <span class="phb-stat-sub">${clvStr ? (data.clv_count || '') + ' picks' : 'pending'}</span>
          </div>
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
      const _smain = (data.picks || []).filter(p => (p.edge || 0) >= 0.04);
      let _sstake, _savgStr, _sShow;
      if (isKelly) {
        const _stotKU  = _smain.reduce((s, p) => s + (p.kelly_units || 0), 0);
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
  // Track-record evidence grid + calibration chart now live on the Model
  // Dashboard (performance.html). renderEvidenceSection(data, perf, hist);

  // ── CLV validation banner ────────────────────────────────────────────────
  // Rendered below the record strip. Only shown when avg_clv data is present.
  // Uses perf.clv_series to compute trend direction.
  function renderCLVBanner(data, perf) {
    const container = document.getElementById('clv-banner-container');
    if (!container || data.avg_clv == null) return;

    const clv     = data.avg_clv;
    const count   = data.clv_count || 0;
    const posPct  = data.clv_positive_pct;
    const isPos   = clv >= 0;
    const clvStr  = (clv >= 0 ? '+' : '') + (clv * 100).toFixed(2) + '%';
    const posPctStr = posPct != null ? Math.round(posPct * 100) + '%' : null;

    // Compute CLV trend from monthly series in perf
    let trendStr = '';
    if (perf && perf.clv_series && perf.clv_series.length >= 3) {
      const s  = perf.clv_series;
      const n  = s.length;
      // Compare last third vs first third
      const firstAvg = s.slice(0, Math.floor(n/3)).reduce((a,b)=>a+b,0) / Math.floor(n/3);
      const lastAvg  = s.slice(-Math.floor(n/3)).reduce((a,b)=>a+b,0) / Math.floor(n/3);
      const slope = lastAvg - firstAvg;
      if      (slope > 0.002)  trendStr = '↑ improving';
      else if (slope < -0.002) trendStr = '↓ declining';
      else                     trendStr = '→ stable';
    }

    // Update trust strip validation card dynamically
    const trustClvEl = document.getElementById('trust-clv-val');
    if (trustClvEl) {
      trustClvEl.textContent = isPos
        ? `Positive CLV ${clvStr} · market confirms edge`
        : `CLV ${clvStr} · monitor market alignment`;
    }

    if (!isPos && Math.abs(clv) < 0.005) {
      // Near-zero CLV — neutral, don't show banner
      return;
    }

    const icon = isPos ? '✅' : '⚠️';
    const titleText = isPos ? 'Closing Line Value Confirmed Positive' : 'Closing Line Value Negative';
    const desc = isPos
      ? `The market consistently prices picks <strong>higher</strong> after they're posted — meaning we're identifying edge <strong>before</strong> it's fully priced in. This is the strongest independent signal that the model finds genuine value, separate from whether bets win or lose on a given day.`
      : `The market has moved against posted picks on average. This is the key signal to monitor — negative CLV means the market disagrees with the model's direction after posting. Continue tracking.`;

    const pills = [
      { val: clvStr,   lbl: 'Avg CLV' },
      ...(posPctStr ? [{ val: posPctStr, lbl: 'Beat close' }] : []),
      ...(count      ? [{ val: count,    lbl: 'Picks tracked' }] : []),
      ...(trendStr   ? [{ val: trendStr, lbl: 'Trend' }] : []),
    ];

    container.innerHTML = `
      <div class="clv-banner ${isPos ? '' : 'negative'}">
        <span class="clv-banner-icon">${icon}</span>
        <div class="clv-banner-body">
          <div class="clv-banner-headline">
            <span class="clv-banner-title ${isPos ? '' : 'negative'}">${titleText}</span>
            <span class="clv-banner-stat ${isPos ? '' : 'negative'}">${clvStr}</span>
            <span class="clv-banner-meta">season average across ${count} tracked picks</span>
          </div>
          <div class="clv-banner-desc">${desc}</div>
          <div class="clv-banner-pills">
            ${pills.map(p => `
              <div class="clv-mini-pill">
                <span class="cmp-val">${p.val}</span>
                <span class="cmp-lbl">${p.lbl}</span>
              </div>`).join('')}
          </div>
        </div>
      </div>`;
  }

  // renderCLVBanner removed — CLV is now in the picks header block (Row 1)

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
    _mainPicksRef = main;
    const shareAllHTML = main.length >= 2
      ? `<div class="share-all-row"><button class="share-all-btn" onclick="shareAllPicks()">𝕏 Share All ${main.length} Picks</button></div>`
      : '';

    // ── Game-state counts (drive the Action Today summary line only) ──────────
    const liveGroup      = main.filter(p => isLiveGame(p));
    const completedGroup = main.filter(p => isGameOver(p));
    const upcomingGroup  = main.filter(p => !isLiveGame(p) && !isGameOver(p));
    const allDone = main.length > 0 && upcomingGroup.length === 0 && liveGroup.length === 0;

    let _stateInline = '';
    let _atNote = 'Odds &amp; starters captured at model run time — re-check current prices and lineups before betting.';
    if (liveGroup.length > 0 || completedGroup.length > 0) {
      let fw = 0, fl = 0;
      completedGroup.forEach(p => {
        const g = scores[p.game];
        if (!g || g.status !== 'final' || g.awayScore == null) return;
        const won = (p.side || '').toUpperCase() === 'AWAY'
          ? g.awayScore > g.homeScore : g.homeScore > g.awayScore;
        won ? fw++ : fl++;
      });
      const rec = (fw + fl) ? ` · ${fw}–${fl}` : '';
      if (allDone) {
        _stateInline = `<span class="pss-up">Today's results</span><span class="pss-sep">·</span>`
          + `<span class="pss-final">${completedGroup.length} game${completedGroup.length !== 1 ? 's' : ''}${rec}</span>`;
        _atNote = 'All of today\'s games have started — new picks post tomorrow morning.';
      } else {
        const parts = [];
        if (upcomingGroup.length)  parts.push(`<span class="pss-up">${upcomingGroup.length} Upcoming</span>`);
        if (liveGroup.length)      parts.push(`<span class="pss-live">${liveGroup.length} Live</span>`);
        if (completedGroup.length) parts.push(`<span class="pss-final">${completedGroup.length} Final${rec}</span>`);
        _stateInline = parts.join('<span class="pss-sep">·</span>');
      }
    }

    // ── One flat, edge-sorted table ──────────────────────────────────────────
    // Near-miss picks (edge < 4%) fold in too. prSortPicks leads with the
    // actionable plays (sorted by the active key, default edge desc); live, final,
    // edge-gone, and near-miss picks are faded and sorted below.
    const ordered = prSortPicks(main.concat(marginal));
    const picksHTML = `<div class="pr-table">${prTableHead()}${prRows(ordered, scores)}</div>`;

    // ── Action Today strip — counts, top edge, live state, model-run time ─────
    const _strongN = main.filter(p => p.edge >= 0.08).length;
    const _best    = main[0];
    const _metaBits = [`<strong>${main.length}</strong> pick${main.length !== 1 ? 's' : ''}`];
    if (_strongN) _metaBits.push(`<strong class="at-strong">${_strongN}</strong> strong`);
    if (_best) _metaBits.push(`top edge <strong class="g">+${(_best.edge * 100).toFixed(1)}%</strong> <span class="at-bt">${_best.pick}</span>`);
    if (data.games_today) _metaBits.push(`<span class="at-dim">${data.games_today} games analyzed</span>`);
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
    refreshBetButtons();
    refreshPersonalTracker();
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
  return h >= 9 && h <= 23;  // extended to midnight to catch late games
}

function startAutoRefresh() {
  _nextRefreshAt = Date.now() + REFRESH_MS;
  setTimeout(async () => {
    if (isLiveHour()) await loadPicks();
    startAutoRefresh();
  }, REFRESH_MS);
  updateRefreshUI();

  // Lightweight score badge refresh every 5 minutes during live hours
  setInterval(async () => {
    if (!isLiveHour()) return;
    const scores = await fetchESPNScores();
    _scoresRef = scores;   // keep fresh so a state-change re-render uses latest scores
    refreshScoreBadges(scores);
  }, 5 * 60 * 1000);
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

// Returns { status, result:'W'|'L', score:'5–3' } or null
function getPickResult(p, scores) {
  const g = scores[p.game];
  if (!g) return null;
  const side = (p.side || '').toUpperCase();
  // Pick-oriented score: our pick's team first, opponent second.
  const ps = side === 'AWAY' ? g.awayScore : g.homeScore;
  const os = side === 'AWAY' ? g.homeScore : g.awayScore;
  const score = (ps != null && os != null) ? `${ps}–${os}` : null;
  if (g.status === 'live')      return { status: 'live', score };
  if (g.status === 'scheduled') return { status: 'scheduled' };
  // final
  const pickWon = side === 'AWAY' ? g.awayScore > g.homeScore : g.homeScore > g.awayScore;
  return { status: 'final', result: pickWon ? 'W' : 'L', score };
}

// ── Floating results indicator ────────────────────────────────────────────────
function updateFloatingResults(scores) {
  const pill    = document.getElementById('floating-results');
  const dotEl   = document.getElementById('fr-dot');
  const textEl  = document.getElementById('fr-text');
  if (!pill || !dotEl || !textEl) return;

  // Only consider today's picks (main-tier)
  const picks = Object.values(picksMap);
  if (picks.length === 0) { pill.style.display = 'none'; return; }

  const results  = picks.map(p => getPickResult(p, scores)).filter(Boolean);
  const settled  = results.filter(r => r.status === 'final');
  const live     = results.filter(r => r.status === 'live').length;
  const pending  = picks.length - settled.length - live;

  if (settled.length === 0) { pill.style.display = 'none'; return; }

  const wins   = settled.filter(r => r.result === 'W').length;
  const losses = settled.length - wins;

  let text = `${wins}W–${losses}L`;
  if (live > 0)          text += ` · ${live} live`;
  else if (pending > 0)  text += ` · ${pending} pending`;
  else                   text += ' · final';

  textEl.textContent = text;
  dotEl.className = 'fr-dot ' + (live > 0 ? 'live' : 'done');
  pill.style.display = 'inline-flex';
}

// Lightweight DOM update — refreshes result badges and card classes without re-rendering
function refreshScoreBadges(scores) {
  for (const [cardId, p] of Object.entries(picksMap)) {
    const gr = getPickResult(p, scores);
    if (!gr) continue;

    // Fade the row live as a game starts or finishes (full re-sort happens on the
    // next render). Present even when the drawer was never expanded.
    const rowEl = document.querySelector('.pr-row[data-pr-card="' + cardId + '"]');
    if (rowEl) rowEl.classList.toggle('pr-faded', !prActionable(p));

    const cardEl = document.getElementById(cardId);
    if (!cardEl) continue;

    // Update result badge (injected with data-result-badge attr)
    const badge = cardEl.querySelector('[data-result-badge]');
    if (badge) {
      if (gr.status === 'final') {
        badge.textContent = `${gr.result} ${gr.score}`;
        badge.className = `result-badge result-badge-${gr.result === 'W' ? 'win' : 'loss'}`;
        badge.style.display = '';
      } else if (gr.status === 'live') {
        badge.textContent = gr.score ? `● LIVE · ${gr.score}` : '● LIVE';
        badge.className = 'live-badge';
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
  const picks = Object.values(picksMap);
  const results = picks.map(p => getPickResult(p, scores)).filter(Boolean);
  const done = results.filter(r => r.status === 'final');
  const wins = done.filter(r => r.result === 'W').length;
  const losses = done.filter(r => r.result === 'L').length;
  if (done.length === 0) { tally.style.display = 'none'; return; }
  tally.style.display = '';
  tally.querySelector('.tc-val').textContent = `${wins}W–${losses}L`;
  const pending = picks.length - done.length;
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
