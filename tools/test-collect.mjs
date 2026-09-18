// Offline test for collect.mjs — serves a fake ESI so the collector can be
// verified without touching the real API.
//
//   node tools/test-collect.mjs
//
// Checks: pagination via x-pages, best-bid/best-ask reduction, the Jita-only
// filter, delta encoding across runs, the yesterday lookback, and gzipping of
// completed days.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const JITA = 60003760;
const ELSEWHERE = 60003757;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'collect-test-'));
const PER_PAGE = 1000;
// item 100 + item 200 + 2600 padded items. Item 300 has no Jita order, so it is
// correctly absent from the output and must NOT be counted.
const ITEMS = 2 + 2600;

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  if (!ok) fail++;
};

// --- fake market ------------------------------------------------------------
// item 100: bids 90/95/92 -> best 95 ; asks 110/105 -> best 105
// item 200: only a bid at Jita, asks are all ELSEWHERE -> ask must be blank
// item 300: orders only at ELSEWHERE -> must not appear at all
let orders = [];
const reset = () => {
  orders = [
    { type_id: 100, location_id: JITA, is_buy_order: true, price: 90 },
    { type_id: 100, location_id: JITA, is_buy_order: true, price: 95 },
    { type_id: 100, location_id: JITA, is_buy_order: true, price: 92 },
    { type_id: 100, location_id: JITA, is_buy_order: false, price: 110 },
    { type_id: 100, location_id: JITA, is_buy_order: false, price: 105 },
    { type_id: 100, location_id: ELSEWHERE, is_buy_order: false, price: 1 }, // must be ignored
    { type_id: 200, location_id: JITA, is_buy_order: true, price: 50 },
    { type_id: 200, location_id: ELSEWHERE, is_buy_order: false, price: 60 },
    { type_id: 300, location_id: ELSEWHERE, is_buy_order: true, price: 5 },
  ];
  // pad so the book spans several pages and exercises the pagination pool
  for (let i = 0; i < 2600; i++) {
    orders.push({ type_id: 1000 + i, location_id: JITA, is_buy_order: true, price: 10 + i });
    orders.push({ type_id: 1000 + i, location_id: JITA, is_buy_order: false, price: 20 + i });
  }
};
reset();

// When true the fake ESI kills the socket instead of answering, which is what
// a transport failure looks like from Node's fetch: it throws, and the reason
// only exists on e.cause.
let killSockets = false;

const server = http.createServer((req, res) => {
  if (killSockets) { req.destroy(); return; }
  const page = Number(new URL(req.url, 'http://x').searchParams.get('page') || 1);
  const pages = Math.max(1, Math.ceil(orders.length / PER_PAGE));
  const slice = orders.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  res.writeHead(200, { 'Content-Type': 'application/json', 'x-pages': String(pages) });
  res.end(JSON.stringify(slice));
});

const rows = (day) => {
  const f = path.join(TMP, day.slice(0, 7), `${day}.csv`);
  const text = fs.existsSync(f)
    ? fs.readFileSync(f, 'utf8')
    : zlib.gunzipSync(fs.readFileSync(f + '.gz')).toString('utf8');
  return text.trim().split('\n').slice(1).filter(Boolean);
};
const cell = (day, id) => {
  const r = rows(day).filter((l) => l.split(',')[1] === String(id));
  return r.length ? r[r.length - 1].split(',').slice(2).join(',') : null;
};

server.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  // must be async: execFileSync would block the event loop serving the fake ESI
  const run = () =>
    execFileAsync(process.execPath, ['collect.mjs'], {
      env: { ...process.env, ESI_BASE: base, DATA_DIR: TMP, CONCURRENCY: '6' },
      cwd: path.resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
    });
  const today = new Date().toISOString().slice(0, 10);

  // ---- a dropped connection must say WHY, not just "HTTP 0"
  // A whole GitHub Actions run died on `FATAL page 1 failed: HTTP 0` with the
  // cause swallowed by a bare catch. The status is not the diagnosis.
  killSockets = true;
  // execFile repeats stderr inside e.message, so count attempts on stderr alone.
  let dropped = null, droppedErr = '';
  try { await run(); } catch (e) { droppedErr = e.stderr || ''; dropped = `${droppedErr}${e.message}`; }
  killSockets = false;
  check('a dropped connection fails the run', dropped !== null, true);
  check('...and the FATAL line carries the transport error, not a bare HTTP 0',
    /page 1 failed: HTTP 0 \u2014 \S/.test(dropped || ''), true);
  check('...naming the socket-level cause', /ECONNRESET|ECONNREFUSED|UND_ERR|socket/i.test(dropped || ''), true);
  check('...and each attempt is logged, so a flap is distinguishable from a hard outage',
    (droppedErr.match(/attempt \d+\/\d+ threw/g) || []).length, 4);

  // ---- run 1: everything is new
  await run();
  const r1 = rows(today);
  check('run 1 writes every item once', r1.length, ITEMS);
  check('best bid is the HIGHEST buy at Jita', cell(today, 100), '95,105');
  check('missing ask side is left blank', cell(today, 200), '50,');
  check('items with no Jita order are excluded', cell(today, 300), null);

  // ---- run 2: nothing moved
  await run();
  check('run 2 writes nothing when unchanged', rows(today).length, ITEMS);

  // ---- run 3: one item moves
  orders.push({ type_id: 100, location_id: JITA, is_buy_order: true, price: 99 });
  await run();
  const r3 = rows(today);
  check('run 3 writes only the item that moved', r3.length - ITEMS, 1);
  check('the new best bid is recorded', cell(today, 100), '99,105');

  // ---- yesterday lookback + gzip of completed days
  const y = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  fs.mkdirSync(path.join(TMP, y.slice(0, 7)), { recursive: true });
  fs.writeFileSync(
    path.join(TMP, y.slice(0, 7), `${y}.csv`),
    'timestamp,type_id,best_buy,best_sell\n' + `${y}T00:00:00.000Z,100,99,105\n`
  );
  fs.rmSync(path.join(TMP, today.slice(0, 7), `${today}.csv`), { force: true });
  await run();
  check(
    'state carries over from yesterday (item 100 not rewritten)',
    rows(today).some((l) => l.split(',')[1] === '100'),
    false
  );
  check(
    'completed days are gzipped',
    fs.existsSync(path.join(TMP, y.slice(0, 7), `${y}.csv.gz`)) &&
      !fs.existsSync(path.join(TMP, y.slice(0, 7), `${y}.csv`)),
    true
  );

  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
  process.exit(fail ? 1 : 0);
});
