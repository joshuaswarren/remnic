#!/usr/bin/env python3
"""Install Remnic into a local Agent Memory Benchmark checkout."""

from __future__ import annotations

import argparse
import re
import shutil
from pathlib import Path


MEMORY_PROVIDER_SPECS = {
    "remnic": (".remnic", "RemnicMemoryProvider"),
    "bm25": (".bm25", "BM25MemoryProvider"),
    "cognee": (".cognee", "CogneeMemoryProvider"),
    "hindsight": (".hindsight", "HindsightMemoryProvider"),
    "hindsight-cloud": (".hindsight", "HindsightCloudMemoryProvider"),
    "hindsight-http": (".hindsight", "HindsightHTTPMemoryProvider"),
    "mastra": (".mastra", "MastraMemoryProvider"),
    "mastra-om": (".mastra_om", "MastraOMMemoryProvider"),
    "mem0": (".mem0", "Mem0MemoryProvider"),
    "mem0-cloud": (".mem0_cloud", "Mem0CloudMemoryProvider"),
    "ogham": (".ogham", "OghamMemoryProvider"),
    "qdrant": (".hybrid_search", "HybridSearchMemoryProvider"),
    "supermemory": (".supermemory", "SupermemoryMemoryProvider"),
}

MEMORY_PROVIDER_METADATA = {
    "RemnicMemoryProvider": {
        "name": "remnic",
        "description": "Remnic core memory stack through the official AMB provider interface.",
        "kind": "local",
        "provider": "Remnic",
        "variant": "core",
        "link": "https://github.com/joshuaswarren/remnic",
        "logo": "",
        "concurrency": 1,
    },
    "BM25MemoryProvider": {
        "name": "bm25",
        "description": "BM25 memory provider.",
        "kind": "local",
        "provider": "BM25",
        "variant": "default",
        "link": "",
        "logo": "",
        "concurrency": 1,
    },
    "CogneeMemoryProvider": {
        "name": "cognee",
        "description": "Cognee memory provider.",
        "kind": "local",
        "provider": "Cognee",
        "variant": "default",
        "link": "",
        "logo": "",
        "concurrency": 1,
    },
    "HindsightMemoryProvider": {
        "name": "hindsight",
        "description": "Hindsight memory provider.",
        "kind": "local",
        "provider": "Hindsight",
        "variant": "default",
        "link": "",
        "logo": "",
        "concurrency": 1,
    },
    "HindsightCloudMemoryProvider": {
        "name": "hindsight-cloud",
        "description": "Hindsight Cloud memory provider.",
        "kind": "cloud",
        "provider": "Hindsight",
        "variant": "cloud",
        "link": "",
        "logo": "",
        "concurrency": 1,
    },
    "HindsightHTTPMemoryProvider": {
        "name": "hindsight-http",
        "description": "Hindsight HTTP memory provider.",
        "kind": "cloud",
        "provider": "Hindsight",
        "variant": "http",
        "link": "",
        "logo": "",
        "concurrency": 1,
    },
    "MastraMemoryProvider": {
        "name": "mastra",
        "description": "Mastra memory provider.",
        "kind": "local",
        "provider": "Mastra",
        "variant": "default",
        "link": "",
        "logo": "",
        "concurrency": 1,
    },
    "MastraOMMemoryProvider": {
        "name": "mastra-om",
        "description": "Mastra OM memory provider.",
        "kind": "local",
        "provider": "Mastra",
        "variant": "om",
        "link": "",
        "logo": "",
        "concurrency": 1,
    },
    "Mem0MemoryProvider": {
        "name": "mem0",
        "description": "Mem0 memory provider.",
        "kind": "local",
        "provider": "Mem0",
        "variant": "default",
        "link": "",
        "logo": "",
        "concurrency": 1,
    },
    "Mem0CloudMemoryProvider": {
        "name": "mem0-cloud",
        "description": "Mem0 Cloud memory provider.",
        "kind": "cloud",
        "provider": "Mem0",
        "variant": "cloud",
        "link": "",
        "logo": "",
        "concurrency": 1,
    },
    "OghamMemoryProvider": {
        "name": "ogham",
        "description": "Ogham memory provider.",
        "kind": "local",
        "provider": "Ogham",
        "variant": "default",
        "link": "",
        "logo": "",
        "concurrency": 1,
    },
    "HybridSearchMemoryProvider": {
        "name": "qdrant",
        "description": "Qdrant hybrid-search memory provider.",
        "kind": "local",
        "provider": "Qdrant",
        "variant": "hybrid-search",
        "link": "",
        "logo": "",
        "concurrency": 1,
    },
    "SupermemoryMemoryProvider": {
        "name": "supermemory",
        "description": "Supermemory provider.",
        "kind": "cloud",
        "provider": "Supermemory",
        "variant": "default",
        "link": "",
        "logo": "",
        "concurrency": 1,
    },
}

