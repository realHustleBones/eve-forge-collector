// Railway entry point — one long-running worker instead of three cron jobs.
//
// Why a worker and not Railway's cron: a 5-minute cron cold-starts a container
// every run and has to reload the previous book from disk to diff against it.
// That's ~50 MB of JSON parsed 288 times a day for nothing. A resident process
// keeps the previous snapshot in memory and only touches the volume to survive
// a restart.
//
// One scan per tick feeds all three outputs — the same ~300 requests produce the
// tape, the ladders, and the top-of-book row.
//
//   PORT           Railway sets this; serves /health and /status
//   INTERVAL_SEC   default 300. ESI caches the book ~5 min; faster is wasted.
//   DATA_ROOT      default /data — mount the Railway volume here
//
// Everything is public ESI. No credentials live in this process.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import crypto from 'node:crypto';
import { snapshot, diff } from './tape.mjs';

const ROOT = process.env.DATA_ROOT || process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
const INTERVAL = Number(process.env.INTERVAL_SEC || 300) * 1000;
const LEVELS = Number(process.env.LEVELS || 25);
const RETAIN_DEPTH = Number(process.env.RETAIN_DAYS || 90);
const PORT = Number(process.env.PORT || 3000);

const FILLS = path.join(ROOT, 'fills');
const DEPTH = path.join(ROOT, 'depth');
const TOB = path.join(ROOT, 'data');
const STATE = path.join(ROOT, 'state', 'book.json.gz');
const UNIVERSE = path.join(ROOT, 'universe.json');

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const day = (iso) => iso.slice(0, 10);

let prev = null;               // { ts, book } — held in memory across ticks
let universe = null;
let ladderHash = new Map();
let tobLast = new Map();
const stats = { started: new Date().toISOString(), ticks: 0, lastTick: null, lastError: null,
                orders: 0, pages: 0, fillsLastTick: 0, unitsLastTick: 0, iskLastTick: 0, fillsToday: 0, today: null,
                exactLastTick: null, probableLastTick: null, topFillLastTick: null,
                ambLastTick: null, frontLastTick: null, emptyLastTick: null,
                cancelsLastTick: 0, repricesLastTick: 0, expiresLastTick: 0 };

// ---------------------------------------------------------------- ladders

function laddersFrom(book) {
  const byType = new Map();
  for (const o of book.values()) {
    if (universe && !universe.has(o.t)) continue;
    let e = byType.get(o.t);
    if (!e) byType.set(o.t, (e = { bid: new Map(), ask: new Map() }));
    const side = o.b ? e.bid : e.ask;
    const cur = side.get(o.p);
    if (cur) { cur[0] += o.v; cur[1] += 1; } else side.set(o.p, [o.v, 1]);
  }
  const lad = (m, desc) => [...m.entries()]
    .sort((x, y) => (desc ? y[0] - x[0] : x[0] - y[0]))
    .slice(0, LEVELS).map(([p, [v, n]]) => [p, v, n]);
  const out = [];
  for (const [t, s] of byType) out.push({ i: t, b: lad(s.bid, true), a: lad(s.ask, false) });
  return out;
}

function topOfBook(book) {
  const m = new Map();
  for (const o of book.values()) {
    let e = m.get(o.t);
    if (!e) m.set(o.t, (e = { b: null, a: null }));
    if (o.b) { if (e.b === null || o.p > e.b) e.b = o.p; }
    else { if (e.a === null || o.p < e.a) e.a = o.p; }
  }
  return m;
}

// ------------------------------------------------------------------ files

