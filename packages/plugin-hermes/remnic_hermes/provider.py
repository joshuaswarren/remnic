"""Remnic MemoryProvider protocol implementation for Hermes Agent."""

from __future__ import annotations

import asyncio
import json
import threading
import uuid
from collections import OrderedDict
from concurrent.futures import Future, TimeoutError as FutureTimeoutError
from time import monotonic
from typing import Any, Awaitable, Callable

from remnic_hermes.client import RemnicClient
from remnic_hermes.config import RemnicHermesConfig

try:  # Hermes Agent is present when loaded as an installed memory provider.
    from agent.memory_provider import MemoryProvider as HermesMemoryProvider
except Exception:  # pragma: no cover - keeps package importable outside Hermes.
    HermesMemoryProvider = object


_NAMESPACE = {"type": "string"}
_STRING_ARRAY = {"type": "array", "items": {"type": "string"}}
_DISCLOSURE = {"type": "string", "enum": ["chunk", "section", "raw"]}
_MEMORY_CATEGORY = {
    "type": "string",
    "enum": [
        "fact",
        "preference",
        "correction",
        "entity",
        "decision",
        "relationship",
        "principle",
        "commitment",
        "moment",
        "skill",
        "rule",
        "procedure",
        "reasoning_trace",
    ],
}
_ACTION_TYPES = [
    "store_episode",
    "store_note",
    "update_note",
    "create_artifact",
    "summarize_node",
    "discard",
    "link_graph",
]
_CONTINUITY_INCIDENT_STATES = ["open", "closed", "all"]
_CONTINUITY_LOOP_CADENCES = ["daily", "weekly", "monthly", "quarterly"]
_CONTINUITY_LOOP_STATUSES = ["active", "paused", "retired"]
_REVIEW_FILTERS = ["all", "unresolved", "contradicts", "independent", "duplicates", "needs-user"]
_REVIEW_RESOLUTION_VERBS = ["keep-a", "keep-b", "merge", "both-valid", "needs-more-context"]
_WORK_TASK_ACTIONS = ["create", "get", "list", "update", "transition", "delete"]
_WORK_TASK_STATUSES = ["todo", "in_progress", "blocked", "done", "cancelled"]
_WORK_TASK_PRIORITIES = ["low", "medium", "high"]
_WORK_PROJECT_ACTIONS = ["create", "get", "list", "update", "delete", "link_task"]
_WORK_PROJECT_STATUSES = ["active", "on_hold", "completed", "archived"]
_WORK_BOARD_ACTIONS = ["export_markdown", "export_snapshot", "import_snapshot"]
_SHARED_FEEDBACK_DECISIONS = ["approved", "approved_with_feedback", "rejected"]
_SHARED_FEEDBACK_SEVERITIES = ["low", "medium", "high"]
_GOVERNANCE_MODES = ["shadow", "apply"]

_loop: asyncio.AbstractEventLoop | None = None
_loop_thread: threading.Thread | None = None
_loop_lock = threading.Lock()


def _get_loop() -> asyncio.AbstractEventLoop:
    global _loop, _loop_thread
    with _loop_lock:
        if _loop is not None and not _loop.is_closed():
            return _loop
        loop = asyncio.new_event_loop()
        _loop = loop

        def _run() -> None:
            asyncio.set_event_loop(loop)
            loop.run_forever()

        _loop_thread = threading.Thread(target=_run, daemon=True, name="remnic-hermes-loop")
        _loop_thread.start()
        return loop


def _run_sync(coro: Any, timeout: float) -> Any:
    future = asyncio.run_coroutine_threadsafe(coro, _get_loop())
    try:
        return future.result(timeout=timeout)
    except FutureTimeoutError as err:
        future.cancel()
        raise TimeoutError("Remnic operation timed out") from err


def _schedule(coro: Any) -> None:
    future = asyncio.run_coroutine_threadsafe(coro, _get_loop())

    def _consume_result(done: Any) -> None:
        try:
            done.result()
        except Exception:
            pass

    future.add_done_callback(_consume_result)


def _schema(
    name: str,
    description: str,
    properties: dict[str, Any],
    required: list[str] | None = None,
    *,
    additional_properties: bool = False,
) -> dict[str, Any]:
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": properties,
        "additionalProperties": additional_properties,
    }
    if required:
        parameters["required"] = required
    return {"name": name, "description": description, "parameters": parameters}


def _legacy_schema(schema: dict[str, Any], name: str, description: str) -> dict[str, Any]:
    return {**schema, "name": name, "description": description}


