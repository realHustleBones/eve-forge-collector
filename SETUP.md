# Setup

Two hosts, deliberately. Railway runs the 5-minute collector on public data only.
Your PC runs the one piece that needs your ESI token, so the token never leaves
your machine.

Times are how long each part actually takes, not counting Railway's build.

---

## Part 1 — GitHub repo (5 min)

From the unzipped folder:

```bash
cd eve-forge-collector
npm test
```

All five suites must say `all checks passed` (85 checks). If they don't, stop and tell me — nothing
below is worth doing against a broken collector.

```bash
git init
git add -A
git commit -m "eve-forge-collector: three tiers over one ESI scan"
```

Create a **public** repo on github.com — no README, no .gitignore, no license,
you already have them. Then:

```bash
git remote add origin https://github.com/<you>/eve-forge-collector.git
git branch -M main
git push -u origin main
```

**Why public:** GitHub gives public repos unlimited Actions minutes. A private
repo draws on the free monthly budget, and 720 hourly runs a month at 1–2 min
each lands uncomfortably close to the cap. Nothing in here is sensitive — it is
public game market data, and there is no token anywhere in the repo.

---

## Part 2 — GitHub Actions, the hourly archive (3 min)

This is tier 1: best bid/ask for every Forge item, committed to git, kept forever.
It is independent of Railway on purpose — if the Railway box dies you still have
an unbroken hourly record.

1. **Settings → Actions → General → Workflow permissions** → select
   **"Read and write permissions"** → Save. Without this the job can't commit
   its own data and every run fails at the push step.
2. **Settings → Secrets and variables → Actions → Variables tab → New repository
   variable.** Name `ESI_UA`, value something that identifies you — a repo URL or
   an email. ESI asks third-party tools to say who they are. It runs without this,
   just rudely.
3. **Actions tab** → if prompted, enable workflows → select **collect** →
   **Run workflow** → Run.

Watch that first run finish green, then check the repo for a new file under
`data/2026-09/`. If it's there, tier 1 is done and self-sustaining.

---

## Part 3 — Railway, the 5-minute worker (10 min)

This is tiers 2 and 3: full ladders and the reconstructed trade tape.

### 3a. Create the service

1. railway.com → **New Project** → **Deploy from GitHub repo** → authorise
   Railway for the repo → pick `eve-forge-collector`.
2. It will build immediately using Nixpacks (detects Node from `package.json`)
   and start with `node worker.mjs`, both set in `railway.json`.

**The first deploy will probably fail its healthcheck. That is expected** — there
is no volume yet, and `/data` doesn't exist. Continue to 3b.

### 3b. Attach the volume — do not skip this

Without a volume the filesystem is wiped on every restart and redeploy. You lose
the state file, which means the next tick has nothing to diff against, which
means a hole in the tape every time Railway so much as reschedules the container.

1. In the project canvas press **⌘K** (Ctrl+K on Windows) → **New Volume**
   → pick the `eve-forge-collector` service.
2. Set the **mount path** to `/data`.
3. Size: **5 GB** is ample. Actual usage lands around 0.85 GB after a full year —
   fills kept forever, depth on a rolling 90 days.

Adding the volume restarts the service. Railway also injects
`RAILWAY_VOLUME_MOUNT_PATH`, which the worker falls back to, so `/data` works
either way.

### 3c. Variables

**Settings → Variables** on the service:

| name | value | why |
|---|---|---|
| `ESI_UA` | your contact string | same as GitHub |
| `INTERVAL_SEC` | `300` | optional **fallback**. The real schedule comes from ESI's `Expires` header |
| `TICK_PAD_SEC` | `5` | optional. Slack added after a generation expires, to absorb CDN jitter without polling early |
| `RETAIN_DAYS` | `90` | optional. Depth retention only — fills are never pruned |

Do **not** set `PORT`. Railway injects it and the worker binds to it.

### 3d. Verify

**Settings → Networking → Generate Domain**, then:

```bash
curl https://<your-app>.up.railway.app/health     # -> booting, then ok
curl https://<your-app>.up.railway.app/status
```

What `/status` should look like after ~15 minutes:

```json
{
  "ticks": 3,
  "skipped": 1,
  "lastTick": "2026-09-15T19:45:00.000Z",
  "lastScan": "2026-09-15T19:47:31.000Z",
  "genLastModified": "Mon, 15 Sep 2026 19:45:00 GMT",
  "nextDelaySec": 154,
  "orders": 312847,
  "pages": 313,
  "fillsLastTick": 1840,
  "unitsLastTick": 94210,
  "rssMB": 260,
  "stale": false
}
```

What to read there:

- **`ticks` climbing.** A tick is a generation that actually *moved*. If it
  sticks at 1 while `skipped` climbs, ESI is serving you the same generation
  forever — check `lastError` and the deploy logs.
