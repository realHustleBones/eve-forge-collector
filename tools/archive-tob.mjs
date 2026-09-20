// archive-tob.mjs — pull the worker's 5-minute top-of-book day files and write
// them into this repo, so the Railway volume is not the only live copy.
//
// This REPLACES the old scanning role of the GitHub Action. It makes no ESI
// requests at all; it only copies what the worker already collected. The worker
// writes top of book for EVERY Forge item on every tick (topOfBook() has no
// universe filter), so the archive it produces is a strict superset of what the
// hourly scanner used to write, at ~58x the sample rate.
//
//   COLLECTOR_URL   https://<app>.up.railway.app   (required)
//   READ_TOKEN      if the worker sets one, passed through as ?k=
//   DAYS            how many recent days to sync (default 7)
//   DATA_DIR        default data
//
// Re-running is safe. A day is fetched only when the worker's copy differs in
// size from what is already committed, so an unchanged closed day costs one
// HEAD-shaped GET and no commit.

import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.COLLECTOR_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.READ_TOKEN || '';
const DAYS = Number(process.env.DAYS || 7);
const DATA = process.env.DATA_DIR || 'data';

if (!BASE) {
  console.error('COLLECTOR_URL is not set — nothing to archive from.');
  process.exit(1);
}

const log = (...a) => console.error(`[${new Date().toISOString()}]`, ...a);
const q = (extra) => (TOKEN ? `${extra}&k=${encodeURIComponent(TOKEN)}` : extra);

async function getJSON(route) {
  const r = await fetch(`${BASE}${route}`, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${route} -> HTTP ${r.status}`);
  return r.json();
}

// The worker gzips a day once it closes, so the same day can arrive as .csv on
// Monday and .csv.gz on Tuesday. Trust the Content-Disposition filename rather
// than guessing, and keep whichever form the worker is serving — the reader
// opens both interchangeably.
async function fetchDay(day) {
  const r = await fetch(`${BASE}/raw?${q(`set=tob&day=${day}`)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`/raw tob ${day} -> HTTP ${r.status}`);
  const cd = r.headers.get('content-disposition') || '';
  const gz = /\.gz"?\s*$/.test(cd);
  const buf = Buffer.from(await r.arrayBuffer());
  return { buf, gz };
}

async function main() {
  const days = await getJSON('/days');
  const tob = (days.tob || []).slice().sort();
  if (!tob.length) { log('worker reports no top-of-book days'); return; }

  const want = tob.slice(-DAYS);
  log(`worker holds ${tob.length} tob days (${tob[0]} to ${tob[tob.length - 1]}); syncing last ${want.length}`);

  let written = 0, skipped = 0, missing = 0;
  for (const day of want) {
    const got = await fetchDay(day);
    if (!got) { missing++; log(`  ${day}: worker has no file`); continue; }

    const dir = path.join(DATA, day.slice(0, 7));
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${day}.csv${got.gz ? '.gz' : ''}`);
    // The counterpart form of the same day, left over from before it was zipped.
    const other = path.join(dir, `${day}.csv${got.gz ? '' : '.gz'}`);

    const same = fs.existsSync(target) && fs.statSync(target).size === got.buf.length;
    if (same) { skipped++; continue; }

    fs.writeFileSync(target, got.buf);
    // A day that has just been gzipped by the worker must not leave the old
    // plain .csv behind: the reader prefers .csv, so a stale one would shadow
    // the fresher .gz for good.
    if (fs.existsSync(other)) fs.unlinkSync(other);
    written++;
    log(`  ${day}: ${(got.buf.length / 1024).toFixed(0)} KB -> ${target}`);
  }
  log(`done — ${written} written, ${skipped} unchanged, ${missing} absent`);
}

main().catch((e) => { log('FATAL', e.message); process.exit(1); });