DATASET_SPECS = {
    "beam": (".beam", "BEAMDataset"),
    "lifebench": (".lifebench", "LifeBenchDataset"),
    "locomo": (".locomo", "LoComoDataset"),
    "longmemeval": (".longmemeval", "LongMemEvalDataset"),
    "membench": (".membench", "MemBenchDataset"),
    "memsim": (".memsim", "MemSimDataset"),
    "personamem": (".personamem", "PersonaMemDataset"),
}

LLM_SPECS = {
    "codex": (".codex", "CodexLLM"),
    "gemini": (".gemini", "GeminiLLM"),
    "groq": (".groq", "GroqLLM"),
    "openai": (".openai", "OpenAILLM"),
}


def patch_memory_provider(amb_root: Path, source_dir: Path) -> None:
    memory_dir = amb_root / "src" / "memory_bench" / "memory"
    init_path = memory_dir / "__init__.py"
    if not init_path.exists():
        raise SystemExit(f"AMB memory package not found: {init_path}")

    shutil.copy2(source_dir / "remnic.py", memory_dir / "remnic.py")

    specs = dict(MEMORY_PROVIDER_SPECS)
    specs.update(existing_memory_provider_specs(init_path.read_text()))
    specs["remnic"] = MEMORY_PROVIDER_SPECS["remnic"]
    init_path.write_text(memory_init_text(specs))


def patch_dataset_registry(amb_root: Path) -> None:
    init_path = amb_root / "src" / "memory_bench" / "dataset" / "__init__.py"
    if not init_path.exists():
        raise SystemExit(f"AMB dataset package not found: {init_path}")
    specs = dict(DATASET_SPECS)
    specs.update(existing_dataset_specs(init_path.read_text()))
    init_path.write_text(dataset_init_text(specs))


def memory_init_text(specs: dict[str, tuple[str, str]]) -> str:
    registry_entries = "\n".join(
        f'    "{name}": _LazyMemoryProvider("{module}", "{class_name}"),'
        for name, (module, class_name) in specs.items()
    )
    metadata_class_names = dict.fromkeys(
        class_name
        for _, class_name in specs.values()
        if class_name in MEMORY_PROVIDER_METADATA
    )
    metadata_entries = "\n".join(
        f"    {class_name!r}: {MEMORY_PROVIDER_METADATA[class_name]!r},"
        for class_name in metadata_class_names
    )
    return f'''"""Memory provider registry with lazy optional-provider imports.

Generated by Remnic's AMB installer so selecting ``--memory remnic`` does not
import unrelated provider SDKs or optional native dependencies.
"""

from importlib import import_module
from typing import Any

from .base import MemoryProvider


_MEMORY_PROVIDER_METADATA: dict[str, dict[str, Any]] = {{
{metadata_entries}
}}


class _LazyMemoryProvider:
    def __init__(self, module_name: str, class_name: str):
        self._module_name = module_name
        self._class_name = class_name
        self._metadata = _MEMORY_PROVIDER_METADATA.get(class_name, {{}})
        self._resolved: type[MemoryProvider] | None = None

    def _resolve(self) -> type[MemoryProvider]:
        if self._resolved is None:
            module = import_module(self._module_name, __package__)
            self._resolved = getattr(module, self._class_name)
        return self._resolved

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        metadata = self.__dict__.get("_metadata", {{}})
        if name in metadata:
            return metadata[name]
        return getattr(self._resolve(), name)

    def __call__(self, *args: Any, **kwargs: Any) -> MemoryProvider:
        return self._resolve()(*args, **kwargs)


REGISTRY: dict[str, Any] = {{
{registry_entries}
}}


def get_memory_provider(name: str) -> MemoryProvider:
    if name not in REGISTRY:
        raise ValueError(f"Unknown memory provider: {{name!r}}. Available: {{list(REGISTRY)}}")
    return REGISTRY[name]()
'''


