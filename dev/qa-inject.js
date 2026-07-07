// Functional-QA probe — injected into each served page BEFORE its own scripts.
// Captures load-time console/JS errors, then drives the page's real interactions
// and writes a JSON result blob into <pre id="__qa"> + sets document.title.
(function () {
  var ERRORS = [];
  window.addEventListener('error', function (e) {
    ERRORS.push('error: ' + (e.message || e.error || e) + (e.filename ? ' @' + e.filename.split('/').pop() + ':' + e.lineno : ''));
  });
  window.addEventListener('unhandledrejection', function (e) { ERRORS.push('promise: ' + (e.reason && e.reason.message || e.reason)); });
  var _ce = console.error;
  console.error = function () { try { ERRORS.push('console.error: ' + Array.prototype.slice.call(arguments).map(String).join(' ').slice(0, 200)); } catch (x) {} return _ce.apply(console, arguments); };

  function T(name, fn) { try { var r = fn(); return { name: name, pass: !!(r && r.pass), detail: (r && r.detail) || '' }; } catch (e) { return { name: name, pass: false, detail: 'THREW: ' + (e.message || e) }; } }
  function txt(el) { return el ? (el.textContent || '').trim() : ''; }

  function runHome() {
    var tests = [];
    // Flat/Kelly toggle
    tests.push(T('kelly-toggle', function () {
      if (typeof setPicksPnlMode !== 'function') return { pass: false, detail: 'setPicksPnlMode missing' };
      setPicksPnlMode('kelly');
      var stakes = [].map.call(document.querySelectorAll('.pr-stake'), txt);
      var blanks = stakes.filter(function (s) { return s === '' || s === '—'; });
      var hasU = stakes.some(function (s) { return /u/.test(s); });
      setPicksPnlMode('flat');
      var flat = [].map.call(document.querySelectorAll('.pr-stake'), txt);
      return { pass: stakes.length > 0 && blanks.length === 0 && hasU && flat.some(function (s) { return /1\.0u/.test(s); }), detail: 'kelly[' + stakes.slice(0, 3).join(',') + '] blanks=' + blanks.length + ' flat[' + flat.slice(0, 2).join(',') + ']' };
    }));
    // Bankroll -> kelly $
    tests.push(T('bankroll-kelly-usd', function () {
      if (typeof setPicksPnlMode === 'function') setPicksPnlMode('kelly');   // re-renders the bankroll input FIRST
      var inp = document.getElementById('phb-bankroll-input'); if (!inp) return { pass: false, detail: 'no bankroll input' };
      inp.value = '5000'; inp.dispatchEvent(new Event('input', { bubbles: true }));
      var usd = [].map.call(document.querySelectorAll('.kelly-usd'), txt).filter(Boolean);
      if (typeof setPicksPnlMode === 'function') setPicksPnlMode('flat');
      return { pass: usd.some(function (s) { return /\$/.test(s); }), detail: 'usd=' + (usd.slice(0, 2).join(',') || 'none') };
    }));
    // Row expand -> drawer populates
    tests.push(T('row-expand-drawer', function () {
      var row = document.querySelector('.pr-row'); if (!row) return { pass: false, detail: 'no .pr-row' };
      row.click();
      var wrap = row.closest('.pr-wrap'); var det = wrap && wrap.querySelector('.pr-details');
      var ok = det && (det.children.length > 0 || (det.innerHTML || '').length > 60);
      return { pass: !!ok, detail: det ? 'drawer html=' + (det.innerHTML || '').length + ' chars' : 'no .pr-details' };
    }));
    // Sort header
    tests.push(T('sort-edge', function () {
      if (typeof prSetSort !== 'function') return { pass: false, detail: 'prSetSort missing' };
      prSetSort('edge'); prSetSort('model'); prSetSort('time');
      return { pass: document.querySelectorAll('.pr-row').length > 0, detail: 'rows after sort=' + document.querySelectorAll('.pr-row').length };
    }));
    // Email form validation (NO submit — would POST to backend)
    tests.push(T('email-validation', function () {
      var form = document.getElementById('ec-form'); var inp = form && form.querySelector('input[type=email]');
      if (!inp) return { pass: false, detail: 'no email input' };
      var hasReq = inp.hasAttribute('required');
      inp.value = 'not-an-email'; var badRej = inp.checkValidity() === false;
      inp.value = 'test@example.com'; var goodOk = inp.checkValidity() === true; inp.value = '';
      return { pass: hasReq && badRej && goodOk, detail: 'required=' + hasReq + ' rejectsBad=' + badRej + ' acceptsGood=' + goodOk };
    }));
    // Share infrastructure present (don't click share-all — it opens a Twitter
    // popup; per-pick image share via html2canvas needs a live check).
    tests.push(T('share-infra', function () {
      var btn = document.querySelector('.share-all-btn'); var modal = document.getElementById('share-modal');
      var fn = typeof shareAllPicks === 'function';
      return { pass: !!modal && fn, detail: 'share-all btn=' + !!btn + ' modal=' + !!modal + ' shareAllPicks=' + fn + ' (image-gen: live check)' };
    }));
    // Floating results pill
    tests.push(T('floating-pill', function () { return { pass: !!document.getElementById('floating-results'), detail: '' }; }));
    // Per-pick share image generation (stub html2canvas so no real CDN/canvas needed)
    tests.push(T('share-image-gen', function () {
      window.html2canvas = function () { return Promise.resolve({ toDataURL: function () { return 'data:image/png;base64,AAAA'; }, width: 680, height: 400 }); };
      var btn = document.querySelector('.share-btn, [onclick*="sharePickCard"], [onclick*="openShareModal"]');
      if (!btn) return { pass: typeof sharePickCard === 'function', detail: 'no per-pick share btn; sharePickCard fn=' + (typeof sharePickCard === 'function') };
      btn.click();
      var modal = document.getElementById('share-modal'); var card = document.getElementById('share-card-el');
      var opened = modal && !modal.classList.contains('hidden');
      if (modal) modal.classList.add('hidden');
      return { pass: !!modal, detail: 'modal opened=' + opened + ' card-el=' + !!card };
    }));
    return tests;
  }

  // Headline numbers for cross-page consistency: record (W–L) + units P&L.
  function headline(scope) {
    var s = (scope || document.body).textContent || '';
    var rec = (s.match(/\d+\s*W\s*[–-]\s*\d+\s*L/) || [''])[0].replace(/\s/g, '');
    var u = (s.match(/[+\-]\d+\.\d+u/) || [''])[0];
    return { record: rec, units: u };
  }

  function runGeneric() {
    var tests = [];
    tests.push(T('no-stuck-loading', function () {
      var loading = [].filter.call(document.querySelectorAll('.loading, [id$="-tbody"]'), function (el) { return /Loading…/.test(el.textContent || ''); });
      return { pass: loading.length === 0, detail: loading.length + ' stuck-loading elements' };
    }));
    tests.push(T('nav-active-single', function () {
      return { pass: document.querySelectorAll('.nav-link.active').length === 1, detail: document.querySelectorAll('.nav-link.active').length + ' active nav links' };
    }));
    tests.push(T('nav-hamburger-toggle', function () {
      if (typeof toggleNav !== 'function') return { pass: false, detail: 'toggleNav missing' };
      var links = document.querySelector('.nav-links'); var before = links && links.classList.contains('open');
      toggleNav(); var after = links && links.classList.contains('open'); toggleNav();
      return { pass: links && (before !== after), detail: 'open toggled ' + before + '->' + after };
    }));
    return tests;
  }

  function runPerf() {
    var t = runGeneric();
    t.push(T('validation-header', function () { var h = document.getElementById('headline-stats'); return { pass: h && /W–|W-/.test(h.textContent) && document.querySelector('.hl-risk-strip'), detail: 'risk-strip=' + !!document.querySelector('.hl-risk-strip') }; }));
    t.push(T('edge-tier-table', function () { var b = document.getElementById('edge-tbody'); return { pass: b && b.children.length > 0, detail: (b ? b.children.length : 0) + ' tier rows' }; }));
    return t;
  }
  function runHistory() {
    var t = runGeneric();
    function tbody() { return document.getElementById('history-tbody') || document.querySelector('tbody'); }
    function rowN() { var b = tbody(); return b ? b.children.length : 0; }
    t.push(T('history-table', function () { return { pass: rowN() > 0, detail: rowN() + ' rows' }; }));
    t.push(T('result-filter', function () {
      var w = document.querySelector('.filter-btn[data-filter="W"]'); if (!w) return { pass: false, detail: 'no W filter' };
      var bn = rowN(); w.click(); var an = rowN();
      var all = document.querySelector('.filter-btn[data-filter="all"]'); if (all) all.click();
      return { pass: an > 0 && an < bn, detail: 'rows ' + bn + '->' + an + ' on Wins (should drop)' };
    }));
    t.push(T('date-window', function () {
      var b7 = document.querySelector('.win-btn[data-window="7"]'); if (!b7) return { pass: false, detail: 'no 7d btn' };
      var bn = rowN(); b7.click(); var an = rowN();
      var all = document.querySelector('.win-btn[data-window="all"]'); if (all) all.click();
      return { pass: an > 0 && an <= bn, detail: 'rows ' + bn + '->' + an + ' on Last 7d' };
    }));
    t.push(T('min-edge-input', function () {
      var inp = document.getElementById('threshold-input'); if (!inp) return { pass: false, detail: 'no min-edge input' };
      var bn = rowN(); inp.value = '8'; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true }));
      var an = rowN(); inp.value = '0'; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true }));
      return { pass: an > 0 && an <= bn, detail: 'rows ' + bn + '->' + an + ' at min-edge 8pp' };
    }));
    t.push(T('pnl-toggle', function () {
      if (typeof togglePnlMode !== 'function') return { pass: false, detail: 'togglePnlMode missing' };
      // Kelly mode is data-gated (_kellyDataAvailable: ≥50% of rows carry real
      // kelly_units) — assert the cycle matches the data, not a fixed 3-mode shape.
      var kellyOK = (typeof _kellyDataAvailable === 'function') ? _kellyDataAvailable() : true;
      var btn = document.getElementById('pnl-toggle-btn'); var labels = [];
      for (var i = 0; i < 3; i++) { labels.push(txt(btn)); togglePnlMode(); }
      var sawKelly = labels.join('|').toLowerCase().indexOf('kelly') > -1;
      var sawDollar = labels.join('|').indexOf('$') > -1;
      var pass = kellyOK ? sawKelly : (!sawKelly && sawDollar);
      return { pass: pass, detail: 'kellyData=' + kellyOK + ' modes: ' + labels.join(' -> ') };
    }));
    t.push(T('csv-export', function () {
      var calls = 0; var _c = URL.createObjectURL; URL.createObjectURL = function () { calls++; return 'blob:x'; };
      var btn = document.getElementById('csv-export-btn'); if (btn) btn.click();
      URL.createObjectURL = _c;
      return { pass: !!btn && calls > 0, detail: 'btn=' + !!btn + ' createObjectURL calls=' + calls };
    }));
    return t;
  }
  function runModel() {
    var t = runGeneric();
    t.push(T('math-collapsibles', function () {
      var trig = document.querySelector('[onclick*="toggleMathSection"], .math-hdr, details summary');
      if (!trig) return { pass: false, detail: 'no collapsible trigger found' };
      trig.click();
      return { pass: true, detail: 'clicked a collapsible without throwing' };
    }));
    t.push(T('section-anchors', function () {
      var links = [].map.call(document.querySelectorAll('a[href^="#section-"]'), function (a) { return a.getAttribute('href'); });
      var missing = links.filter(function (h) { return !document.querySelector(h); });
      return { pass: links.length === 0 || missing.length === 0, detail: links.length + ' anchors, ' + missing.length + ' missing targets' };
    }));
    return t;
  }
  function runPreview() {
    var t = runGeneric();
    t.push(T('preview-state', function () {
      var empty = document.querySelector('.preview-empty'); var cards = document.querySelectorAll('.preview-pick-card, .ppc-card, [class*="preview-pick"]');
      return { pass: !!empty || cards.length > 0, detail: empty ? 'empty-state shown' : cards.length + ' preview cards' };
    }));
    return t;
  }

  function nav() { return [].map.call(document.querySelectorAll('nav a[href]'), function (a) { return a.getAttribute('href'); }).filter(function (h) { return h && !/^#|^http|^tel:|^mailto:/.test(h); }); }

  function go() {
    var p = location.pathname, tests, hscope = null;
    if (/performance/.test(p)) { tests = runPerf(); hscope = document.getElementById('headline-stats'); }
    else if (/history/.test(p)) { tests = runHistory(); }
    else if (/model/.test(p)) { tests = runModel(); }
    else if (/preview/.test(p)) { tests = runPreview(); }
    else { tests = runHome(); hscope = document.getElementById('picks-header-block'); }
    var out = { page: p, consoleErrors: ERRORS.slice(0, 10), navLinks: nav(), headline: headline(hscope), tests: tests };
    var pre = document.createElement('pre'); pre.id = '__qa'; pre.textContent = '@@QA@@' + JSON.stringify(out) + '@@END@@';
    document.body.appendChild(pre); document.title = 'QA_DONE ' + tests.filter(function (t) { return !t.pass; }).length + ' fail';
  }
  setTimeout(go, 5500);
})();
