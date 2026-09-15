# eve-forge-collector

Three collectors over one data source, plus the tools to read them back.

| tier | script | cadence | host | keeps |
|---|---|---|---|---|
| 1 | `collect.mjs` | hourly | GitHub Actions | best bid / ask, every Forge item, forever |
| 2 | `depth.mjs` | 5 min | persistent | 25 ladder levels a side, liquid universe, 90 days |
| 3 | `tape.mjs` | 5 min | persistent | inferred fills — price, size, side — forever |

`universe.mjs` (weekly) decides who is liquid enough for tiers 2 and 3.
All three make the same ~300-request pass over `/markets/10000002/orders/`; they
differ only in what they keep.

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
3. Set `ESI_UA` to a contact string. Optionally `INTERVAL_SEC` (default 300) and
   `RETAIN_DAYS` (default 90, depth only — fills are kept forever).
4. `GET /health` returns 200 while ticks are landing, 503 if the last one is
   older than 3 intervals. `GET /status` returns tick count, order count, fills
   on the last tick, and **`rssMB`** — watch that one.

**Cost**, at Railway's published rates ($0.00000386/GB/s memory,
$0.00000772/vCPU/s, $0.00000006/GB/s volume): the worker is idle ~95% of the
time, so roughly **$3-7/month** of compute plus $0.78 for a 5 GB volume. Well
inside the $5 Hobby minimum.

**The real constraint is bandwidth, not money.** Scanning the whole Forge book
every 5 minutes pulls 250-350 pages of ~230 KB, which is **55-80 MB a scan,
16-22 GB a day, 475-665 GB a month inbound.** Railway's published rate is
egress-only, so this should be free — but it is a lot of traffic and worth
confirming against fair-use before leaving it running. Halving the cadence to 10
minutes halves it and costs you little, since most items don't move that fast.

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

| prev -> now | verdict | confidence |
|---|---|---|
| `volume_remain` fell, id present | **fill** at that price, that size | exact |
| price changed, id present | reprice (no fill) | — |
| price changed AND volume fell | fill, but the price is ambiguous | probable |
| id gone, at/ahead of the surviving touch | fill | probable |
| id gone, behind the touch | cancel | — |
| id gone, past `issued + duration` | expire | certain |

Every fill carries `c: "exact" | "probable"`. **Never treat the tape as ground
truth without running `tools/validate-tape.mjs`** — it sums a day's inferred
fills per type and divides by the volume ESI actually reports. Near 1.0 is
healthy; systematically under means fills are being lost, over means cancels are
being read as fills. Run it weekly.

Two things bound the accuracy and no amount of engineering fixes them: ESI caches
the book ~5 minutes, so anything that opens and closes inside one interval is
invisible; and a full cancel is indistinguishable from a full fill except by
queue position.

## Data layout

```
data/YYYY-MM/YYYY-MM-DD.csv(.gz)   top of book, every item, forever
depth/YYYY-MM-DD.ndjson(.gz)       25 ladder levels a side, rolling RETAIN_DAYS
fills/YYYY-MM-DD.ndjson(.gz)       the inferred tape, forever
state/book.json.gz                 last snapshot, so a restart can resume
universe.json                      which types get depth and tape
```

```csv
timestamp,type_id,best_buy,best_sell
2026-09-14T15:48:02.523Z,28699,92020,95340
```
```json
{"t":"2026-09-15T19:45:00.000Z","i":15614,"b":[[141900,121,1]],"a":[[159900,6,1]]}
{"t":"2026-09-15T19:45:00.000Z","i":15614,"p":159900,"q":658,"s":"a","c":"exact"}
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

39 checks across three suites (9 + 13 + 17), all against a fake in-process ESI — no network.
Pagination via `x-pages`, best-bid/ask reduction, the Jita filter, ladder merging
and the level cap, delta encoding, retention and gzip, and the full fill-inference
table including a reconstruction of a real 868-unit sweep.

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