- **`skipped`.** Generations that came back unchanged, costing one request each
  instead of 411. A few is normal, especially right after a restart.
- **`lastScan` vs `lastTick`.** `lastScan` is the liveness signal and what the
  watchdog and `/health` judge — a run of unchanged generations is a healthy
  worker being cheap, not a dead one.
- **`nextDelaySec`** should sit a little under 300. That is ESI's `Expires`
  driving the schedule. If it pins to 300 every time, the cache headers aren't
  arriving and the worker has fallen back to the fixed timer.
- **`orders` around 250k–350k.** Much lower means pages are failing; the worker
  aborts rather than write a partial book, since a partial book invents fills.
- **`fillsLastTick` is 0 on the very first tick and only the first.** The tape is
  a difference between two snapshots — there is nothing to compare against yet.
- **`rssMB`.** If it runs near your plan's ceiling, tell me and I'll swap the
  book from a Map of objects to parallel typed arrays — 32 bytes an order
  instead of ~150, about a 5× cut.

---

## Part 4 — the universe file (one-off, then monthly)

Until `universe.json` exists the worker keeps ladders for **every** type with a
Jita order, which is more depth data than you need. The universe file narrows
tiers 2 and 3 to items that actually trade.

Run it locally — it takes 10–20 minutes because it pulls daily history for every
type, one call each:

```bash
ESI_UA="you@example.com" node universe.mjs 50000000   # 50M ISK/day floor
```

Then upload the resulting `universe.json` to the volume at `/data/universe.json`.
Easiest route is `railway run` from the repo, or commit it and have the worker
read it from the repo path — tell me which you'd rather and I'll wire it.

The worker re-reads the file at each UTC date rollover, so a new one takes effect
within a day without a restart. Re-run it monthly; the liquid set drifts.

---

## Part 5 — your positions, on your PC (10 min)

The only piece that touches your token. It stays home.

Nothing on Railway ever sees `tokens.json`. If that box is ever compromised the
worst case is someone reading a market that is already public.

I haven't written this piece yet — it needs a decision from you: push your orders
and fills into the same GitHub repo on a schedule, or write them to a local
folder the MCP server reads. Say which and I'll build it.

---

## Verifying the tape is honest — do this after a week

The tape is **inferred**, not observed. EVE publishes no time-and-sales. Before
you trust anything built on it:

```bash
node tools/validate-tape.mjs 2026-09-22
```

It sums a day's inferred fills per item and divides by the volume ESI actually
reports for that day.

- **Aggregate ratio near 1.0** — the inference is sound.
- **Systematically under 1.0** — fills are being lost. Usually sampling gaps
  (orders that opened and closed inside one 5-minute interval), or fills being
  misread as cancels.
- **Over 1.0** — cancels are being counted as fills. The front-of-queue heuristic
  is too loose and needs tightening.

Run it weekly. If the median drifts away from 1.0, stop trusting volume-by-price
and volume-by-time until it's retuned.

---

## The bandwidth question, before you leave it running

Scanning the whole Forge book every 5 minutes pulls 250–350 pages of roughly
230 KB each:

| interval | per scan | per day | per month |
|---|---|---|---|
| 5 min | 55–80 MB | 16–22 GB | **475–665 GB** |
| 10 min | 55–80 MB | 8–11 GB | 240–330 GB |
| 15 min | 55–80 MB | 5–7 GB | 160–220 GB |

That is inbound, and Railway's published rate is egress-only, so it should cost
nothing. But it is a lot of traffic to park on a $5 plan without checking, and
almost nothing in that book moves twice inside ten minutes. **If in doubt start
at `INTERVAL_SEC=600`** — you lose very little resolution and halve the traffic.
You can always tighten it later; the data formats don't change.

---

## If something breaks

| symptom | cause | fix |
|---|---|---|
| `nextDelaySec` always exactly 300 | no `Expires`/`Date` from ESI, fixed-timer fallback in use | harmless, but tell me — it means the cache alignment isn't working |
| `skipped` climbing but `ticks` frozen | same generation served repeatedly | check `genLastModified` is actually advancing |
| deploy fails healthcheck, logs show `/data` errors | no volume | Part 3b |
| `ticks` stuck at 1, `lastError` mentions pages | ESI refusing or rate-limiting | check `ESI_UA` is set; the worker backs off on its own |
| every restart logs `cold start` | volume not mounted, or mounted at the wrong path | mount path must be exactly `/data` |
| restart logs `no stored generation` every time | state written by an older build, or the volume isn't persisting | harmless once; persistent means check the volume |
| `fillsLastTick` always 0 | still cold-starting each tick — see above | same |
| Actions runs fail at the push step | workflow permissions | Part 2 step 1 |
| `rssMB` near the plan ceiling | book held twice during the diff | ask me for the typed-array rewrite |
| worker went quiet and never came back | it should self-exit and restart | check `restartPolicyType` is `ALWAYS` in `railway.json` |
