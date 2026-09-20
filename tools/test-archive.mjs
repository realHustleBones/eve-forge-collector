// Tests for tools/archive-tob.mjs — the job that replaced hourly scanning.
//   node tools/test-archive.mjs
//
// Serves a real archive through the real reader, points the archiver at it, and
// checks what lands on disk. The cases that matter in production are all about
// a day changing FORM rather than content: the worker gzips a day once it
// closes, so the same day arrives as .csv one run and .csv.gz the next, and the
// reader prefers .csv — so a stale plain file left beside a fresh .gz would
// shadow it for good.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import net from 'node:net';
import { execFile } from 'node:child_process';

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  if (!ok) fail++;
};
const freePort = () => new Promise((res) => {
  const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); });
});
const w = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-vol-'));
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-repo-'));
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-ship-'));
const OPEN = '2026-09-16', CLOSED = '2026-09-15';

const closedBody = 'timestamp,type_id,best_buy,best_sell\n2026-09-15T10:00:00.000Z,15614,141900,159900\n';
const openBody = 'timestamp,type_id,best_buy,best_sell\n2026-09-16T10:00:00.000Z,15614,141800,159800\n';
w(path.join(ROOT, 'data', '2026-09', `${CLOSED}.csv`), closedBody);
w(path.join(ROOT, 'data', '2026-09', `${OPEN}.csv`), openBody);

// The repo copy that ships inside the deploy. The archiver must never read this
// back and call it the worker's data: that would make the job a no-op.
w(path.join(REPO, 'data', '2026-09', `${CLOSED}.csv`),
  'timestamp,type_id,best_buy,best_sell\n2026-09-15T09:00:00.000Z,15614,111111,222222\n');
process.env.REPO_DIR = REPO;

const { makeReader } = await import('../read.mjs');
const reader = makeReader({ root: ROOT });
const port = await freePort();
const srv = http.createServer(async (req, res) => {
  if (await reader(req, res)) return;
  res.writeHead(404); res.end('{}');
});
await new Promise((r) => srv.listen(port, r));

const run = (env = {}) => new Promise((res) => {
  execFile(process.execPath, [path.join(import.meta.dirname, 'archive-tob.mjs')],
    { env: { ...process.env, COLLECTOR_URL: `http://127.0.0.1:${port}`, DATA_DIR: OUT, DAYS: '7', ...env } },
    (err, stdout, stderr) => res({ code: err ? err.code ?? 1 : 0, out: String(stderr) }));
});

const at = (d, gz) => path.join(OUT, '2026-09', `${d}.csv${gz ? '.gz' : ''}`);

try {
  let r = await run();
  check('archiver exits clean', r.code, 0);
  check('...and writes both days the worker holds',
    [fs.existsSync(at(CLOSED)), fs.existsSync(at(OPEN))], [true, true]);
  check('...with the WORKER content, not the repo copy it is overwriting',
    fs.readFileSync(at(CLOSED), 'utf8'), closedBody);
  check('...and reports what it wrote', /2 written, 0 unchanged/.test(r.out), true);

  // Second run, nothing changed upstream.
  r = await run();
  check('re-running is a no-op, not a rewrite', /0 written, 2 unchanged/.test(r.out), true);

  // The worker closes the day and gzips it. The archiver has to follow the form
  // change AND clear the plain file, or the reader keeps serving the stale one.
  const gzPath = path.join(ROOT, 'data', '2026-09', `${CLOSED}.csv.gz`);
  fs.writeFileSync(gzPath, zlib.gzipSync(closedBody));
  fs.unlinkSync(path.join(ROOT, 'data', '2026-09', `${CLOSED}.csv`));
  r = await run();
  check('a day the worker has since gzipped is re-fetched as .gz',
    [fs.existsSync(at(CLOSED, true)), fs.existsSync(at(CLOSED))], [true, false]);
  check('...and the gzip still holds the same rows',
    zlib.gunzipSync(fs.readFileSync(at(CLOSED, true))).toString('utf8'), closedBody);

  // A day the worker no longer has must not blow the job up.
  fs.unlinkSync(gzPath);
  r = await run();
  check('a day that vanished upstream is reported, not fatal',
    [r.code, /1 absent/.test(r.out)], [0, true]);
  check('...and what was already archived is left alone',
    fs.existsSync(at(CLOSED, true)), true);

  // Misconfiguration should fail loudly rather than commit an empty archive.
  r = await run({ COLLECTOR_URL: '' });
  check('no COLLECTOR_URL is a hard failure', r.code, 1);
} finally {
  srv.close();
  for (const d of [ROOT, OUT, REPO]) fs.rmSync(d, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
process.exit(fail ? 1 : 0);
