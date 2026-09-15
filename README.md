# eve-forge-collector

Three collectors over one data source, plus the tools to read them back.

| tier | script | cadence | host | keeps |
|---|---|---|---|---|
| 1 | `collect.mjs` | hourly | GitHub Actions | best bid / ask, every Forge item, forever |
| 2 | `depth.mjs` | 5 min | persistent | 25 ladder levels a side, liquid universe, 90 days |
| 3 | `tape.mjs` | 5 min | persistent | inferred fills — price, size, side — forever |

`universe.mjs` (weekly) decides who is liquid enough for tiers 2 and 3.
All three make the same pass over `/markets/10000002/orders/` — 410-411 pages as
of September 2026 — and differ only in what they keep.

## Running it on Railway

`worker.mjs` is the hosted entry point: one resident process that does **one scan
per tick and feeds all three outputs**. Use it instead of Railway's cron — a
5-minute cron cold-starts a container 288 times a day and has to reload ~50 MB of
previous book from disk each time just to have something to diff against. The
worker keeps the previous snapshot in memory and writes state only so a restart
can resume.

1. New project -> Deploy from GitHub repo. Nixpacks detects Node; `railway.json`
   sets the start command and health check.
2. **Attach a volume mounted at `/data`.** Without one the filesystem is
   ephemeral and every restart loses the state file, which means a cold start and
   a gap in the tape. 5 GB (Hobby) is ample — about 0.85 GB after a year.
3. Set `ESI_UA` to a contact string. Optionally `INTERVAL_SEC` (fallback only —
   see below), `TICK_PAD_SEC` (default 5) and `RETAIN_DAYS` (default 90, depth
   only — fills are kept forever).
4. `GET /health` returns 200 while **scans** are landing, 503 if the last one is
   older than 3 intervals. Scans, not ticks: a run of generations where nothing
   changed is a healthy worker being cheap, and judging it on ticks would kill a
   process that is working correctly. `GET /status` adds tick and skip counts,
   order count, the fill breakdown, and **`rssMB`**.

### The worker follows ESI's cache, not a stopwatch

`INTERVAL_SEC` is a **fallback**, not the schedule. Each scan reads `Expires`
and `Date` off page 1 and sleeps until the next generation is actually due —
`Expires - Date` rather than `Expires - now`, so a container with a wrong clock
still gets it right.

Before committing to 411 pages it checks page 1's `Last-Modified`. ESI stamps
that with when the *generation* was cached and keeps it consistent across every
page of a paginated resource, so page 1 alone identifies the generation: if the
stamp hasn't moved, pages 2-411 cannot have moved either. An unchanged
generation therefore costs **one request instead of 411**.

(A per-page `ETag` will not do this job. It describes only its own page, so
page 1 could return 304 while page 200 differs.)

A fixed timer fails two ways, neither of them visible in the output:

- **lands twice in one generation** — a full scan that can only report "nothing
  happened". Guaranteed after every restart, since restarting re-phases the timer.
- **skips a generation** — one diff spanning ten minutes while every row it
  writes is stamped as five.

The second one is the dangerous one, because the data looks fine.

**Rate limit.** CCP metered `/markets/{region_id}/orders` on 24 Feb 2026:
12,000 tokens, 2 per request. Their own worked example is every region at every
expiry — 1,723 pages × 2 × 3 = 10,338 tokens — described as well within budget.
One region at the same cadence is **411 × 2 × 3 = 2,466, about 20%.**

**Cost**, at Railway's published rates ($0.00000386/GB/s memory,
$0.00000772/vCPU/s, $0.00000006/GB/s volume): the worker is idle ~95% of the
time, so roughly **$3-7/month** of compute plus $0.78 for a 5 GB volume. Well
inside the $5 Hobby minimum.

**The real constraint is bandwidth, not money.** Scanning the whole Forge book
pulls 250-350 pages of ~230 KB, which is **55-80 MB a scan, 16-22 GB a day,
475-665 GB a month inbound.** Railway's published rate is egress-only, so this
should be free — but it is a lot of traffic and worth confirming against
fair-use before leaving it running.