def existing_memory_provider_specs(text: str) -> dict[str, tuple[str, str]]:
    return existing_registry_specs(text, "_LazyMemoryProvider")


def existing_dataset_specs(text: str) -> dict[str, tuple[str, str]]:
    return existing_registry_specs(text, "_LazyDataset")


def existing_registry_specs(text: str, lazy_class_name: str) -> dict[str, tuple[str, str]]:
    imports = {
        class_name: module_name
        for module_name, class_name in re.findall(
            r"^from \.([A-Za-z_][A-Za-z0-9_]*) import ([A-Za-z_][A-Za-z0-9_]*)\s*$",
            text,
            flags=re.MULTILINE,
        )
    }
    registry_match = re.search(r"REGISTRY\s*:[^=]*=\s*\{(?P<body>.*?)\n\}", text, flags=re.DOTALL)
    if not registry_match:
        return {}
    specs: dict[str, tuple[str, str]] = {}
    for name, module_name, class_name in re.findall(
        rf"[\"']([^\"']+)[\"']\s*:\s*{re.escape(lazy_class_name)}\([\"']([^\"']+)[\"'],\s*[\"']([^\"']+)[\"']\)",
        registry_match.group("body"),
    ):
        specs[name] = (module_name, class_name)
    for name, class_name in re.findall(
        r"[\"']([^\"']+)[\"']\s*:\s*([A-Za-z_][A-Za-z0-9_]*)",
        registry_match.group("body"),
    ):
        module_name = imports.get(class_name)
        if module_name:
            specs[name] = (f".{module_name}", class_name)
    return specs


def dataset_init_text(specs: dict[str, tuple[str, str]]) -> str:
    registry_entries = "\n".join(
        f'    "{name}": _LazyDataset("{module}", "{class_name}"),'
        for name, (module, class_name) in specs.items()
    )
    return f'''"""Dataset registry with lazy optional-dataset imports.

Generated by Remnic's AMB installer so selecting one dataset does not import
unrelated benchmark dependencies.
"""

from importlib import import_module
from typing import Any

from .base import Dataset


class _LazyDataset:
    def __init__(self, module_name: str, class_name: str):
        self._module_name = module_name
        self._class_name = class_name
        self._resolved: type[Dataset] | None = None

    def _resolve(self) -> type[Dataset]:
        if self._resolved is None:
            module = import_module(self._module_name, __package__)
            self._resolved = getattr(module, self._class_name)
        return self._resolved

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self._resolve(), name)

    def __call__(self, *args: Any, **kwargs: Any) -> Dataset:
        return self._resolve()(*args, **kwargs)


REGISTRY: dict[str, Any] = {{
{registry_entries}
}}


def get_dataset(name: str) -> Dataset:
    if name not in REGISTRY:
        raise ValueError(f"Unknown dataset: {{name!r}}. Available: {{list(REGISTRY)}}")
    return REGISTRY[name]()
'''


def patch_codex_llm(amb_root: Path, source_dir: Path) -> None:
    llm_dir = amb_root / "src" / "memory_bench" / "llm"
    init_path = llm_dir / "__init__.py"
    if not init_path.exists():
        raise SystemExit(f"AMB LLM package not found: {init_path}")

    shutil.copy2(source_dir / "codex_llm.py", llm_dir / "codex.py")
    specs = dict(LLM_SPECS)
    specs.update(existing_llm_specs(init_path.read_text()))
    specs["codex"] = LLM_SPECS["codex"]
    init_path.write_text(llm_init_text(specs))


