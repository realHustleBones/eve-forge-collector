// End-to-end test for worker.mjs — the thing Railway actually runs.
//   node tools/test-worker.mjs
//
// Boots the real worker against a fake in-process ESI and drives it through the
// sequence that matters in production: cold start, an unchanged generation, a
// generation that really moved, and a restart that has to resume from the
// volume rather than re-cold-starting and punching a hole in the tape.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
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

// two resting asks on one type
let book = [
  { order_id: 1, type_id: 15614, location_id: JITA, is_buy_order: false, price: 159900, volume_remain: 664, issued: '2026-09-15T00:00:00Z', duration: 90 },
  { order_id: 2, type_id: 15614, location_id: JITA, is_buy_order: false, price: 163500, volume_remain: 29,  issued: '2026-09-15T00:00:00Z', duration: 90 },
];
let stamp = 0;
const lm = () => `Mon, 15 Sep 2026 ${String(22 + Math.floor(stamp / 60)).padStart(2, '0')}:${String(stamp % 60).padStart(2, '0')}:00 GMT`;
let esiHits = 0;

const esi = http.createServer((req, res) => {
  esiHits++;
  res.writeHead(200, {
    'Content-Type': 'application/json', 'x-pages': '1',
    'last-modified': lm(),
    date: 'Mon, 15 Sep 2026 22:00:00 GMT',
    expires: 'Mon, 15 Sep 2026 22:00:01 GMT',   // 1s ttl -> the floor governs
  });
  res.end(JSON.stringify(book));
});

const status = async (port) => (await fetch(`http://127.0.0.1:${port}/status`)).json();
const health = async (port) => {
  const r = await fetch(`http://127.0.0.1:${port}/health`);
  return [r.status, (await r.text())];
};

const waitFor = async (fn, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* not up yet */ }
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for the worker');
    await sleep(150);
  }
};

const boot = (port, esiPort) => spawn(process.execPath, ['worker.mjs'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, ESI_BASE: `http://127.0.0.1:${esiPort}`, DATA_ROOT: ROOT,
         PORT: String(port), INTERVAL_SEC: '2', TICK_MIN_SEC: '1', TICK_PAD_SEC: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

esi.listen(0, async () => {
  const esiPort = esi.address().port;
  const port = await freePort();
  let w = boot(port, esiPort);
  const logs = [];
  w.stdout.on('data', (d) => logs.push(d.toString()));
  w.stderr.on('data', (d) => logs.push(d.toString()));

  try {
    // ---- cold start
    let st = await waitFor(async () => { const s = await status(port); return s.ticks >= 1 ? s : null; });
    check('cold start scans and records the book', st.orders, 2);
    check('...and produces no tape, having nothing to diff', st.fillsLastTick, 0);
    check('...and remembers the generation', st.genLastModified, lm());
    check('health is ok once a scan has landed', await health(port), [200, 'ok']);

    // ---- unchanged generation: must skip, not re-scan, and not invent a tick
    const hitsBefore = esiHits;
    st = await waitFor(async () => { const s = await status(port); return s.skipped >= 1 ? s : null; });
    check('an unchanged generation is skipped', st.skipped >= 1, true);
    check('...without counting as a tick', st.ticks, 1);
    check('...and the skip logged its reason', logs.join('').includes('gen unchanged'), true);
    check('...costing at most one request per skip', esiHits - hitsBefore <= st.skipped + 1, true);

    // ---- a generation that really moved: 658 units off the front ask
    book = [
      { order_id: 1, type_id: 15614, location_id: JITA, is_buy_order: false, price: 159900, volume_remain: 6, issued: '2026-09-15T00:00:00Z', duration: 90 },
      { order_id: 2, type_id: 15614, location_id: JITA, is_buy_order: false, price: 163500, volume_remain: 29, issued: '2026-09-15T00:00:00Z', duration: 90 },
    ];
    stamp = 5;
    st = await waitFor(async () => { const s = await status(port); return s.ticks >= 2 ? s : null; });
    check('a moved generation produces a tick', st.ticks >= 2, true);
    check('...and the fill is exact, 658 units', [st.fillsLastTick, st.unitsLastTick], [1, 658]);
    check('...and lands in the fills file', (() => {
      const d = new Date().toISOString().slice(0, 10);
      const f = path.join(ROOT, 'fills', `${d}.ndjson`);
      return fs.existsSync(f) && JSON.parse(fs.readFileSync(f, 'utf8').trim().split('\n').pop()).q;
    })(), 658);

    // ---- restart: must resume from the volume, not cold start
    w.kill('SIGTERM');
    await waitFor(async () => w.exitCode !== null || w.killed, 5000).catch(() => {});
    await sleep(400);
    const port2 = await freePort();
    w = boot(port2, esiPort);
    const logs2 = [];
    w.stdout.on('data', (d) => logs2.push(d.toString()));
    await waitFor(async () => { const s = await status(port2); return s.lastScan ? s : null; });
    check('a restart resumes from the volume instead of cold starting',
      [logs2.join('').includes('resumed from state'), logs2.join('').includes('cold start')], [true, false]);
  } finally {
    w.kill('SIGKILL');
    esi.close();
    fs.rmSync(ROOT, { recursive: true, force: true });
  }

  console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
  process.exit(fail ? 1 : 0);
});
