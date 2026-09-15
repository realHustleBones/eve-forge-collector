// EVE Forge bid/ask collector — every item with a live order at Jita 4-4.
//
// Public ESI only. No credentials, no tokens, nothing to leak.
//
// Strategy: page the WHOLE Forge order book (~300 requests) rather than one
// request per type_id (~15,000). Reduce to best bid / best ask per type at
// Jita 4-4, then write only the rows that actually moved since the last run.
//
// Output: data/YYYY-MM/YYYY-MM-DD.csv   (completed days are gzipped)
//         timestamp,type_id,best_buy,best_sell

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const FORGE = 10000002;
const JITA = 60003760;
const ESI = process.env.ESI_BASE || 'https://esi.evetech.net/latest';
const UA = process.env.ESI_UA || 'eve-forge-collector (+github actions; set ESI_UA to your contact)';
const CONCURRENCY = Number(process.env.CONCURRENCY || 12);
const RETRIES = 4;
const DATA = process.env.DATA_DIR || 'data';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(`[${new Date().toISOString()}]`, ...a);

// ---------------------------------------------------------------- ESI fetch

let errorBudgetPause = 0;

async function getPage(page) {
  const url = `${ESI}/markets/${FORGE}/orders/?order_type=all&page=${page}`;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    if (errorBudgetPause > Date.now()) await sleep(errorBudgetPause - Date.now());
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });

      // ESI error budget: back off hard rather than get the IP banned.
      // NB: Number(null) === 0, so an ABSENT header must be checked for
      // explicitly or every request looks like it blew the budget.
      const remainRaw = r.headers.get('x-esi-error-limit-remain');
      const remain = remainRaw === null ? NaN : Number(remainRaw);
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
      return {
        ok: true,
        page,
        body: await r.json(),
        pages: Number(r.headers.get('x-pages') || 1),
      };
    } catch (e) {
      await sleep(1000 * 2 ** attempt);
    }
  }
  return { ok: false, status: 0, page };
}

// Reduce a page of orders into the running best bid / best ask map.
function absorb(best, orders) {
  for (const o of orders) {
    if (o.location_id !== JITA) continue;
    let e = best.get(o.type_id);
    if (!e) best.set(o.type_id, (e = { bid: null, ask: null }));
    if (o.is_buy_order) {
      if (e.bid === null || o.price > e.bid) e.bid = o.price;
    } else {
      if (e.ask === null || o.price < e.ask) e.ask = o.price;
    }
  }
}

async function scanForge() {
  const first = await getPage(1);
  if (!first.ok) throw new Error(`page 1 failed: HTTP ${first.status}`);

  const best = new Map();
  absorb(best, first.body);
  const pages = first.pages;
  log(`x-pages = ${pages}`);

  let failed = 0;
  let next = 2;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, Math.max(pages - 1, 0)) }, async () => {
      while (next <= pages) {
        const p = next++;
        const res = await getPage(p);
        if (res.ok) absorb(best, res.body);
        else {
          failed++;
          log(`page ${p} failed: HTTP ${res.status}`);
        }
      }
    })
  );

  // A handful of dropped pages is survivable; a lot means bad data.
  if (failed > Math.max(3, pages * 0.05)) {
    throw new Error(`${failed}/${pages} pages failed — refusing to write a partial snapshot`);
  }
  return { best, pages, failed };
}

// ------------------------------------------------------------ file plumbing

const dayFile = (day) => path.join(DATA, day.slice(0, 7), `${day}.csv`);

function readDay(day) {
  const plain = dayFile(day);
  if (fs.existsSync(plain)) return fs.readFileSync(plain, 'utf8');
  if (fs.existsSync(plain + '.gz')) return zlib.gunzipSync(fs.readFileSync(plain + '.gz')).toString('utf8');
  return null;
}

// Last known (bid, ask) per type, from today's file then yesterday's.
// Anything absent from both is treated as changed, so every item is
// re-stated at least once a day and each file stays self-describing.
function priorState(today, yesterday) {
  const state = new Map();
  for (const day of [yesterday, today]) {
    const text = readDay(day);
    if (!text) continue;
    for (const line of text.split('\n')) {
      if (!line || line.startsWith('timestamp')) continue;
      const [, id, bid, ask] = line.split(',');
      state.set(Number(id), `${bid},${ask}`); // later file wins
    }
  }
  return state;
}

function gzipCompletedDays(today) {
  if (!fs.existsSync(DATA)) return 0;
  let n = 0;
  for (const month of fs.readdirSync(DATA)) {
    const dir = path.join(DATA, month);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.csv')) continue;
      const day = f.slice(0, 10);
      if (day >= today) continue; // never touch the day still being written
      const full = path.join(dir, f);
      fs.writeFileSync(full + '.gz', zlib.gzipSync(fs.readFileSync(full), { level: 9 }));
      fs.unlinkSync(full);
      n++;
    }
  }
  return n;
}

// ------------------------------------------------------------------- main

async function main() {
  const t0 = Date.now();
  const ts = new Date().toISOString();
  const today = ts.slice(0, 10);
  const yesterday = new Date(Date.parse(today) - 86400_000).toISOString().slice(0, 10);

  const { best, pages, failed } = await scanForge();
  log(`scanned ${pages} pages (${failed} failed), ${best.size} items with a Jita order`);

  const state = priorState(today, yesterday);

  const out = [];
  for (const [id, { bid, ask }] of best) {
    const line = `${bid ?? ''},${ask ?? ''}`;
    if (state.get(id) === line) continue; // unchanged — skip
    out.push(`${ts},${id},${line}`);
  }

  const file = dayFile(today);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file) && !fs.existsSync(file + '.gz')) {
    fs.writeFileSync(file, 'timestamp,type_id,best_buy,best_sell\n');
  } else if (!fs.existsSync(file)) {
    // day was gzipped early (shouldn't happen) — reopen it
    fs.writeFileSync(file, zlib.gunzipSync(fs.readFileSync(file + '.gz')));
    fs.unlinkSync(file + '.gz');
  }
  if (out.length) fs.appendFileSync(file, out.join('\n') + '\n');

  const zipped = gzipCompletedDays(today);

  log(
    `wrote ${out.length} changed rows of ${best.size} items ` +
      `(${((1 - out.length / Math.max(best.size, 1)) * 100).toFixed(1)}% unchanged, skipped) ` +
      `-> ${file}${zipped ? `; gzipped ${zipped} completed day(s)` : ''} ` +
      `in ${((Date.now() - t0) / 1000).toFixed(1)}s`
  );
}

main().catch((e) => {
  log('FATAL', e.message);
  process.exit(1);
});