def existing_llm_specs(text: str) -> dict[str, tuple[str, str]]:
    return existing_registry_specs(text, "_LazyLLM")


def llm_init_text(specs: dict[str, tuple[str, str]]) -> str:
    registry_entries = "\n".join(
        f'    "{name}": _LazyLLM("{module}", "{class_name}"),'
        for name, (module, class_name) in specs.items()
    )
    return f'''"""LLM registry with lazy provider imports.

Generated by Remnic's AMB installer so selecting Codex does not import
unrelated LLM SDKs.
"""

import os
from importlib import import_module
from typing import Any

from .base import LLM, Schema


class _LazyLLM:
    def __init__(self, module_name: str, class_name: str):
        self._module_name = module_name
        self._class_name = class_name
        self._resolved: type[LLM] | None = None

    def _resolve(self) -> type[LLM]:
        if self._resolved is None:
            module = import_module(self._module_name, __package__)
            self._resolved = getattr(module, self._class_name)
        return self._resolved

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self._resolve(), name)

    def __call__(self, *args: Any, **kwargs: Any) -> LLM:
        return self._resolve()(*args, **kwargs)


REGISTRY: dict[str, Any] = {{
{registry_entries}
}}


def get_llm(name: str = "gemini") -> LLM:
    if name not in REGISTRY:
        raise ValueError(f"Unknown LLM: {{name!r}}. Available: {{list(REGISTRY)}}")
    return REGISTRY[name]()


def get_answer_llm() -> LLM:
    provider = os.environ.get("OMB_ANSWER_LLM", "groq")
    model = os.environ.get("OMB_ANSWER_MODEL")
    if provider not in REGISTRY:
        raise ValueError(f"Unknown OMB_ANSWER_LLM: {{provider!r}}. Available: {{list(REGISTRY)}}")
    return REGISTRY[provider](model) if model else REGISTRY[provider]()


def get_judge_llm() -> LLM:
    provider = os.environ.get("OMB_JUDGE_LLM", "gemini")
    model = os.environ.get("OMB_JUDGE_MODEL")
    if provider not in REGISTRY:
        raise ValueError(f"Unknown OMB_JUDGE_LLM: {{provider!r}}. Available: {{list(REGISTRY)}}")
    return REGISTRY[provider](model) if model else REGISTRY[provider]()
'''


def patch_cli_llm_gate(amb_root: Path) -> None:
    cli_path = amb_root / "src" / "memory_bench" / "cli.py"
    if not cli_path.exists():
        raise SystemExit(f"AMB CLI not found: {cli_path}")

    text = cli_path.read_text()
    if "Remnic Codex LLM bypass" in text:
        return
    old = """def _resolve_gemini_key() -> None:
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        typer.echo("Error: GEMINI_API_KEY environment variable is not set.", err=True)
        raise typer.Exit(1)
    os.environ["GOOGLE_API_KEY"] = key
"""
    new = """def _resolve_gemini_key() -> None:
    # Remnic Codex LLM bypass: when forced, reset these values after AMB's
    # dotenv load so local .env files cannot redirect the benchmark path.
    if os.environ.get("REMNIC_AMB_FORCE_CODEX_LLM") == "1":
        os.environ["OMB_ANSWER_LLM"] = "codex"
        os.environ["OMB_JUDGE_LLM"] = "codex"
        os.environ["OMB_ANSWER_MODEL"] = "gpt-5.5"
        os.environ["OMB_JUDGE_MODEL"] = "gpt-5.5"
        return
    # When both AMB answer and judge LLMs are explicitly routed through
    # Codex, the Gemini/Google key gate is not part of the active
    # benchmark path.
    answer_llm = os.environ.get("OMB_ANSWER_LLM", "").strip().lower()
    judge_llm = os.environ.get("OMB_JUDGE_LLM", "").strip().lower()
    if answer_llm == "codex" and judge_llm == "codex":
        return
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        typer.echo("Error: GEMINI_API_KEY environment variable is not set.", err=True)
        raise typer.Exit(1)
    os.environ["GOOGLE_API_KEY"] = key
"""
    if old not in text:
        raise SystemExit("Could not find AMB Gemini key gate to patch")
    cli_path.write_text(text.replace(old, new, 1))


