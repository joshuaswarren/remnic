#!/usr/bin/env python3
"""Multi-target pool tests for remnic-llm-proxy (no external network)."""
import importlib.util
import json
import os
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def load_proxy_module():
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, "remnic-llm-proxy.py")
    spec = importlib.util.spec_from_file_location("remnic_llm_proxy", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _Target(BaseHTTPRequestHandler):
    hits = []

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        kind = getattr(self.server, "pool_kind", "unknown")
        _Target.hits.append((kind, json.loads(body.decode()) if body else {}))
        delay = getattr(self.server, "delay", 0.0)
        if delay:
            time.sleep(delay)
        status = getattr(self.server, "status", 200)
        payload = json.dumps({"choices": [{"message": {"role": "assistant", "content": kind}}]}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format, *args):  # noqa: A002
        pass


def _serve(kind, delay=0.0, status=200):
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Target)
    server.pool_kind = kind
    server.delay = delay
    server.status = status
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


class PoolTargetsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = load_proxy_module()
        cls.mod.FAIL_COOLDOWN_S = 60.0  # long enough that a down target stays down for the test
        _Target.hits = []
        cls.up_a, cls.base_a = _serve("a", delay=0.4)      # slow: occupies its 1 slot
        cls.up_b, cls.base_b = _serve("b")
        cls.up_busy, cls.base_busy = _serve("busy", status=503)
        cls.up_c, cls.base_c = _serve("c")
        cls.tmp = tempfile.TemporaryDirectory()
        cls.pool_file = os.path.join(cls.tmp.name, "multi-pool.json")
        cls.saved_pool_file = cls.mod.POOL_FILE
        cls.mod.POOL_FILE = cls.pool_file
        cls.proxy = ThreadingHTTPServer(("127.0.0.1", 0), cls.mod.Handler)
        threading.Thread(target=cls.proxy.serve_forever, daemon=True).start()
        cls.proxy_url = f"http://127.0.0.1:{cls.proxy.server_address[1]}/v1/chat/completions"

    @classmethod
    def tearDownClass(cls):
        cls.mod.POOL_FILE = cls.saved_pool_file
        cls.proxy.shutdown()
        for server in (cls.up_a, cls.up_b, cls.up_busy, cls.up_c):
            server.shutdown()
        cls.tmp.cleanup()

    def setUp(self):
        _Target.hits.clear()
        self.mod._target_down_until.clear()
        self.mod._target_semaphores.clear()
        self.mod._target_in_flight.clear()

    def _write_pool(self, pool):
        with open(self.pool_file, "w", encoding="utf-8") as fh:
            json.dump(pool, fh)

    def _post(self):
        body = json.dumps({"messages": [{"role": "user", "content": "ping"}], "max_tokens": 8}).encode()
        req = urllib.request.Request(
            self.proxy_url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        return urllib.request.urlopen(req, timeout=30)

    def test_two_targets_spread_calls_to_free_slots(self):
        self._write_pool({
            "enabled": True,
            "model": "remnic-core",
            "targets": [
                {"base": self.base_a, "slots": 1},
                {"base": self.base_b, "slots": 1},
            ],
        })
        results = []
        threads = [
            threading.Thread(target=lambda: results.append(self._post().status)),
            threading.Thread(target=lambda: results.append(self._post().status)),
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join(30)
        self.assertEqual(sorted(results), [200, 200])
        kinds = sorted(kind for kind, _ in _Target.hits)
        self.assertEqual(kinds, ["a", "b"])  # a's only slot was held by the slow reply

    def test_mixed_model_names_refuse_the_pool(self):
        self._write_pool({
            "enabled": True,
            "targets": [
                {"base": self.base_b, "slots": 1, "model": "remnic-core"},
                {"base": self.base_c, "slots": 1, "model": "qwen-other"},
            ],
        })
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self._post()
        self.assertEqual(caught.exception.code, 503)
        self.assertEqual(_Target.hits, [])

    def test_failing_target_is_skipped_for_cooldown(self):
        self._write_pool({
            "enabled": True,
            "model": "remnic-core",
            "targets": [
                {"base": self.base_busy, "slots": 1},
                {"base": self.base_c, "slots": 1},
            ],
        })
        with self._post() as resp:
            self.assertEqual(resp.status, 200)
        with self._post() as resp:
            self.assertEqual(resp.status, 200)
        busy_hits = [k for k, _ in _Target.hits if k == "busy"]
        c_hits = [k for k, _ in _Target.hits if k == "c"]
        self.assertEqual(len(busy_hits), 1)   # tried once, then cooled down
        self.assertEqual(len(c_hits), 2)      # both calls landed on the healthy target

    def test_single_target_file_still_works(self):
        self._write_pool({"enabled": True, "base": self.base_c, "model": "remnic-core"})
        with self._post() as resp:
            self.assertEqual(resp.status, 200)
        self.assertEqual(_Target.hits[0][0], "c")
        self.assertEqual(_Target.hits[0][1]["model"], "remnic-core")

    def test_health_lists_targets_without_secrets(self):
        self._write_pool({
            "enabled": True,
            "model": "remnic-core",
            "targets": [
                {"base": self.base_b, "slots": 2, "key": "secret-b"},
                {"base": self.base_c, "slots": 1, "key": "secret-c"},
            ],
        })
        url = f"http://127.0.0.1:{self.proxy.server_address[1]}/health"
        with urllib.request.urlopen(url, timeout=10) as resp:
            payload = json.loads(resp.read().decode())
        targets = payload["pool"]["targets"]
        self.assertEqual(len(targets), 2)
        for entry in targets:
            self.assertIn("base_host", entry)
            self.assertIn("slots", entry)
            self.assertNotIn("key", entry)
            self.assertNotIn("base", entry)
        self.assertNotIn("secret-b", json.dumps(payload))


if __name__ == "__main__":
    unittest.main()
