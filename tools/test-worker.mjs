// End-to-end test for worker.mjs — the thing Railway actually runs.
//   node tools/test-worker.mjs
//
// Boots the real worker against a fake in-process ESI and drives it through the
// sequence that matters in production: cold start, an unchanged generation, a
// generation that really moved, and — the expensive one — a RESTART, which has
// to resume from the volume, reuse the stored generation instead of re-reading
// every page, and not restate every ladder just because the process bounced.
//
// The fake ESI serves ONE order per page on purpose, so "probed one page" and
// "scanned the whole book" are different request counts and the test can tell
// them apart.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  if (!ok) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => {
  const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); });
});

const JITA = 60003760;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-test-'));
const DAY = new Date().toISOString().slice(0, 10);
const STATE_FILE = path.join(ROOT, 'state', 'book.json.gz');
const depthFile = path.join(ROOT, 'depth', `${DAY}.ndjson`);
const tobFile = path.join(ROOT, 'data', DAY.slice(0, 7), `${DAY}.csv`);
const countLines = (f) => (fs.existsSync(f)
  ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).length : 0);

// two types, so "restated everything" (2 ladders) and "only what moved" (1) differ
const ord = (id, type, price, vol, buy) => ({
  order_id: id, type_id: type, location_id: JITA, is_buy_order: buy,
  price, volume_remain: vol, issued: '2026-09-15T00:00:00Z', duration: 90,
});
let book = [ord(1, 15614, 159900, 664, false), ord(2, 15614, 163500, 29, false), ord(3, 28699, 92020, 100, true)];

let stamp = 0;
const lm = () => `Mon, 15 Sep 2026 22:${String(stamp).padStart(2, '0')}:00 GMT`;
let esiHits = 0;

const esi = http.createServer((req, res) => {
  esiHits++;
  const page = Number(new URL(req.url, 'http://x').searchParams.get('page') || 1);
  res.writeHead(200, {
    'Content-Type': 'application/json', 'x-pages': String(book.length),   // 1 order per page
    'last-modified': lm(),
    date: 'Mon, 15 Sep 2026 22:00:00 GMT',
    expires: 'Mon, 15 Sep 2026 22:00:01 GMT',   // 1s ttl, so the floor governs
  });
  res.end(JSON.stringify(book.slice(page - 1, page)));
});

const status = async (p) => (await fetch(`http://127.0.0.1:${p}/status`)).json();
const get = async (p, route) => (await fetch(`http://127.0.0.1:${p}${route}`)).json();
const health = async (p) => { const r = await fetch(`http://127.0.0.1:${p}/health`); return [r.status, await r.text()]; };
const waitFor = async (fn, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* not up yet */ }
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for the worker');
    await sleep(120);
  }
};

