// Unit tests for the fill-inference differ. Pure function, no network.
//   node tools/test-tape.mjs

import { diff, touches } from '../tape.mjs';

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  if (!ok) fail++;
};
const NOW = Date.parse('2026-09-15T18:00:00Z');
const FUTURE = NOW + 30 * 86400_000;
const PAST = NOW - 86400_000;
const mk = (rows) => new Map(rows.map(([id, t, p, v, b, e = FUTURE]) => [id, { t, p, v, b, e }]));
const only = (ev, k) => ev.filter((e) => e.k === k);

// 1 — partial fill on a resting ask
{
  const prev = mk([[1, 15614, 159900, 664, false]]);
  const now  = mk([[1, 15614, 159900,   6, false]]);
  const ev = diff(prev, now, NOW);
  check('partial fill is exact, with price and size',
    only(ev, 'fill'), [{ k: 'fill', i: 15614, p: 159900, q: 658, s: 'a', c: 'exact' }]);
}

// 2 — reprice alone is not a fill
{
  const prev = mk([[1, 15614, 165700, 95, false]]);
  const now  = mk([[1, 15614, 159900, 95, false]]);
  const ev = diff(prev, now, NOW);
  check('a reprice emits no fill', only(ev, 'fill').length, 0);
  check('a reprice is recorded with both prices',
    only(ev, 'reprice'), [{ k: 'reprice', i: 15614, from: 165700, to: 159900, q: 95, s: 'a' }]);
}

// 3 — reprice AND volume drop: price is ambiguous, so never exact
{
  const prev = mk([[1, 15614, 165700, 95, false]]);
  const now  = mk([[1, 15614, 159900, 80, false]]);
  const ev = diff(prev, now, NOW);
  check('fill alongside a reprice is downgraded to probable',
    only(ev, 'fill'), [{ k: 'fill', i: 15614, p: 165700, q: 15, s: 'a', c: 'probable' }]);
}

// 4 — a vanished order AT the front is a fill; one BEHIND the touch is a cancel
{
  const prev = mk([
    [1, 15614, 159800, 150, false],   // front — swept
    [2, 15614, 159900, 664, false],   // front — swept
    [3, 15614, 170000, 500, false],   // deep — walked away
    [4, 15614, 163500,  29, false],   // survives, becomes the touch
  ]);
  const now = mk([[4, 15614, 163500, 29, false]]);
  const ev = diff(prev, now, NOW);
  check('orders in front of the surviving touch are probable fills',
    only(ev, 'fill').map((f) => [f.p, f.q, f.c]),
    [[159800, 150, 'probable'], [159900, 664, 'probable']]);
  check('an order behind the touch is a cancel',
    only(ev, 'cancel').map((c) => [c.p, c.q]), [[170000, 500]]);
}

// 5 — same logic inverted on the bid side
{
  const prev = mk([
    [1, 15614, 141900, 121, true],    // best bid — hit
    [2, 15614, 128500, 2750, true],   // deep — cancelled
    [3, 15614, 141800, 1784, true],   // survives
  ]);
  const now = mk([[3, 15614, 141800, 1784, true]]);
  const ev = diff(prev, now, NOW);
  check('a vanished best bid is a probable fill',
    only(ev, 'fill').map((f) => [f.p, f.q, f.s]), [[141900, 121, 'b']]);
  check('a deep vanished bid is a cancel',
    only(ev, 'cancel').map((c) => c.p), [128500]);
}

// 6 — expiry beats the fill/cancel guess
{
  const prev = mk([[1, 15614, 159900, 664, false, PAST]]);
  const ev = diff(prev, new Map(), NOW);
  check('an order past issued+duration is an expire, not a fill', only(ev, 'fill').length, 0);
  check('...and is labelled expire', only(ev, 'expire').length, 1);
}

// 7 — whole side clears: no surviving touch to compare against
{
  const prev = mk([[1, 15614, 159900, 664, false], [2, 15614, 160000, 1000, false]]);
  const ev = diff(prev, new Map(), NOW);
  check('when a side empties entirely every order counts as filled',
    only(ev, 'fill').reduce((s, f) => s + f.q, 0), 1664);
}

// 8 — a brand-new order is not an event
{
  const ev = diff(new Map(), mk([[9, 15614, 159900, 6, false]]), NOW);
  check('a new order_id emits nothing', ev.length, 0);
}

// 9 — volume going UP on the same id (shouldn't happen) must not emit a negative fill
{
  const prev = mk([[1, 15614, 159900, 10, false]]);
  const now  = mk([[1, 15614, 159900, 99, false]]);
  check('volume increasing emits no fill', only(diff(prev, now, NOW), 'fill').length, 0);
}

// 10 — touches picks best ask low and best bid high, per type
{
  const t = touches(mk([
    [1, 15614, 160000, 1, false], [2, 15614, 159900, 1, false],
    [3, 15614, 141800, 1, true],  [4, 15614, 141900, 1, true],
    [5, 28699,  95340, 1, false],
  ]));
  check('best ask is the lowest, best bid the highest', [t.get(15614).a, t.get(15614).b], [159900, 141900]);
  check('touches are per type', t.get(28699).a, 95340);
}

// 11 — the sweep we actually watched today, end to end
{
  const prev = mk([
    [1, 15614, 159800,  150, false],   // the opponent
    [2, 15614, 159900,  664, false],   // yours, nine orders collapsed to one for the test
    [3, 15614, 160000, 1000, false],   // the new block
    [4, 15614, 163500,   29, false],
  ]);
  const now = mk([
    [2, 15614, 159900,    6, false],   // 658 taken
    [3, 15614, 160000,  940, false],   // 60 taken
    [4, 15614, 163500,   29, false],
  ]);
  const f = only(diff(prev, now, NOW), 'fill');
  check('the 09-15 sweep reconstructs to 868 units', f.reduce((s, x) => s + x.q, 0), 868);
  check('...at the right prices and sizes',
    f.map((x) => [x.p, x.q, x.c]).sort(),
    [[159800, 150, 'probable'], [159900, 658, 'exact'], [160000, 60, 'exact']].sort());
}

console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
process.exit(fail ? 1 : 0);
