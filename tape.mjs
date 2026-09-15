// TIER 3 — the reconstructed trade tape.
//
// EVE publishes no time-and-sales. /markets/history/ is daily only. So fills are
// inferred by differencing the whole Forge order book on order_id between
// consecutive snapshots. order_id survives a reprice, which is what makes this
// tractable: a moved order and a hit order are distinguishable.
//
// Classification per order_id, prev -> now:
//   volume_remain fell, id still there   -> FILL, exact price and size
//   price changed, id still there        -> REPRICE (and a fill too, if volume fell)
//   id gone, at or better than the new
//     best price on its side             -> FILL, probable (it was at the front)
//   id gone, behind the surviving touch  -> CANCEL, probable
//   id gone, past issued+duration        -> EXPIRE, certain
//
// Every emitted fill carries `c` = exact | probable, so downstream work can
// weight them. Validate against the daily volume ESI reports: sum a day's fills
// per type and compare (tools/validate-tape.mjs).
//
// Output: fills/YYYY-MM-DD.ndjson  (gzipped when the day closes)
//   {"t":"...","i":15614,"p":159900,"q":658,"s":"a","c":"exact"}
//   s = side the resting order was on: 'a' = someone lifted an ask,
//                                      'b' = someone hit a bid.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const FORGE = 10000002;
const JITA = 60003760;
const ESI = process.env.ESI_BASE || 'https://esi.evetech.net/latest';
const UA = process.env.ESI_UA || 'eve-forge-collector tape (set ESI_UA to your contact)';
const CONCURRENCY = Number(process.env.CONCURRENCY || 12);
const FILLS_DIR = process.env.FILLS_DIR || 'fills';
const STATE = process.env.STATE_FILE || 'state/book.json.gz';
const JITA_ONLY = process.env.JITA_ONLY !== '0';
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
      // Number(null) === 0 — an absent header must be checked explicitly.
      const raw = r.headers.get('x-esi-error-limit-remain');
      const remain = raw === null ? NaN : Number(raw);
      if (Number.isFinite(remain) && remain < 20) {
        const reset = Number(r.headers.get('x-esi-error-limit-reset') || 60);
        errorBudgetPause = Date.now() + (reset + 1) * 1000;
        log(`error budget low (${remain}); pausing ${reset}s`);
      }
      if (r.status === 420 || r.status === 429 || r.status >= 500) { await sleep(1000 * 2 ** attempt); continue; }
      if (!r.ok) return { ok: false, status: r.status, page };
      return { ok: true, page, body: await r.json(), pages: Number(r.headers.get('x-pages') || 1) };
    } catch { await sleep(1000 * 2 ** attempt); }
  }
  return { ok: false, status: 0, page };
}

export async function snapshot() {
  const first = await getPage(1);
  if (!first.ok) throw new Error(`page 1 failed: HTTP ${first.status}`);
  const book = new Map();
  const take = (orders) => {
    for (const o of orders) {
      if (JITA_ONLY && o.location_id !== JITA) continue;
      book.set(o.order_id, {
        t: o.type_id, p: o.price, v: o.volume_remain,
        b: !!o.is_buy_order, e: Date.parse(o.issued) + o.duration * 86400_000,
      });
    }
  };
  take(first.body);
  const pages = first.pages;
  let failed = 0, next = 2;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(pages - 1, 0)) }, async () => {
    while (next <= pages) {
      const p = next++;
      const r = await getPage(p);
      if (r.ok) take(r.body); else { failed++; log(`page ${p} failed: HTTP ${r.status}`); }
    }
  }));
  if (failed > Math.max(3, pages * 0.05)) {
    throw new Error(`${failed}/${pages} pages failed — a partial book would invent fills`);
  }
  return { book, pages, failed };
}

// The surviving touch per (type, side): best ask and best bid still on the book.
export function touches(book) {
  const m = new Map();
  for (const o of book.values()) {
    let e = m.get(o.t);
    if (!e) m.set(o.t, (e = { a: Infinity, b: -Infinity }));
    if (o.b) { if (o.p > e.b) e.b = o.p; }
    else { if (o.p < e.a) e.a = o.p; }
  }
  return m;
}

