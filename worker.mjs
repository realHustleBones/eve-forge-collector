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
import { snapshot, diff, planNext } from './tape.mjs';
import { makeReader } from './read.mjs';

const ROOT = process.env.DATA_ROOT || process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
const INTERVAL = Number(process.env.INTERVAL_SEC || 300) * 1000;
const LEVELS = Number(process.env.LEVELS || 25);
// Depth retention. Unset, 0, or "forever" keeps every ladder for good; a
// positive number is a rolling window in days. A negative or unparseable value
// means forever too — deleting the archive is not a sane reading of a typo.
const RETAIN_RAW = String(process.env.RETAIN_DAYS ?? '').trim().toLowerCase();
const RETAIN_DEPTH = (RETAIN_RAW === '' || RETAIN_RAW === 'forever' || RETAIN_RAW === 'never')
  ? 0 : (Number(RETAIN_RAW) > 0 ? Number(RETAIN_RAW) : 0);
const PRUNE_DEPTH = RETAIN_DEPTH > 0;
const PORT = Number(process.env.PORT || 3000);
// How long after a generation expires to go looking for the next one. A couple
// of seconds of slack absorbs CDN jitter without polling early, which CCP
// explicitly asks clients not to do.
const PAD = Number(process.env.TICK_PAD_SEC || 5) * 1000;
const MIN_DELAY = Number(process.env.TICK_MIN_SEC || 15) * 1000;

const FILLS = path.join(ROOT, 'fills');
const DEPTH = path.join(ROOT, 'depth');
const TOB = path.join(ROOT, 'data');
const STATE = path.join(ROOT, 'state', 'book.json.gz');
const UNIVERSE = path.join(ROOT, 'universe.json');

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const day = (iso) => iso.slice(0, 10);

let prev = null;               // { ts, book } — held in memory across ticks
let gen = null;                // ESI generation stamp from the last scan
let nextDelayMs = INTERVAL;    // what the scheduler will actually wait
let universe = null;
let ladderHash = new Map();
let tobLast = new Map();
const stats = { started: new Date().toISOString(), ticks: 0, lastTick: null, lastError: null,
                orders: 0, pages: 0, fillsLastTick: 0, unitsLastTick: 0, iskLastTick: 0, fillsToday: 0, today: null,
                lastScan: null, skipped: 0, genLastModified: null, nextDelaySec: null,
                exactLastTick: null, probableLastTick: null, topFillLastTick: null,
                ambLastTick: null, frontLastTick: null, emptyLastTick: null,
                cancelsLastTick: 0, repricesLastTick: 0, expiresLastTick: 0, replacesLastTick: 0 };

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

// ONE definition, used by both the tick and the restart seed. If these two ever
// hashed differently the seed would look like a change and restate everything,
// which is the exact bug it exists to prevent.
const ladderKey = (L) => crypto.createHash('sha1').update(JSON.stringify([L.b, L.a])).digest('hex');

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

function saveState(ts, book, g) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  const o = [...book].map(([id, x]) => [id, x.t, x.p, x.v, x.b ? 1 : 0, x.e]);
  const tmp = STATE + '.tmp';
  // `gen` rides along with the book so a restart can ask "is this still the
  // generation I already have?" in ONE request instead of re-reading 410 pages
  // to rediscover a book it just loaded off the volume.
  fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify({ ts, gen: g || null, o }), { level: 6 }));
  fs.renameSync(tmp, STATE);   // atomic: a crash mid-write can't corrupt the state
}
function loadState() {
  if (!fs.existsSync(STATE)) return null;
  try {
    const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(STATE)).toString('utf8'));
    return {
      ts: j.ts,
      gen: j.gen || null,   // absent in state files written before this existed
      book: new Map(j.o.map((r) => [r[0], { t: r[1], p: r[2], v: r[3], b: !!r[4], e: r[5] }])),
    };
  } catch (e) { log('state unreadable, cold starting:', e.message); return null; }
}

// A restart used to restate every ladder and every top-of-book row — 18,806 of
// each, every time Railway so much as redeployed — because these delta caches
// live only in memory. The resumed book IS what was last written, so rehashing
// it puts the delta encoding back exactly where it left off.
function seedDeltaCaches(book) {
  for (const L of laddersFrom(book)) ladderHash.set(L.i, ladderKey(L));
  for (const [t, v] of topOfBook(book)) tobLast.set(t, `${v.b ?? ''},${v.a ?? ''}`);
}

