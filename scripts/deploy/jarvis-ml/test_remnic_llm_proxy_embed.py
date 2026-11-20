#!/usr/bin/env python3
"""Embed-pool routing tests for remnic-llm-proxy (no external network)."""
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


class _Embedder(BaseHTTPRequestHandler):
    hits = []

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        kind = getattr(self.server, "pool_kind", "unknown")
        payload_in = json.loads(body.decode()) if body else {}
        _Embedder.hits.append((kind, payload_in))
        delay = getattr(self.server, "delay", 0.0)
        if delay:
            time.sleep(delay)
        status = getattr(self.server, "status", 200)
        dims = getattr(self.server, "dims", 768)
        raw = getattr(self.server, "raw_body", None)
        if raw is not None:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        inputs = payload_in.get("input") or []
        if isinstance(inputs, str):
            inputs = [inputs]
        # A flat token array is one input under the embeddings API.
        if isinstance(inputs, list) and inputs and all(isinstance(i, int) for i in inputs):
            inputs = [inputs]
        payload = json.dumps({
            "data": [{"embedding": [0.0] * dims, "index": i} for i, _ in enumerate(inputs)],
            "model": payload_in.get("model", "embed-model"),
            "usage": {"prompt_tokens": 1, "total_tokens": 1},
        }).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format, *args):  # noqa: A002
        pass


class _PickFirst:
    """Deterministic weighted-pick stub: always choose the first listed member."""

    @staticmethod
    def uniform(_a, _b):
        return 0.0


def _serve(kind, **attrs):
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Embedder)
    server.pool_kind = kind
    for key, val in attrs.items():
        setattr(server, key, val)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


class EmbedPoolTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = load_proxy_module()
        cls.mod.FAIL_COOLDOWN_S = 60.0
        cls.mod.EMBED_TIMEOUT_S = 2.0
        cls.mod.EMBED_DEADLINE_S = 20.0
        _Embedder.hits = []
        cls.up_a, cls.base_a = _serve("a")
        cls.up_busy, cls.base_busy = _serve("busy", status=503)
        cls.up_wrong, cls.base_wrong = _serve("wrong-dims", dims=384)
        cls.up_array, cls.base_array = _serve("array-body", raw_body=b"[]")
        cls.up_b, cls.base_b = _serve("b")
        cls.tmp = tempfile.TemporaryDirectory()
        cls.pool_file = os.path.join(cls.tmp.name, "embed-pool.json")
        cls.saved = cls.mod.EMBED_POOL_FILE
        cls.mod.EMBED_POOL_FILE = cls.pool_file
        cls.proxy = ThreadingHTTPServer(("127.0.0.1", 0), cls.mod.Handler)
        threading.Thread(target=cls.proxy.serve_forever, daemon=True).start()
        cls.embed_url = f"http://127.0.0.1:{cls.proxy.server_address[1]}/v1/embeddings"

    @classmethod
    def tearDownClass(cls):
        cls.mod.EMBED_POOL_FILE = cls.saved
        cls.proxy.shutdown()
        for server in (cls.up_a, cls.up_busy, cls.up_wrong, cls.up_array, cls.up_b):
            server.shutdown()
        cls.tmp.cleanup()

    def setUp(self):
        _Embedder.hits.clear()
        self.mod._target_down_until.clear()
        self.mod._target_semaphores.clear()
        self.mod._target_in_flight.clear()

    def _write_pool(self, pool):
        with open(self.pool_file, "w", encoding="utf-8") as fh:
            json.dump(pool, fh)

    def _post(self, inputs):
        body = json.dumps({"model": "embeddinggemma-300m", "input": inputs}).encode()
        req = urllib.request.Request(
            self.embed_url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        return urllib.request.urlopen(req, timeout=30)

    def test_embed_routes_batch_to_one_member(self):
        self._write_pool({
            "enabled": True, "pool": "qmd-embed", "model": "embeddinggemma-300m",
            "dimensions": 768,
            "members": [{"name": "one", "url": self.base_a, "weight": 1}],
        })
        with self._post(["x", "y", "z"]) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode())
        self.assertEqual(len(data["data"]), 3)
        self.assertEqual(len(_Embedder.hits), 1)  # batch stays atomic on one member
        self.assertEqual(_Embedder.hits[0][1]["input"], ["x", "y", "z"])

    def test_busy_member_fails_over_to_next(self):
        saved_random = self.mod.random
        self.mod.random = _PickFirst
        self.addCleanup(lambda: setattr(self.mod, "random", saved_random))
        self._write_pool({
            "enabled": True, "model": "embeddinggemma-300m", "dimensions": 768,
            "members": [
                {"name": "busy", "url": self.base_busy, "weight": 1},
                {"name": "b", "url": self.base_b, "weight": 1},
            ],
        })
        with self._post("ping") as resp:
            self.assertEqual(resp.status, 200)
        with self._post("ping2") as resp:
            self.assertEqual(resp.status, 200)
        self.assertEqual(sum(1 for k, _ in _Embedder.hits if k == "busy"), 1)
        self.assertEqual(sum(1 for k, _ in _Embedder.hits if k == "b"), 2)

    def test_wrong_dimensions_member_is_cooled_down(self):
        saved_random = self.mod.random
        self.mod.random = _PickFirst
        self.addCleanup(lambda: setattr(self.mod, "random", saved_random))
        self._write_pool({
            "enabled": True, "model": "embeddinggemma-300m", "dimensions": 768,
            "members": [
                {"name": "wrong", "url": self.base_wrong, "weight": 100},
                {"name": "b", "url": self.base_b, "weight": 1},
            ],
        })
        with self._post("ping") as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode())
        self.assertEqual(len(data["data"][0]["embedding"]), 768)  # served by b, not wrong-dims
        self.assertEqual(sum(1 for k, _ in _Embedder.hits if k == "wrong-dims"), 1)  # tried once, then cooled
        with self._post("again") as resp:
            self.assertEqual(resp.status, 200)
        self.assertEqual(sum(1 for k, _ in _Embedder.hits if k == "b"), 2)

    def test_mixed_member_models_refuse_the_pool(self):
        self._write_pool({
            "enabled": True, "dimensions": 768,
            "members": [
                {"name": "m1", "url": self.base_a, "model": "embeddinggemma-300m"},
                {"name": "m2", "url": self.base_b, "model": "other-embed"},
            ],
        })
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self._post("ping")
        self.assertEqual(caught.exception.code, 503)
        self.assertEqual(_Embedder.hits, [])




    def test_embed_rows_ok_rejects_malformed_batches(self):
        good = json.dumps({"data": [{"embedding": [0.0] * 768}]}).encode()
        self.assertTrue(self.mod._embed_rows_ok(good, 768, 1))
        self.assertFalse(self.mod._embed_rows_ok(b"[]", 768, 1))  # top-level array, not an error crash
        self.assertFalse(self.mod._embed_rows_ok(b'{"data": []}', 768, 1))  # empty batch
        self.assertFalse(self.mod._embed_rows_ok(good, 768, 2))  # one vector for two inputs
        self.assertFalse(self.mod._embed_rows_ok(good, 384, 1))  # wrong dims
        self.assertFalse(self.mod._embed_rows_ok(b'{"data": [{"embedding": "x"}]}', 768, 1))
        self.assertFalse(self.mod._embed_rows_ok(b"not-json", 768, 1))

    def test_embed_rows_ok_rejects_non_finite_components(self):
        good = json.dumps({"data": [{"embedding": [0.5, 1, -0.25]}]}).encode()
        self.assertTrue(self.mod._embed_rows_ok(good, 3, 1))  # int and float components ok
        for bad in ([None, 0.2, 0.3], [True, 0.2, 0.3], ["x", 0.2, 0.3]):
            body = json.dumps({"data": [{"embedding": bad}]}).encode()
            self.assertFalse(self.mod._embed_rows_ok(body, 3, 1), bad)
        # NaN/Infinity are not representable in JSON; encode them as produced
        # anyway by a lax upstream serializer.
        for bad in (b'{"data": [{"embedding": [NaN, 0.2, 0.3]}]}',
                    b'{"data": [{"embedding": [Infinity, 0.2, 0.3]}]}'):
            self.assertFalse(self.mod._embed_rows_ok(bad, 3, 1), bad)

    def test_flat_token_array_is_one_input(self):
        self._write_pool({
            "enabled": True, "model": "embeddinggemma-300m", "dimensions": 768,
            "members": [{"name": "a", "url": self.base_a}],
        })
        with self._post([1, 2, 3, 4]) as resp:
            data = json.loads(resp.read())
            self.assertEqual(len(data["data"]), 1)  # one vector for the token array

    def test_top_level_array_body_fails_over(self):
        self._write_pool({
            "enabled": True, "model": "embeddinggemma-300m", "dimensions": 768,
            "members": [
                {"name": "array", "url": self.base_array, "weight": 100},
                {"name": "b", "url": self.base_b, "weight": 1},
            ],
        })
        saved_random = self.mod.random
        self.mod.random = _PickFirst
        self.addCleanup(lambda: setattr(self.mod, "random", saved_random))
        with self._post("ping") as resp:
            self.assertEqual(resp.status, 200)
        self.assertEqual(sum(1 for k, _ in _Embedder.hits if k == "array-body"), 1)
        self.assertEqual(sum(1 for k, _ in _Embedder.hits if k == "b"), 1)

    def test_conflicting_requested_dimensions_rejected(self):
        self._write_pool({
            "enabled": True, "model": "embeddinggemma-300m", "dimensions": 768,
            "members": [{"name": "a", "url": self.base_a}],
        })
        body = json.dumps({"model": "embeddinggemma-300m", "input": "x", "dimensions": 256}).encode()
        req = urllib.request.Request(self.embed_url, data=body,
                                     headers={"Content-Type": "application/json"}, method="POST")
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(req, timeout=10)
        self.assertEqual(caught.exception.code, 400)
        self.assertEqual(_Embedder.hits, [])

    def test_requested_dimensions_validated_against_response(self):
        # Pool has no fixed dims; the caller's requested dims gate the answer.
        # The 768 member is marked down; the 384 member matches and serves.
        self._write_pool({
            "enabled": True, "model": "embeddinggemma-300m",
            "members": [
                {"name": "a", "url": self.base_a, "weight": 100},
                {"name": "wrong", "url": self.base_wrong, "weight": 1},
            ],
        })
        saved_random = self.mod.random
        self.mod.random = _PickFirst
        self.addCleanup(lambda: setattr(self.mod, "random", saved_random))
        body = json.dumps({"model": "embeddinggemma-300m", "input": "x", "dimensions": 384}).encode()
        req = urllib.request.Request(self.embed_url, data=body,
                                     headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=10) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode())
        self.assertEqual(len(data["data"][0]["embedding"]), 384)

    def test_extra_model_does_not_override_pool_model(self):
        self._write_pool({
            "enabled": True, "model": "embeddinggemma-300m", "dimensions": 768,
            "members": [{"name": "a", "url": self.base_a, "extra": {"model": "rogue-model"}}],
        })
        with self._post("ping") as resp:
            self.assertEqual(resp.status, 200)
        self.assertEqual(_Embedder.hits[0][1]["model"], "embeddinggemma-300m")

    def test_non_object_extra_refuses_the_pool(self):
        self._write_pool({
            "enabled": True, "model": "embeddinggemma-300m",
            "members": [{"name": "a", "url": self.base_a, "extra": ["rogue"]}],
        })
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self._post("ping")
        self.assertEqual(caught.exception.code, 503)
        self.assertEqual(_Embedder.hits, [])

    def test_query_string_still_routes_to_pool(self):
        self._write_pool({
            "enabled": True, "model": "embeddinggemma-300m", "dimensions": 768,
            "members": [{"name": "a", "url": self.base_a}],
        })
        body = json.dumps({"model": "embeddinggemma-300m", "input": "x"}).encode()
        req = urllib.request.Request(self.embed_url + "?ignored=1", data=body,
                                     headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=10) as resp:
            self.assertEqual(resp.status, 200)
        self.assertEqual(len(_Embedder.hits), 1)  # pool served it, not the MiniMax passthrough

    def test_missing_body_on_pool_endpoint_is_400(self):
        req = urllib.request.Request(self.embed_url, data=b"",
                                     headers={"Content-Type": "application/json"}, method="POST")
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(req, timeout=10)
        self.assertEqual(caught.exception.code, 400)
        self.assertEqual(_Embedder.hits, [])


if __name__ == "__main__":
    unittest.main()
