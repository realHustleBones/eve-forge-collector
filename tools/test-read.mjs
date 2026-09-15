// Tests for read.mjs — the endpoints a dashboard and the MCP server both sit on.
//   node tools/test-read.mjs
//
// Builds a small archive on disk, serves it through the real router, and checks
// the numbers coming back. Also covers the two things that bite in production:
// a day file that has been gzipped because the day closed, and a last line that
// is half-written because the collector is appending while we read.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import net from 'node:net';

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  if (!ok) fail++;
};
const freePort = () => new Promise((res) => {
  const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); });
});

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'read-test-'));
const DAY = '2026-09-15', OLD = '2026-09-14';
const w = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };

// 15614: 100 @ 159900, 50 @ 159900, 25 @ 160000 in hour 10; 10 @ 141900 in hour 11
const FILLS = [
  '{"t":"2026-09-15T10:00:00.000Z","i":15614,"p":159900,"q":100,"s":"a","c":"exact"}',
  '{"t":"2026-09-15T10:05:00.000Z","i":15614,"p":159900,"q":50,"s":"a","c":"exact"}',
  '{"t":"2026-09-15T10:05:00.000Z","i":15614,"p":160000,"q":25,"s":"a","c":"probable","r":"front"}',
  '{"t":"2026-09-15T11:00:00.000Z","i":15614,"p":141900,"q":10,"s":"b","c":"exact"}',
  '{"t":"2026-09-15T11:00:00.000Z","i":28699,"p":90000,"q":7,"s":"b","c":"exact"}',
].join('\n') + '\n';
// the collector appends while we read, so the tail can be a fragment
w(path.join(ROOT, 'fills', `${DAY}.ndjson`), FILLS + '{"t":"2026-09-15T11:05:00.000Z","i":156');
// a closed day is gzipped
w(path.join(ROOT, 'fills', `${OLD}.ndjson.gz`), zlib.gzipSync(
  '{"t":"2026-09-14T09:00:00.000Z","i":15614,"p":158000,"q":3,"s":"a","c":"exact"}\n'));

w(path.join(ROOT, 'depth', `${DAY}.ndjson`), [
  '{"t":"2026-09-15T10:00:00.000Z","i":15614,"b":[[141900,121,1]],"a":[[159900,6,1]]}',
  '{"t":"2026-09-15T10:30:00.000Z","i":15614,"b":[[141800,50,1]],"a":[[159800,10,2]]}',
  '{"t":"2026-09-15T10:30:00.000Z","i":28699,"b":[[90000,5,1]],"a":[]}',
].join('\n') + '\n');

w(path.join(ROOT, 'data', '2026-09', `${DAY}.csv`), [
  'timestamp,type_id,best_buy,best_sell',
  '2026-09-15T10:00:00.000Z,15614,141900,159900',
  '2026-09-15T10:30:00.000Z,28699,90000,',
  '2026-09-15T11:00:00.000Z,15614,141800,159800',
].join('\n') + '\n');

const { makeReader } = await import('../read.mjs');

const serve = async (reader) => {
  const port = await freePort();
  const srv = http.createServer(async (req, res) => {
    if (await reader(req, res)) return;
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"fellthrough":true}');
  });
  await new Promise((r) => srv.listen(port, r));
  return { port, srv, get: async (u) => {
    const r = await fetch(`http://127.0.0.1:${port}${u}`);
    return { status: r.status, body: await r.json() };
  } };
};

