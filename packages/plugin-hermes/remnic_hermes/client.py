"""Async HTTP client for the Remnic memory API."""

from __future__ import annotations

import ipaddress
from typing import Any
from urllib.parse import quote

import httpx


def _validate_header_value(field: str, value: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field} must be a string")
    if (
        value.startswith(" ")
        or value.endswith(" ")
        or any(ord(character) < 0x20 or ord(character) > 0x7E for character in value)
    ):
        raise ValueError(f"{field} must be printable ASCII without edge spaces")
    if field in {"client_id", "namespace"} and len(value) > 256:
        raise ValueError(f"{field} must contain at most 256 characters")
    return value


def is_loopback_host(host: str) -> bool:
    """Classify a host as loopback (shared classifier for client and bridge).

    Accepts IPv4/IPv6 literals (bracketed or bare, trailing dot stripped),
    IPv4-mapped IPv6 loopbacks, and ``localhost``/``*.localhost`` names.
    Wildcard addresses (``0.0.0.0``, ``::``) are NOT loopback.
    """
    normalized_host = host.rstrip(".").removeprefix("[").removesuffix("]")
    try:
        address = ipaddress.ip_address(normalized_host)
    except ValueError:
        normalized_hostname = normalized_host.lower()
        return normalized_hostname == "localhost" or normalized_hostname.endswith(".localhost")
    return address.is_loopback or bool(
        address.version == 6 and address.ipv4_mapped and address.ipv4_mapped.is_loopback
    )


def _url_host_and_scheme(host: str, allow_insecure_http: bool) -> tuple[str, str]:
    normalized_host = host.rstrip(".").removeprefix("[").removesuffix("]")
    try:
        address = ipaddress.ip_address(normalized_host)
    except ValueError:
        url_host = host
    else:
        url_host = f"[{address.compressed}]" if address.version == 6 else address.compressed
    scheme = "http" if is_loopback_host(host) or allow_insecure_http else "https"
    return url_host, scheme


