"""Remnic MemoryProvider plugin for Hermes Agent."""

from remnic_hermes.client import RemnicClient
from remnic_hermes.config import RemnicHermesConfig
from remnic_hermes.provider import RemnicMemoryProvider

# Legacy aliases — preserved for the Engram → Remnic compat window.
# These will be removed in a future major release.
EngramMemoryProvider = RemnicMemoryProvider
EngramClient = RemnicClient
EngramHermesConfig = RemnicHermesConfig

__all__ = [
    "RemnicMemoryProvider",
    "RemnicClient",
    "RemnicHermesConfig",
    "EngramMemoryProvider",
    "EngramClient",
    "EngramHermesConfig",
    "register",
]

_RECALL_DEBUG_TOOLS = [
    ("recall_explain", "recall_explain"),
    ("recall_tier_explain", "recall_tier_explain"),
    ("recall_xray", "recall_xray"),
    ("memory_last_recall", "memory_last_recall"),
    ("memory_intent_debug", "memory_intent_debug"),
    ("memory_qmd_debug", "memory_qmd_debug"),
    ("memory_graph_explain", "memory_graph_explain"),
    ("memory_feedback_last_recall", "memory_feedback_last_recall"),
    ("set_coding_context", "set_coding_context"),
]


def _register_recall_debug_tools(ctx, provider: RemnicMemoryProvider, prefix: str, legacy: bool = False):  # type: ignore[no-untyped-def]
    schema_prefix = "legacy_" if legacy else ""
    for tool_suffix, handler_name in _RECALL_DEBUG_TOOLS:
        ctx.register_tool(
            f"{prefix}_{tool_suffix}",
            getattr(provider, f"{schema_prefix}{tool_suffix}_schema"),
            getattr(provider, handler_name),
        )


def _register_issue_805_tools(  # type: ignore[no-untyped-def]
    ctx,
    provider: RemnicMemoryProvider,
    prefix: str,
    legacy: bool = False,
):
    schema_prefix = "legacy_" if legacy else ""
    ctx.register_tool(
        f"{prefix}_memory_get",
        getattr(provider, f"{schema_prefix}memory_get_schema"),
        provider.memory_get,
    )
    ctx.register_tool(
        f"{prefix}_memory_store",
        getattr(provider, f"{schema_prefix}memory_store_schema"),
        provider.memory_store,
    )
    ctx.register_tool(
        f"{prefix}_memory_timeline",
        getattr(provider, f"{schema_prefix}memory_timeline_schema"),
        provider.memory_timeline,
    )
    ctx.register_tool(
        f"{prefix}_memory_profile",
        getattr(provider, f"{schema_prefix}memory_profile_schema"),
        provider.memory_profile,
    )
    ctx.register_tool(
        f"{prefix}_memory_entities",
        getattr(provider, f"{schema_prefix}memory_entities_schema"),
        provider.memory_entities,
    )
    ctx.register_tool(
        f"{prefix}_memory_questions",
        getattr(provider, f"{schema_prefix}memory_questions_schema"),
        provider.memory_questions,
    )
    ctx.register_tool(
        f"{prefix}_memory_identity",
        getattr(provider, f"{schema_prefix}memory_identity_schema"),
        provider.memory_identity,
    )
    ctx.register_tool(
        f"{prefix}_memory_promote",
        getattr(provider, f"{schema_prefix}memory_promote_schema"),
        provider.memory_promote,
    )
    ctx.register_tool(
        f"{prefix}_memory_outcome",
        getattr(provider, f"{schema_prefix}memory_outcome_schema"),
        provider.memory_outcome,
    )
    ctx.register_tool(f"{prefix}_entity_get", getattr(provider, f"{schema_prefix}entity_get_schema"), provider.entity_get)
    ctx.register_tool(f"{prefix}_memory_capture", getattr(provider, f"{schema_prefix}memory_capture_schema"), provider.memory_capture)
    ctx.register_tool(
        f"{prefix}_memory_action_apply",
        getattr(provider, f"{schema_prefix}memory_action_apply_schema"),
        provider.memory_action_apply,
    )


