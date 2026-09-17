// TIER 2 — full order-book ladders for the liquid universe, every 5 minutes.
//
// Same single pass over the Forge book that collect.mjs makes (~300 requests),
// but instead of reducing each item to two numbers it keeps the whole Jita
// ladder. This is the heatmap feed.
//
// Run from a persistent host (cron / systemd timer / Task Scheduler), NOT from
// GitHub Actions — scheduled runs there get throttled and dropped well before
// 5-minute cadence. ESI caches the order book ~5 min, so polling faster than
// that returns byte-identical data; 5 minutes is the real ceiling.
//
// Output: depth/YYYY-MM-DD.ndjson  (gzipped once the day is done)
//   {"t":"2026-09-15T16:05:00.000Z","i":15614,
//    "b":[[141800,1784,1],[141600,177,1],...],
//    "a":[[163700,7,1],[163800,150,1],...]}
//   price, volume, order-count per level; bids high→low, asks low→high.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const FORGE = 10000002;
const JITA = 60003760;
const ESI = process.env.ESI_BASE || 'https://esi.evetech.net/latest';
const UA = process.env.ESI_UA || 'eve-forge-collector depth (set ESI_UA to your contact)';
const CONCURRENCY = Number(process.env.CONCURRENCY || 12);
const DEPTH_DIR = process.env.DEPTH_DIR || 'depth';
const UNIVERSE = process.env.UNIVERSE_FILE || 'universe.json';
const LEVELS = Number(process.env.LEVELS || 25);      // per side, like ESI's own cap
// Same rule as worker.mjs: unset / 0 / "forever" keeps everything.
const RETAIN_RAW = String(process.env.RETAIN_DAYS ?? '').trim().toLowerCase();
const RETAIN_DAYS = (RETAIN_RAW === '' || RETAIN_RAW === 'forever' || RETAIN_RAW === 'never')
  ? 0 : (Number(RETAIN_RAW) > 0 ? Number(RETAIN_RAW) : 0);
const RETRIES = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(`[${new Date().toISOString()}]`, ...a);

let errorBudgetPause = 0;

async function getPage(page) {
  const url = `${ESI}/markets/${FORGE}/orders/?order_type=all&page=${page}`;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    if (errorBudgetPause > Date.now()) await sleep(errorBudgetPause - Date.now());
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
      // Number(null) === 0 — an ABSENT header must be checked explicitly or every
      // response looks like a blown error budget. (Cost us a 61s sleep per request.)
      const raw = r.headers.get('x-esi-error-limit-remain');
      const remain = raw === null ? NaN : Number(raw);
      if (Number.isFinite(remain) && remain < 20) {
        const reset = Number(r.headers.get('x-esi-error-limit-reset') || 60);
        errorBudgetPause = Date.now() + (reset + 1) * 1000;
        log(`error budget low (${remain}); pausing ${reset}s`);
      }
      if (r.status === 420 || r.status === 429 || r.status >= 500) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!r.ok) return { ok: false, status: r.status, page };
      return { ok: true, page, body: await r.json(), pages: Number(r.headers.get('x-pages') || 1) };
    } catch {
      await sleep(1000 * 2 ** attempt);
    }
  }
  return { ok: false, status: 0, page };
}

// type_id -> { bid: Map(price -> [vol, orders]), ask: Map(...) }
function absorb(book, orders, want) {
  for (const o of orders) {
    if (o.location_id !== JITA) continue;
    if (want && !want.has(o.type_id)) continue;
    let e = book.get(o.type_id);
    if (!e) book.set(o.type_id, (e = { bid: new Map(), ask: new Map() }));
    const side = o.is_buy_order ? e.bid : e.ask;
    const cur = side.get(o.price);
    if (cur) { cur[0] += o.volume_remain; cur[1] += 1; }
    else side.set(o.price, [o.volume_remain, 1]);
  }
}

function ladder(side, desc) {
  return [...side.entries()]
    .sort((x, y) => (desc ? y[0] - x[0] : x[0] - y[0]))
    .slice(0, LEVELS)
    .map(([p, [v, n]]) => [p, v, n]);
}

// ---------------------------------------------------------------- storage

