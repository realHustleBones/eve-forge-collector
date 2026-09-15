// read.mjs — the way data gets OUT.
//
// The worker already runs an HTTP server for /health and /status, so the
// archive on the Railway volume gets read endpoints on the same port rather
// than a second service. Everything here is READ-ONLY and public game data.
//
//   GET /days                         what exists, per dataset
//   GET /fills?type=&day=&from=&to=   the reconstructed trade tape
//   GET /tape?type=&day=              volume by price + volume by hour
//   GET /depth?type=&day=[&at=]       ladders: nearest one, or the day's series
//   GET /series?type=&from=&to=       top of book over time
//   GET /raw?set=fills&day=           the whole day file, streamed
//
// Set READ_TOKEN to require ?k=<token> on every one of these. /health and
// /status stay open so Railway's healthcheck keeps working.
//
// EVERY reader here STREAMS. A day of depth is ~250k rows and well over 100 MB;
// readFileSync on that would spike the same process that is trying to hold a
// 330k-order book in memory. Nothing in this file ever holds a whole file.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';

const MAX_ROWS = 50_000;
const DEF_ROWS = 5_000;

// A day file is plain .ndjson/.csv while the day is open and .gz once it closes.
function dayFile(dir, day, ext) {
  for (const p of [path.join(dir, `${day}.${ext}`), path.join(dir, `${day}.${ext}.gz`)]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function* lines(file) {
  const raw = fs.createReadStream(file);
  const input = file.endsWith('.gz') ? raw.pipe(zlib.createGunzip()) : raw;
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const l of rl) if (l) yield l;
  } finally {
    rl.close(); raw.destroy();
  }
}

// The worker appends while we read, so the last line can be half-written.
// Skipping an unparseable line is correct: it will be complete next time.
async function* records(file) {
  for await (const l of lines(file)) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    yield o;
  }
}

const daysIn = (dir, ext) => (fs.existsSync(dir)
  ? [...new Set(fs.readdirSync(dir)
      .filter((f) => f.endsWith(`.${ext}`) || f.endsWith(`.${ext}.gz`))
      .map((f) => f.slice(0, 10))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort()
  : []);

const today = () => new Date().toISOString().slice(0, 10);
const num = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));

// ------------------------------------------------------------------ handlers

async function getFills(dirs, q) {
  const day = q.day || today();
  const f = dayFile(dirs.fills, day, 'ndjson');
  if (!f) return { day, n: 0, fills: [], note: 'no fills recorded for that day' };
  const type = q.type ? Number(q.type) : null;
  const from = q.from || null, to = q.to || null;
  const limit = Math.min(num(q.limit, DEF_ROWS), MAX_ROWS);
  const out = [];
  let scanned = 0, truncated = false;
  for await (const r of records(f)) {
    scanned++;
    if (to && r.t > to) break;            // the file is time-ordered, so stop
    if (from && r.t < from) continue;
    if (type !== null && r.i !== type) continue;
    if (q.conf && r.c !== q.conf) continue;
    if (out.length >= limit) { truncated = true; break; }
    out.push(r);
  }
  return { day, type, n: out.length, scanned, truncated, fills: out };
}

// The money endpoint: volume by price and volume by hour, which is what a
// tape is actually FOR. Aggregated server-side so a browser never has to pull
// 144k rows to draw a histogram.
async function getTape(dirs, q) {
  const day = q.day || today();
  const type = q.type ? Number(q.type) : null;
  if (type === null) return { error: 'type is required' };
  const f = dayFile(dirs.fills, day, 'ndjson');
  if (!f) return { day, type, n: 0, note: 'no fills recorded for that day' };

  const byPrice = new Map(), byHour = new Map(), conf = {};
  let n = 0, units = 0, isk = 0, first = null, last = null;
  const side = { a: 0, b: 0 };
  for await (const r of records(f)) {
    if (r.i !== type) continue;
    n++; units += r.q; isk += r.p * r.q;
    first ??= r.t; last = r.t;
    side[r.s] = (side[r.s] || 0) + r.q;
    const key = `${r.c}${r.r ? ':' + r.r : ''}`;
    conf[key] = (conf[key] || 0) + 1;
    const p = byPrice.get(r.p) || [0, 0, 0];
    p[0] += r.q; p[1] += r.p * r.q; p[2]++; byPrice.set(r.p, p);
    const h = r.t.slice(11, 13);
    const b = byHour.get(h) || [0, 0, 0];
    b[0] += r.q; b[1] += r.p * r.q; b[2]++; byHour.set(h, b);
  }
  return {
    day, type, n, units, isk,
    vwap: units ? isk / units : null,
    first, last, side, conf,
    byPrice: [...byPrice.entries()].sort((a, b) => a[0] - b[0])
      .map(([p, [q, k, c]]) => ({ price: p, units: q, isk: k, fills: c })),
    byHour: [...byHour.entries()].sort()
      .map(([h, [q, k, c]]) => ({ hour: h, units: q, isk: k, fills: c })),
  };
}