_CONTINUITY_IDENTITY_TOOLS = [
    ("continuity_audit_generate", "continuity_audit_generate"),
    ("continuity_incident_open", "continuity_incident_open"),
    ("continuity_incident_close", "continuity_incident_close"),
    ("continuity_incident_list", "continuity_incident_list"),
    ("continuity_loop_add_or_update", "continuity_loop_add_or_update"),
    ("continuity_loop_review", "continuity_loop_review"),
    ("identity_anchor_get", "identity_anchor_get"),
    ("identity_anchor_update", "identity_anchor_update"),
]


def _register_issue_806_tools(  # type: ignore[no-untyped-def]
    ctx,
    provider: RemnicMemoryProvider,
    prefix: str,
    legacy: bool = False,
):
    schema_prefix = "legacy_" if legacy else ""
    for tool_suffix, handler_name in _CONTINUITY_IDENTITY_TOOLS:
        ctx.register_tool(
            f"{prefix}_{tool_suffix}",
            getattr(provider, f"{schema_prefix}{tool_suffix}_schema"),
            getattr(provider, handler_name),
        )


_REVIEW_SUGGESTION_TOOLS = [
    ("review_queue_list", "review_queue_list"),
    ("review_list", "review_list"),
    ("review_resolve", "review_resolve"),
    ("suggestion_submit", "suggestion_submit"),
]


def _register_issue_807_tools(  # type: ignore[no-untyped-def]
    ctx,
    provider: RemnicMemoryProvider,
    prefix: str,
    legacy: bool = False,
):
    schema_prefix = "legacy_" if legacy else ""
    for tool_suffix, handler_name in _REVIEW_SUGGESTION_TOOLS:
        ctx.register_tool(
            f"{prefix}_{tool_suffix}",
            getattr(provider, f"{schema_prefix}{tool_suffix}_schema"),
            getattr(provider, handler_name),
        )


_WORK_BOARD_TOOLS = [
    ("work_task", "work_task"),
    ("work_project", "work_project"),
    ("work_board", "work_board"),
]


def _register_issue_808_tools(  # type: ignore[no-untyped-def]
    ctx,
    provider: RemnicMemoryProvider,
    prefix: str,
    legacy: bool = False,
):
    schema_prefix = "legacy_" if legacy else ""
    for tool_suffix, handler_name in _WORK_BOARD_TOOLS:
        ctx.register_tool(
            f"{prefix}_{tool_suffix}",
            getattr(provider, f"{schema_prefix}{tool_suffix}_schema"),
            getattr(provider, handler_name),
        )


_SHARED_CONTEXT_TOOLS = [
    ("shared_context_write_output", "shared_context_write_output"),
    ("shared_feedback_record", "shared_feedback_record"),
    ("shared_priorities_append", "shared_priorities_append"),
    ("shared_context_cross_signals_run", "shared_context_cross_signals_run"),
    ("shared_context_curate_daily", "shared_context_curate_daily"),
]


def _register_issue_809_tools(  # type: ignore[no-untyped-def]
    ctx,
    provider: RemnicMemoryProvider,
    prefix: str,
    legacy: bool = False,
):
    schema_prefix = "legacy_" if legacy else ""
    for tool_suffix, handler_name in _SHARED_CONTEXT_TOOLS:
        ctx.register_tool(
            f"{prefix}_{tool_suffix}",
            getattr(provider, f"{schema_prefix}{tool_suffix}_schema"),
            getattr(provider, handler_name),
        )


_COMPOUNDING_TOOLS = [
    ("compounding_weekly_synthesize", "compounding_weekly_synthesize"),
    ("compounding_promote_candidate", "compounding_promote_candidate"),
]