// Day files sit flat in fills/ and depth/ but under a YYYY-MM directory in
// data/. Walking instead of a flat readdir is what lets maintain() reach the
// top-of-book CSVs at all.
function* dayFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { yield* dayFiles(full); continue; }
    if (/^\d{4}-\d{2}-\d{2}[.]/.test(e.name)) yield full;
  }
}

function maintain(today) {
  let zipped = 0, pruned = 0;
  // A null cutoff is the whole point of PRUNE_DEPTH being off: the loop below
  // already treats null as "keep everything", so forever needs no special case.
  const cutoff = PRUNE_DEPTH
    ? new Date(Date.parse(today) - RETAIN_DEPTH * 86400_000).toISOString().slice(0, 10)
    : null;
  // [dir, extension, prune-before]. Top-of-book used to be missing from this
  // list, so every CSV on the volume stayed uncompressed for good — about five
  // times the bytes it needs, on the one dataset that is never pruned. The
  // reader already opens .csv and .csv.gz interchangeably, so zipping a closed
  // day is invisible to every endpoint.
  for (const [dir, ext, retain] of [[FILLS, 'ndjson', null],
                                    [DEPTH, 'ndjson', cutoff],
                                    [TOB,   'csv',    null]]) {
    for (const full of dayFiles(dir)) {
      const f = path.basename(full), d = f.slice(0, 10);
      if (retain && d < retain) { fs.unlinkSync(full); pruned++; continue; }
      // Only ever zip a day that has closed: the open day is still being
      // appended to, and a .gz beside a live .csv would hide the live one.
      if (f.endsWith(`.${ext}`) && d < today) {
        fs.writeFileSync(full + '.gz', zlib.gzipSync(fs.readFileSync(full), { level: 9 }));
        fs.unlinkSync(full); zipped++;
      }
    }
  }
  return { zipped, pruned };
}

// How much room is left, measured rather than guessed. Railway does not put the
// volume size in the environment, so statfs on the mount point is the only
// honest source; a wrong guess here is worse than no number at all.
function dayBytes(dir) {
  const per = new Map();
  for (const full of dayFiles(dir)) {
    const d = path.basename(full).slice(0, 10);
    try { per.set(d, (per.get(d) || 0) + fs.statSync(full).size); } catch { /* raced maintain */ }
  }
  return per;
}

