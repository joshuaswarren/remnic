#!/usr/bin/env python3
"""Remnic LLM routing proxy for jarvis-ml (127.0.0.1:4399).

Remnic's `localLlmUrl` and `localLlmFastUrl` point here. One proxy, three rules:

1. Chat completion POSTs go to POOL_FILE (trained extraction pool) by default.
   A pool file either names one upstream ({base, model, key}) or lists several
   under "targets" (each {base, key, slots, model?}); a call takes the first
   target with a free slot, a busy/failing target is skipped for
   POOL_FAIL_COOLDOWN_S, and all targets must declare the same trained model
   name or the pool is refused.
   When RECALL_POOL_FILE is set and the caller sends `X-Remnic-Operation`
   matching recall-side ops (see `should_use_recall_pool`), the same request
   goes to the recall pool instead (e.g. jarvis-ml qwen 4-slot on :8091).
   Trained-model-only policy (Joshua, 2026-11-06): memory-writing paths stay
   on the trained pool; recall-side local LLM ops may use the recall pool.
   If RECALL_POOL_FILE is unset/disabled, recall ops get 503 immediately (no
   fallback to the extraction pool — that path recreates 30–70 s recall stalls).
   remnic-server is the only client of this proxy. NO MiniMax or other
   fallback: pool missing/disabled fails 503 immediately; engine busy
   (429/5xx/transport error) waits 10 s per retry until CHAT_TIMEOUT_S,
   then 503. Caller deadlines are respected structurally: the disconnect
   watcher aborts any wait the moment the caller gives up (fast ops cap at
   localLlmFastTimeoutMs=150 s, task ops at localLlmTimeoutMs=600 s).
2. Everything else (GET /v1/models, backend detection) passes to MiniMax.
3. GET /health reports queue depth (in-flight + busy-wait counters)
   without touching any upstream.

The reranker (QMD rerank) does not traverse this proxy and is unchanged.

shortcut: non-streaming only; Remnic does not stream these calls.
Cancellation: when the downstream caller disconnects, the pending upstream
request is torn down promptly (see _cancellable_open); no fallback is sent.
"""
import contextlib
import errno
import functools
import http.client
import json
import os
import select
import socket
import sys
import urllib.parse
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MINIMAX = "https://api.minimax.io"
# POOL_FILE and RECALL_POOL_FILE must be set in the environment (see jarvis-ml deploy notes).
POOL_FILE = os.environ.get("POOL_FILE", "")
RECALL_POOL_FILE = os.environ.get("RECALL_POOL_FILE", "")

CANCEL_POLL = 0.1  # downstream liveness poll cadence; bounds cancel latency and watcher join
BUSY_STATUSES = {429, 500, 502, 503}  # engine busy/unavailable: wait and retry, never fall back
BUSY_WAIT_S = 10.0      # pause between retries while the engine is busy
CHAT_TIMEOUT_S = 600.0  # total budget per chat request including busy waits (caller caps: 150 s fast / 600 s task; abort ends waits)
TIMEOUT_STATUS = 504    # computed upstream timeout expired; the call is not retried
MAX_POOL_INFLIGHT = int(os.environ.get("POOL_MAX_INFLIGHT", "2"))  # Studio chat requests in flight at once
MAX_RECALL_POOL_INFLIGHT = int(os.environ.get("RECALL_MAX_POOL_INFLIGHT", "4"))
FAIL_COOLDOWN_S = float(os.environ.get("POOL_FAIL_COOLDOWN_S", "30"))  # a failing target is skipped this long
PREFILL_TOK_S = float(os.environ.get("PREFILL_TOK_S", "129.0"))   # prompt processing rate of the pool (default: Studio)
DECODE_TOK_S = float(os.environ.get("DECODE_TOK_S", "19.9"))     # generation rate of the pool (default: Studio; Spark under load measured about 2)
TIMEOUT_MARGIN = 1.25   # multiplier on prefill + decode time
TIMEOUT_FLOOR_S = 15.0  # seconds added on top (connect, queueing inside the engine)
QUEUE_BUDGET_S = float(os.environ.get("QUEUE_BUDGET_S", "300"))  # added to request_timeout_s (not a wall-clock queue cap; verified 322s wall under load)
CHARS_PER_TOKEN = 3.0   # conservative: overestimates prompt tokens, lengthens the timeout
DEFAULT_MAX_TOKENS = 4096
_lock = threading.Lock()
# Per (pool file, target base): slot semaphore and cooldown end for a failing target.
_target_semaphores = {}
_target_in_flight = {}
_target_down_until = {}
_health = {
    "extraction_in_flight": 0,
    "pool_active": 0,
    "recall_in_flight": 0,
    "recall_pool_active": 0,
    "extraction_busy_waits_total": 0,
    "recall_busy_waits_total": 0,
    "extraction_last_busy_unix": 0.0,
    "recall_last_busy_unix": 0.0,
    "extraction_last_503_unix": 0.0,
    "recall_last_503_unix": 0.0,
}

