// Weekly: decide which items are liquid enough to keep full ladders for.
//
//   node universe.mjs [minDailyIsk]        default 50000000 (50M ISK/day)
//
// Walks /markets/10000002/history/ for every type currently quoted at Jita and
// keeps those whose 7-day average ISK volume clears the floor. That is one call
// per type (~15k), which is why this is a weekly job and not part of the
// 5-minute loop. Writes universe.json, which depth.mjs reads.

import fs from 'node:fs';

const FORGE = 10000002;
const JITA = 60003760;
const ESI = process.env.ESI_BASE || 'https://esi.evetech.net/latest';
const UA = process.env.ESI_UA || 'eve-forge-collector universe (set ESI_UA to your contact)';
const CONCURRENCY = Number(process.env.CONCURRENCY || 16);
const FLOOR = Number(process.argv[2] || process.env.MIN_DAILY_ISK || 50_000_000);
const OUT = process.env.UNIVERSE_FILE || 'universe.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(`[${new Date().toISOString()}]`, ...a);

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
      if (r.status === 420 || r.status === 429 || r.status >= 500) { await sleep(1000 * 2 ** i); continue; }
      if (!r.ok) return { ok: false, status: r.status };
      return { ok: true, body: await r.json(), pages: Number(r.headers.get('x-pages') || 1) };
    } catch { await sleep(1000 * 2 ** i); }
  }
  return { ok: false, status: 0 };
}

async function quotedAtJita() {
  const ids = new Set();
  const first = await getJSON(`${ESI}/markets/${FORGE}/orders/?order_type=all&page=1`);
  if (!first.ok) throw new Error(`page 1: HTTP ${first.status}`);
  for (const o of first.body) if (o.location_id === JITA) ids.add(o.type_id);
  const pages = first.pages;
  let next = 2;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pages) }, async () => {
    while (next <= pages) {
      const p = next++;
      const r = await getJSON(`${ESI}/markets/${FORGE}/orders/?order_type=all&page=${p}`);
      if (r.ok) for (const o of r.body) if (o.location_id === JITA) ids.add(o.type_id);
    }
  }));
  return [...ids];
}

async function main() {
  const t0 = Date.now();
  const ids = await quotedAtJita();
  log(`${ids.length} types quoted at Jita — pulling history (this takes a while)`);

  const keep = [];
  const detail = {};
  let done = 0, i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < ids.length) {
      const id = ids[i++];
      const r = await getJSON(`${ESI}/markets/${FORGE}/history/?type_id=${id}`);
      done++;
      if (done % 1000 === 0) log(`  ${done}/${ids.length}`);
      if (!r.ok || !Array.isArray(r.body) || !r.body.length) continue;
      const last7 = r.body.slice(-7);
      const isk = last7.reduce((s, d) => s + d.average * d.volume, 0) / last7.length;
      if (isk >= FLOOR) { keep.push(id); detail[id] = Math.round(isk); }
    }
  }));

  keep.sort((a, b) => detail[b] - detail[a]);
  fs.writeFileSync(OUT, JSON.stringify({
    generated: new Date().toISOString(),
    min_daily_isk: FLOOR,
    count: keep.length,
    type_ids: keep,
    daily_isk: detail,
  }, null, 0));
  log(`kept ${keep.length}/${ids.length} types above ${FLOOR.toLocaleString()} ISK/day ` +
      `-> ${OUT} in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`);
}

main().catch((e) => { log('FATAL', e.message); process.exit(1); });