def patch_mode_llm_imports(amb_root: Path) -> None:
    modes_dir = amb_root / "src" / "memory_bench" / "modes"
    init_path = modes_dir / "__init__.py"
    rag_path = modes_dir / "rag.py"
    agentic_path = modes_dir / "agentic_rag.py"

    if init_path.exists():
        text = init_path.read_text()
        text = text.replace(
            '    if llm is not None and "llm" in cls.__init__.__code__.co_varnames:\n'
            "        return cls(llm=llm)\n"
            "    return cls()\n",
            '    init_code = getattr(cls.__init__, "__code__", None)\n'
            '    if llm is not None and init_code is not None and "llm" in init_code.co_varnames:\n'
            "        return cls(llm=llm)\n"
            "    return cls()\n",
        )
        init_path.write_text(text)

    if rag_path.exists():
        text = rag_path.read_text()
        text = text.replace(
            "from ..llm.gemini import GeminiLLM\n",
            "from ..llm import get_answer_llm\nfrom ..llm.base import LLM\n",
        )
        text = replace_gemini_llm_references(text, "get_answer_llm")
        rag_path.write_text(text)

    if agentic_path.exists():
        text = agentic_path.read_text()
        text = text.replace("from ..llm.gemini import GeminiLLM\n", "from ..llm.base import LLM\n")
        text = text.replace(
            "    def __init__(self, llm: GeminiLLM | None = None, k: int = 10):\n"
            "        self._llm = llm or GeminiLLM()\n"
            "        self._rag = RAGMode(llm=self._llm, k=k)\n",
            "    def __init__(self, llm: LLM | None = None, k: int = 10):\n"
            "        from ..llm import get_answer_llm\n"
            "        self._llm = llm or get_answer_llm()\n"
            "        self._rag = RAGMode(llm=self._llm, k=k)\n",
        )
        agentic_path.write_text(text)


def patch_judge_llm_import(amb_root: Path) -> None:
    judge_path = amb_root / "src" / "memory_bench" / "judge.py"
    if not judge_path.exists():
        return
    text = judge_path.read_text()
    text = text.replace("from .llm.gemini import GeminiLLM\n", "from .llm import get_judge_llm\n")
    text = ensure_judge_llm_type_import(text)
    text = replace_gemini_llm_references(text, "get_judge_llm")
    judge_path.write_text(text)


def replace_gemini_llm_references(text: str, factory_name: str) -> str:
    return (
        text.replace("GeminiLLM()", f"{factory_name}()")
        .replace("GeminiLLM | None", "LLM | None")
        .replace("GeminiLLM", "LLM")
    )


def ensure_judge_llm_type_import(text: str) -> str:
    if "LLM" not in text:
        return text
    if has_llm_base_import(text, "LLM"):
        return text

    import_pattern = r"^from \.llm\.base import (?P<names>.+)$"
    if re.search(import_pattern, text, flags=re.MULTILINE):
        return re.sub(
            import_pattern,
            lambda match: f"from .llm.base import LLM, {match.group('names').strip()}",
            text,
            count=1,
            flags=re.MULTILINE,
        )
    return "from .llm.base import LLM\n" + text


def has_llm_base_import(text: str, symbol: str) -> bool:
    for match in re.finditer(r"^from \.llm\.base import (?P<names>.+)$", text, flags=re.MULTILINE):
        imports = [
            part.strip().split(" as ", 1)[0].strip()
            for part in match.group("names").split(",")
        ]
        if symbol in imports:
            return True
    return False


