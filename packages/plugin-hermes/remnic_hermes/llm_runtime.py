"""Resolve a production Hermes completion delegate for the loopback LLM bridge.

Memory-provider discovery hands the plugin a collector that can register
providers and tools. That collector does not carry a live ``PluginLlm``
facade — stuffing ``ctx.llm`` onto it is not a host contract.

The real resolver is Hermes' ``PluginLlm`` type, constructed against the
installed runtime (``agent.plugin_llm`` and documented aliases). When the
runtime is not importable yet, start is deferred until a host hook fires.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

_log = logging.getLogger("remnic_hermes.llm_runtime")

_PLUGIN_LLM_IMPORTS = (
    "agent.plugin_llm",
    "hermes_agent.plugin_llm",
    "hermes_cli.plugin_llm",
)

_DEFER_HOOKS = ("pre_llm_call", "on_session_start", "on_session_reset")


def _discover_plugin_llm_class() -> type[Any] | None:
    """Return the installed Hermes ``PluginLlm`` type, or None if unavailable."""
    for module_name in _PLUGIN_LLM_IMPORTS:
        try:
            module = __import__(module_name, fromlist=["PluginLlm"])
        except Exception:
            continue
        candidate = getattr(module, "PluginLlm", None)
        if isinstance(candidate, type) and callable(getattr(candidate, "complete", None)):
            return candidate
    return None


def _instantiate_plugin_llm(plugin_cls: type[Any], plugin_id: str = "remnic") -> Any | None:
    try:
        instance = plugin_cls(plugin_id=plugin_id)
    except TypeError:
        try:
            instance = plugin_cls(plugin_id)
        except Exception:
            return None
    except Exception:
        _log.debug("PluginLlm construction failed", exc_info=True)
        return None
    complete = getattr(instance, "complete", None)
    if not callable(complete):
        return None
    return instance


def _is_plugin_llm_shaped(llm: object) -> bool:
    if type(llm).__name__ == "PluginLlm":
        return True
    if any(getattr(llm, attr, None) not in (None, "") for attr in ("plugin_id", "_plugin_id")):
        return True
    if callable(getattr(llm, "complete_structured", None)):
        return True
    return False


def _is_memory_provider_collector(ctx: object) -> bool:
    return callable(getattr(ctx, "register_memory_provider", None))


def resolve_completion_delegate(ctx: object | None = None) -> Callable[..., Any] | None:
    """Return a live Hermes completion callable, or None until the runtime exists.

    Collector-only contexts with a stuffed ``ctx.llm.complete`` are ignored:
    that is not the production host contract. A discovered ``PluginLlm``
    instance is preferred; a PluginLlm-shaped facade already on ``ctx`` is
    accepted as a runtime adapter.
    """
    plugin_cls = _discover_plugin_llm_class()
    if plugin_cls is not None:
        instance = _instantiate_plugin_llm(plugin_cls)
        if instance is not None:
            return instance.complete

    llm = getattr(ctx, "llm", None) if ctx is not None else None
    complete = getattr(llm, "complete", None) if llm is not None else None
    if not callable(complete):
        return None
    if _is_plugin_llm_shaped(llm):
        return complete
    if _is_memory_provider_collector(ctx):
        _log.warning(
            "llm_bridge enabled on a memory-provider collector without a Hermes "
            "PluginLlm runtime; bridge start deferred"
        )
        return None
    return complete


def arm_deferred_bridge_start(ctx: object, section: object) -> None:
    """Retry bridge start from host hooks once PluginLlm becomes importable."""
    register_hook = getattr(ctx, "register_hook", None)
    if not callable(register_hook):
        return
    state = {"started": False}

    def _try_start(*_args: object, **_kwargs: object) -> None:
        if state["started"]:
            return
        complete = resolve_completion_delegate(ctx)
        if complete is None:
            return
        import remnic_hermes

        starter = remnic_hermes.start_bridge_from_config
        bridge = starter(section, complete)
        if bridge is not None:
            state["started"] = True

    for hook in _DEFER_HOOKS:
        try:
            register_hook(hook, _try_start)
        except Exception:
            _log.debug("llm_bridge could not register defer hook %s", hook, exc_info=True)
