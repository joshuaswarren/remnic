# How I use Remnic every day

This is a 30-day log from my own self-hosted Remnic daemon, one namespace, read over its HTTP API. Each number below has the command that produced it. Rows marked **Not measured** say why.

Scope: the detail read returns each memory's text and file path. The script keeps only the created time and the named frontmatter fields (connector, origin, source), and nothing but counts is published. The 8,601 are non-private memories: the list and detail routes exclude private memories.

Window: 2026-10-06 00:00 UTC to 2026-11-05 16:00 UTC. That is 31 UTC days. The last day is partial: 16 hours, 564 retained memories.

## Retained memories created per day

This counts memories still retained when the scan reads them, grouped by created date. It is not a write-event count. A memory deleted before the scan is absent, and an update to an existing memory is not counted. The list route pages through the live store and has no snapshot read, so a memory archived during the scan can shift later rows and be missed. Every figure here is a read-time count.

| Measure | Value |
| --- | --- |
| Retained memories created in the window | 8,601 |
| Days in the window | 31 |
| Days with zero retained memories | 0 |
| Per day, median | 168 |
| Per day, mean | 277.5 |
| Per day, lowest and highest | 35 and 1,394 |

## Who created them

Each retained memory records the connector that created it in `sourceConnector`. Every id from the window scan was read once.

| Connector | Retained memories |
| --- | --- |
| codex | 5,092 |
| grok-bot | 1,043 |
| chatgpt | 8 |
| openclaw | 1 |
| No connector field | 2,160 |
| Detail read returned HTTP 404 | 297 |
| **Total** | **8,601** |

The 2,160 with no connector come from the `source` field: wearable:limitless 1,211, wearable:omi 663, wearable:bee 261, correction-contract 14, extraction 11.

The 297 HTTP 404 rows are memories the list call returned and the detail call then failed to find. The cause is **Not measured**.

The `origin` field gives a different split: connector:codex 3,537, none 4,755, unknown 12. This log uses `sourceConnector`. The two fields do not agree, so do not add them together.

**Recalls by agent or connector, with counts: Not measured.** Recall timing records have no caller field, and the API has no per-caller recall count.

## Recalls per day

**Not measured.** The HTTP API keeps no per-day recall log. The recall timing buffer holds the last 50 recalls and clears when the daemon restarts. The daemon last restarted at 2026-11-05 15:06 UTC, so the buffer cannot give a 30-day count.

## Recall latency

**30-day median and p90: Not measured,** for the same reason as recalls per day. The figures below are a snapshot of recalls since the restart, read at 16:39 UTC. The buffer is live, so a later read differs. The buffer held 15 recalls, all with the full recall plan. Their totals in milliseconds, sorted: 6,177; 8,597; 11,517; 35,683; 47,072; 55,127; 60,621; 61,019; 61,428; 62,123; 63,113; 66,730; 68,235; 68,258; 68,505.

- Median: 61.0 s (the 8th of 15 values).
- p90: 68.3 s (nearest rank, the 14th of 15 values).

`total` in each record is wall-clock milliseconds from the start of the recall function to the timing summary near the end of the recall. Later work, such as the episodic-context step, is not in it. Early-return paths record `total` at their own return.

Command:

```bash
curl -s -H "Authorization: Bearer $REMNIC_TOKEN" "$REMNIC_URL/engram/v1/recall/timings" \
  | jq -c '{generatedAt, processStartedAt, count, totals: ([.records[].timingsMs.total] | sort)}'
```

This route needs the daemon's configured operator principal. A token for any other principal gets HTTP 403.

## Commands

Set `REMNIC_URL` and `REMNIC_TOKEN` from your own config. Do not publish either value. This script produced the window, per-day, and connector numbers above:

```python
import collections, datetime as dt, json, os, socket, statistics, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE, TOKEN = os.environ["REMNIC_URL"], os.environ["REMNIC_TOKEN"]
START = dt.datetime(2026, 10, 6, tzinfo=dt.timezone.utc)
END = dt.datetime(2026, 11, 5, 16, 0, tzinfo=dt.timezone.utc)

def get(path):
    req = urllib.request.Request(BASE + path, headers={"Authorization": "Bearer " + TOKEN})
    return json.loads(urllib.request.urlopen(req, timeout=180).read())

# Newest first. Offset paging can repeat a row when a write lands mid-scan, so keep ids in a dict.
seen, off = {}, 0
while True:
    page = get(f"/engram/v1/memories?namespace=generalist&limit=200&offset={off}&sort=created_desc")["memories"]
    if not page:
        break
    old = False
    for m in page:
        t = dt.datetime.fromisoformat(m["created"].replace("Z", "+00:00"))
        if t < START:
            old = True
        elif t < END:
            seen[m["id"]] = t
    if old:
        break
    off += 200

per_day = collections.Counter(t.date().isoformat() for t in seen.values())
# Every UTC date in the window, so a day with no retained memories counts as zero.
window_days = [(START + dt.timedelta(days=i)).date().isoformat() for i in range((END - START).days + 1)]
days = [per_day.get(d, 0) for d in window_days]
print("window", START.isoformat(), END.isoformat(), "retained memories created in window", len(seen), "days", len(days), "zero-write days", sum(1 for d in days if d == 0))
print("per day median", statistics.median(days), "mean", round(statistics.mean(days), 1), "min", min(days), "max", max(days))
print("partial day 2026-11-05 counted to 16:00Z:", per_day["2026-11-05"])

def detail(mid):
    try:
        fm = get(f"/engram/v1/memories/{mid}?namespace=generalist")["memory"]["frontmatter"]
        return ("ok", fm.get("sourceConnector") or "none", fm.get("origin") or "none", fm.get("source") or "none")
    except urllib.error.HTTPError as e:
        return (f"http {e.code}", None, None, None)
    except Exception as e:
        kind = "timeout" if isinstance(e, (TimeoutError, socket.timeout)) or "timed out" in str(e) else "other"
        return (kind, None, None, None)

with ThreadPoolExecutor(2) as ex:
    res = list(ex.map(detail, list(seen)))
ok = [r for r in res if r[0] == "ok"]
print("detail status", dict(collections.Counter(r[0] for r in res)))
print("sourceConnector", dict(collections.Counter(r[1] for r in ok)))
print("origin", dict(collections.Counter(r[2] for r in ok)))
print("source where no connector", dict(collections.Counter(r[3] for r in ok if r[1] == "none")))
```

The counts from one run, which was the run above: 8,601 retained memories over 31 days, 0 zero-write days; detail status 8,304 ok and 297 `http 404`; `sourceConnector` codex 5,092, grok-bot 1,043, none 2,160, chatgpt 8, openclaw 1; `origin` connector:codex 3,537, none 4,755, unknown 12; `source` for the 2,160 with no connector as listed above.