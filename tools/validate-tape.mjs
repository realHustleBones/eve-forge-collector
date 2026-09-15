// Is the reconstructed tape any good? Compare a day of inferred fills against
// the daily volume ESI actually reports.
//
//   node tools/validate-tape.mjs 2026-09-16 [minVolume]
//
// ESI's /markets/history/ is the ground truth: one row per type per day with a
// real `volume`. Sum the inferred fills for that day per type and take the
// ratio. Near 1.0 means the inference is sound. Systematically under means
// fills are being lost (sampling gaps, or fills classified as cancels); over
// means cancels are being counted as fills.
//
// Run this weekly. If the median drifts, the heuristic needs retuning before
// anything downstream is trusted.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const FORGE = 10000002;
const ESI = process.env.ESI_BASE || 'https://esi.evetech.net/latest';
const UA = process.env.ESI_UA || 'eve-forge-collector validate (set ESI_UA to your contact)';
const FILLS_DIR = process.env.FILLS_DIR || 'fills';
const CONCURRENCY = Number(process.env.CONCURRENCY || 12);

const day = process.argv[2];
const MINVOL = Number(process.argv[3] || 100);
if (!day) { console.error('usage: node tools/validate-tape.mjs <YYYY-MM-DD> [minVolume]'); process.exit(1); }

const f = path.join(FILLS_DIR, `${day}.ndjson`);
const text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8')
  : fs.existsSync(f + '.gz') ? zlib.gunzipSync(fs.readFileSync(f + '.gz')).toString('utf8')
  : null;
if (!text) { console.error(`no fills for ${day}`); process.exit(1); }

// Inferred volume per type. A fill is one side of a trade, so the tape's
// unit count is directly comparable to ESI's daily volume.
const mine = new Map(); const exact = new Map();
for (const line of text.split('\n')) {
  if (!line) continue;
  const o = JSON.parse(line);
  mine.set(o.i, (mine.get(o.i) || 0) + o.q);
  if (o.c === 'exact') exact.set(o.i, (exact.get(o.i) || 0) + o.q);
}

const ids = [...mine.keys()];
const real = new Map();
let i = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (i < ids.length) {
    const id = ids[i++];
    try {
      const r = await fetch(`${ESI}/markets/${FORGE}/history/?type_id=${id}`,
        { headers: { Accept: 'application/json', 'User-Agent': UA } });
      if (!r.ok) continue;
      const row = (await r.json()).find((d) => d.date === day);
      if (row) real.set(id, row.volume);
    } catch { /* skip */ }
  }
}));

const rows = [];
for (const [id, v] of mine) {
  const r = real.get(id);
  if (r == null || r < MINVOL) continue;
  rows.push({ id, inferred: v, reported: r, ratio: v / r, exactShare: (exact.get(id) || 0) / v });
}
rows.sort((a, b) => a.ratio - b.ratio);

if (!rows.length) { console.log('no types with enough reported volume to compare'); process.exit(0); }
const med = rows[Math.floor(rows.length / 2)].ratio;
const within = (lo, hi) => rows.filter((r) => r.ratio >= lo && r.ratio <= hi).length;
const ti = rows.reduce((s, r) => s + r.inferred, 0);
const tr = rows.reduce((s, r) => s + r.reported, 0);

console.log(`${day} — ${rows.length} types with >= ${MINVOL} reported units\n`);
console.log(`  total inferred  ${ti.toLocaleString()}`);
console.log(`  total reported  ${tr.toLocaleString()}`);
console.log(`  aggregate ratio ${(ti / tr).toFixed(3)}`);
console.log(`  median ratio    ${med.toFixed(3)}`);
console.log(`  within +/-10%   ${within(0.9, 1.1)} (${(within(0.9, 1.1) / rows.length * 100).toFixed(0)}%)`);
console.log(`  within +/-25%   ${within(0.75, 1.25)} (${(within(0.75, 1.25) / rows.length * 100).toFixed(0)}%)`);
console.log(`  exact share     ${(rows.reduce((s, r) => s + r.exactShare, 0) / rows.length * 100).toFixed(0)}% of inferred units came from volume_remain deltas\n`);
const show = (label, list) => {
  console.log(`  ${label}`);
  for (const r of list) console.log(`    ${String(r.id).padStart(7)}  inferred ${String(r.inferred).padStart(8)}  reported ${String(r.reported).padStart(8)}  ratio ${r.ratio.toFixed(2)}`);
};
show('worst under-count (fills being missed):', rows.slice(0, 5));
show('worst over-count (cancels read as fills):', rows.slice(-5).reverse());
