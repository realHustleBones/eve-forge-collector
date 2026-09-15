// One-shot: convert the old local snapshots.csv into the partitioned layout so
// the archive is continuous instead of starting from zero.
//
//   node tools/seed-from-snapshots.mjs path/to/snapshots.csv
//
// The legacy file is kept verbatim (no delta encoding applied) — a fully
// populated file is just a delta file where every row happened to change, so
// readers need no special case.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const src = process.argv[2];
if (!src) {
  console.error('usage: node tools/seed-from-snapshots.mjs <snapshots.csv>');
  process.exit(1);
}
const DATA = process.env.DATA_DIR || 'data';
const today = new Date().toISOString().slice(0, 10);

const byDay = new Map();
let n = 0;
for (const line of fs.readFileSync(src, 'utf8').split('\n')) {
  if (!line || line.startsWith('timestamp')) continue;
  const day = line.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
  if (!byDay.has(day)) byDay.set(day, []);
  byDay.get(day).push(line.trim());
  n++;
}

let files = 0;
for (const [day, lines] of [...byDay].sort()) {
  const dir = path.join(DATA, day.slice(0, 7));
  fs.mkdirSync(dir, { recursive: true });
  const body = 'timestamp,type_id,best_buy,best_sell\n' + lines.join('\n') + '\n';
  if (day < today) {
    fs.writeFileSync(path.join(dir, `${day}.csv.gz`), zlib.gzipSync(body, { level: 9 }));
  } else {
    // today is still being appended to — leave it uncompressed
    fs.writeFileSync(path.join(dir, `${day}.csv`), body);
  }
  files++;
}
console.log(`seeded ${n.toLocaleString()} rows across ${files} day files into ${DATA}/`);