// prev/now are Map(order_id -> {t,p,v,b,e}); nowTs is ms.
export function diff(prev, now, nowTs) {
  const out = [];
  const tch = touches(now);
  for (const [id, o] of prev) {
    const n = now.get(id);

    if (!n) {
      if (o.e && nowTs > o.e) { out.push({ k: 'expire', i: o.t, p: o.p, q: o.v, s: o.b ? 'b' : 'a' }); continue; }
      const t = tch.get(o.t);
      // No surviving orders on that side at all: everything there cleared.
      const front = !t ? true
        : o.b ? o.p >= t.b            // bid at or above the best surviving bid
              : o.p <= t.a;           // ask at or below the best surviving ask
      out.push(front
        ? { k: 'fill', i: o.t, p: o.p, q: o.v, s: o.b ? 'b' : 'a', c: 'probable' }
        : { k: 'cancel', i: o.t, p: o.p, q: o.v, s: o.b ? 'b' : 'a' });
      continue;
    }

    if (n.p !== o.p) {
      out.push({ k: 'reprice', i: o.t, from: o.p, to: n.p, q: n.v, s: o.b ? 'b' : 'a' });
      // A reprice and a fill inside one interval: the fill's price is ambiguous
      // (before or after the move), so it is never 'exact'.
      if (n.v < o.v) out.push({ k: 'fill', i: o.t, p: o.p, q: o.v - n.v, s: o.b ? 'b' : 'a', c: 'probable' });
      continue;
    }

    // Same price, less volume: the only way that happens is a fill.
    if (n.v < o.v) out.push({ k: 'fill', i: o.t, p: o.p, q: o.v - n.v, s: o.b ? 'b' : 'a', c: 'exact' });
  }
  return out;
}

// ------------------------------------------------------------------ storage

const dayFile = (d) => path.join(FILLS_DIR, `${d}.ndjson`);

function loadState() {
  if (!fs.existsSync(STATE)) return null;
  const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(STATE)).toString('utf8'));
  return { ts: j.ts, book: new Map(j.o.map((r) => [r[0], { t: r[1], p: r[2], v: r[3], b: !!r[4], e: r[5] }])) };
}
function saveState(ts, book) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  const o = [...book].map(([id, x]) => [id, x.t, x.p, x.v, x.b ? 1 : 0, x.e]);
  fs.writeFileSync(STATE, zlib.gzipSync(JSON.stringify({ ts, o }), { level: 6 }));
}
function gzipClosedDays(today) {
  if (!fs.existsSync(FILLS_DIR)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(FILLS_DIR)) {
    if (!f.endsWith('.ndjson')) continue;
    const day = f.slice(0, 10);
    if (day >= today) continue;
    const p = path.join(FILLS_DIR, f);
    fs.writeFileSync(p + '.gz', zlib.gzipSync(fs.readFileSync(p), { level: 9 }));
    fs.unlinkSync(p);
    n++;
  }
  return n;
}

// --------------------------------------------------------------------- main

async function main() {
  const t0 = Date.now();
  const iso = new Date().toISOString();
  const today = iso.slice(0, 10);

  const { book, pages } = await snapshot();
  const prev = loadState();
  saveState(iso, book);

  if (!prev) {
    log(`cold start: ${book.size} orders stored, no tape this run (nothing to diff against)`);
    return;
  }

  const ev = diff(prev.book, book, Date.parse(iso));
  const fills = ev.filter((e) => e.k === 'fill');
  const lines = fills.map((f) => JSON.stringify({ t: iso, i: f.i, p: f.p, q: f.q, s: f.s, c: f.c }));

  fs.mkdirSync(FILLS_DIR, { recursive: true });
  if (lines.length) fs.appendFileSync(dayFile(today), lines.join('\n') + '\n');
  const zipped = gzipClosedDays(today);

  const n = (k) => ev.filter((e) => e.k === k).length;
  const exact = fills.filter((f) => f.c === 'exact');
  const isk = fills.reduce((s, f) => s + f.p * f.q, 0);
  log(
    `${pages}p · ${book.size} orders · gap ${((Date.parse(iso) - Date.parse(prev.ts)) / 60000).toFixed(1)}m · ` +
      `fills ${fills.length} (${exact.length} exact, ${fills.length - exact.length} probable) ` +
      `= ${fills.reduce((s, f) => s + f.q, 0).toLocaleString()} units / ${(isk / 1e9).toFixed(2)}B ISK · ` +
      `reprice ${n('reprice')} · cancel ${n('cancel')} · expire ${n('expire')}` +
      (zipped ? ` · gzipped ${zipped}` : '') + ` · ${((Date.now() - t0) / 1000).toFixed(1)}s`
  );
}

if (process.argv[1] && process.argv[1].endsWith('tape.mjs')) {
  main().catch((e) => { log('FATAL', e.message); process.exit(1); });
}