DEFAULT_RECALL_OPERATIONS = frozenset({
    "recall",
    "rerank",
    "recognition-tier",
    "deep-recall-policy",
    "deep_recall",
    "who_knows",
})


def should_use_recall_pool(headers) -> bool:
    """Route when remnic sends X-Remnic-Operation for recall-side local LLM work."""
    op = (headers.get("X-Remnic-Operation") or "").strip()
    if not op:
        return False
    override = os.environ.get("RECALL_OPERATIONS", "").strip()
    if override:
        return op in {part.strip() for part in override.split(",") if part.strip()}
    if op == "recall" or op.startswith(("recall_", "recall-")):
        return True
    return op in DEFAULT_RECALL_OPERATIONS


class CallerDisconnected(Exception):
    """The downstream caller closed its connection; no further upstream work is done."""


def _caller_eof(sock, wait: float = 0.0):
    """True once sock is readable and peeked empty (caller gone), or sock itself is dead."""
    try:
        ready, _, _ = select.select([sock], [], [], wait)
    except (OSError, ValueError):
        return True
    if not ready:
        return False
    try:
        return sock.recv(1, socket.MSG_PEEK) == b""
    except OSError:
        return True


def _teardown(conn):
    # http.client moves the socket into the response object once headers arrive
    # (conn.sock becomes None), so tear down the socket we dialed, not conn.sock.
    sock = getattr(conn, "live_sock", None) or getattr(conn, "sock", None)
    if sock is None:
        return
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    try:
        sock.close()
    except OSError:
        pass
    conn.sock = None


def _watch_caller(downstream, cancel, conns):
    """Bounded select(MSG_PEEK) watcher: caller EOF cancels and tears down the upstream links."""
    while not cancel.is_set():
        if _caller_eof(downstream, CANCEL_POLL):
            cancel.set()
            for conn in list(conns):
                _teardown(conn)
            return


class _UpstreamConnection(http.client.HTTPConnection):
    """HTTPConnection whose dial is pollable so caller disconnect can cancel it."""

    def __init__(self, *args, context=None, gone=None, **kwargs):
        if context is not None:
            self.default_port = 443  # before super() parses host/port
        super().__init__(*args, **kwargs)
        self.context = context
        self.gone = gone

    def connect(self):
        self.sock = self._dial()
        if self.context is not None:
            self.sock = self.context.wrap_socket(self.sock, server_hostname=self.host)
        self.live_sock = self.sock

    def _dial(self):
        timeout_s = float(self.timeout) if self.timeout is not None else 0.0
        deadline = time.monotonic() + timeout_s
        family, *_rest, addr = socket.getaddrinfo(self.host, self.port, 0, socket.SOCK_STREAM)[0]
        sock = socket.socket(family, socket.SOCK_STREAM)
        sock.setblocking(False)
        try:
            sock.connect(addr)
        except BlockingIOError:
            pass
        except OSError:
            sock.close()
            raise
        while True:
            if self.gone and self.gone():
                sock.close()
                raise CallerDisconnected("downstream caller disconnected")
            left = deadline - time.monotonic()
            if left <= 0:
                sock.close()
                raise TimeoutError(errno.ETIMEDOUT, "upstream connect timed out")
            if not select.select([], [sock], [], min(CANCEL_POLL, left))[1]:
                continue
            err = sock.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
            if err == 0:
                break
            if err in (errno.EINPROGRESS, errno.EALREADY, errno.EWOULDBLOCK, errno.EINTR):
                continue
            sock.close()
            raise OSError(err, os.strerror(err))
        sock.setblocking(True)
        sock.settimeout(self.timeout)
        return sock


