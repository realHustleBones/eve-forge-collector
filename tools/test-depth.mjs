// Offline test for depth.mjs — fake in-process ESI, no network.
//   node tools/test-depth.mjs

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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'depth-test-'));
const PER_PAGE = 1000;

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  if (!ok) fail++;
};

let orders = [];
const reset = () => {
  orders = [
    // type 100 — two orders share 95, so they must merge to [95, 12, 2]
    { type_id: 100, location_id: JITA, is_buy_order: true,  price: 95, volume_remain: 5 },
    { type_id: 100, location_id: JITA, is_buy_order: true,  price: 95, volume_remain: 7 },
    { type_id: 100, location_id: JITA, is_buy_order: true,  price: 90, volume_remain: 3 },
    { type_id: 100, location_id: JITA, is_buy_order: false, price: 110, volume_remain: 4 },
    { type_id: 100, location_id: JITA, is_buy_order: false, price: 105, volume_remain: 9 },
    { type_id: 100, location_id: ELSEWHERE, is_buy_order: false, price: 1, volume_remain: 99 },
    // type 200 — in the book but NOT in the universe, must be skipped
    { type_id: 200, location_id: JITA, is_buy_order: true, price: 50, volume_remain: 2 },
  ];
  // type 300 — 40 ask levels, to exercise the LEVELS cap
  for (let k = 0; k < 40; k++) {
    orders.push({ type_id: 300, location_id: JITA, is_buy_order: false, price: 1000 + k, volume_remain: 1 });
  }
  for (let i = 0; i < 1200; i++) {
    orders.push({ type_id: 5000 + i, location_id: JITA, is_buy_order: true, price: 10 + i, volume_remain: 1 });
  }
};
reset();

const server = http.createServer((req, res) => {
  const page = Number(new URL(req.url, 'http://x').searchParams.get('page') || 1);
  const pages = Math.max(1, Math.ceil(orders.length / PER_PAGE));
  res.writeHead(200, { 'Content-Type': 'application/json', 'x-pages': String(pages) });
  res.end(JSON.stringify(orders.slice((page - 1) * PER_PAGE, page * PER_PAGE)));
});

const readDay = (day) => {
  const f = path.join(TMP, 'depth', `${day}.ndjson`);
  const text = fs.existsSync(f)
    ? fs.readFileSync(f, 'utf8')
    : zlib.gunzipSync(fs.readFileSync(f + '.gz')).toString('utf8');
  return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const latest = (day, id) => {
  const r = readDay(day).filter((o) => o.i === id);
  return r.length ? r[r.length - 1] : null;
};

server.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const root = path.resolve(import.meta.dirname, '..');
  const uni = path.join(TMP, 'universe.json');
  fs.writeFileSync(uni, JSON.stringify({ type_ids: [100, 300, ...Array.from({ length: 1200 }, (_, i) => 5000 + i)] }));

  const run = () =>
    execFileAsync(process.execPath, ['depth.mjs'], {
      env: { ...process.env, ESI_BASE: base, DEPTH_DIR: path.join(TMP, 'depth'),
             UNIVERSE_FILE: uni, CONCURRENCY: '6', LEVELS: '25', RETAIN_DAYS: '2' },
      cwd: root, encoding: 'utf8',
    });
  const today = new Date().toISOString().slice(0, 10);

  await run();
  const t100 = latest(today, 100);
  check('orders at the same price merge', t100.b[0], [95, 12, 2]);
  check('bids run high to low', t100.b.map((l) => l[0]), [95, 90]);
  check('asks run low to high', t100.a.map((l) => l[0]), [105, 110]);
  check('non-Jita orders excluded', t100.a.some((l) => l[0] === 1), false);
  check('types outside the universe skipped', latest(today, 200), null);
  check('ladder capped at LEVELS per side', latest(today, 300).a.length, 25);
  check('cap keeps the BEST levels', latest(today, 300).a[0][0], 1000);
  const n1 = readDay(today).length;
  check('one row per universe type on a cold start', n1, 1202);

  await run();
  check('unchanged ladders write nothing', readDay(today).length, n1);

  orders.push({ type_id: 100, location_id: JITA, is_buy_order: true, price: 99, volume_remain: 1 });
  await run();
  check('a changed ladder writes one row', readDay(today).length - n1, 1);
  check('the new level is on top', latest(today, 100).b[0], [99, 1, 1]);

  // retention: a file older than RETAIN_DAYS goes away, a finished recent day gzips
  const old = new Date(Date.now() - 5 * 86400_000).toISOString().slice(0, 10);
  const yday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  fs.writeFileSync(path.join(TMP, 'depth', `${old}.ndjson`), '{}\n');
  fs.writeFileSync(path.join(TMP, 'depth', `${yday}.ndjson`), '{"t":"x","i":1,"b":[],"a":[]}\n');
  await run();
  check('files past RETAIN_DAYS are pruned', fs.existsSync(path.join(TMP, 'depth', `${old}.ndjson`)), false);
  check('finished days are gzipped', fs.existsSync(path.join(TMP, 'depth', `${yday}.ndjson.gz`)), true);

  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
  process.exit(fail ? 1 : 0);
});