function diskReport(today) {
  const out = { retainDepthDays: PRUNE_DEPTH ? RETAIN_DEPTH : null };
  let used = 0;
  for (const [k, dir, retain] of [['fills', FILLS, null],
                                  ['depth', DEPTH, PRUNE_DEPTH ? RETAIN_DEPTH : null],
                                  ['tob',   TOB,   null]]) {
    const per = dayBytes(dir);
    const days = [...per.keys()].sort();
    const bytes = [...per.values()].reduce((a, b) => a + b, 0);
    used += bytes;
    // Median of the CLOSED days only: today is a part-day and the open file is
    // not yet compressed, so including it would overstate the daily rate.
    const closed = days.filter((d) => d < today).map((d) => per.get(d)).sort((a, b) => a - b);
    out[k] = {
      mb: +(bytes / 1e6).toFixed(1), days: days.length,
      from: days[0] ?? null, to: days[days.length - 1] ?? null,
      mbPerDay: closed.length ? +(closed[closed.length >> 1] / 1e6).toFixed(2) : null,
      retainDays: retain,
    };
  }
  out.usedMB = +(used / 1e6).toFixed(1);
  try {
    const st = fs.statfsSync(ROOT);
    const total = st.blocks * st.bsize, free = st.bavail * st.bsize;
    out.volumeGB = +(total / 1e9).toFixed(2);
    out.freeGB = +(free / 1e9).toFixed(2);
    out.usedPct = total ? +((1 - free / total) * 100).toFixed(1) : null;
    // With retention off every set grows without a ceiling, and depth is much
    // the largest of the three — so it has to be charged against free space day
    // on day, not treated as something that plateaus.
    const grow = ((out.fills.mbPerDay || 0) + (out.tob.mbPerDay || 0)
                  + (PRUNE_DEPTH ? 0 : (out.depth.mbPerDay || 0))) * 1e6;
    // While a window IS set, depth stops taking new ground once it fills, but
    // until then it is still claiming some — charge that remainder up front.
    const depthLeft = PRUNE_DEPTH
      ? (out.depth.mbPerDay || 0) * 1e6 * Math.max(0, RETAIN_DEPTH - out.depth.days)
      : 0;
    if (grow > 0) out.daysUntilFull = Math.max(0, Math.round((free - depthLeft) / grow));
    out.note = PRUNE_DEPTH
      ? `depth rolls off at ${RETAIN_DEPTH} days; fills and top-of-book are never pruned`
      : 'nothing is pruned — every dataset is kept for good';
  } catch { out.volumeGB = null; out.note = 'statfs unavailable — volume size unknown'; }
  return out;
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

  const snap = await snapshot(gen);
  gen = snap.gen;
  nextDelayMs = planNext(gen, { interval: INTERVAL, pad: PAD, min: MIN_DELAY });
  stats.lastScan = iso; stats.lastError = null;
  stats.genLastModified = gen ? gen.lastModified : null;
  stats.nextDelaySec = Math.round(nextDelayMs / 1000);

  // Same generation as last time: the book is byte-identical, so there is
  // nothing to diff and nothing to write. Cost of finding that out is one page
  // instead of 411.
  if (snap.unchanged) {
    stats.skipped++;
    log(`gen unchanged (${gen.lastModified}) · skipped ${Math.max(snap.pages - 1, 0)} pages · ` +
        `next in ${(nextDelayMs / 1000).toFixed(0)}s · rss ${(process.memoryUsage().rss / 1e6).toFixed(0)}MB`);
    return;
  }

  const { book, pages } = snap;
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
    const h = ladderKey(L);
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
  saveState(iso, book, gen);
  const { zipped, pruned } = maintain(d);
  stats.disk = diskReport(d);

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

  stats.ticks++; stats.lastTick = iso;
  stats.fillsLastTick = all.n; stats.unitsLastTick = all.q; stats.iskLastTick = all.k;
  stats.exactLastTick = ex; stats.probableLastTick = pr;
  stats.ambLastTick = amb; stats.frontLastTick = frt; stats.emptyLastTick = emp;
  stats.cancelsLastTick = cnt('cancel'); stats.repricesLastTick = cnt('reprice'); stats.expiresLastTick = cnt('expire');
  stats.replacesLastTick = cnt('replace');
  stats.topFillLastTick = top ? { i: top.i, p: top.p, q: top.q, s: top.s, c: top.c, isk: top.p * top.q } : null;
  stats.fillsToday += all.n;

  log(`${pages}p ${book.size} orders · fills ${all.n} (${all.q.toLocaleString()}u, ${B(all.k)})` +
      ` [exact ${ex.n} ${B(ex.k)} · amb ${amb.n} ${B(amb.k)} · front ${frt.n} ${B(frt.k)} · empty ${emp.n} ${B(emp.k)}]` +
      ` · cx ${cnt('cancel')} rp ${cnt('reprice')} rr ${cnt('replace')} xp ${cnt('expire')}` +
      (top ? ` · top ${top.i} ${top.q.toLocaleString()}@${top.p.toLocaleString()}=${B(top.p * top.q)}${top.c === 'exact' ? '' : '?'}` : '') +
      ` · depth ${drows.length} · tob ${trows.length}` +
      (zipped ? ` · gz ${zipped}` : '') + (pruned ? ` · pruned ${pruned}` : '') +
      ` · rss ${(process.memoryUsage().rss / 1e6).toFixed(0)}MB · ${((Date.now() - t0) / 1000).toFixed(1)}s` +
      ` · next ${(nextDelayMs / 1000).toFixed(0)}s`);
}

// ------------------------------------------------------------------- main

let running = false, stopping = false, timer = null;

