// Read a bid/ask series back out of the archive.
//
//   node tools/series.mjs 28699                 # whole archive
//   node tools/series.mjs 28699 2026-09-01      # from a date
//   node tools/series.mjs 28699 2026-09-01 2026-09-14
//
// The archive is delta-encoded: a row exists only where the value changed, and
// a value holds until the next row for that type. Pass --fill to emit one row
// per stored sample instead (carrying the last known value forward).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const DATA = process.env.DATA_DIR || 'data';
const args = process.argv.slice(2).filter((a) => a !== '--fill');
const fill = process.argv.includes('--fill');
const [id, from = '0000-00-00', to = '9999-99-99'] = args;

if (!id) {
  console.error('usage: node tools/series.mjs <type_id> [from] [to] [--fill]');
  process.exit(1);
}

const days = [];
for (const month of fs.existsSync(DATA) ? fs.readdirSync(DATA).sort() : []) {
  const dir = path.join(DATA, month);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir).sort()) {
    const day = f.slice(0, 10);
    if (day < from || day > to) continue;
    days.push(path.join(dir, f));
  }
}

const rows = [];
const stamps = new Set();
for (const f of days) {
  const text = f.endsWith('.gz')
    ? zlib.gunzipSync(fs.readFileSync(f)).toString('utf8')
    : fs.readFileSync(f, 'utf8');
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('timestamp')) continue;
    const [ts, t, bid, ask] = line.split(',');
    stamps.add(ts);
    if (t === id) rows.push({ ts, bid, ask });
  }
}

if (!rows.length) {
  console.error(`no data for type_id ${id} in ${from}..${to}`);
  process.exit(1);
}

console.log('timestamp,type_id,best_buy,best_sell');
if (!fill) {
  for (const r of rows) console.log(`${r.ts},${id},${r.bid},${r.ask}`);
} else {
  const sorted = [...stamps].sort();
  let i = 0;
  let cur = null;
  for (const ts of sorted) {
    while (i < rows.length && rows[i].ts <= ts) cur = rows[i++];
    if (cur) console.log(`${ts},${id},${cur.bid},${cur.ask}`);
  }
}
console.error(`${rows.length} change rows across ${days.length} day files`);