class RemnicMemoryProvider(HermesMemoryProvider):  # type: ignore[misc]
    """MemoryProvider that delegates to the Remnic daemon via HTTP."""

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        cfg = RemnicHermesConfig.from_hermes_config(config or {})
        self._host = cfg.host
        self._port = cfg.port
        self._token = cfg.token
        self._timeout = cfg.timeout
        self._configured_session_key = bool(cfg.session_key)
        self._session_key = cfg.session_key or f"hermes-{uuid.uuid4().hex[:12]}"
        self._client: RemnicClient | None = None
        self._prefetch_cache: OrderedDict[str, tuple[str, float]] = OrderedDict()
        self._prefetch_inflight: set[str] = set()
        self._prefetch_lock = threading.Lock()
        self._prefetch_wait_timeout = min(cfg.timeout, 0.1)
        self._prefetch_cache_ttl = 60.0
        self._prefetch_cache_max_entries = 128

    @property
    def name(self) -> str:
        return "remnic"

    def is_available(self) -> bool:
        return bool(self._token)

    def initialize(self, session_id: Any = "", **kwargs: Any) -> None:
        """Connect to Remnic daemon and verify health."""
        del kwargs
        if isinstance(session_id, str) and session_id and not self._configured_session_key:
            self._session_key = session_id
        _run_sync(self._initialize_async(), self._timeout)

    async def _initialize_async(self) -> None:
        self._client = RemnicClient(
            host=self._host,
            port=self._port,
            token=self._token,
            client_id="hermes",
            timeout=self._timeout,
        )

        try:
            await self._client.health()
        except Exception:
            pass  # Non-fatal — daemon might start later.

    def system_prompt_block(self) -> str:
        return ""

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        if not self._client:
            return ""
        if not query or len(query.split()) < 3:
            return ""

        session_key = session_id or self._session_key
        cache_key = f"{session_key}\0{query}"
        future: Future[Any] | None = None
        with self._prefetch_lock:
            cached = self._get_prefetch_cache_locked(cache_key)
            if cached is not None:
                return cached
            if cache_key not in self._prefetch_inflight:
                future = self._queue_prefetch_locked(cache_key, query, session_key)

        if future is not None:
            try:
                return future.result(timeout=self._prefetch_wait_timeout) or ""
            except FutureTimeoutError:
                return ""
            except Exception:
                return ""

        return ""

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        if not self._client:
            return
        if not query or len(query.split()) < 3:
            return

        session_key = session_id or self._session_key
        cache_key = f"{session_key}\0{query}"
        with self._prefetch_lock:
            if self._get_prefetch_cache_locked(cache_key) is not None or cache_key in self._prefetch_inflight:
                return
            self._queue_prefetch_locked(cache_key, query, session_key)

    def _get_prefetch_cache_locked(self, cache_key: str) -> str | None:
        cached = self._prefetch_cache.get(cache_key)
        if cached is None:
            return None
        block, inserted_at = cached
        if monotonic() - inserted_at > self._prefetch_cache_ttl:
            self._prefetch_cache.pop(cache_key, None)
            return None
        self._prefetch_cache.move_to_end(cache_key)
        return block

    def _set_prefetch_cache_locked(self, cache_key: str, block: str) -> None:
        self._prefetch_cache[cache_key] = (block, monotonic())
        self._prefetch_cache.move_to_end(cache_key)
        while len(self._prefetch_cache) > self._prefetch_cache_max_entries:
            self._prefetch_cache.popitem(last=False)

    def _clear_prefetch_cache(self, session_key: str | None = None) -> None:
        with self._prefetch_lock:
            if session_key is None:
                self._prefetch_cache.clear()
                return
            prefix = f"{session_key}\0"
            for cache_key in list(self._prefetch_cache.keys()):
                if cache_key.startswith(prefix):
                    self._prefetch_cache.pop(cache_key, None)

    async def _client_call(self, operation: Callable[[RemnicClient], Awaitable[Any]]) -> Any:
        client = self._client
        if not client:
            return {"error": "Not connected to Remnic"}

        async def call() -> Any:
            return await operation(client)

        provider_loop = _get_loop()
        try:
            running_loop = asyncio.get_running_loop()
        except RuntimeError:
            running_loop = None
        if running_loop is provider_loop:
            return await call()

        future = asyncio.run_coroutine_threadsafe(call(), provider_loop)
        return await asyncio.wrap_future(future)

    def _queue_prefetch_locked(self, cache_key: str, query: str, session_key: str) -> Future[Any]:
        self._prefetch_inflight.add(cache_key)
        future = asyncio.run_coroutine_threadsafe(
            self._prefetch_async(cache_key, query, session_key),
            _get_loop(),
        )

        def _consume_result(done: Future[Any]) -> None:
            try:
                done.result()
            except Exception:
                pass

        future.add_done_callback(_consume_result)
        return future

    async def _prefetch_async(self, cache_key: str, query: str, session_key: str) -> str:
        try:
            block = await self._recall_block(query=query, session_key=session_key)
            if block:
                with self._prefetch_lock:
                    self._set_prefetch_cache_locked(cache_key, block)
            return block
        except Exception:
            return ""
        finally:
            with self._prefetch_lock:
                self._prefetch_inflight.discard(cache_key)

    async def _recall_block(self, *, query: str, session_key: str) -> str:
        if not self._client:
            return ""
        result = await self._client_call(
            lambda client: client.recall(
                query=query,
                session_key=session_key,
                top_k=8,
            )
        )
        context = result.get("context", "")
        count = result.get("count", 0)
        if context and count > 0:
            return f"<remnic-memory count=\"{count}\">\n{context}\n</remnic-memory>"
        return ""

    async def pre_llm_call(self, messages: list[dict[str, str]]) -> str:
        """Recall relevant memories and return context to inject into system prompt."""
        query = ""
        for msg in reversed(messages):
            if msg.get("role") == "user":
                query = msg.get("content", "")
                break

        if not query or len(query.split()) < 3:
            return ""
        try:
            return await self._recall_block(query=query, session_key=self._session_key)
        except Exception:
            return ""

    def sync_turn(
        self,
        user_content: str | list[dict[str, Any]],
        assistant_content: str | None = None,
        *,
        session_id: str = "",
    ) -> None:
        """Observe the latest conversation turn."""
        if not self._client:
            return

        if isinstance(user_content, list):
            if not user_content:
                return
            messages = user_content[-2:] if len(user_content) >= 2 else user_content
        else:
            messages = [{"role": "user", "content": user_content}]
            if assistant_content:
                messages.append({"role": "assistant", "content": assistant_content})

        session_key = session_id or self._session_key
        _schedule(self._observe_and_invalidate_async(session_key=session_key, messages=messages))

    async def _observe_and_invalidate_async(self, *, session_key: str, messages: list[dict[str, Any]]) -> None:
        if not self._client:
            return
        await self._client_call(
            lambda client: client.observe(
                session_key=session_key,
                messages=messages,
            )
        )
        self._clear_prefetch_cache(session_key)

    def on_session_end(self, messages: list[dict[str, Any]]) -> None:
        self._observe_messages(messages)

    def on_pre_compress(self, messages: list[dict[str, Any]]) -> str:
        self._observe_messages(messages)
        return ""

    async def extract_memories(self, session: dict[str, Any]) -> None:
        """Structured extraction at session end — send full transcript for deep analysis."""
        if not self._client:
            return
        messages = session.get("messages", [])
        if not messages:
            return
        try:
            await self._client_call(
                lambda client: client.observe(
                    session_key=self._session_key,
                    messages=messages,
                )
            )
            self._clear_prefetch_cache(self._session_key)
        except Exception:
            pass

    def _observe_messages(self, messages: list[dict[str, Any]]) -> None:
        if not self._client:
            return

        if not messages:
            return

        try:
            _run_sync(
                self._client.observe(
                    session_key=self._session_key,
                    messages=messages,
                ),
                self._timeout,
            )
            self._clear_prefetch_cache(self._session_key)
        except Exception:
            pass

    def on_session_switch(
        self,
        new_session_id: str,
        *,
        parent_session_id: str = "",
        reset: bool = False,
        **kwargs: Any,
    ) -> None:
        """Refresh daemon session scoping when Hermes rotates its session id."""
        del parent_session_id, reset, kwargs
        if self._configured_session_key:
            return
        normalized = new_session_id.strip()
        if normalized:
            self._session_key = normalized
            self._clear_prefetch_cache()

    def shutdown(self) -> None:
        """Close the HTTP client."""
        if self._client:
            _run_sync(self._client.close(), self._timeout)
            self._client = None

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        schemas: list[dict[str, Any]] = []
        seen: set[str] = set()
        for attr_name in dir(self):
            if not attr_name.endswith("_schema"):
                continue
            schema = getattr(self, attr_name, None)
            if not isinstance(schema, dict):
                continue
            name = schema.get("name")
            if not isinstance(name, str) or name in seen:
                continue
            schemas.append(schema)
            seen.add(name)
        return sorted(schemas, key=lambda schema: str(schema.get("name", "")))

    def handle_tool_call(self, tool_name: str, args: dict[str, Any], **kwargs: Any) -> str:
        del kwargs
        handler_name = self._handler_name_for_tool(tool_name)
        if not handler_name:
            return json.dumps({"error": f"Unknown Remnic memory tool: {tool_name}"})
        handler = getattr(self, handler_name, None)
        if not callable(handler):
            return json.dumps({"error": f"Remnic memory tool is not implemented: {tool_name}"})
        try:
            return json.dumps(_run_sync(handler(**(args or {})), self._timeout))
        except Exception as err:
            return json.dumps({"error": str(err)})

    def _handler_name_for_tool(self, tool_name: str) -> str | None:
        for attr_name in dir(self):
            if not attr_name.endswith("_schema"):
                continue
            schema = getattr(self, attr_name, None)
            if not isinstance(schema, dict) or schema.get("name") != tool_name:
                continue
            suffix = attr_name.removesuffix("_schema")
            if suffix.startswith("legacy_"):
                suffix = suffix.removeprefix("legacy_")
            return suffix
        return None

    # -- Existing explicit tool schemas for Hermes tool registration --

    recall_schema = _schema(
        "remnic_recall",
        "Recall memories from Remnic matching a natural language query",
        {"query": {"type": "string", "description": "Natural language recall query"}},
        ["query"],
    )
    store_schema = _schema(
        "remnic_store",
        "Store a memory in Remnic for future recall",
        {"content": {"type": "string", "description": "Memory content to store"}},
        ["content"],
        additional_properties=True,
    )
    search_schema = _schema(
        "remnic_search",
        "Full-text search across all Remnic memories",
        {"query": {"type": "string", "description": "Search query"}},
        ["query"],
    )

    legacy_recall_schema = _legacy_schema(
        recall_schema,
        "engram_recall",
        "Recall memories from Engram matching a natural language query",
    )
    legacy_store_schema = _legacy_schema(
        store_schema,
        "engram_store",
        "Store a memory in Engram for future recall",
    )
    legacy_search_schema = _legacy_schema(
        search_schema,
        "engram_search",
        "Full-text search across all Engram memories",
    )

    # -- Issue #804 recall debug / explain tool schemas --

    recall_explain_schema = _schema(
        "remnic_recall_explain",
        "Return the last recall snapshot for a Hermes session or the most recent one.",
        {"sessionKey": {"type": "string"}, "namespace": _NAMESPACE},
    )
    recall_tier_explain_schema = _schema(
        "remnic_recall_tier_explain",
        "Return structured tier attribution for the last direct-answer-eligible recall.",
        {"sessionKey": {"type": "string"}, "namespace": _NAMESPACE},
    )
    recall_xray_schema = _schema(
        "remnic_recall_xray",
        "Run recall with X-ray attribution capture enabled.",
        {
            "query": {"type": "string", "description": "Query to recall against."},
            "sessionKey": {"type": "string"},
            "namespace": _NAMESPACE,
            "budget": {"type": "integer", "minimum": 1},
            "disclosure": _DISCLOSURE,
        },
        ["query"],
    )
    memory_last_recall_schema = _schema(
        "remnic_memory_last_recall",
        "Fetch the last set of memory IDs injected into context for a session.",
        {"sessionKey": {"type": "string"}},
    )
    memory_intent_debug_schema = _schema(
        "remnic_memory_intent_debug",
        "Inspect the last persisted planner/intent snapshot.",
        {"namespace": _NAMESPACE},
    )
    memory_qmd_debug_schema = _schema(
        "remnic_memory_qmd_debug",
        "Inspect the last persisted QMD recall snapshot.",
        {"namespace": _NAMESPACE},
    )
    memory_graph_explain_schema = _schema(
        "remnic_memory_graph_explain",
        "Inspect the last graph-mode recall expansion snapshot.",
        {"namespace": _NAMESPACE},
    )
    memory_feedback_last_recall_schema = _schema(
        "remnic_memory_feedback_last_recall",
        "Record relevance feedback for a memory returned by recall.",
        {
            "memoryId": {"type": "string"},
            "vote": {"type": "string", "enum": ["up", "down"]},
            "note": {"type": "string"},
        },
        ["memoryId", "vote"],
    )
    set_coding_context_schema = _schema(
        "remnic_set_coding_context",
        "Attach or clear coding context for a Hermes session.",
        {
            "sessionKey": {"type": "string"},
            "codingContext": {
                "anyOf": [
                    {"type": "null"},
                    {
                        "type": "object",
                        "properties": {
                            "projectId": {"type": "string"},
                            "branch": {"type": ["string", "null"]},
                            "rootPath": {"type": "string"},
                            "defaultBranch": {"type": ["string", "null"]},
                        },
                        "required": [
                            "projectId",
                            "branch",
                            "rootPath",
                            "defaultBranch",
                        ],
                        "additionalProperties": False,
                    },
                ]
            },
            "projectTag": {"type": "string"},
        },
        ["sessionKey"],
    )
    set_coding_context_schema["parameters"]["anyOf"] = [
        {"required": ["codingContext"]},
        {"required": ["projectTag"]},
    ]
    lcm_search_schema = _schema(
        "remnic_lcm_search",
        "Search the daemon-side Lossless Context Management conversation archive",
        {
            "query": {"type": "string", "description": "Search query"},
            "sessionKey": {"type": "string", "description": "Optional session filter"},
            "namespace": {"type": "string"},
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "Max results to return",
            },
        },
        ["query"],
    )

    legacy_recall_explain_schema = _legacy_schema(
        recall_explain_schema,
        "engram_recall_explain",
        "Return the last Engram recall snapshot for a session or the most recent one.",
    )
    legacy_recall_tier_explain_schema = _legacy_schema(
        recall_tier_explain_schema,
        "engram_recall_tier_explain",
        "Return structured Engram tier attribution for the last recall.",
    )
    legacy_recall_xray_schema = _legacy_schema(
        recall_xray_schema,
        "engram_recall_xray",
        "Run Engram recall with X-ray attribution capture enabled.",
    )
    legacy_memory_last_recall_schema = _legacy_schema(
        memory_last_recall_schema,
        "engram_memory_last_recall",
        "Fetch the last set of Engram memory IDs injected into context.",
    )
    legacy_memory_intent_debug_schema = _legacy_schema(
        memory_intent_debug_schema,
        "engram_memory_intent_debug",
        "Inspect the last persisted Engram planner/intent snapshot.",
    )
    legacy_memory_qmd_debug_schema = _legacy_schema(
        memory_qmd_debug_schema,
        "engram_memory_qmd_debug",
        "Inspect the last persisted Engram QMD recall snapshot.",
    )
    legacy_memory_graph_explain_schema = _legacy_schema(
        memory_graph_explain_schema,
        "engram_memory_graph_explain",
        "Inspect the last Engram graph-mode recall expansion snapshot.",
    )
    legacy_memory_feedback_last_recall_schema = _legacy_schema(
        memory_feedback_last_recall_schema,
        "engram_memory_feedback_last_recall",
        "Record Engram relevance feedback for a memory returned by recall.",
    )
    legacy_set_coding_context_schema = _legacy_schema(
        set_coding_context_schema,
        "engram_set_coding_context",
        "Attach or clear coding context for an Engram session.",
    )
    legacy_lcm_search_schema = _legacy_schema(
        lcm_search_schema,
        "engram_lcm_search",
        "Search the daemon-side Engram Lossless Context Management conversation archive",
    )

    # -- Issue #805 memory CRUD / inspection tool schemas --

    memory_get_schema = _schema(
        "remnic_memory_get",
        "Fetch one stored memory by id.",
        {"memoryId": {"type": "string"}, "namespace": _NAMESPACE},
        ["memoryId"],
    )
    memory_store_schema = _schema(
        "remnic_memory_store",
        "Store a memory with the daemon's rich memory_store schema.",
        {
            "schemaVersion": {"type": "number"},
            "idempotencyKey": {"type": "string"},
            "dryRun": {"type": "boolean"},
            "sessionKey": {"type": "string"},
            "content": {"type": "string"},
            "category": {"type": "string"},
            "confidence": {"type": "number"},
            "namespace": _NAMESPACE,
            "tags": _STRING_ARRAY,
            "entityRef": {"type": "string"},
            "ttl": {"type": "string"},
            "sourceReason": {"type": "string"},
        },
        ["content"],
    )
    memory_timeline_schema = _schema(
        "remnic_memory_timeline",
        "Read the event timeline for a stored memory.",
        {"memoryId": {"type": "string"}, "namespace": _NAMESPACE, "limit": {"type": "number"}},
        ["memoryId"],
    )
    memory_profile_schema = _schema(
        "remnic_memory_profile",
        "Read the user's behavioral profile.",
        {"namespace": _NAMESPACE},
    )
    memory_entities_schema = _schema(
        "remnic_memory_entities",
        "List tracked entities.",
        {"namespace": _NAMESPACE},
    )
    memory_questions_schema = _schema(
        "remnic_memory_questions",
        "List open memory questions.",
        {"namespace": _NAMESPACE},
    )
    memory_identity_schema = _schema(
        "remnic_memory_identity",
        "Read identity memory state.",
        {"namespace": _NAMESPACE},
    )
    memory_promote_schema = _schema(
        "remnic_memory_promote",
        "Promote a memory candidate or review item.",
        {
            "memoryId": {"type": "string"},
            "namespace": _NAMESPACE,
            "sessionKey": {"type": "string"},
        },
        ["memoryId"],
    )
    memory_outcome_schema = _schema(
        "remnic_memory_outcome",
        "Record or inspect an outcome for a memory action.",
        {
            "memoryId": {"type": "string"},
            "outcome": {"type": "string", "enum": ["success", "failure"]},
            "namespace": _NAMESPACE,
            "sessionKey": {"type": "string"},
            "timestamp": {
                "type": "string",
                "description": "Optional ISO-8601 timestamp of the observation.",
            },
        },
        ["memoryId", "outcome"],
    )
    entity_get_schema = _schema(
        "remnic_entity_get",
        "Fetch one tracked entity by name.",
        {"name": {"type": "string"}, "namespace": _NAMESPACE},
        ["name"],
    )
    memory_capture_schema = _schema(
        "remnic_memory_capture",
        "Capture an explicit memory using the OpenClaw memory_capture surface.",
        {
            "content": {"type": "string"},
            "namespace": _NAMESPACE,
            "category": _MEMORY_CATEGORY,
            "tags": _STRING_ARRAY,
            "entityRef": {"type": "string"},
            "confidence": {"type": "number"},
            "ttl": {"type": "string"},
            "sourceReason": {"type": "string"},
        },
        ["content"],
    )
    memory_action_apply_schema = _schema(
        "remnic_memory_action_apply",
        "Apply a memory action using the OpenClaw memory_action_apply surface.",
        {
            "action": {
                "type": "string",
                "enum": _ACTION_TYPES,
            },
            "category": _MEMORY_CATEGORY,
            "content": {"type": "string"},
            "outcome": {"type": "string", "enum": ["applied", "skipped", "failed"]},
            "reason": {"type": "string"},
            "memoryId": {"type": "string"},
            "sessionKey": {"type": "string"},
            "linkTargetId": {"type": "string"},
            "linkType": {"type": "string"},
            "linkStrength": {"type": "number"},
            "artifactType": {"type": "string"},
            "execute": {"type": "boolean"},
            "sourcePrompt": {"type": "string"},
            "namespace": _NAMESPACE,
            "dryRun": {"type": "boolean"},
        },
        ["action"],
    )

    legacy_memory_get_schema = _legacy_schema(memory_get_schema, "engram_memory_get", "Fetch one Engram memory by id.")
    legacy_memory_store_schema = _legacy_schema(memory_store_schema, "engram_memory_store", "Store a memory in Engram.")
    legacy_memory_timeline_schema = _legacy_schema(
        memory_timeline_schema,
        "engram_memory_timeline",
        "Read an Engram memory timeline.",
    )
    legacy_memory_profile_schema = _legacy_schema(
        memory_profile_schema,
        "engram_memory_profile",
        "Read the Engram behavioral profile.",
    )
    legacy_memory_entities_schema = _legacy_schema(
        memory_entities_schema,
        "engram_memory_entities",
        "List Engram tracked entities.",
    )
    legacy_memory_questions_schema = _legacy_schema(
        memory_questions_schema,
        "engram_memory_questions",
        "List Engram memory questions.",
    )
    legacy_memory_identity_schema = _legacy_schema(
        memory_identity_schema,
        "engram_memory_identity",
        "Read Engram identity memory state.",
    )
    legacy_memory_promote_schema = _legacy_schema(
        memory_promote_schema,
        "engram_memory_promote",
        "Promote an Engram memory candidate.",
    )
    legacy_memory_outcome_schema = _legacy_schema(
        memory_outcome_schema,
        "engram_memory_outcome",
        "Record or inspect an Engram memory outcome.",
    )
    legacy_entity_get_schema = _legacy_schema(entity_get_schema, "engram_entity_get", "Fetch one Engram tracked entity by name.")
    legacy_memory_capture_schema = _legacy_schema(memory_capture_schema, "engram_memory_capture", "Capture an explicit Engram memory.")
    legacy_memory_action_apply_schema = _legacy_schema(
        memory_action_apply_schema,
        "engram_memory_action_apply",
        "Apply an Engram memory action.",
    )

    # -- Issue #806 continuity / identity tool schemas --

    continuity_audit_generate_schema = _schema(
        "remnic_continuity_audit_generate",
        "Generate a deterministic identity continuity audit report.",
        {
            "period": {"type": "string", "enum": ["weekly", "monthly"]},
            "key": {
                "type": "string",
                "description": "Period key (weekly: YYYY-Www, monthly: YYYY-MM). Defaults to current.",
            },
        },
    )
    continuity_incident_open_schema = _schema(
        "remnic_continuity_incident_open",
        "Create a new continuity incident record in append-only storage.",
        {
            "symptom": {
                "type": "string",
                "description": "Observed continuity failure symptom.",
            },
            "namespace": _NAMESPACE,
            "triggerWindow": {
                "type": "string",
                "description": "Time window when incident occurred.",
            },
            "suspectedCause": {"type": "string"},
        },
        ["symptom"],
    )
    continuity_incident_close_schema = _schema(
        "remnic_continuity_incident_close",
        "Close an open continuity incident with verification details.",
        {
            "id": {"type": "string", "description": "Incident ID to close."},
            "namespace": _NAMESPACE,
            "fixApplied": {"type": "string", "description": "What fix was applied."},
            "verificationResult": {"type": "string", "description": "How closure was verified."},
            "preventiveRule": {"type": "string", "description": "Optional preventive follow-up rule."},
        },
        ["id", "fixApplied", "verificationResult"],
    )
    continuity_incident_list_schema = _schema(
        "remnic_continuity_incident_list",
        "List continuity incidents, optionally filtered by state.",
        {
            "state": {"type": "string", "enum": _CONTINUITY_INCIDENT_STATES},
            "namespace": _NAMESPACE,
            "limit": {
                "type": "number",
                "description": "Max incidents (default 25, max 200).",
            },
        },
    )
    continuity_loop_add_or_update_schema = _schema(
        "remnic_continuity_loop_add_or_update",
        "Add or update a continuity improvement loop entry.",
        {
            "id": {"type": "string", "description": "Stable loop identifier."},
            "cadence": {"type": "string", "enum": _CONTINUITY_LOOP_CADENCES},
            "purpose": {"type": "string", "description": "What this recurring loop improves."},
            "status": {"type": "string", "enum": _CONTINUITY_LOOP_STATUSES},
            "killCondition": {
                "type": "string",
                "description": "Clear condition for retiring this loop.",
            },
            "namespace": _NAMESPACE,
            "lastReviewed": {
                "type": "string",
                "description": "ISO timestamp for last review.",
            },
            "notes": {"type": "string"},
        },
        ["id", "cadence", "purpose", "status", "killCondition"],
    )
    continuity_loop_review_schema = _schema(
        "remnic_continuity_loop_review",
        "Update review metadata for an existing continuity improvement loop.",
        {
            "id": {"type": "string", "description": "Loop ID to review."},
            "namespace": _NAMESPACE,
            "status": {"type": "string", "enum": _CONTINUITY_LOOP_STATUSES},
            "notes": {"type": "string"},
            "reviewedAt": {
                "type": "string",
                "description": "ISO timestamp for review event.",
            },
        },
        ["id"],
    )
    identity_anchor_get_schema = _schema(
        "remnic_identity_anchor_get",
        "Read the identity continuity anchor document.",
        {"namespace": _NAMESPACE},
    )
    identity_anchor_update_schema = _schema(
        "remnic_identity_anchor_update",
        "Conservatively merge identity anchor sections without overwriting existing material.",
        {
            "namespace": _NAMESPACE,
            "identityTraits": {
                "type": "string",
                "description": "Updates for 'Identity Traits' section.",
            },
            "communicationPreferences": {
                "type": "string",
                "description": "Updates for 'Communication Preferences' section.",
            },
            "operatingPrinciples": {
                "type": "string",
                "description": "Updates for 'Operating Principles' section.",
            },
            "continuityNotes": {
                "type": "string",
                "description": "Updates for 'Continuity Notes' section.",
            },
        },
    )

    legacy_continuity_audit_generate_schema = _legacy_schema(
        continuity_audit_generate_schema,
        "engram_continuity_audit_generate",
        "Generate a deterministic Engram identity continuity audit report.",
    )
    legacy_continuity_incident_open_schema = _legacy_schema(
        continuity_incident_open_schema,
        "engram_continuity_incident_open",
        "Create a new Engram continuity incident record.",
    )
    legacy_continuity_incident_close_schema = _legacy_schema(
        continuity_incident_close_schema,
        "engram_continuity_incident_close",
        "Close an open Engram continuity incident.",
    )
    legacy_continuity_incident_list_schema = _legacy_schema(
        continuity_incident_list_schema,
        "engram_continuity_incident_list",
        "List Engram continuity incidents.",
    )
    legacy_continuity_loop_add_or_update_schema = _legacy_schema(
        continuity_loop_add_or_update_schema,
        "engram_continuity_loop_add_or_update",
        "Add or update an Engram continuity improvement loop.",
    )
    legacy_continuity_loop_review_schema = _legacy_schema(
        continuity_loop_review_schema,
        "engram_continuity_loop_review",
        "Update review metadata for an Engram continuity improvement loop.",
    )
    legacy_identity_anchor_get_schema = _legacy_schema(
        identity_anchor_get_schema,
        "engram_identity_anchor_get",
        "Read the Engram identity continuity anchor document.",
    )
    legacy_identity_anchor_update_schema = _legacy_schema(
        identity_anchor_update_schema,
        "engram_identity_anchor_update",
        "Conservatively merge Engram identity anchor sections.",
    )

    # -- Issue #807 review queue / suggestions tool schemas --

    review_queue_list_schema = _schema(
        "remnic_review_queue_list",
        "Fetch the latest review queue artifact bundle.",
        {"runId": {"type": "string"}, "namespace": _NAMESPACE},
    )
    review_list_schema = _schema(
        "remnic_review_list",
        "List contradiction review items pending user resolution.",
        {
            "filter": {
                "type": "string",
                "enum": _REVIEW_FILTERS,
                "description": "Filter by verdict type. Default: unresolved.",
            },
            "namespace": _NAMESPACE,
            "limit": {"type": "number", "description": "Max items to return (default 50)."},
        },
    )
    review_resolve_schema = _schema(
        "remnic_review_resolve",
        "Resolve a contradiction pair with a chosen verb.",
        {
            "pairId": {
                "type": "string",
                "description": "The contradiction pair ID to resolve.",
            },
            "verb": {
                "type": "string",
                "enum": _REVIEW_RESOLUTION_VERBS,
                "description": "Resolution action.",
            },
            "mergedMemoryId": {
                "type": "string",
                "description": "Existing merged memory ID to use when verb is merge.",
            },
            "mergedContent": {
                "type": "string",
                "description": "Content for a new merged memory when verb is merge.",
            },
        },
        ["pairId", "verb"],
    )
    suggestion_submit_schema = _schema(
        "remnic_suggestion_submit",
        "Queue a suggested memory for review.",
        {
            "schemaVersion": {"type": "number"},
            "idempotencyKey": {"type": "string"},
            "dryRun": {"type": "boolean"},
            "sessionKey": {"type": "string"},
            "content": {"type": "string"},
            "category": {"type": "string"},
            "confidence": {"type": "number"},
            "namespace": _NAMESPACE,
            "tags": _STRING_ARRAY,
            "entityRef": {"type": "string"},
            "ttl": {"type": "string"},
            "sourceReason": {"type": "string"},
        },
        ["content"],
    )

    legacy_review_queue_list_schema = _legacy_schema(
        review_queue_list_schema,
        "engram_review_queue_list",
        "Fetch the latest Engram review queue artifact bundle.",
    )
    legacy_review_list_schema = _legacy_schema(
        review_list_schema,
        "engram_review_list",
        "List Engram contradiction review items pending user resolution.",
    )
    legacy_review_resolve_schema = _legacy_schema(
        review_resolve_schema,
        "engram_review_resolve",
        "Resolve an Engram contradiction pair with a chosen verb.",
    )
    legacy_suggestion_submit_schema = _legacy_schema(
        suggestion_submit_schema,
        "engram_suggestion_submit",
        "Queue a suggested Engram memory for review.",
    )

    # -- Issue #808 work boards / peer co-tracking tool schemas --

    work_task_schema = _schema(
        "remnic_work_task",
        "Manage work-layer tasks (create, get, list, update, transition, delete).",
        {
            "action": {"type": "string", "enum": _WORK_TASK_ACTIONS},
            "id": {"type": "string"},
            "title": {"type": "string"},
            "description": {"type": "string"},
            "status": {"type": "string", "enum": _WORK_TASK_STATUSES},
            "priority": {"type": "string", "enum": _WORK_TASK_PRIORITIES},
            "owner": {"type": "string"},
            "assignee": {"type": "string"},
            "projectId": {"type": "string"},
            "tags": _STRING_ARRAY,
            "dueAt": {"type": "string"},
        },
        ["action"],
    )
    work_project_schema = _schema(
        "remnic_work_project",
        "Manage work-layer projects (create, get, list, update, delete, link_task).",
        {
            "action": {"type": "string", "enum": _WORK_PROJECT_ACTIONS},
            "id": {"type": "string"},
            "name": {"type": "string"},
            "description": {"type": "string"},
            "status": {"type": "string", "enum": _WORK_PROJECT_STATUSES},
            "owner": {"type": "string"},
            "tags": _STRING_ARRAY,
            "taskId": {"type": "string", "description": "Task ID for link_task."},
            "projectId": {"type": "string", "description": "Project ID for link_task."},
        },
        ["action"],
    )
    work_board_schema = _schema(
        "remnic_work_board",
        "Export/import work-layer board snapshots and markdown.",
        {
            "action": {"type": "string", "enum": _WORK_BOARD_ACTIONS},
            "projectId": {"type": "string"},
            "snapshotJson": {"type": "string", "description": "Snapshot JSON for import_snapshot."},
            "linkToMemory": {
                "type": "boolean",
                "description": "If true, output can be retained as long-term memory.",
            },
        },
        ["action"],
    )

    legacy_work_task_schema = _legacy_schema(
        work_task_schema,
        "engram_work_task",
        "Manage Engram work-layer tasks.",
    )
    legacy_work_project_schema = _legacy_schema(
        work_project_schema,
        "engram_work_project",
        "Manage Engram work-layer projects.",
    )
    legacy_work_board_schema = _legacy_schema(
        work_board_schema,
        "engram_work_board",
        "Export/import Engram work-layer board snapshots and markdown.",
    )

    # -- Issue #809 shared context / peer modeling tool schemas --

    shared_context_write_output_schema = _schema(
        "remnic_shared_context_write_output",
        "Write agent work product into the shared-context directory.",
        {
            "agentId": {"type": "string", "description": "Agent ID producing this output."},
            "title": {"type": "string", "description": "Short title for the output."},
            "content": {"type": "string", "description": "Markdown content to write."},
        },
        ["agentId", "title", "content"],
    )
    shared_feedback_record_schema = _schema(
        "remnic_shared_feedback_record",
        "Append an approval/rejection decision into the shared-context feedback inbox.",
        {
            "agent": {"type": "string", "description": "Agent name that produced the output."},
            "decision": {"type": "string", "enum": _SHARED_FEEDBACK_DECISIONS},
            "reason": {"type": "string"},
            "date": {"type": "string", "description": "ISO timestamp. Defaults to now."},
            "learning": {"type": "string"},
            "outcome": {"type": "string"},
            "severity": {"type": "string", "enum": _SHARED_FEEDBACK_SEVERITIES},
            "confidence": {"type": "number", "description": "Confidence 0-1."},
            "workflow": {"type": "string"},
            "tags": _STRING_ARRAY,
            "evidenceWindowStart": {"type": "string"},
            "evidenceWindowEnd": {"type": "string"},
            "refs": _STRING_ARRAY,
        },
        ["agent", "decision", "reason"],
    )
    shared_priorities_append_schema = _schema(
        "remnic_shared_priorities_append",
        "Append priorities text into the shared-context inbox.",
        {
            "agentId": {"type": "string"},
            "text": {"type": "string", "description": "Priority notes (markdown)."},
        },
        ["agentId", "text"],
    )
    shared_context_cross_signals_run_schema = _schema(
        "remnic_shared_context_cross_signals_run",
        "Generate cross-signal markdown and JSON artifacts.",
        {"date": {"type": "string", "description": "YYYY-MM-DD. Defaults to today."}},
    )
    shared_context_curate_daily_schema = _schema(
        "remnic_shared_context_curate_daily",
        "Generate a daily roundtable summary.",
        {"date": {"type": "string", "description": "YYYY-MM-DD. Defaults to today."}},
    )

    legacy_shared_context_write_output_schema = _legacy_schema(
        shared_context_write_output_schema,
        "engram_shared_context_write_output",
        "Write agent work product into the Engram shared-context directory.",
    )
    legacy_shared_feedback_record_schema = _legacy_schema(
        shared_feedback_record_schema,
        "engram_shared_feedback_record",
        "Append an approval/rejection decision into the Engram shared-context feedback inbox.",
    )
    legacy_shared_priorities_append_schema = _legacy_schema(
        shared_priorities_append_schema,
        "engram_shared_priorities_append",
        "Append priorities text into the Engram shared-context inbox.",
    )
    legacy_shared_context_cross_signals_run_schema = _legacy_schema(
        shared_context_cross_signals_run_schema,
        "engram_shared_context_cross_signals_run",
        "Generate Engram cross-signal markdown and JSON artifacts.",
    )
    legacy_shared_context_curate_daily_schema = _legacy_schema(
        shared_context_curate_daily_schema,
        "engram_shared_context_curate_daily",
        "Generate an Engram daily roundtable summary.",
    )

    # -- Issue #810 compounding learning tool schemas --

    compounding_weekly_synthesize_schema = _schema(
        "remnic_compounding_weekly_synthesize",
        "Generate weekly compounding outputs.",
        {"weekId": {"type": "string", "description": "ISO week ID (YYYY-Www). Defaults to current week."}},
    )
    compounding_promote_candidate_schema = _schema(
        "remnic_compounding_promote_candidate",
        "Promote a compounding candidate into durable memory.",
        {
            "weekId": {"type": "string"},
            "candidateId": {"type": "string"},
            "dryRun": {"type": "boolean", "description": "Preview without writing."},
        },
        ["weekId", "candidateId"],
    )

    legacy_compounding_weekly_synthesize_schema = _legacy_schema(
        compounding_weekly_synthesize_schema,
        "engram_compounding_weekly_synthesize",
        "Generate weekly Engram compounding outputs.",
    )
    legacy_compounding_promote_candidate_schema = _legacy_schema(
        compounding_promote_candidate_schema,
        "engram_compounding_promote_candidate",
        "Promote an Engram compounding candidate into durable memory.",
    )

    # -- Issue #811 compression guideline policy tool schemas --

    compression_guidelines_optimize_schema = _schema(
        "remnic_compression_guidelines_optimize",
        "Run the compression guideline optimizer.",
        {
            "dryRun": {"type": "boolean"},
            "eventLimit": {"type": "number"},
        },
    )
    compression_guidelines_activate_schema = _schema(
        "remnic_compression_guidelines_activate",
        "Promote a staged compression guideline draft to active.",
        {
            "expectedContentHash": {"type": "string"},
            "expectedGuidelineVersion": {"type": "number"},
        },
    )

    legacy_compression_guidelines_optimize_schema = _legacy_schema(
        compression_guidelines_optimize_schema,
        "engram_compression_guidelines_optimize",
        "Run the Engram compression guideline optimizer.",
    )
    legacy_compression_guidelines_activate_schema = _legacy_schema(
        compression_guidelines_activate_schema,
        "engram_compression_guidelines_activate",
        "Promote a staged Engram compression guideline draft to active.",
    )

    # -- Issue #812 governance / hygiene tool schemas --

    memory_governance_run_schema = _schema(
        "remnic_memory_governance_run",
        "Run Remnic memory governance in a bounded shadow/apply pass.",
        {
            "namespace": _NAMESPACE,
            "mode": {"type": "string", "enum": _GOVERNANCE_MODES},
            "recentDays": {"type": "number"},
            "maxMemories": {"type": "number"},
            "batchSize": {"type": "number"},
        },
    )
    procedure_mining_run_schema = _schema(
        "remnic_procedure_mining_run",
        "Run procedural memory mining.",
        {"namespace": _NAMESPACE},
    )
    procedural_stats_schema = _schema(
        "remnic_procedural_stats",
        "Read procedural memory stats.",
        {"namespace": _NAMESPACE},
    )
    contradiction_scan_run_schema = _schema(
        "remnic_contradiction_scan_run",
        "Run an on-demand contradiction scan over the memory corpus.",
        {"namespace": _NAMESPACE},
    )
    memory_summarize_hourly_schema = _schema(
        "remnic_memory_summarize_hourly",
        "Generate hourly summaries for recent conversations.",
        {},
    )
    conversation_index_update_schema = _schema(
        "remnic_conversation_index_update",
        "Chunk transcript history into conversation-index documents.",
        {
            "sessionKey": {"type": "string"},
            "hours": {"type": "number", "description": "How many hours of transcript history to include."},
            "embed": {"type": "boolean", "description": "Run QMD embed after update for this invocation."},
        },
    )

    legacy_memory_governance_run_schema = _legacy_schema(
        memory_governance_run_schema,
        "engram_memory_governance_run",
        "Run Engram memory governance in a bounded shadow/apply pass.",
    )
    legacy_procedure_mining_run_schema = _legacy_schema(
        procedure_mining_run_schema,
        "engram_procedure_mining_run",
        "Run Engram procedural memory mining.",
    )
    legacy_procedural_stats_schema = _legacy_schema(
        procedural_stats_schema,
        "engram_procedural_stats",
        "Read Engram procedural memory stats.",
    )
    legacy_contradiction_scan_run_schema = _legacy_schema(
        contradiction_scan_run_schema,
        "engram_contradiction_scan_run",
        "Run an on-demand Engram contradiction scan over the memory corpus.",
    )
    legacy_memory_summarize_hourly_schema = _legacy_schema(
        memory_summarize_hourly_schema,
        "engram_memory_summarize_hourly",
        "Generate hourly summaries for recent Engram conversations.",
    )
    legacy_conversation_index_update_schema = _legacy_schema(
        conversation_index_update_schema,
        "engram_conversation_index_update",
        "Chunk Engram transcript history into conversation-index documents.",
    )

    # -- Issue #813 context recap tool schemas --

    day_summary_schema = _schema(
        "remnic_day_summary",
        "Generate a structured end-of-day summary.",
        {
            "memories": {"type": "string"},
            "sessionKey": {"type": "string"},
            "namespace": _NAMESPACE,
        },
    )
    briefing_schema = _schema(
        "remnic_briefing",
        "Generate a daily context briefing.",
        {
            "since": {"type": "string", "description": "Lookback window, e.g. yesterday, 3d, 1w, or 24h."},
            "focus": {"type": "string", "description": "Optional filter, e.g. person:Jane Doe or project:remnic."},
            "namespace": _NAMESPACE,
            "format": {"type": "string", "enum": ["markdown", "json"]},
            "maxFollowups": {"type": "number"},
        },
    )
    context_checkpoint_schema = _schema(
        "remnic_context_checkpoint",
        "Save a structured context checkpoint for a session.",
        {
            "sessionKey": {"type": "string"},
            "context": {"type": "string"},
            "namespace": _NAMESPACE,
        },
        ["sessionKey", "context"],
    )

    legacy_day_summary_schema = _legacy_schema(
        day_summary_schema,
        "engram_day_summary",
        "Generate a structured Engram end-of-day summary.",
    )
    legacy_briefing_schema = _legacy_schema(
        briefing_schema,
        "engram_briefing",
        "Generate an Engram daily context briefing.",
    )
    legacy_context_checkpoint_schema = _legacy_schema(
        context_checkpoint_schema,
        "engram_context_checkpoint",
        "Save a structured Engram context checkpoint for a session.",
    )

    # -- Issue #814 profiling tool schema --

    profiling_report_schema = _schema(
        "remnic_profiling_report",
        "Return timing and performance data for Remnic recall and extraction pipelines.",
        {
            "format": {"type": "string", "enum": ["ascii", "json"]},
            "limit": {"type": "number", "minimum": 1, "maximum": 20},
        },
    )
    legacy_profiling_report_schema = _legacy_schema(
        profiling_report_schema,
        "engram_profiling_report",
        "Return timing and performance data for Engram recall and extraction pipelines.",
    )

    async def recall(self, query: str, **kwargs: Any) -> dict[str, Any]:
        """Tool handler for remnic_recall / engram_recall."""
        return await self._client_call(lambda client: client.recall(query=query, session_key=self._session_key))

    async def store(self, content: str, **kwargs: Any) -> dict[str, Any]:
        """Tool handler for remnic_store / engram_store."""
        session_key = kwargs.pop("sessionKey", self._session_key)
        return await self._client_call(
            lambda client: client.store(content=content, sessionKey=session_key, **kwargs)
        )

    async def search(self, query: str, **kwargs: Any) -> dict[str, Any]:
        """Tool handler for remnic_search / engram_search."""
        return await self._client_call(lambda client: client.search(query=query))

    async def lcm_search(
        self,
        query: str,
        sessionKey: str = "",
        namespace: str | None = None,
        limit: int | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Tool handler for remnic_lcm_search / engram_lcm_search."""
        return await self._client_call(
            lambda client: client.lcm_search(
                query=query,
                session_key=sessionKey,
                namespace=namespace,
                limit=limit,
            )
        )

    async def recall_explain(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.recall_explain(**kwargs))

    async def recall_tier_explain(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.recall_tier_explain(**kwargs))

    async def recall_xray(self, query: str, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.recall_xray(query=query, **kwargs))

    async def memory_last_recall(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.memory_last_recall(**kwargs))

    async def memory_intent_debug(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.memory_intent_debug(**kwargs))

    async def memory_qmd_debug(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.memory_qmd_debug(**kwargs))

    async def memory_graph_explain(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.memory_graph_explain(**kwargs))

    async def memory_feedback_last_recall(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.memory_feedback_last_recall(**kwargs))

    async def set_coding_context(self, sessionKey: str, **kwargs: Any) -> dict[str, Any]:  # noqa: N803
        return await self._client_call(lambda client: client.set_coding_context(sessionKey, **kwargs))

    async def memory_get(self, memoryId: str, **kwargs: Any) -> dict[str, Any]:  # noqa: N803
        return await self._client_call(lambda client: client.memory_get(memoryId, **kwargs))

    async def memory_store(self, content: str, **kwargs: Any) -> dict[str, Any]:
        session_key = kwargs.pop("sessionKey", self._session_key)
        return await self._client_call(
            lambda client: client.memory_store(content=content, sessionKey=session_key, **kwargs)
        )

    async def memory_timeline(self, memoryId: str, **kwargs: Any) -> dict[str, Any]:  # noqa: N803
        return await self._client_call(lambda client: client.memory_timeline(memoryId, **kwargs))

    async def memory_profile(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.memory_profile(**kwargs))

    async def memory_entities(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.memory_entities(**kwargs))

    async def memory_questions(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.memory_questions(**kwargs))

    async def memory_identity(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.memory_identity(**kwargs))

    async def memory_promote(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.memory_promote(**kwargs))

    async def memory_outcome(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.memory_outcome(**kwargs))

    async def entity_get(self, name: str, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.entity_get(name, **kwargs))

    async def memory_capture(self, content: str, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.memory_capture(content=content, **kwargs))

    async def memory_action_apply(self, action: str, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.memory_action_apply(action=action, **kwargs))

    async def continuity_audit_generate(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.continuity_audit_generate(**kwargs))

    async def continuity_incident_open(self, symptom: str, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.continuity_incident_open(symptom=symptom, **kwargs))

    async def continuity_incident_close(
        self,
        id: str,  # noqa: A002,N803
        fixApplied: str,  # noqa: N803
        verificationResult: str,  # noqa: N803
        **kwargs: Any,
    ) -> dict[str, Any]:
        return await self._client_call(
            lambda client: client.continuity_incident_close(
                incident_id=id,
                fix_applied=fixApplied,
                verification_result=verificationResult,
                **kwargs,
            )
        )

    async def continuity_incident_list(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.continuity_incident_list(**kwargs))

    async def continuity_loop_add_or_update(
        self,
        id: str,  # noqa: A002,N803
        cadence: str,
        purpose: str,
        status: str,
        killCondition: str,  # noqa: N803
        **kwargs: Any,
    ) -> dict[str, Any]:
        return await self._client_call(
            lambda client: client.continuity_loop_add_or_update(
                loop_id=id,
                cadence=cadence,
                purpose=purpose,
                status=status,
                kill_condition=killCondition,
                **kwargs,
            )
        )

    async def continuity_loop_review(self, id: str, **kwargs: Any) -> dict[str, Any]:  # noqa: A002,N803
        return await self._client_call(lambda client: client.continuity_loop_review(loop_id=id, **kwargs))

    async def identity_anchor_get(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.identity_anchor_get(**kwargs))

    async def identity_anchor_update(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.identity_anchor_update(**kwargs))

    async def review_queue_list(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.review_queue_list(**kwargs))

    async def review_list(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.review_list(**kwargs))

    async def review_resolve(self, pairId: str, verb: str, **kwargs: Any) -> dict[str, Any]:  # noqa: N803
        return await self._client_call(lambda client: client.review_resolve(pair_id=pairId, verb=verb, **kwargs))

    async def suggestion_submit(self, content: str, **kwargs: Any) -> dict[str, Any]:
        session_key = kwargs.pop("sessionKey", self._session_key)
        return await self._client_call(
            lambda client: client.suggestion_submit(content=content, sessionKey=session_key, **kwargs)
        )

    async def work_task(self, action: str, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.work_task(action=action, **kwargs))

    async def work_project(self, action: str, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.work_project(action=action, **kwargs))

    async def work_board(self, action: str, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.work_board(action=action, **kwargs))

    async def shared_context_write_output(
        self,
        agentId: str,  # noqa: N803
        title: str,
        content: str,
    ) -> dict[str, Any]:
        return await self._client_call(
            lambda client: client.shared_context_write_output(
                agent_id=agentId,
                title=title,
                content=content,
            )
        )

    async def shared_feedback_record(
        self,
        agent: str,
        decision: str,
        reason: str,
        **kwargs: Any,
    ) -> dict[str, Any]:
        return await self._client_call(
            lambda client: client.shared_feedback_record(
                agent=agent,
                decision=decision,
                reason=reason,
                **kwargs,
            )
        )

    async def shared_priorities_append(self, agentId: str, text: str) -> dict[str, Any]:  # noqa: N803
        return await self._client_call(lambda client: client.shared_priorities_append(agent_id=agentId, text=text))

    async def shared_context_cross_signals_run(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.shared_context_cross_signals_run(**kwargs))

    async def shared_context_curate_daily(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.shared_context_curate_daily(**kwargs))

    async def compounding_weekly_synthesize(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.compounding_weekly_synthesize(**kwargs))

    async def compounding_promote_candidate(
        self,
        weekId: str,  # noqa: N803
        candidateId: str,  # noqa: N803
        **kwargs: Any,
    ) -> dict[str, Any]:
        return await self._client_call(
            lambda client: client.compounding_promote_candidate(
                week_id=weekId,
                candidate_id=candidateId,
                **kwargs,
            )
        )

    async def compression_guidelines_optimize(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.compression_guidelines_optimize(**kwargs))

    async def compression_guidelines_activate(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.compression_guidelines_activate(**kwargs))

    async def memory_governance_run(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.memory_governance_run(**kwargs))

    async def procedure_mining_run(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.procedure_mining_run(**kwargs))

    async def procedural_stats(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.procedural_stats(**kwargs))

    async def contradiction_scan_run(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.contradiction_scan_run(**kwargs))

    async def memory_summarize_hourly(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.memory_summarize_hourly())

    async def conversation_index_update(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.conversation_index_update(**kwargs))

    async def profiling_report(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.profiling_report(**kwargs))

    async def day_summary(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.day_summary(**kwargs))

    async def briefing(self, **kwargs: Any) -> dict[str, Any]:
        return await self._client_call(lambda client: client.briefing(**kwargs))

    async def context_checkpoint(
        self,
        sessionKey: str,  # noqa: N803
        context: str,
        **kwargs: Any,
    ) -> dict[str, Any]:
        return await self._client_call(
            lambda client: client.context_checkpoint(
                session_key=sessionKey,
                context=context,
                **kwargs,
            )
        )


# Legacy class alias — import path compat for pre-rename consumers.
EngramMemoryProvider = RemnicMemoryProvider