// Self-rescheduling instead of setInterval, because the wait is no longer a
// constant — each tick learns from ESI's own Expires header when the next
// generation is due and sleeps exactly that long. A failed tick falls back to
// the fixed interval rather than hammering.
async function loop() {
  if (running || stopping) return;                 // a slow tick must not overlap the next
  running = true;
  try { await tick(); }
  catch (e) {
    stats.lastError = `${new Date().toISOString()} ${e.message}`;
    log('TICK FAILED', e.message);
    nextDelayMs = INTERVAL;
  } finally {
    running = false;
    // Every write in a tick is synchronous, so once tick() returns the volume is
    // already consistent — no reason to sit out the rest of the shutdown grace.
    if (stopping) { log('tick finished, exiting'); process.exit(0); }
    timer = setTimeout(loop, nextDelayMs);
  }
}

const BOOT = Date.now();

// Liveness is measured on lastScan, NOT lastTick. A run of generations where
// nothing changed is a healthy worker doing its job cheaply; judging it on
// lastTick would kill a process that is working correctly.
const staleAfter = () => Math.max(nextDelayMs, INTERVAL) * 3;

// Railway healthchecks run at DEPLOY time only — nothing polls /health once the
// deploy is live. So the worker has to notice its own death: if no scan has
// landed in 3 intervals, exit non-zero and let restartPolicyType ALWAYS bring
// it back. Without this a wedged process would sit there looking deployed.
setInterval(() => {
  if (!stats.lastScan) return;
  const age = Date.now() - Date.parse(stats.lastScan);
  if (age > staleAfter()) {
    log(`WATCHDOG last scan ${(age / 60000).toFixed(1)}m ago (>3 intervals) — exiting for restart`);
    process.exit(1);
  }
}, Math.min(INTERVAL, 60_000)).unref();

const reader = makeReader({ root: ROOT });

const ENDPOINTS = {
  '/days': 'which days exist, per dataset',
  '/fills': '?type=&day=&from=&to=&conf= — the reconstructed trade tape',
  '/tape': '?type=&day= — volume by price and volume by hour, aggregated',
  '/depth': '?type=&day=[&at=] — ladders: the whole day, or the one nearest a time',
  '/series': '?type=&from=&to= — top of book over time',
  '/raw': '?set=fills|depth|tob&day= — the whole day file, streamed',
};

http.createServer(async (req, res) => {
  // Parse the path so a query string can't defeat the health route.
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://x').pathname; } catch { /* keep '/' */ }

  const stale = !!stats.lastScan && Date.now() - Date.parse(stats.lastScan) > staleAfter();
  // Starting up counts as healthy: the very first scan is a full Forge sweep and
  // the deploy healthcheck would otherwise fail before it finishes.
  const booting = !stats.lastScan && Date.now() - BOOT < INTERVAL * 2;
  const ok = booting || (!!stats.lastScan && !stale);
  if (pathname === '/health') {
    res.writeHead(ok ? 200 : 503, { 'Content-Type': 'text/plain' });
    return res.end(ok ? (booting ? 'booting' : 'ok') : 'stale');
  }

  // Read endpoints get first refusal, ahead of the /status catch-all. A reader
  // blowing up must never take down the collector, so it is fully contained.
  try {
    if (await reader(req, res)) return;
  } catch (e) {
    log('read endpoint failed:', e.message);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: e.message }));
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ...stats, stale, rssMB: +(process.memoryUsage().rss / 1e6).toFixed(0),
                           intervalSec: INTERVAL / 1000, universe: universe ? universe.size : 'all',
                           endpoints: ENDPOINTS, readTokenRequired: !!process.env.READ_TOKEN }, null, 2));
}).listen(PORT, () => log(`http on :${PORT} · schedule from ESI Expires (fallback ${INTERVAL / 1000}s) · data ${ROOT}` +
                          (process.env.READ_TOKEN ? ' · read endpoints require ?k=' : '')));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    log(`${sig} — finishing current tick then exiting`);
    setTimeout(() => process.exit(0), running ? 90_000 : 0);
  });
}

loadUniverse();
prev = loadState();
if (prev) {
  gen = prev.gen;              // lets the first scan be a 1-page probe
  seedDeltaCaches(prev.book);  // stops the first tick restating every ladder
}
log(prev
  ? `resumed from state at ${prev.ts} (${prev.book.size} orders)` +
    (gen ? ` · gen ${gen.lastModified}` : ' · no stored generation, first scan will be full')
  : 'cold start — first tick produces no tape');
await loop();   // loop() reschedules itself off ESI's Expires header