class RemnicClient:
    """Typed async HTTP client for the Remnic daemon.

    NOTE: HTTP paths and the client-id header still use the legacy ``engram``
    prefix because the server exposes the legacy surface for the v1.x compat
    window. These will switch to a ``/remnic/v1`` surface once the daemon ships
    the dual-path rollout.
    """

    def __init__(
        self,
        *,
        host: str = "127.0.0.1",
        port: int = 4318,
        token: str = "",
        client_id: str = "hermes",
        namespace: str | None = None,
        session_key: str = "",
        timeout: float = 30.0,
        allow_insecure_http: bool = False,
    ) -> None:
        if not isinstance(allow_insecure_http, bool):
            raise TypeError("allow_insecure_http must be a boolean")
        client_id = _validate_header_value("client_id", client_id)
        if namespace is not None:
            namespace = _validate_header_value("namespace", namespace)
        session_key = _validate_header_value("session_key", session_key)
        url_host, scheme = _url_host_and_scheme(host, allow_insecure_http)
        self.base_url = f"{scheme}://{url_host}:{port}/engram/v1"
        self.mcp_url = f"{scheme}://{url_host}:{port}/mcp"
        self.token = token
        self.client_id = client_id
        self.namespace = namespace
        self.session_key = session_key
        self._mcp_request_id = 0
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "X-Engram-Client-Id": client_id,
        }
        if namespace:
            headers["X-Engram-Namespace"] = namespace
        if session_key:
            headers["X-Hermes-Session-Id"] = session_key
        self._http = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=timeout,
            headers=headers,
        )

    def set_session_key(self, session_key: str) -> None:
        session_key = _validate_header_value("session_key", session_key)
        self.session_key = session_key
        if session_key:
            self._http.headers["X-Hermes-Session-Id"] = session_key
        else:
            self._http.headers.pop("X-Hermes-Session-Id", None)

    async def _post_json(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        request_payload = payload
        if self.namespace and payload.get("namespace") is None:
            request_payload = {**payload, "namespace": self.namespace}
        resp = await self._http.post(path, json=request_payload)
        resp.raise_for_status()
        return resp.json()  # type: ignore[no-any-return]

    async def _get_json(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        clean_params = {
            key: value
            for key, value in (params or {}).items()
            if value is not None
        }
        if path != "/health" and self.namespace and "namespace" not in clean_params:
            clean_params["namespace"] = self.namespace
        resp = await self._http.get(path, params=clean_params)
        resp.raise_for_status()
        return resp.json()  # type: ignore[no-any-return]

    async def _mcp_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        self._mcp_request_id += 1
        resp = await self._http.post(
            self.mcp_url,
            json={
                "jsonrpc": "2.0",
                "id": self._mcp_request_id,
                "method": "tools/call",
                "params": {
                    "name": name,
                    "arguments": arguments,
                },
            },
        )
        resp.raise_for_status()
        payload = resp.json()
        if "error" in payload:
            raise RuntimeError(str(payload["error"]))
        return payload.get("result", payload)  # type: ignore[no-any-return]

    async def recall(
        self,
        query: str,
        *,
        session_key: str = "",
        top_k: int = 8,
        mode: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "query": query,
            "sessionKey": session_key,
            "topK": top_k,
        }
        if mode:
            body["mode"] = mode
        return await self._post_json("/recall", body)

    async def observe(
        self,
        session_key: str,
        messages: list[dict[str, Any]],
        **kwargs: Any,
    ) -> dict[str, Any]:
        return await self._post_json(
            "/observe",
            {"sessionKey": session_key, "messages": messages, **kwargs},
        )

    async def store(self, content: str, **kwargs: Any) -> dict[str, Any]:
        return await self._post_json("/memories", {"content": content, **kwargs})

    async def search(self, query: str, *, top_k: int = 10) -> dict[str, Any]:
        return await self._post_json("/search", {"query": query, "topK": top_k})

    async def lcm_search(
        self,
        query: str,
        *,
        session_key: str = "",
        namespace: str | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"query": query}
        if session_key:
            body["sessionKey"] = session_key
        if namespace:
            body["namespace"] = namespace
        if limit is not None:
            body["limit"] = limit
        return await self._post_json("/lcm/search", body)

    async def recall_explain(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.recall_explain", kwargs)

    async def recall_tier_explain(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.recall_tier_explain", kwargs)

    async def recall_xray(self, query: str, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.recall_xray", {"query": query, **kwargs})

    async def memory_last_recall(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.memory_last_recall", kwargs)

    async def memory_intent_debug(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.memory_intent_debug", kwargs)

    async def memory_qmd_debug(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.memory_qmd_debug", kwargs)

    async def memory_graph_explain(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.memory_graph_explain", kwargs)

    async def memory_feedback_last_recall(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.memory_feedback", kwargs)

    async def set_coding_context(self, session_key: str, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool(
            "engram.set_coding_context",
            {"sessionKey": session_key, **kwargs},
        )

    async def health(self) -> dict[str, Any]:
        return await self._get_json("/health")

    async def memory_get(self, memory_id: str, **kwargs: Any) -> dict[str, Any]:
        return await self._get_json(f"/memories/{quote(memory_id, safe='')}", kwargs)

    async def memory_store(self, content: str, **kwargs: Any) -> dict[str, Any]:
        return await self._post_json("/memories", {"content": content, **kwargs})

    async def memory_timeline(self, memory_id: str, **kwargs: Any) -> dict[str, Any]:
        return await self._get_json(f"/memories/{quote(memory_id, safe='')}/timeline", kwargs)

    async def memory_entities(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.memory_entities_list", kwargs)

    async def entity_get(self, name: str, **kwargs: Any) -> dict[str, Any]:
        return await self._get_json(f"/entities/{quote(name, safe='')}", kwargs)

    async def memory_profile(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.memory_profile", kwargs)

    async def memory_questions(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.memory_questions", kwargs)

    async def memory_identity(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.memory_identity", kwargs)

    async def memory_promote(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.memory_promote", kwargs)

    async def memory_outcome(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.memory_outcome", kwargs)

    async def memory_capture(self, content: str, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.memory_store", {"content": content, **kwargs})

    async def memory_action_apply(self, action: str, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.memory_action_apply", {"action": action, **kwargs})

    async def continuity_audit_generate(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.continuity_audit_generate", kwargs)

    async def continuity_incident_open(self, symptom: str, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.continuity_incident_open", {"symptom": symptom, **kwargs})

    async def continuity_incident_close(
        self,
        incident_id: str,
        *,
        fix_applied: str,
        verification_result: str,
        **kwargs: Any,
    ) -> dict[str, Any]:
        return await self._mcp_tool(
            "engram.continuity_incident_close",
            {
                "id": incident_id,
                "fixApplied": fix_applied,
                "verificationResult": verification_result,
                **kwargs,
            },
        )

    async def continuity_incident_list(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.continuity_incident_list", kwargs)

    async def continuity_loop_add_or_update(
        self,
        loop_id: str,
        *,
        cadence: str,
        purpose: str,
        status: str,
        kill_condition: str,
        **kwargs: Any,
    ) -> dict[str, Any]:
        return await self._mcp_tool(
            "engram.continuity_loop_add_or_update",
            {
                "id": loop_id,
                "cadence": cadence,
                "purpose": purpose,
                "status": status,
                "killCondition": kill_condition,
                **kwargs,
            },
        )

    async def continuity_loop_review(self, loop_id: str, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.continuity_loop_review", {"id": loop_id, **kwargs})

    async def identity_anchor_get(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.identity_anchor_get", kwargs)

    async def identity_anchor_update(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.identity_anchor_update", kwargs)

    async def review_queue_list(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.review_queue_list", kwargs)

    async def review_list(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.review_list", kwargs)

    async def review_resolve(self, pair_id: str, verb: str, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.review_resolve", {"pairId": pair_id, "verb": verb, **kwargs})

    async def suggestion_submit(self, content: str, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.suggestion_submit", {"content": content, **kwargs})

    async def work_task(self, action: str, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.work_task", {"action": action, **kwargs})

    async def work_project(self, action: str, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.work_project", {"action": action, **kwargs})

    async def work_board(self, action: str, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.work_board", {"action": action, **kwargs})

    async def shared_context_write_output(
        self,
        agent_id: str,
        title: str,
        content: str,
        **kwargs: Any,
    ) -> dict[str, Any]:
        return await self._mcp_tool(
            "engram.shared_context_write_output",
            {"agentId": agent_id, "title": title, "content": content, **kwargs},
        )

    async def shared_feedback_record(self, agent: str, decision: str, reason: str, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool(
            "engram.shared_feedback_record",
            {"agent": agent, "decision": decision, "reason": reason, **kwargs},
        )

    async def shared_priorities_append(self, agent_id: str, text: str) -> dict[str, Any]:
        return await self._mcp_tool(
            "engram.shared_priorities_append",
            {"agentId": agent_id, "text": text},
        )

    async def shared_context_cross_signals_run(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.shared_context_cross_signals_run", kwargs)

    async def shared_context_curate_daily(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.shared_context_curate_daily", kwargs)

    async def compounding_weekly_synthesize(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.compounding_weekly_synthesize", kwargs)

    async def compounding_promote_candidate(
        self,
        week_id: str,
        candidate_id: str,
        **kwargs: Any,
    ) -> dict[str, Any]:
        return await self._mcp_tool(
            "engram.compounding_promote_candidate",
            {"weekId": week_id, "candidateId": candidate_id, **kwargs},
        )

    async def compression_guidelines_optimize(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.compression_guidelines_optimize", kwargs)

    async def compression_guidelines_activate(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.compression_guidelines_activate", kwargs)

    async def memory_governance_run(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.memory_governance_run", kwargs)

    async def procedure_mining_run(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.procedure_mining_run", kwargs)

    async def procedural_stats(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.procedural_stats", kwargs)

    async def contradiction_scan_run(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.contradiction_scan_run", kwargs)

    async def memory_summarize_hourly(self) -> dict[str, Any]:
        return await self._mcp_tool("engram.memory_summarize_hourly", {})

    async def conversation_index_update(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.conversation_index_update", kwargs)

    async def profiling_report(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.profiling_report", kwargs)

    async def day_summary(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.day_summary", kwargs)

    async def briefing(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.briefing", kwargs)

    async def context_checkpoint(self, session_key: str, context: str, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool(
            "engram.context_checkpoint",
            {"sessionKey": session_key, "context": context, **kwargs},
        )

    async def close(self) -> None:
        await self._http.aclose()


# Legacy class alias — import path compat for pre-rename consumers.
EngramClient = RemnicClient
