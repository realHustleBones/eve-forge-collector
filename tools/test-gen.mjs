// Offline test for the ESI cache-generation logic — fake in-process ESI.
//   node tools/test-gen.mjs
//
// Covers the two things that make the worker stop wasting full scans:
// recognising an unchanged generation from page 1's Last-Modified, and working
// out when the next generation is due from Expires minus Date (which is immune
// to this container's clock being wrong).

import http from 'node:http';

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  if (!ok) fail++;
};

const JITA = 60003760;
const PER_PAGE = 1000;

// 3 pages' worth, so a full scan is visibly more than one request
const orders = [];
for (let i = 0; i < 2500; i++) {
  orders.push({ order_id: i + 1, type_id: 1000 + (i % 50), location_id: JITA,
                is_buy_order: i % 2 === 0, price: 100 + i, volume_remain: 5,
                issued: '2026-09-15T00:00:00Z', duration: 90 });
}

let lastModified = 'Mon, 15 Sep 2026 22:45:00 GMT';
let sendLastModified = true;
// Deliberately absurd server clock: if anything reads Expires against the LOCAL
// clock instead of against the server's own Date, ttl comes out years wrong.
let serverNow = 'Mon, 15 Sep 2026 22:46:08 GMT';
let expires = 'Mon, 15 Sep 2026 22:50:00 GMT';
let hits = 0;

const server = http.createServer((req, res) => {
  hits++;
  const page = Number(new URL(req.url, 'http://x').searchParams.get('page') || 1);
  const pages = Math.ceil(orders.length / PER_PAGE);
  const h = { 'Content-Type': 'application/json', 'x-pages': String(pages),
              date: serverNow, expires };
  if (sendLastModified) h['last-modified'] = lastModified;
  res.writeHead(200, h);
  res.end(JSON.stringify(orders.slice((page - 1) * PER_PAGE, page * PER_PAGE)));
});

server.listen(0, async () => {
  process.env.ESI_BASE = `http://127.0.0.1:${server.address().port}`;
  const { snapshot, planNext, genOf } = await import('../tape.mjs');

  // ---- 1. cold scan reads every page
  hits = 0;
  const a = await snapshot(null);
  check('a cold scan fetches every page', hits, 3);
  check('...and returns a book', a.book.size, 2500);
  check('...and is not flagged unchanged', a.unchanged, false);
  check('...and reports the generation stamp', a.gen.lastModified, lastModified);
  check('...with ttl from Expires minus the SERVER Date (232s)', a.gen.ttlMs, 232000);

  // ---- 2. same generation: one page, no book, no work
  hits = 0;
  const b = await snapshot(a.gen);
  check('an unchanged generation costs ONE request, not three', hits, 1);
  check('...and is flagged unchanged', b.unchanged, true);
  check('...and returns no book, so nothing can diff against a stale one', b.book, null);

  // ---- 3. generation rolls: full scan again
  lastModified = 'Mon, 15 Sep 2026 22:50:00 GMT';
  hits = 0;
  const c = await snapshot(b.gen);
  check('a rolled generation triggers a full scan', hits, 3);
  check('...and is not flagged unchanged', c.unchanged, false);

  // ---- 4. no Last-Modified at all: never claim unchanged
  sendLastModified = false;
  hits = 0;
  const d = await snapshot(c.gen);
  check('a missing Last-Modified always scans', [hits, d.unchanged], [3, false]);
  const e = await snapshot(d.gen);
  check('...and two header-less scans in a row still never claim unchanged', e.unchanged, false);
  sendLastModified = true;

  // ---- 5. planNext clamping
  const I = 300_000;
  check('normal ttl waits ttl + pad', planNext({ ttlMs: 232_000 }, { interval: I }), 237_000);
  check('no generation falls back to the fixed interval', planNext(null, { interval: I }), I);
  check('a null ttl falls back to the fixed interval', planNext({ ttlMs: null }, { interval: I }), I);
  check('an already-expired generation is floored, not spun', planNext({ ttlMs: -90_000 }, { interval: I }), 15_000);
  check('a far-future Expires cannot park the worker', planNext({ ttlMs: 9_000_000 }, { interval: I }), 600_000);

  // ---- 6. genOf on a response with no cache headers
  check('genOf tolerates a response with no cache headers', genOf({}), { lastModified: null, ttlMs: null });

  server.close();
  console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
  process.exit(fail ? 1 : 0);
});