Cache alignment does **not** materially reduce that figure, and it would be
wrong to claim otherwise: when the book genuinely changes you still have to
download it, and in a live market it changes every generation. What alignment
removes is the *redundant* scans — the ones after every restart, and the ones
drift causes — which are pure waste rather than a standing cost. The lever that
actually cuts the total is cadence: `INTERVAL_SEC=600` roughly halves it and
costs little, since almost nothing in that book moves twice inside ten minutes.

**Memory** is the other thing to watch. The book is held twice during a diff
(previous and current). If `rssMB` from `/status` runs near your plan's ceiling,
the fix is to store the book in parallel typed arrays instead of a Map of
objects — 32 bytes an order instead of ~150, roughly a 5x cut.

**Setup instructions are in [SETUP.md](SETUP.md).**

## The trade tape is INFERRED, and here is exactly how

EVE publishes no time-and-sales. `/markets/history/` is daily only. So `tape.mjs`
reconstructs fills by differencing the whole order book on `order_id` between
consecutive snapshots. `order_id` survives a reprice, which is what makes a moved
order distinguishable from a hit one.

| prev -> now | verdict | `c` | `r` |
|---|---|---|---|
| `volume_remain` fell, id present | **fill** at that price, that size | exact | — |
| price changed, id present | reprice (no fill) | — | — |
| price changed AND volume fell | fill happened, price ambiguous | probable | `amb` |
| id gone, ahead of a **live** touch | fill | probable | `front` |
| id gone, **nothing left on that side** | fill, by default | probable | `empty` |
| id gone, behind the touch | cancel | — | — |
| id gone, past `issued + duration` | expire | certain | — |

Every fill carries `c: "exact" | "probable"`, and every probable one carries `r`
saying **why**. That distinction is the whole ball game:

- `amb` is as certain as exact — the order survived and its volume fell, so the
  trade definitely happened; only the price is in doubt.
- `front` is a real inference from a real surviving touch.
- `empty` is a **default, not a deduction**. Nothing survives on that side, so
  there is nothing to compare against, and a plain cancel is indistinguishable
  from a sweep.

**Measured at Jita on 2026-09-15, over 734 fills in one generation:**

| | fills | ISK | share |
|---|---|---|---|
| `exact` | 573 | 12.48B | 54.1% |
| `amb` | 5 | 0.01B | 0.04% |
| `front` | 156 | 10.57B | 45.8% |
| `empty` | **0** | **0.00B** | **0%** |

`empty` never fires here, and the reason is specific to this station. The worry
was that most of 18,806 items are one trader's lone order, so a cancel would
empty the side and be booked as a sweep. That is true of a quiet regional market
and **false at Jita 4-4**, which is where everyone parks: for `empty` to fire,
every order on that side of that item must vanish inside one generation. Do not
carry this result to another region without re-measuring.

So the tape is roughly half observed and half inferred-on-evidence. What `front`
still cannot separate is "sold from the front" versus "cancelled at the front".
The reason to trust it is economic: cancelling forfeits the whole broker fee,
while repricing preserves `order_id` and bills a discounted relist — so traders
reprice, and the data agrees (189 reprices against 4 visible cancels in that
same generation).

**None of this replaces `tools/validate-tape.mjs`** — it sums a day's inferred
fills per type and divides by the volume ESI actually reports. Near 1.0 is
healthy; systematically under means fills are being lost, over means cancels are
being read as fills. Run it weekly.

Two things bound the accuracy and no amount of engineering fixes them: ESI caches
the book ~5 minutes, so anything that opens and closes inside one interval is
invisible; and a full cancel is indistinguishable from a full fill except by
queue position.

## Getting the data out

The worker serves read endpoints on the same port as `/health`. Generate a
Railway domain (**Settings -> Networking -> Generate Domain**) and they are
live. Everything is read-only, streamed, and CORS-open so a browser page can
call it directly.

| endpoint | what it gives you |
|---|---|
| `/days` | which days exist, per dataset |
| `/fills?type=&day=&from=&to=&conf=` | the reconstructed tape, row by row |
| `/tape?type=&day=` | **volume by price + volume by hour, aggregated server-side** |
| `/depth?type=&day=[&at=]` | ladders: the day's series, or the one in force at a moment |
| `/series?type=&from=&to=` | top of book over time |
| `/raw?set=fills\|depth&day=` | the whole day file, streamed as a download |