const appendLines = (dir, d, lines) => {
  if (!lines.length) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${d}.ndjson`), lines.join('\n') + '\n');
};

function saveState(ts, book) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  const o = [...book].map(([id, x]) => [id, x.t, x.p, x.v, x.b ? 1 : 0, x.e]);
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify({ ts, o }), { level: 6 }));
  fs.renameSync(tmp, STATE);   // atomic: a crash mid-write can't corrupt the state
}
function loadState() {
  if (!fs.existsSync(STATE)) return null;
  try {
    const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(STATE)).toString('utf8'));
    return { ts: j.ts, book: new Map(j.o.map((r) => [r[0], { t: r[1], p: r[2], v: r[3], b: !!r[4], e: r[5] }])) };
  } catch (e) { log('state unreadable, cold starting:', e.message); return null; }
}

function maintain(today) {
  let zipped = 0, pruned = 0;
  const cutoff = new Date(Date.parse(today) - RETAIN_DEPTH * 86400_000).toISOString().slice(0, 10);
  for (const [dir, retain] of [[FILLS, null], [DEPTH, cutoff]]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const d = f.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      const full = path.join(dir, f);
      if (retain && d < retain) { fs.unlinkSync(full); pruned++; continue; }
      if (f.endsWith('.ndjson') && d < today) {
        fs.writeFileSync(full + '.gz', zlib.gzipSync(fs.readFileSync(full), { level: 9 }));
        fs.unlinkSync(full); zipped++;
      }
    }
  }
  return { zipped, pruned };
}

function loadUniverse() {
  if (!fs.existsSync(UNIVERSE)) { universe = null; return; }
  try {
    const u = JSON.parse(fs.readFileSync(UNIVERSE, 'utf8'));
    universe = new Set((Array.isArray(u) ? u : u.type_ids).map(Number));
    log(`universe: ${universe.size} types`);
  } catch (e) { log('universe.json unreadable:', e.message); }
}

// ------------------------------------------------------------------- tick

async function tick() {
  const t0 = Date.now();
  const iso = new Date().toISOString();
  const d = day(iso);
  if (stats.today !== d) { stats.today = d; stats.fillsToday = 0; loadUniverse(); }

  const { book, pages } = await snapshot();
  stats.orders = book.size; stats.pages = pages;

  // --- tape
  let fills = [], ev = [];
  if (prev) {
    ev = diff(prev.book, book, Date.parse(iso));
    fills = ev.filter((e) => e.k === 'fill');
    appendLines(FILLS, d, fills.map((f) =>
      JSON.stringify({ t: iso, i: f.i, p: f.p, q: f.q, s: f.s, c: f.c, ...(f.r ? { r: f.r } : {}) })));
  }

  // --- depth (only what moved)
  const drows = [];
  for (const L of laddersFrom(book)) {
    const h = crypto.createHash('sha1').update(JSON.stringify([L.b, L.a])).digest('hex');
    if (ladderHash.get(L.i) === h) continue;
    ladderHash.set(L.i, h);
    drows.push(JSON.stringify({ t: iso, i: L.i, b: L.b, a: L.a }));
  }
  appendLines(DEPTH, d, drows);

  // --- top of book (only what moved)
  const tob = topOfBook(book);
  const trows = [];
  for (const [t, v] of tob) {
    const line = `${v.b ?? ''},${v.a ?? ''}`;
    if (tobLast.get(t) === line) continue;
    tobLast.set(t, line);
    trows.push(`${iso},${t},${line}`);
  }
  if (trows.length) {
    const dir = path.join(TOB, d.slice(0, 7));
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${d}.csv`);
    if (!fs.existsSync(f)) fs.writeFileSync(f, 'timestamp,type_id,best_buy,best_sell\n');
    fs.appendFileSync(f, trows.join('\n') + '\n');
  }

  prev = { ts: iso, book };
  saveState(iso, book);
  const { zipped, pruned } = maintain(d);

  // The tape's honesty lives entirely in the exact/probable split.
  //   exact    = volume_remain fell on a surviving order_id. That is an
  //              OBSERVATION; nothing but a trade can do it.
  //   probable = the order_id vanished while at or ahead of the surviving
  //              touch. That is a GUESS. A full fill and a cancel of a
  //              front-of-book order are literally indistinguishable in the
  //              data, and this branch resolves the tie toward 'fill'.
  // So: if probable carries most of the ISK, the tape is mostly inference and
  // the front-of-queue test is what needs tightening, not the plumbing.
  const agg = (xs) => xs.reduce((a, f) => (a.n++, a.q += f.q, a.k += f.p * f.q, a), { n: 0, q: 0, k: 0 });
  const all = agg(fills);
  const ex = agg(fills.filter((f) => f.c === 'exact'));
  const pr = agg(fills.filter((f) => f.c === 'probable'));
  // 'probable' is three different things wearing one label. Ranked by trust:
  //   amb   — order survived, volume fell. The trade is certain; only the price
  //           is ambiguous because it repriced in the same window.
  //   front — order vanished from at or ahead of a live surviving touch.
  //   empty — order vanished and nothing survives on that side, so there was
  //           nothing to compare it to. This is the bucket a plain cancel on a
  //           thin item falls into, and the one that can inflate the tape.
  const amb = agg(fills.filter((f) => f.r === 'amb'));
  const frt = agg(fills.filter((f) => f.r === 'front'));
  const emp = agg(fills.filter((f) => f.r === 'empty'));
  const cnt = (k) => ev.reduce((s, e) => s + (e.k === k ? 1 : 0), 0);
  // One misclassified whale can carry a whole tick's ISK while the average
  // hides it, so name the biggest single inferred fill every tick.
  const top = fills.reduce((bst, f) => (!bst || f.p * f.q > bst.p * bst.q ? f : bst), null);
  const B = (x) => (x / 1e9).toFixed(2) + 'B';

  stats.ticks++; stats.lastTick = iso; stats.lastError = null;
  stats.fillsLastTick = all.n; stats.unitsLastTick = all.q; stats.iskLastTick = all.k;
  stats.exactLastTick = ex; stats.probableLastTick = pr;
  stats.ambLastTick = amb; stats.frontLastTick = frt; stats.emptyLastTick = emp;
  stats.cancelsLastTick = cnt('cancel'); stats.repricesLastTick = cnt('reprice'); stats.expiresLastTick = cnt('expire');
  stats.topFillLastTick = top ? { i: top.i, p: top.p, q: top.q, s: top.s, c: top.c, isk: top.p * top.q } : null;
  stats.fillsToday += all.n;

  log(`${pages}p ${book.size} orders · fills ${all.n} (${all.q.toLocaleString()}u, ${B(all.k)})` +
      ` [exact ${ex.n} ${B(ex.k)} · amb ${amb.n} ${B(amb.k)} · front ${frt.n} ${B(frt.k)} · empty ${emp.n} ${B(emp.k)}]` +
      ` · cx ${cnt('cancel')} rp ${cnt('reprice')} xp ${cnt('expire')}` +
      (top ? ` · top ${top.i} ${top.q.toLocaleString()}@${top.p.toLocaleString()}=${B(top.p * top.q)}${top.c === 'exact' ? '' : '?'}` : '') +
      ` · depth ${drows.length} · tob ${trows.length}` +
      (zipped ? ` · gz ${zipped}` : '') + (pruned ? ` · pruned ${pruned}` : '') +
      ` · rss ${(process.memoryUsage().rss / 1e6).toFixed(0)}MB · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ------------------------------------------------------------------- main

let running = false, stopping = false;
async function loop() {
  if (running || stopping) return;                 // a slow tick must not overlap the next
  running = true;
  try { await tick(); }
  catch (e) { stats.lastError = `${new Date().toISOString()} ${e.message}`; log('TICK FAILED', e.message); }
  finally { running = false; }
}

const BOOT = Date.now();

// Railway healthchecks run at DEPLOY time only — nothing polls /health once the
// deploy is live. So the worker has to notice its own death: if no tick has
// landed in 3 intervals, exit non-zero and let restartPolicyType ALWAYS bring
// it back. Without this a wedged process would sit there looking deployed.
setInterval(() => {
  if (!stats.lastTick) return;
  const age = Date.now() - Date.parse(stats.lastTick);
  if (age > INTERVAL * 3) {
    log(`WATCHDOG last tick ${(age / 60000).toFixed(1)}m ago (>3 intervals) — exiting for restart`);
    process.exit(1);
  }
}, Math.min(INTERVAL, 60_000)).unref();

http.createServer((req, res) => {
  const stale = stats.lastTick && Date.now() - Date.parse(stats.lastTick) > INTERVAL * 3;
  // Starting up counts as healthy: the very first tick is a full Forge scan and
  // the deploy healthcheck would otherwise fail before it finishes.
  const booting = stats.ticks === 0 && Date.now() - BOOT < INTERVAL * 2;
  const ok = booting || (stats.ticks > 0 && !stale);
  if (req.url === '/health') {
    res.writeHead(ok ? 200 : 503, { 'Content-Type': 'text/plain' });
    return res.end(ok ? (booting ? 'booting' : 'ok') : 'stale');
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ...stats, stale, rssMB: +(process.memoryUsage().rss / 1e6).toFixed(0),
                           intervalSec: INTERVAL / 1000, universe: universe ? universe.size : 'all' }, null, 2));
}).listen(PORT, () => log(`health on :${PORT} · interval ${INTERVAL / 1000}s · data ${ROOT}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { stopping = true; log(`${sig} — finishing current tick then exiting`); setTimeout(() => process.exit(0), running ? 90_000 : 0); });
}

loadUniverse();
prev = loadState();
log(prev ? `resumed from state at ${prev.ts} (${prev.book.size} orders)` : 'cold start — first tick produces no tape');
await loop();
setInterval(loop, INTERVAL);