const dayFile = (day) => path.join(DEPTH_DIR, `${day}.ndjson`);

function lastHashes(day, yesterday) {
  // Ladder fingerprints from the most recent sample of each type, so an
  // unchanged book writes nothing. Reads at most two files.
  const h = new Map();
  for (const d of [yesterday, day]) {
    const f = dayFile(d);
    let text = null;
    if (fs.existsSync(f)) text = fs.readFileSync(f, 'utf8');
    else if (fs.existsSync(f + '.gz')) text = zlib.gunzipSync(fs.readFileSync(f + '.gz')).toString('utf8');
    if (!text) continue;
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const o = JSON.parse(line);
        h.set(o.i, crypto.createHash('sha1').update(JSON.stringify([o.b, o.a])).digest('hex'));
      } catch { /* truncated final line — ignore */ }
    }
  }
  return h;
}

function maintain(today) {
  if (!fs.existsSync(DEPTH_DIR)) return { zipped: 0, pruned: 0 };
  const cutoff = RETAIN_DAYS > 0
    ? new Date(Date.parse(today) - RETAIN_DAYS * 86400_000).toISOString().slice(0, 10)
    : null;
  let zipped = 0, pruned = 0;
  for (const f of fs.readdirSync(DEPTH_DIR)) {
    const day = f.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const full = path.join(DEPTH_DIR, f);
    if (cutoff && day < cutoff) { fs.unlinkSync(full); pruned++; continue; }
    if (f.endsWith('.ndjson') && day < today) {
      fs.writeFileSync(full + '.gz', zlib.gzipSync(fs.readFileSync(full), { level: 9 }));
      fs.unlinkSync(full);
      zipped++;
    }
  }
  return { zipped, pruned };
}

// ------------------------------------------------------------------- main

async function main() {
  const t0 = Date.now();
  const ts = new Date().toISOString();
  const today = ts.slice(0, 10);
  const yesterday = new Date(Date.parse(today) - 86400_000).toISOString().slice(0, 10);

  let want = null;
  if (fs.existsSync(UNIVERSE)) {
    const u = JSON.parse(fs.readFileSync(UNIVERSE, 'utf8'));
    want = new Set((Array.isArray(u) ? u : u.type_ids).map(Number));
    log(`universe: ${want.size} types`);
  } else {
    log(`no ${UNIVERSE} — keeping ladders for EVERY type with a Jita order`);
  }

  const first = await getPage(1);
  if (!first.ok) throw new Error(`page 1 failed: HTTP ${first.status}`);
  const book = new Map();
  absorb(book, first.body, want);
  const pages = first.pages;

  let failed = 0, next = 2;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, Math.max(pages - 1, 0)) }, async () => {
      while (next <= pages) {
        const p = next++;
        const res = await getPage(p);
        if (res.ok) absorb(book, res.body, want);
        else { failed++; log(`page ${p} failed: HTTP ${res.status}`); }
      }
    })
  );
  if (failed > Math.max(3, pages * 0.05)) {
    throw new Error(`${failed}/${pages} pages failed — refusing to write a partial ladder`);
  }

  const prior = lastHashes(today, yesterday);
  const out = [];
  let unchanged = 0;
  for (const [id, sides] of book) {
    const b = ladder(sides.bid, true);
    const a = ladder(sides.ask, false);
    const hash = crypto.createHash('sha1').update(JSON.stringify([b, a])).digest('hex');
    if (prior.get(id) === hash) { unchanged++; continue; }
    out.push(JSON.stringify({ t: ts, i: id, b, a }));
  }

  fs.mkdirSync(DEPTH_DIR, { recursive: true });
  if (out.length) fs.appendFileSync(dayFile(today), out.join('\n') + '\n');
  const { zipped, pruned } = maintain(today);

  log(
    `${pages} pages (${failed} failed) · ${book.size} types · wrote ${out.length} ladders, ` +
      `${unchanged} unchanged` +
      (zipped ? ` · gzipped ${zipped}` : '') + (pruned ? ` · pruned ${pruned}` : '') +
      ` · ${((Date.now() - t0) / 1000).toFixed(1)}s`
  );
}

main().catch((e) => { log('FATAL', e.message); process.exit(1); });
