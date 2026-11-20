#!/usr/bin/env python3
"""Routing tests for remnic-llm-proxy (no network)."""
import importlib.util
import json
import os
import tempfile
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def load_proxy_module():
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, "remnic-llm-proxy.py")
    spec = importlib.util.spec_from_file_location("remnic_llm_proxy", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _Recorder(BaseHTTPRequestHandler):
    hits = []

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        kind = getattr(self.server, "pool_kind", "unknown")
        _Recorder.hits.append((kind, json.loads(body.decode()) if body else {}))
        payload = json.dumps({"choices": [{"message": {"role": "assistant", "content": kind}}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format, *args):  # noqa: A002
        pass


class ProxyRoutingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = load_proxy_module()
        cls._saved_recall_operations = os.environ.get("RECALL_OPERATIONS")
        os.environ.pop("RECALL_OPERATIONS", None)
        _Recorder.hits = []
        cls.up_extraction = ThreadingHTTPServer(("127.0.0.1", 0), _Recorder)
        cls.up_extraction.pool_kind = "extraction"
        cls.up_recall = ThreadingHTTPServer(("127.0.0.1", 0), _Recorder)
        cls.up_recall.pool_kind = "recall"
        threading.Thread(target=cls.up_extraction.serve_forever, daemon=True).start()
        threading.Thread(target=cls.up_recall.serve_forever, daemon=True).start()
        cls.extraction_base = f"http://127.0.0.1:{cls.up_extraction.server_address[1]}"
        cls.recall_base = f"http://127.0.0.1:{cls.up_recall.server_address[1]}"
        cls.tmp = tempfile.TemporaryDirectory()
        cls.extraction_file = os.path.join(cls.tmp.name, "extraction-pool.json")
        cls.recall_file = os.path.join(cls.tmp.name, "recall-pool.json")
        cls.synthetic_key = "test-redact-key-must-not-leak"
        with open(cls.extraction_file, "w", encoding="utf-8") as fh:
            json.dump(
                {"enabled": True, "base": cls.extraction_base, "model": "remnic-core", "key": cls.synthetic_key},
                fh,
            )
        with open(cls.recall_file, "w", encoding="utf-8") as fh:
            json.dump(
                {"enabled": True, "base": cls.recall_base, "model": "qwen3.8-27b-64k", "key": cls.synthetic_key},
                fh,
            )
        cls.mod.POOL_FILE = cls.extraction_file
        cls.mod.RECALL_POOL_FILE = cls.recall_file
        cls.proxy = ThreadingHTTPServer(("127.0.0.1", 0), cls.mod.Handler)
        threading.Thread(target=cls.proxy.serve_forever, daemon=True).start()
        cls.proxy_url = f"http://127.0.0.1:{cls.proxy.server_address[1]}/v1/chat/completions"

    @classmethod
    def tearDownClass(cls):
        cls.proxy.shutdown()
        cls.proxy.server_close()
        cls.up_extraction.shutdown()
        cls.up_extraction.server_close()
        cls.up_recall.shutdown()
        cls.up_recall.server_close()
        cls.tmp.cleanup()
        if cls._saved_recall_operations is None:
            os.environ.pop("RECALL_OPERATIONS", None)
        else:
            os.environ["RECALL_OPERATIONS"] = cls._saved_recall_operations

    def setUp(self):
        _Recorder.hits.clear()

    def _post(self, operation):
        body = json.dumps({"messages": [{"role": "user", "content": "ping"}], "max_tokens": 8}).encode()
        req = urllib.request.Request(
            self.proxy_url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "X-Remnic-Operation": operation,
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            self.assertEqual(resp.status, 200)

    def test_recall_operation_uses_recall_pool(self):
        self._post("recall")
        self.assertEqual(len(_Recorder.hits), 1)
        self.assertEqual(_Recorder.hits[0][0], "recall")

    def test_extraction_operation_uses_extraction_pool(self):
        self._post("extraction")
        self.assertEqual(len(_Recorder.hits), 1)
        self.assertEqual(_Recorder.hits[0][0], "extraction")

    def test_should_use_recall_pool_classifier(self):
        self.assertTrue(self.mod.should_use_recall_pool({"X-Remnic-Operation": "recall"}))
        self.assertTrue(self.mod.should_use_recall_pool({"X-Remnic-Operation": "rerank"}))
        self.assertFalse(self.mod.should_use_recall_pool({"X-Remnic-Operation": "extraction"}))
        self.assertFalse(self.mod.should_use_recall_pool({}))


    def test_recall_without_pool_fails_fast_not_extraction(self):
        saved = self.mod.RECALL_POOL_FILE
        self.mod.RECALL_POOL_FILE = ""
        self.addCleanup(lambda: setattr(self.mod, "RECALL_POOL_FILE", saved))
        body = json.dumps({"messages": [{"role": "user", "content": "ping"}], "max_tokens": 8}).encode()
        req = urllib.request.Request(
            self.proxy_url,
            data=body,
            headers={"Content-Type": "application/json", "X-Remnic-Operation": "recall"},
            method="POST",
        )
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(req, timeout=10)
        self.assertEqual(caught.exception.code, 503)
        self.assertEqual(_Recorder.hits, [])

    def test_invalid_chat_json_returns_400(self):
        req = urllib.request.Request(
            self.proxy_url,
            data=b"{not-json",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(req, timeout=10)
        self.assertEqual(caught.exception.code, 400)

    def test_health_redacts_pool_secrets(self):
        url = f"http://127.0.0.1:{self.proxy.server_address[1]}/health"
        with urllib.request.urlopen(url, timeout=10) as resp:
            payload = json.loads(resp.read().decode())
        for field in ("pool", "recall_pool"):
            block = payload.get(field)
            self.assertIsInstance(block, dict, field)
            self.assertNotIn("key", block)
            self.assertNotIn("base", block)
            self.assertIn("base_host", block)
            self.assertTrue(block.get("has_key"))
            self.assertNotIn(self.synthetic_key, json.dumps(block))

    def test_chat_query_string_still_routes_to_pool(self):
        url = self.proxy_url + "?ignored=1"
        body = json.dumps({"messages": [{"role": "user", "content": "ping"}], "max_tokens": 8}).encode()
        req = urllib.request.Request(url, data=body,
                                     headers={"Content-Type": "application/json",
                                              "X-Remnic-Operation": "extraction"}, method="POST")
        with urllib.request.urlopen(req, timeout=10) as resp:
            self.assertEqual(resp.status, 200)
        self.assertEqual(len(_Recorder.hits), 1)
        self.assertEqual(_Recorder.hits[0][0], "extraction")  # pool served, not MiniMax passthrough

    def test_redirect_handler_refuses_credential_leaks(self):
        handler = self.mod._SafeRedirectHandler()
        req = urllib.request.Request("https://a.example/v1", data=b"{}",
                                     headers={"Authorization": "Bearer secret"})
        self.assertIsNone(handler.redirect_request(req, None, 302, "Found", {}, "https://b.example/v1"))
        self.assertIsNone(handler.redirect_request(req, None, 302, "Found", {}, "http://a.example/v1"))
        same = handler.redirect_request(req, None, 302, "Found", {}, "https://a.example/other")
        self.assertIsNotNone(same)



if __name__ == "__main__":
    unittest.main()