def _register_issue_810_tools(  # type: ignore[no-untyped-def]
    ctx,
    provider: RemnicMemoryProvider,
    prefix: str,
    legacy: bool = False,
):
    schema_prefix = "legacy_" if legacy else ""
    for tool_suffix, handler_name in _COMPOUNDING_TOOLS:
        ctx.register_tool(
            f"{prefix}_{tool_suffix}",
            getattr(provider, f"{schema_prefix}{tool_suffix}_schema"),
            getattr(provider, handler_name),
        )


_COMPRESSION_GUIDELINE_TOOLS = [
    ("compression_guidelines_optimize", "compression_guidelines_optimize"),
    ("compression_guidelines_activate", "compression_guidelines_activate"),
]


def _register_issue_811_tools(  # type: ignore[no-untyped-def]
    ctx,
    provider: RemnicMemoryProvider,
    prefix: str,
    legacy: bool = False,
):
    schema_prefix = "legacy_" if legacy else ""
    for tool_suffix, handler_name in _COMPRESSION_GUIDELINE_TOOLS:
        ctx.register_tool(
            f"{prefix}_{tool_suffix}",
            getattr(provider, f"{schema_prefix}{tool_suffix}_schema"),
            getattr(provider, handler_name),
        )


_GOVERNANCE_HYGIENE_TOOLS = [
    ("memory_governance_run", "memory_governance_run"),
    ("procedure_mining_run", "procedure_mining_run"),
    ("procedural_stats", "procedural_stats"),
    ("contradiction_scan_run", "contradiction_scan_run"),
    ("memory_summarize_hourly", "memory_summarize_hourly"),
    ("conversation_index_update", "conversation_index_update"),
]


def _register_issue_812_tools(  # type: ignore[no-untyped-def]
    ctx,
    provider: RemnicMemoryProvider,
    prefix: str,
    legacy: bool = False,
):
    schema_prefix = "legacy_" if legacy else ""
    for tool_suffix, handler_name in _GOVERNANCE_HYGIENE_TOOLS:
        ctx.register_tool(
            f"{prefix}_{tool_suffix}",
            getattr(provider, f"{schema_prefix}{tool_suffix}_schema"),
            getattr(provider, handler_name),
        )


_CONTEXT_RECAP_TOOLS = [
    ("day_summary", "day_summary"),
    ("briefing", "briefing"),
    ("context_checkpoint", "context_checkpoint"),
]


def _register_issue_813_tools(  # type: ignore[no-untyped-def]
    ctx,
    provider: RemnicMemoryProvider,
    prefix: str,
    legacy: bool = False,
):
    schema_prefix = "legacy_" if legacy else ""
    for tool_suffix, handler_name in _CONTEXT_RECAP_TOOLS:
        ctx.register_tool(
            f"{prefix}_{tool_suffix}",
            getattr(provider, f"{schema_prefix}{tool_suffix}_schema"),
            getattr(provider, handler_name),
        )


_PROFILING_TOOLS = [
    ("profiling_report", "profiling_report"),
]


def _register_issue_814_tools(  # type: ignore[no-untyped-def]
    ctx,
    provider: RemnicMemoryProvider,
    prefix: str,
    legacy: bool = False,
):
    schema_prefix = "legacy_" if legacy else ""
    for tool_suffix, handler_name in _PROFILING_TOOLS:
        ctx.register_tool(
            f"{prefix}_{tool_suffix}",
            getattr(provider, f"{schema_prefix}{tool_suffix}_schema"),
            getattr(provider, handler_name),
        )


def _register_issue_815_hooks(ctx, provider: RemnicMemoryProvider):  # type: ignore[no-untyped-def]
    register_hook = getattr(ctx, "register_hook", None)
    if not callable(register_hook):
        return

    def _on_session_reset(session_id: str = "", **kwargs):  # type: ignore[no-untyped-def]
        provider.on_session_switch(
            session_id,
            reset=True,
            reason="hermes_session_reset",
            **kwargs,
        )

    register_hook("on_session_reset", _on_session_reset)


