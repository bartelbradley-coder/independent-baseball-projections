// Fail-closed suppression tests (node dev/test_clv_suppression.js)
// ibp-utils.js is a browser script (touches window at top level), so the
// pure function under test is extracted textually and evaluated standalone.
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'ibp-utils.js'), 'utf8');
const m = src.match(/function computeClvSuppressed\([\s\S]*?\n}/);
if (!m) { console.error('FAIL: computeClvSuppressed not found in ibp-utils.js'); process.exit(1); }
const computeClvSuppressed = eval('(' + m[0] + ')');
const ok = { clv_suppressed: false }, sup = { clv_suppressed: true }, missing = {};
const cases = [
  ['today ok, performance unavailable -> suppressed', [ok, null, ok], true],
  ['performance ok, history unavailable -> suppressed', [ok, ok, undefined], true],
  ['suppression field missing on one payload -> suppressed', [ok, missing, ok], true],
  ['conflicting flags (any true wins) -> suppressed', [ok, sup, ok], true],
  ['suppressed true with stale non-null CLV values -> suppressed',
    [{ clv_suppressed: true, avg_clv: 0.002, rows: [{ clv: 0.01 }] }, ok, ok], true],
  ['reversed completion order (argument order irrelevant) -> same result',
    [ok, sup].reverse(), true],
  ['all payloads explicitly false -> renderable', [ok, ok, ok], false],
  ['empty payload list -> suppressed', [], true],
];
let fail = 0;
for (const [name, payloads, want] of cases) {
  const got = computeClvSuppressed(payloads);
  if (got !== want) { console.error('FAIL:', name, 'got', got); fail++; }
  else console.log('ok:', name);
}
process.exit(fail ? 1 : 0);
