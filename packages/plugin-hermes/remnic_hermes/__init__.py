"""Remnic MemoryProvider plugin for Hermes Agent."""

import logging

from remnic_hermes.client import RemnicClient
from remnic_hermes.config import RemnicHermesConfig
from remnic_hermes.llm_bridge import BridgePolicy, HermesLlmBridge, start_bridge_from_config
from remnic_hermes.llm_runtime import arm_deferred_bridge_start, resolve_completion_delegate
from remnic_hermes.provider import RemnicMemoryProvider

# Legacy aliases — preserved for the Engram → Remnic compat window.
# These will be removed in a future major release.
EngramMemoryProvider = RemnicMemoryProvider
EngramClient = RemnicClient
EngramHermesConfig = RemnicHermesConfig

__all__ = [
    "BridgePolicy",
    "EngramClient",
    "EngramHermesConfig",
    "EngramMemoryProvider",
    "HermesLlmBridge",
    "RemnicClient",
    "RemnicHermesConfig",
    "RemnicMemoryProvider",
    "register",
    "resolve_completion_delegate",
    "start_bridge_from_config",
]

def _register_tools_from_schemas(ctx, provider: RemnicMemoryProvider):  # type: ignore[no-untyped-def]
    """Register every tool the provider exposes, under both name families.

    Loops ``provider.get_tool_schemas()`` (issue #2483): the schemas carry
    their own registered name — the primary ``remnic_*`` names and the legacy
    ``engram_*`` aliases kept for the compat window — and
    ``_handler_name_for_tool`` maps each name back onto the provider method
    that implements it.
    """
    for schema in provider.get_tool_schemas():
        tool_name = schema["name"]
        handler_name = provider._handler_name_for_tool(tool_name)
        if not handler_name:
            continue
        ctx.register_tool(tool_name, schema, getattr(provider, handler_name))


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

    # Every tool the provider exposes, under its remnic_* and engram_* names.
    _register_tools_from_schemas(ctx, provider)

    # Opt-in loopback LLM bridge (issue #2834); a no-op unless configured.
    _maybe_start_llm_bridge(ctx, config)


_log = logging.getLogger("remnic_hermes")


def _maybe_start_llm_bridge(ctx, config: dict[str, object]) -> HermesLlmBridge | None:  # type: ignore[no-untyped-def]
    """Start the opt-in policy-bound loopback LLM bridge (issue #2834).

    Disabled unless the ``remnic.llm_bridge.enabled`` config is true, so the
    default plugin is unchanged. The completion delegate is resolved from the
    installed Hermes ``PluginLlm`` runtime, not from a collector ``ctx.llm``
    attribute. Collector-only registration defers start until that facade is
    importable. Any failure is contained: the bridge serves optional
    background generation, never recall.
    """
    try:
        section = config.get("llm_bridge") if isinstance(config, dict) else None
        try:
            policy = BridgePolicy.from_config(section)
        except (TypeError, ValueError):
            return start_bridge_from_config(section, None)
        if not policy.enabled:
            return None
        llm_complete = resolve_completion_delegate(ctx)
        if llm_complete is None:
            _log.warning(
                "llm_bridge enabled but Hermes PluginLlm runtime is not available yet; deferring start"
            )
            arm_deferred_bridge_start(ctx, section)
            return None
        return start_bridge_from_config(section, llm_complete)
    except Exception:
        _log.warning("llm_bridge setup failed unexpectedly", exc_info=True)
        return None