async function getDepth(dirs, q) {
  const day = q.day || today();
  const type = q.type ? Number(q.type) : null;
  if (type === null) return { error: 'type is required' };
  const f = dayFile(dirs.depth, day, 'ndjson');
  if (!f) return { day, type, n: 0, note: 'no depth recorded for that day' };
  const at = q.at || null;
  const limit = Math.min(num(q.limit, 500), MAX_ROWS);
  const out = [];
  let nearest = null;
  for await (const r of records(f)) {
    if (r.i !== type) continue;
    if (at) { if (r.t <= at) nearest = r; else break; continue; }
    out.push(r);
    if (out.length > limit) out.shift();   // keep the most recent `limit`
  }
  return at ? { day, type, at, ladder: nearest } : { day, type, n: out.length, ladders: out };
}

async function getSeries(dirs, q) {
  const type = q.type ? Number(q.type) : null;
  if (type === null) return { error: 'type is required' };
  const from = q.from || today(), to = q.to || today();
  const limit = Math.min(num(q.limit, DEF_ROWS), MAX_ROWS);
  const out = [];
  const months = [...new Set([from.slice(0, 7), to.slice(0, 7)])];
  const days = [];
  for (const m of months) {
    const dir = path.join(dirs.tob, m);
    for (const d of daysIn(dir, 'csv')) if (d >= from && d <= to) days.push([dir, d]);
  }
  days.sort((a, b) => (a[1] < b[1] ? -1 : 1));
  for (const [dir, d] of days) {
    const f = dayFile(dir, d, 'csv');
    if (!f) continue;
    for await (const l of lines(f)) {
      if (l.startsWith('timestamp,')) continue;
      const [t, id, buy, sell] = l.split(',');
      if (Number(id) !== type) continue;
      out.push({ t, buy: buy === '' ? null : Number(buy), sell: sell === '' ? null : Number(sell) });
      if (out.length >= limit) return { type, from, to, n: out.length, truncated: true, series: out };
    }
  }
  return { type, from, to, n: out.length, truncated: false, series: out };
}

// ---------------------------------------------------------------- the router

export function makeReader({ root }) {
  const dirs = {
    fills: path.join(root, 'fills'),
    depth: path.join(root, 'depth'),
    tob: path.join(root, 'data'),
  };
  const token = process.env.READ_TOKEN || null;

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (!['/days', '/fills', '/tape', '/depth', '/series', '/raw'].includes(p)) return false;

    const q = Object.fromEntries(url.searchParams);
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(body));
    };

    if (token && q.k !== token) { send(401, { error: 'bad or missing ?k' }); return true; }

    try {
      if (p === '/days') {
        const months = fs.existsSync(dirs.tob) ? fs.readdirSync(dirs.tob) : [];
        send(200, {
          fills: daysIn(dirs.fills, 'ndjson'),
          depth: daysIn(dirs.depth, 'ndjson'),
          tob: months.flatMap((m) => daysIn(path.join(dirs.tob, m), 'csv')).sort(),
        });
        return true;
      }

      if (p === '/raw') {
        const set = q.set || 'fills';
        const day = q.day || today();
        const spec = { fills: [dirs.fills, 'ndjson'], depth: [dirs.depth, 'ndjson'] }[set];
        if (!spec) { send(400, { error: 'set must be fills or depth' }); return true; }
        const f = dayFile(spec[0], day, spec[1]);
        if (!f) { send(404, { error: `no ${set} for ${day}` }); return true; }
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson',
          'Content-Disposition': `attachment; filename="${set}-${day}.ndjson${f.endsWith('.gz') ? '.gz' : ''}"`,
          'Access-Control-Allow-Origin': '*',
        });
        fs.createReadStream(f).pipe(res);   // streamed, never buffered
        return true;
      }

      const fn = { '/fills': getFills, '/tape': getTape, '/depth': getDepth, '/series': getSeries }[p];
      const body = await fn(dirs, q);
      send(body.error ? 400 : 200, body);
    } catch (e) {
      send(500, { error: e.message });
    }
    return true;
  };
}
