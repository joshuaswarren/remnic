"""Held-out latency harness (issue #1585).

The eval contract for both model-lab tasks is **held-out p95 latency** plus
classification accuracy (faithfulness F1 / correction-intent detection F1).
The accuracy math lives in ``eval_runner.py``; this module owns the latency
side. Pure stdlib so the percentile definitions are identical between the CI
sanity probe and the GPU eval script — the p95 that lands in a manifest is
computable from a hand-checked fixture.

The actual measurement requires a served model (GPU-gated); this module
provides the ``measure_endpoint_latencies`` harness that drives a served
openai-compatible endpoint and the ``summarize`` / ``percentile`` math. The
math is unit-tested on synthetic samples now; the live measurement runs only
on the lab box (issue #1585 follow-up when the GPU frees).
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any, Mapping, Sequence


def percentile(values: Sequence[float], p: float) -> float:
    """Linear-interpolation percentile of ``values`` in [0, 100].

    Mirrors numpy's default ('linear') so the GPU script and this stdlib
    helper agree. ``p`` outside (0, 100] raises; an empty input raises.
    """
    if not values:
        raise ValueError("percentile of an empty sequence is undefined")
    if not 0 < p <= 100:
        raise ValueError(f"p must be in (0, 100], got {p}")
    ordered = sorted(values)
    if len(ordered) == 1:
        return float(ordered[0])
    rank = (p / 100) * (len(ordered) - 1)
    lo = int(rank)
    hi = min(lo + 1, len(ordered) - 1)
    frac = rank - lo
    return float(ordered[lo] + (ordered[hi] - ordered[lo]) * frac)


def summarize(samples_ms: Sequence[float]) -> dict[str, float]:
    """Summarize a latency sample set into the manifest's p95 block.

    Returns ``{count, min, mean, p50, p95, p99, max}``. All values in
    milliseconds. An empty input raises (a measurement with no samples is a
    bug, not a zero).
    """
    if not samples_ms:
        raise ValueError("cannot summarize an empty latency sample set")
    xs = [float(x) for x in samples_ms]
    return {
        "count": float(len(xs)),
        "min": round(min(xs), 3),
        "mean": round(sum(xs) / len(xs), 3),
        "p50": round(percentile(xs, 50), 3),
        "p95": round(percentile(xs, 95), 3),
        "p99": round(percentile(xs, 99), 3),
        "max": round(max(xs), 3),
    }


def measure_endpoint_latencies(
    base_url: str,
    model: str,
    payloads: Sequence[Mapping[str, Any]],
    *,
    timeout_ms: int = 10_000,
) -> dict[str, float]:
    """Drive a served openai-compatible endpoint and summarize per-call latency.

    POSTs each payload (an openai-compatible chat body, minus ``model`` which is
    injected) to ``${base_url}/chat/completions`` and records wall-clock ms.
    Network errors / non-2xx / timeouts are counted under ``errorCount`` but do
    NOT contribute to the latency summary — a failed request has no latency.

    GPU-gated: only meaningful against a served model (issue #1585 follow-up).
    Returns ``{count, errorCount, min, mean, p50, p95, p99, max}``.
    """
    url = base_url.rstrip("/") + "/chat/completions"
    latencies: list[float] = []
    errors = 0
    for payload in payloads:
        body = dict(payload)
        body["model"] = model
        started = time.perf_counter()
        try:
            req = urllib.request.Request(
                url,
                data=json.dumps(body).encode("utf-8"),
                headers={"content-type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=timeout_ms / 1000) as resp:  # noqa: S310 — lab box, local endpoint
                if 200 <= resp.status < 300:
                    latencies.append((time.perf_counter() - started) * 1000)
                else:
                    errors += 1
        except (urllib.error.URLError, TimeoutError, OSError):
            errors += 1
    out: dict[str, float] = {"count": float(len(latencies)), "errorCount": float(errors)}
    if latencies:
        out.update(summarize(latencies))
    return out
