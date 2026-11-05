# How I use Remnic every day

This is a 30-day log from my own self-hosted Remnic deployment, one namespace, read over its HTTP API. Every number below comes from the command shown next to it. Rows marked **Not measured** say why.

Window: 2026-10-06 to 2026-11-05, UTC. That is 31 calendar days. Nov 5 was still in progress when I measured.

## Writes per day

| Measure | Value |
| --- | --- |
| Memories written in the window | 8,601 |
| Per day, median | 168 |
| Per day, mean | 277.5 |
| Per day, lowest and highest | 35 and 1,394 |

Command (pages the namespace newest first, stops at the window start, counts by created date):

```python
import collections, datetime as dt, json, os, statistics, urllib.request

BASE, TOKEN = os.environ["REMNIC_URL"], os.environ["REMNIC_TOKEN"]

def get(path):
    req = urllib.request.Request(BASE + path, headers={"Authorization": "Bearer " + TOKEN})
    return json.loads(urllib.request.urlopen(req, timeout=180).read())

now = dt.datetime.now(dt.timezone.utc)
start = (now - dt.timedelta(days=30)).replace(hour=0, minute=0, second=0, microsecond=0)
per_day, ids, off = collections.Counter(), [], 0
while True:
    page = get(f"/engram/v1/memories?namespace=generalist&limit=200&offset={off}&sort=created_desc")
    if not page["memories"]:
        break
    done = False
    for m in page["memories"]:
        t = dt.datetime.fromisoformat(m["created"].replace("Z", "+00:00"))
        if t < start:
            done = True
            break
        per_day[t.date().isoformat()] += 1
        ids.append(m["id"])
    if done:
        break
    off += 200
days = [per_day[d] for d in sorted(per_day)]
print(len(ids), len(days), statistics.median(days), round(statistics.mean(days), 1), min(days), max(days))
```

## Recalls per day

**Not measured.** The HTTP API keeps no per-day recall log. The recall timing buffer holds the last 50 recalls and clears on restart, so it cannot give a 30-day count.

## Recall latency

**Not measured over 30 days,** for the same reason. The buffer covers only the period since the last restart. When I read it, it held 8 recalls, all with the full recall plan. Their total times in milliseconds were 6,177; 35,683; 47,072; 55,127; 61,019; 66,730; 68,235; 68,505.

- Median: 58.1 s (mean of the 4th and 5th values).
- p90: 68.5 s (nearest rank).

Command:

```bash
curl -s -H "Authorization: Bearer $REMNIC_TOKEN" "$REMNIC_URL/engram/v1/recall/timings" \
  | jq '[.records[].timingsMs.total] | sort'
```

## Who writes

Each memory records the connector that wrote it in `sourceConnector`. I read that field for every memory in the window.

| Source | Memories |
| --- | --- |
| codex | 5,090 |
| grok-bot | 1,043 |
| chatgpt | 8 |
| openclaw | 1 |
| No connector field | 2,160 |
| Detail read failed | 299 |
| **Total** | **8,601** |

The 2,160 with no connector are wearable and extraction writes: wearable:limitless 1,211, wearable:omi 663, wearable:bee 261, correction-contract 14, extraction 11. The 299 failed reads were 297 HTTP 404 responses and 2 timeouts.

The `origin` field gives a different split (connector:codex 3,535). I counted `sourceConnector` only.

**Recall calls by agent or connector, with counts: Not measured.** Recall timing records carry no caller field, and the API exposes no per-caller recall count.

Command (one detail read per memory in the window, two at a time; about 23 minutes for 8,601 reads):

```python
from concurrent.futures import ThreadPoolExecutor

def connector(mid):
    try:
        fm = get(f"/engram/v1/memories/{mid}?namespace=generalist")["memory"]["frontmatter"]
        return fm.get("sourceConnector") or "none"
    except Exception:
        return "failed"

with ThreadPoolExecutor(2) as ex:
    print(collections.Counter(ex.map(connector, ids)))
```

Run both snippets after the first script with the same `REMNIC_URL` and `REMNIC_TOKEN` from your own config. Do not publish either value.