let proc = null, logs = '';
const boot = async (esiPort) => {
  const port = await freePort();
  logs = '';
  proc = spawn(process.execPath, ['worker.mjs'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, ESI_BASE: `http://127.0.0.1:${esiPort}`, DATA_ROOT: ROOT,
           PORT: String(port), INTERVAL_SEC: '2', TICK_MIN_SEC: '1', TICK_PAD_SEC: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => { logs += d; });
  proc.stderr.on('data', (d) => { logs += d; });
  return port;
};
const stop = async () => {
  proc.kill('SIGTERM');
  const t0 = Date.now();
  while (proc.exitCode === null && proc.signalCode === null && Date.now() - t0 < 6000) await sleep(80);
  await sleep(250);
};

esi.listen(0, async () => {
  const esiPort = esi.address().port;
  try {
    // ---- cold start
    let port = await boot(esiPort);
    let st = await waitFor(async () => { const s = await status(port); return s.ticks >= 1 ? s : null; });
    check('cold start scans and records the book', st.orders, 3);
    check('...produces no tape, having nothing to diff', st.fillsLastTick, 0);
    check('...remembers the generation', st.genLastModified, lm());
    check('...and writes a ladder for both types', countLines(depthFile), 2);
    check('health is ok once a scan has landed', await health(port), [200, 'ok']);

    // ---- unchanged generation: one request, no tick
    let hits = esiHits;
    st = await waitFor(async () => { const s = await status(port); return s.skipped >= 1 ? s : null; });
    check('an unchanged generation is skipped', st.skipped >= 1, true);
    check('...without counting as a tick', st.ticks, 1);
    check('...logging its reason', logs.includes('gen unchanged'), true);
    check('...and costing one request, not a whole book', esiHits - hits <= st.skipped + 1, true);

    // ---- a generation that really moved
    book = [ord(1, 15614, 159900, 6, false), ord(2, 15614, 163500, 29, false), ord(3, 28699, 92020, 100, true)];
    stamp = 5;
    st = await waitFor(async () => { const s = await status(port); return s.ticks >= 2 ? s : null; });
    check('a moved generation produces a tick', [st.fillsLastTick, st.unitsLastTick], [1, 658]);
    check('...and only the ladder that moved is written', countLines(depthFile), 3);
    check('...and the fill lands in the fills file',
      JSON.parse(fs.readFileSync(path.join(ROOT, 'fills', `${DAY}.ndjson`), 'utf8').trim().split('\n').pop()).q, 658);

    const stored = JSON.parse(zlib.gunzipSync(fs.readFileSync(STATE_FILE)).toString('utf8'));
    check('the state file carries the generation stamp', stored.gen.lastModified, lm());

    // ---- RESTART. Nothing changed while we were down.
    const depthAtStop = countLines(depthFile), tobAtStop = countLines(tobFile);
    await stop();
    hits = esiHits;
    port = await boot(esiPort);
    await waitFor(async () => { const s = await status(port); return s.lastScan ? s : null; });
    check('a restart resumes from the volume, not a cold start',
      [logs.includes('resumed from state'), logs.includes('cold start')], [true, false]);
    check('...and says which generation it resumed on', logs.includes(`gen ${lm()}`), true);
    check('...so the first scan is a one-page probe, not the whole book', esiHits - hits, 1);
    check('...and restates nothing', [countLines(depthFile), countLines(tobFile)], [depthAtStop, tobAtStop]);

    // ---- now move ONE type. Only that type may be restated.
    book = [ord(1, 15614, 159900, 6, false), ord(2, 15614, 163500, 29, false), ord(3, 28699, 92020, 90, true)];
    stamp = 9;
    await waitFor(async () => (countLines(depthFile) > depthAtStop ? true : null));
    await sleep(300);
    check('after a restart only the changed ladder writes, not every ladder',
      countLines(depthFile) - depthAtStop, 1);
    // Top of book stores PRICE only, and that volume move left the best bid at
    // 92020 — so the correct number of new rows here is zero. If the seeding
    // were broken this would be 2, one restated row per type.
    check('...and a volume-only move writes no top-of-book row at all',
      countLines(tobFile) - tobAtStop, 0);

    // Now move the PRICE, which top of book does track. One row, not two.
    book = [ord(1, 15614, 159900, 6, false), ord(2, 15614, 163500, 29, false), ord(3, 28699, 92500, 90, true)];
    stamp = 13;
    await waitFor(async () => (countLines(tobFile) > tobAtStop ? true : null));
    await sleep(300);
    check('...while a price move writes exactly the one type that moved',
      countLines(tobFile) - tobAtStop, 1);

    // ---- closed days get compressed, top of book included
    // The CSVs live under data/YYYY-MM/ and maintain() used to read only the two
    // flat directories, so a volume's top-of-book was never zipped and never
    // pruned: the one dataset kept forever was also the one kept at full size.
    const YDAY = new Date(Date.parse(DAY) - 86400_000).toISOString().slice(0, 10);
    const yTob = path.join(ROOT, 'data', YDAY.slice(0, 7), `${YDAY}.csv`);
    const yFills = path.join(ROOT, 'fills', `${YDAY}.ndjson`);
    fs.mkdirSync(path.dirname(yTob), { recursive: true });
    fs.mkdirSync(path.dirname(yFills), { recursive: true });
    fs.writeFileSync(yTob, 'timestamp,type_id,best_buy,best_sell\n'
      + `${YDAY}T12:00:00.000Z,28699,88200,94900\n`);
    fs.writeFileSync(yFills, JSON.stringify(
      { t: `${YDAY}T12:00:00.000Z`, i: 28699, p: 94880, q: 3678, s: 'a', c: 'exact' }) + '\n');

    book = [ord(1, 15614, 159700, 6, false), ord(2, 15614, 163500, 29, false), ord(3, 28699, 92600, 90, true)];
    stamp = 14;
    await waitFor(async () => (fs.existsSync(`${yTob}.gz`) ? true : null));
    check('a closed top-of-book day gets compressed', fs.existsSync(yTob), false);
    check('...and so does a closed fills day',
      [fs.existsSync(`${yFills}.gz`), fs.existsSync(yFills)], [true, false]);
    check("...and today's open file is left alone", fs.existsSync(tobFile), true);
    // The reader merges the volume with the repo's own shipped data/, which has
    // real rows for this day too, so look for OUR row rather than the first one.
    const zipped = await get(port, `/series?type=28699&from=${YDAY}&to=${YDAY}`);
    const afterZip = (await status(port)).lastScan;
    check('...and the reader still serves the day it just zipped',
      zipped.series?.some((r) => r.t === `${YDAY}T12:00:00.000Z` && r.sell === 94900), true);

    // ---- depth is kept forever
    // An ancient depth day is the whole test: under the old rolling window this
    // file was deleted on the first tick that saw it, silently and for good.
    const OLD = '2020-01-01';
    const oldDepth = path.join(ROOT, 'depth', `${OLD}.ndjson.gz`);
    fs.writeFileSync(oldDepth, zlib.gzipSync(JSON.stringify(
      { t: `${OLD}T00:00:00.000Z`, i: 28699, b: [[1, 1, 1]], a: [[2, 1, 1]] }) + '\n'));
    book = [ord(1, 15614, 159600, 6, false), ord(2, 15614, 163500, 29, false), ord(3, 28699, 92700, 90, true)];
    stamp = 15;
    await waitFor(async () => ((await status(port)).lastScan > afterZip ? true : null));
    check('a depth day from years ago is still there after a tick', fs.existsSync(oldDepth), true);

    // ---- the volume is measured, not guessed
    const disk = (await status(port)).disk;
    check('status reports bytes per dataset',
      [typeof disk.fills.mb, typeof disk.depth.mb, typeof disk.tob.mb],
      ['number', 'number', 'number']);
    check('...and how big the volume actually is', disk.volumeGB > 0, true);
    check('...and which sets are never pruned, so growth is attributable',
      [disk.fills.retainDays, disk.tob.retainDays], [null, null]);
    check('...and a closed day gives a measured per-day rate', disk.tob.mbPerDay !== null, true);
    check('...and reports depth as kept for good, not on a window',
      [disk.retainDepthDays, disk.depth.retainDays], [null, null]);
    check('...and counts depth against free space, since it no longer plateaus',
      disk.note.includes('nothing is pruned'), true);

    // ---- a state file from before `gen` existed must still load
    await stop();
    const old = JSON.parse(zlib.gunzipSync(fs.readFileSync(STATE_FILE)).toString('utf8'));
    delete old.gen;
    fs.writeFileSync(STATE_FILE, zlib.gzipSync(JSON.stringify(old)));
    hits = esiHits;
    port = await boot(esiPort);
    await waitFor(async () => { const s = await status(port); return s.lastScan ? s : null; });
    check('a pre-existing state file with no generation still resumes',
      logs.includes('no stored generation'), true);
    check('...and falls back to scanning the whole book', esiHits - hits, 3);
  } finally {
    if (proc) proc.kill('SIGKILL');
    esi.close();
    fs.rmSync(ROOT, { recursive: true, force: true });
  }

  console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
  process.exit(fail ? 1 : 0);
});