def _load_hermes_host_config() -> dict:  # type: ignore[type-arg]
    """Load Hermes config.yaml when the registration context carries no config.

    Hermes' memory-provider discovery (`plugins/memory/__init__.py`) invokes
    ``register()`` with a bare collector that exposes
    ``register_memory_provider()`` but has NO ``.config`` attribute. Reading
    the host config here lets a `$HERMES_HOME/plugins/<name>/` directory shim
    simply re-export this ``register`` instead of duplicating config loading
    (issue #1929).

    Prefers ``load_config_readonly()`` (fast, no deepcopy) and falls back to
    ``load_config()`` on older Hermes releases (v0.7.0+ supported floor) that
    predate the readonly helper.
    """
    try:
        from hermes_cli import config as hermes_config
    except Exception:
        return {}
    loader = getattr(hermes_config, "load_config_readonly", None)
    if not callable(loader):
        loader = getattr(hermes_config, "load_config", None)
    if not callable(loader):
        return {}
    try:
        loaded = loader()
        return loaded if isinstance(loaded, dict) else {}
    except Exception:
        return {}


def register(ctx):  # type: ignore[no-untyped-def]
    """Hermes plugin entry point. Registers the MemoryProvider and explicit tools."""
    raw_config = getattr(ctx, "config", None)
    if not isinstance(raw_config, dict):
        raw_config = _load_hermes_host_config()
    config = raw_config.get("remnic")
    if not isinstance(config, dict):
        config = raw_config.get("engram", {})

    provider = RemnicMemoryProvider(config)
    ctx.register_memory_provider(provider)
    _register_issue_815_hooks(ctx, provider)

    # Primary tool names (Remnic-branded).
    ctx.register_tool("remnic_recall", provider.recall_schema, provider.recall)
    ctx.register_tool("remnic_store", provider.store_schema, provider.store)
    ctx.register_tool("remnic_search", provider.search_schema, provider.search)
    ctx.register_tool(
        "remnic_lcm_search", provider.lcm_search_schema, provider.lcm_search
    )
    _register_recall_debug_tools(ctx, provider, "remnic")
    _register_issue_805_tools(ctx, provider, "remnic")
    _register_issue_806_tools(ctx, provider, "remnic")
    _register_issue_807_tools(ctx, provider, "remnic")
    _register_issue_808_tools(ctx, provider, "remnic")
    _register_issue_809_tools(ctx, provider, "remnic")
    _register_issue_810_tools(ctx, provider, "remnic")
    _register_issue_811_tools(ctx, provider, "remnic")
    _register_issue_812_tools(ctx, provider, "remnic")
    _register_issue_813_tools(ctx, provider, "remnic")
    _register_issue_814_tools(ctx, provider, "remnic")

    # Legacy tool aliases — existing Hermes configs may reference the engram_*
    # names. Keep them wired until the compat window closes.
    ctx.register_tool("engram_recall", provider.legacy_recall_schema, provider.recall)
    ctx.register_tool("engram_store", provider.legacy_store_schema, provider.store)
    ctx.register_tool("engram_search", provider.legacy_search_schema, provider.search)
    ctx.register_tool(
        "engram_lcm_search", provider.legacy_lcm_search_schema, provider.lcm_search
    )
    _register_recall_debug_tools(ctx, provider, "engram", legacy=True)
    _register_issue_805_tools(ctx, provider, "engram", legacy=True)
    _register_issue_806_tools(ctx, provider, "engram", legacy=True)
    _register_issue_807_tools(ctx, provider, "engram", legacy=True)
    _register_issue_808_tools(ctx, provider, "engram", legacy=True)
    _register_issue_809_tools(ctx, provider, "engram", legacy=True)
    _register_issue_810_tools(ctx, provider, "engram", legacy=True)
    _register_issue_811_tools(ctx, provider, "engram", legacy=True)
    _register_issue_812_tools(ctx, provider, "engram", legacy=True)
    _register_issue_813_tools(ctx, provider, "engram", legacy=True)
    _register_issue_814_tools(ctx, provider, "engram", legacy=True)