const s = await serve(makeReader({ root: ROOT }));
try {
  // ---- /days
  let r = await s.get('/days');
  check('/days lists fills days, gzipped ones included', r.body.fills, [OLD, DAY]);
  check('/days lists depth and top-of-book days', [r.body.depth, r.body.tob], [[DAY], [DAY]]);

  // ---- /fills
  r = await s.get(`/fills?type=15614&day=${DAY}`);
  check('/fills filters to one type', r.body.n, 4);
  check('...and skips the half-written tail instead of dying',
    r.body.fills.at(-1), { t: '2026-09-15T11:00:00.000Z', i: 15614, p: 141900, q: 10, s: 'b', c: 'exact' });
  r = await s.get(`/fills?type=15614&day=${DAY}&from=2026-09-15T10:30:00.000Z`);
  check('/fills honours a from bound', r.body.n, 1);
  r = await s.get(`/fills?type=15614&day=${DAY}&to=2026-09-15T10:04:00.000Z`);
  check('/fills honours a to bound', r.body.n, 1);
  r = await s.get(`/fills?type=15614&day=${DAY}&conf=probable`);
  check('/fills filters by confidence', [r.body.n, r.body.fills[0].r], [1, 'front']);
  r = await s.get(`/fills?type=15614&day=${DAY}&limit=2`);
  check('/fills caps at limit and says so', [r.body.n, r.body.truncated], [2, true]);
  r = await s.get(`/fills?day=${OLD}`);
  check('/fills reads a gzipped closed day', r.body.n, 1);
  r = await s.get('/fills?day=1999-01-01');
  check('/fills on a day with no data is empty, not an error', [r.status, r.body.n], [200, 0]);

  // ---- /tape, the aggregate
  r = await s.get(`/tape?type=15614&day=${DAY}`);
  const t = r.body;
  check('/tape totals units and ISK', [t.n, t.units, t.isk], [4, 185, 29404000]);
  check('/tape vwap is ISK over units', t.vwap, 29404000 / 185);
  check('/tape volume-by-price is sorted and merged',
    t.byPrice, [
      { price: 141900, units: 10, isk: 1419000, fills: 1 },
      { price: 159900, units: 150, isk: 23985000, fills: 2 },
      { price: 160000, units: 25, isk: 4000000, fills: 1 },
    ]);
  check('/tape volume-by-hour buckets correctly',
    t.byHour, [
      { hour: '10', units: 175, isk: 27985000, fills: 3 },
      { hour: '11', units: 10, isk: 1419000, fills: 1 },
    ]);
  check('/tape splits by resting side', t.side, { a: 175, b: 10 });
  check('/tape censuses confidence AND reason', t.conf, { exact: 3, 'probable:front': 1 });
  check('/tape reports the window it actually covered',
    [t.first, t.last], ['2026-09-15T10:00:00.000Z', '2026-09-15T11:00:00.000Z']);
  r = await s.get(`/tape?day=${DAY}`);
  check('/tape without a type is a 400, not a whole-market scan', [r.status, r.body.error], [400, 'type is required']);

  // ---- /depth
  r = await s.get(`/depth?type=15614&day=${DAY}`);
  check('/depth returns the day series for one type', r.body.n, 2);
  r = await s.get(`/depth?type=15614&day=${DAY}&at=2026-09-15T10:15:00.000Z`);
  check('/depth?at= returns the ladder in force at that moment', r.body.ladder.t, '2026-09-15T10:00:00.000Z');
  r = await s.get(`/depth?type=15614&day=${DAY}&at=2026-09-15T23:59:00.000Z`);
  check('...and the latest one when asked past the end', r.body.ladder.t, '2026-09-15T10:30:00.000Z');

  // ---- /series
  r = await s.get(`/series?type=15614&from=${DAY}&to=${DAY}`);
  check('/series reads top of book for one type', r.body.n, 2);
  check('...carrying prices through as numbers', r.body.series[1], { t: '2026-09-15T11:00:00.000Z', buy: 141800, sell: 159800 });
  r = await s.get(`/series?type=28699&from=${DAY}&to=${DAY}`);
  check('...and an empty side reads as null, not zero', r.body.series[0].sell, null);

  // ---- /raw
  const raw = await fetch(`http://127.0.0.1:${s.port}/raw?set=fills&day=${DAY}`);
  check('/raw streams the day file as a download',
    [raw.status, raw.headers.get('content-disposition').includes(`fills-${DAY}`)], [200, true]);

  // ---- routing
  r = await s.get('/status');
  check('an unknown path falls through to the worker, not the reader', r.body.fellthrough, true);
} finally { s.srv.close(); }

// ---- READ_TOKEN
process.env.READ_TOKEN = 'sekrit';
const s2 = await serve(makeReader({ root: ROOT }));
try {
  let r = await s2.get(`/fills?day=${DAY}`);
  check('READ_TOKEN blocks an unauthenticated read', r.status, 401);
  r = await s2.get(`/fills?day=${DAY}&k=wrong`);
  check('...and a wrong one', r.status, 401);
  r = await s2.get(`/fills?day=${DAY}&k=sekrit`);
  check('...and lets the right one through', r.status, 200);
  r = await s2.get('/status?k=sekrit');
  check('...without swallowing paths it does not own', r.body.fellthrough, true);
} finally { s2.srv.close(); }

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
process.exit(fail ? 1 : 0);