```bash
curl "https://<app>.up.railway.app/tape?type=15614&day=2026-09-15"
```

`/tape` is the one to reach for. It aggregates on the server, so drawing a
volume-by-price histogram costs one small JSON response instead of pulling
144,000 fill rows into a browser.

**Set `READ_TOKEN`** to a random string and every read endpoint then requires
`?k=<token>`. `/health` and `/status` stay open so Railway's healthcheck keeps
working. The archive is public game data, so this is about not leaving an
unmetered endpoint on the same process that is trying to collect — not secrecy.

Every reader **streams**. A day of depth is ~250k rows and comfortably over
100 MB; nothing here ever holds a whole file, because the process doing the
serving is the same one holding a 330k-order book.

## Data layout

```
data/YYYY-MM/YYYY-MM-DD.csv(.gz)   top of book, every item, forever
depth/YYYY-MM-DD.ndjson(.gz)       25 ladder levels a side, rolling RETAIN_DAYS
fills/YYYY-MM-DD.ndjson(.gz)       the inferred tape, forever
state/book.json.gz                 last snapshot + generation stamp, so a
                                   restart resumes without re-reading the book
universe.json                      which types get depth and tape
```

```csv
timestamp,type_id,best_buy,best_sell
2026-09-14T15:48:02.523Z,28699,92020,95340
```
```json
{"t":"2026-09-15T19:45:00.000Z","i":15614,"b":[[141900,121,1]],"a":[[159900,6,1]]}
{"t":"2026-09-15T19:45:00.000Z","i":15614,"p":159900,"q":658,"s":"a","c":"exact"}
{"t":"2026-09-15T19:45:00.000Z","i":15614,"p":159800,"q":150,"s":"a","c":"probable","r":"empty"}
```

An empty CSV field means no order on that side at Jita. In the tape, `s` is the
side the *resting* order was on — `a` means someone lifted an ask.

Everything is delta-encoded: a row is written only when the value actually
changed. A naive full snapshot would be ~15,000 rows an hour for tier 1 alone,
and ~10 million rows a day for tier 2. Values hold until the next row for that
type; anything unseen for a day is restated, so each file stays close to
self-describing.

## Reading it back

```bash
node tools/series.mjs 28699                                # change rows only
node tools/series.mjs 28699 2026-09-01 2026-09-14 --fill   # one row per sample
node tools/validate-tape.mjs 2026-09-22                    # is the tape honest?
```

## Tests

```bash
npm test
```

115 checks across six suites (9 + 13 + 23 + 18 + 30 + 22), all against a fake
in-process ESI — no network.
Pagination via `x-pages`, best-bid/ask reduction, the Jita filter, ladder merging
and the level cap, delta encoding, retention and gzip, and the full fill-inference
table including a reconstruction of a real 868-unit sweep.

`test-read.mjs` builds a small archive on disk and checks every read endpoint's
arithmetic, plus the two things that bite in production: a day file gzipped
because the day closed, and a last line half-written because the collector is
appending while the reader reads.

`test-gen.mjs` covers cache-generation detection and the scheduler's clamps,
including a server whose clock disagrees with the client's. `test-worker.mjs`
boots the **real worker** against a fake ESI that serves one order per page — so
"probed a page" and "read the whole book" are different request counts — and
drives it through cold start, an unchanged generation, a generation that moved,
a restart that resumes from the volume and reuses the stored generation without
restating every ladder, and a state file written before `gen` existed.

## Seeded history

`data/2026-08/` and `data/2026-09/` came from the local collector's
`snapshots.csv` — 26,777 rows, 2026-08-06 to 2026-09-14, 39 items. Narrow days
(only items with open orders at the time) but an identical format, so the series
is continuous.

## Relationship to the local collector

Separate archives. The `eve-esi` MCP server on your machine reads the local
`snapshots.csv`, so `forge_bidask_history` keeps working off local data. Point
`server.mjs` at a clone of this repo's `data/` directory to have the MCP tools
read the full archive instead — then the local hourly task, and its console
window, can be retired.