class _HTTPHandler(urllib.request.HTTPHandler):
    def __init__(self, conn_factory):
        super().__init__()
        self._conn_factory = conn_factory

    def http_open(self, req):
        return self.do_open(self._conn_factory, req)


class _HTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self, conn_factory):
        super().__init__()  # default validating SSL context, same as urlopen
        self._conn_factory = conn_factory

    def https_open(self, req):
        return self.do_open(self._conn_factory, req, context=getattr(self, "_context", None))


def _tracked(conns, factory):
    def make(*args, **kwargs):
        conn = factory(*args, **kwargs)
        conns.append(conn)
        return conn
    return make


@contextlib.contextmanager
def _cancellable_open(req, timeout, downstream):
    """urlopen over a watcher-cancellable connection.

    Redirect (301/302/303 -> GET, 307/308 keep method+body), HTTPError mapping and
    Authorization handling stay stock urllib; only the dial and teardown are ours.
    DNS resolution happens before the pollable dial and is not interruptible.
    """
    gone = (lambda: _caller_eof(downstream)) if downstream is not None else None
    conns = []
    factory = functools.partial(_UpstreamConnection, gone=gone)
    opener = urllib.request.build_opener(
        _HTTPHandler(_tracked(conns, factory)),
        _HTTPSHandler(_tracked(conns, factory)),
    )
    cancel = threading.Event()
    watcher = None
    if downstream is not None:
        watcher = threading.Thread(target=_watch_caller, args=(downstream, cancel, conns), daemon=True)
        watcher.start()
    keep_response = False
    try:
        yield opener.open(req, timeout=timeout)
    except urllib.error.HTTPError:
        keep_response = True  # caller still needs err.read() on this response
        raise
    except CallerDisconnected:
        raise
    except BaseException as err:
        if cancel.is_set():
            raise CallerDisconnected("downstream caller disconnected") from err
        raise
    finally:
        cancel.set()
        if watcher is not None:
            watcher.join(CANCEL_POLL * 3)
        if not keep_response:
            for conn in conns:
                conn.close()


def _pool_file_ok(pool):
    return bool(pool.get("enabled") and (pool.get("base") or pool.get("targets")))


def load_pool():
    if not POOL_FILE:
        return None
    try:
        with open(POOL_FILE) as fh:
            pool = json.load(fh)
    except (OSError, ValueError):
        return None
    return pool if _pool_file_ok(pool) else None


def pool_health_public(pool, pool_file=""):
    """Health snapshot without secrets or full upstream URLs."""
    if not pool:
        return None
    out = {
        "enabled": bool(pool.get("enabled")),
        "base_host": urllib.parse.urlparse(pool.get("base", "")).hostname,
        "model": pool.get("model"),
        "has_key": bool(pool.get("key")),
    }
    if pool.get("targets"):
        now = time.monotonic()
        out["targets"] = [
            {
                "base_host": urllib.parse.urlparse(t.get("base", "")).hostname,
                "model": t.get("model", pool.get("model")),
                "slots": t.get("slots"),
                "in_flight": _target_in_flight.get((pool_file, t.get("base")), 0),
                "down_for_s": round(max(0.0, _target_down_until.get((pool_file, t.get("base")), 0.0) - now), 1),
                "has_key": bool(t.get("key") or pool.get("key")),
            }
            for t in pool["targets"]
            if isinstance(t, dict)
        ]
    return out


def pool_targets(pool, default_slots):
    """Normalize a pool file into its target list, or a refusal reason.

    Old single-target files {base, model, key, extra} become one target whose
    slot count defaults to the pool's inflight cap. In a multi-target file
    every target must declare the same trained model name (its own `model`
    or the pool's) — a mixed file is refused wholesale, because it would
    send trained-model traffic to a box serving something else.
    """
    if not pool:
        return None, "pool missing or disabled"
    required = pool.get("model")
    raw = pool.get("targets")
    if not raw:
        if not pool.get("base"):
            return None, "pool has no base and no targets"
        raw = [{
            "base": pool["base"], "key": pool.get("key"), "model": required,
            "slots": pool.get("slots"), "extra": pool.get("extra"),
        }]
    targets = []
    for entry in raw:
        if not isinstance(entry, dict) or not entry.get("base"):
            return None, "a pool target has no base"
        targets.append({
            "base": entry["base"],
            "key": entry.get("key") or pool.get("key"),
            "model": entry.get("model") or required,
            "slots": int(entry.get("slots") or default_slots),
            "extra": entry.get("extra") or pool.get("extra") or {},
        })
    declared = {t["model"] for t in targets if t["model"]}
    if len(declared) > 1:
        return None, "pool targets declare different models; refusing the pool"
    if len(targets) > 1 and not declared:
        return None, "multi-target pools must declare the trained model name"
    for t in targets:
        t["model"] = next(iter(declared), t["model"])
    return targets, None