def patch_runner_incremental_batch_save(amb_root: Path) -> None:
    runner_path = amb_root / "src" / "memory_bench" / "runner.py"
    if not runner_path.exists():
        raise SystemExit(f"AMB runner not found: {runner_path}")
    text = runner_path.read_text()
    patched = patch_runner_answer_raw_response(text)
    if "Remnic patch: save batch results incrementally" in patched:
        if patched != text:
            runner_path.write_text(patched)
        return

    pattern = re.compile(
        r"(?P<indent>[ \t]+)async def bounded\(i, q\):\n"
        r"(?P=indent)    async with sem:\n"
        r"(?P=indent)        results\[i\] = await _process_one\(q\)\n"
        r"(?P=indent)        progress\.advance\(task_id\)\n"
        r"\n"
        r"(?P=indent)await asyncio\.gather\(\*\[bounded\(i, q\) for i, q in enumerate\(queries\)\]\)\n"
        r"(?P=indent)return results\n",
    )

    def replacement(match: re.Match[str]) -> str:
        indent = match.group("indent")
        return f"""{indent}save_lock = asyncio.Lock()

{indent}async def bounded(i, q):
{indent}    async with sem:
{indent}        results[i] = await _process_one(q)
{indent}        progress.advance(task_id)
{indent}        async with save_lock:
{indent}            completed = [r for r in results if r]
{indent}            if completed:
{indent}                correct_count = sum(1 for r in completed if r.correct)
{indent}                partial = EvalSummary(
{indent}                    dataset=dataset.name, split=split, category=category,
{indent}                    memory_provider=memory.name, run_name=effective_name,
{indent}                    mode=mode.name, oracle=oracle,
{indent}                    total_queries=len(completed),
{indent}                    correct=correct_count,
{indent}                    accuracy=correct_count / len(completed),
{indent}                    ingestion_time_ms=round(ingestion_ms, 1),
{indent}                    ingested_docs=ingested_docs_count,
{indent}                    description=description, answer_llm=mode.llm_id,
{indent}                    judge_llm=self._get_judge(dataset)._llm.model_id, results=completed,
{indent}                )
{indent}                # Remnic patch: save batch results incrementally so long
{indent}                # Codex-backed runs survive transient query failures.
{indent}                self._save(partial)

{indent}await asyncio.gather(*[bounded(i, q) for i, q in enumerate(queries)])
{indent}return results
"""

    patched, replacements = pattern.subn(replacement, patched, count=1)
    if replacements != 1:
        raise SystemExit("Could not find AMB batch runner block to patch")
    runner_path.write_text(patched)


def patch_runner_answer_raw_response(text: str) -> str:
    if "Remnic patch: preserve AnswerResult raw_response" in text:
        return text
    pattern = re.compile(
        r"(?P<indent>[ \t]+)raw_response=None,\s+# skip storing to conserve disk space\n",
    )

    def replacement(match: re.Match[str]) -> str:
        indent = match.group("indent")
        return (
            f"{indent}# Remnic patch: preserve AnswerResult raw_response so\n"
            f"{indent}# agent-mode Codex direct-answer provenance survives in result JSON.\n"
            f'{indent}raw_response=getattr(answer_result, "raw_response", None),\n'
        )

    patched, replacements = pattern.subn(replacement, text, count=1)
    if replacements != 1:
        raise SystemExit("Could not find AMB QueryResult raw_response assignment to patch")
    return patched


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--amb",
        required=True,
        help="Path to vectorize-io/agent-memory-benchmark checkout",
    )
    args = parser.parse_args()

    amb_root = Path(args.amb).expanduser().resolve()
    source_dir = Path(__file__).resolve().parent
    patch_memory_provider(amb_root, source_dir)
    patch_dataset_registry(amb_root)
    patch_codex_llm(amb_root, source_dir)
    patch_cli_llm_gate(amb_root)
    patch_mode_llm_imports(amb_root)
    patch_judge_llm_import(amb_root)
    patch_runner_incremental_batch_save(amb_root)
    print(f"Installed Remnic AMB provider and Codex LLM into {amb_root}")


if __name__ == "__main__":
    main()