def _target_semaphore(pool_file, target):
    key = (pool_file, target["base"])
    with _lock:
        sem = _target_semaphores.get(key)
        if sem is None:
            sem = threading.BoundedSemaphore(target["slots"])
            _target_semaphores[key] = sem
        return sem


def _acquire_target(pool_file, targets, downstream, deadline, queue_label):
    """First target with a free slot; None once the deadline passes.

    A target inside its failure cooldown is skipped. When every target is
    busy or down the caller waits (cancel-aware) — for a down-only pool it
    wakes no later than the earliest cooldown end.
    """
    while True:
        now = time.monotonic()
        if now >= deadline:
            return None
        for target in targets:
            until = _target_down_until.get((pool_file, target["base"]), 0.0)
            if until > now:
                continue
            sem = _target_semaphore(pool_file, target)
            if sem.acquire(blocking=False):
                return target, sem
        if _caller_eof(downstream, CANCEL_POLL):
            raise CallerDisconnected(f"downstream caller disconnected while queued for {queue_label}")


def load_recall_pool():
    if not RECALL_POOL_FILE:
        return None
    try:
        with open(RECALL_POOL_FILE) as fh:
            pool = json.load(fh)
    except (OSError, ValueError):
        return None
    return pool if _pool_file_ok(pool) else None


def request_timeout_s(payload):
    """Upstream time budget: prompt tokens / prefill rate + max_tokens / decode rate, plus margin."""
    chars = sum(len(str(m.get("content", ""))) for m in payload.get("messages", []))
    max_tokens = payload.get("max_tokens") or payload.get("max_completion_tokens") or DEFAULT_MAX_TOKENS
    raw = chars / CHARS_PER_TOKEN / PREFILL_TOK_S + max_tokens / DECODE_TOK_S
    return min(CHAT_TIMEOUT_S, QUEUE_BUDGET_S + raw * TIMEOUT_MARGIN + TIMEOUT_FLOOR_S)


def _timed_out(err):
    return isinstance(err, TimeoutError) or isinstance(getattr(err, "reason", None), TimeoutError)


def post(base, path, payload, auth, downstream, timeout=CHAT_TIMEOUT_S):
    headers = {"Content-Type": "application/json"}
    if auth:
        headers["Authorization"] = auth
    req = urllib.request.Request(base + path, data=json.dumps(payload).encode(), headers=headers, method="POST")
    try:
        with _cancellable_open(req, timeout, downstream) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as err:
        return err.code, err.read()
    except CallerDisconnected:
        raise
    except (OSError, http.client.HTTPException) as err:
        status = TIMEOUT_STATUS if _timed_out(err) else 502
        return status, json.dumps({"error": str(err)}).encode()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, status, data):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _chat_via_pool(
        self,
        payload,
        pool,
        *,
        pool_file,
        default_slots,
        in_flight_field,
        active_field,
        busy_waits_field,
        last_busy_field,
        last_503_field,
        queue_label,
        missing_error,
        busy_error,
        disconnect_label,
    ):
        targets, refuse_reason = pool_targets(pool, default_slots)
        if targets is None:
            with _lock:
                _health[last_503_field] = time.time()
            return 503, json.dumps({"error": f"{missing_error} ({refuse_reason})"}).encode()
        deadline = time.monotonic() + CHAT_TIMEOUT_S
        with _lock:
            _health[in_flight_field] += 1
        try:
            while True:
                picked = _acquire_target(pool_file, targets, self.connection, deadline, queue_label)
                if picked is None:
                    with _lock:
                        _health[last_503_field] = time.time()
                    return 503, json.dumps({"error": busy_error}).encode()
                target, sem = picked
                target_key = (pool_file, target["base"])
                auth = "Bearer " + target["key"] if target.get("key") else None
                body = {**payload,
                        "model": target["model"] or payload.get("model"),
                        **target["extra"]}
                with _lock:
                    _target_in_flight[target_key] = _target_in_flight.get(target_key, 0) + 1
                    _health[active_field] += 1
                try:
                    status, data = post(target["base"], self.path, body, auth, self.connection,
                                        request_timeout_s(payload))
                finally:
                    with _lock:
                        _target_in_flight[target_key] -= 1
                        _health[active_field] -= 1
                    sem.release()
                if status not in BUSY_STATUSES:
                    return status, data
                # Failing target: skip it for the cooldown, try the next one.
                _target_down_until[target_key] = time.monotonic() + FAIL_COOLDOWN_S
                if time.monotonic() >= deadline:
                    with _lock:
                        _health[last_503_field] = time.time()
                    return 503, json.dumps({"error": busy_error}).encode()
                with _lock:
                    _health[busy_waits_field] += 1
                    _health[last_busy_field] = time.time()
                if _caller_eof(self.connection, CANCEL_POLL):
                    raise CallerDisconnected(disconnect_label)
        finally:
            with _lock:
                _health[in_flight_field] -= 1

    def _route_chat(self, payload):
        recall_op = should_use_recall_pool(self.headers)
        recall_pool = load_recall_pool() if recall_op else None
        if recall_op and not recall_pool:
            # Fail fast: a recall op on the shared extraction pool re-creates the
            # Spark queue stall this split removes (30–70 s recall waits measured).
            with _lock:
                _health["recall_last_503_unix"] = time.time()
            return 503, json.dumps({
                "error": (
                    "recall pool missing or disabled; recall ops must not use "
                    "the trained extraction pool (no fallback)"
                ),
            }).encode()
        if recall_pool:
            return self._chat_via_pool(
                payload,
                recall_pool,
                pool_file=RECALL_POOL_FILE,
                default_slots=MAX_RECALL_POOL_INFLIGHT,
                in_flight_field="recall_in_flight",
                active_field="recall_pool_active",
                busy_waits_field="recall_busy_waits_total",
                last_busy_field="recall_last_busy_unix",
                last_503_field="recall_last_503_unix",
                queue_label="recall pool",
                missing_error="recall pool missing or disabled",
                busy_error="recall pool busy beyond deadline; no fallback",
                disconnect_label="downstream caller disconnected while waiting for recall pool",
            )
        return self._chat_via_pool(
            payload,
            load_pool(),
            pool_file=POOL_FILE,
            default_slots=MAX_POOL_INFLIGHT,
            in_flight_field="extraction_in_flight",
            active_field="pool_active",
            busy_waits_field="extraction_busy_waits_total",
            last_busy_field="extraction_last_busy_unix",
            last_503_field="extraction_last_503_unix",
            queue_label="trained model",
            missing_error="trained pool missing or disabled; trained-model-only policy forbids fallback",
            busy_error="trained model busy beyond deadline; no fallback",
            disconnect_label="downstream caller disconnected while waiting for trained model",
        )

    def _forward(self, method):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        try:
            if method == "POST" and body and self.path.endswith("/chat/completions"):
                status, data = self._route_chat(json.loads(body))
            else:
                status, data = self._passthrough(method, body)
        except CallerDisconnected:
            self.close_connection = True
            return
        self._send(status, data)

    def _passthrough(self, method, body):
        req = urllib.request.Request(MINIMAX + self.path, data=body, method=method,
                                     headers={"Authorization": self.headers.get("Authorization") or ""})
        try:
            with _cancellable_open(req, 60, self.connection) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as err:
            return err.code, err.read()
        except (OSError, http.client.HTTPException) as err:
            return 502, json.dumps({"error": str(err)}).encode()

    def do_GET(self):
        if self.path == "/health":
            with _lock:
                snapshot = {
                    **_health,
                    "pool": pool_health_public(load_pool(), POOL_FILE),
                    "recall_pool": pool_health_public(load_recall_pool(), RECALL_POOL_FILE),
                }
            return self._send(200, json.dumps(snapshot).encode())
        self._forward("GET")

    def do_POST(self):
        self._forward("POST")

    def log_message(self, _format, *_args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 4399), Handler).serve_forever()
