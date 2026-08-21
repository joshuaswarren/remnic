#!/usr/bin/env python3
"""Run AMB dataset ingestion/retrieval through Remnic without answer/judge calls.

This is a diagnostic preflight, not a leaderboard evaluator. It uses AMB's
dataset and MemoryProvider APIs, writes retrieved contexts, and avoids any LLM
generation or judging so it can run without Gemini credentials.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any

from memory_bench.dataset import get_dataset
from memory_bench.memory import get_memory_provider
from memory_bench.models import Document, Query
from memory_bench.utils import count_tokens


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--split", default="100k", help="BEAM split to inspect")
    parser.add_argument("--category", default=None, help="Optional BEAM category filter")
    parser.add_argument("--query-limit", type=int, default=None, help="Max queries to retrieve")
    parser.add_argument("--query-offset", type=int, default=0, help="Number of loaded queries to skip before applying --query-limit")
    parser.add_argument("--doc-limit", type=int, default=None, help="Max documents to ingest")
    parser.add_argument("--run-name", default="remnic-retrieval", help="Run/store name")
    parser.add_argument("--output-dir", default="outputs", help="AMB-style output root")
    parser.add_argument("--output-file", default=None, help="Explicit JSON output file")
    parser.add_argument("--memory", default="remnic", help="AMB memory provider name")
    parser.add_argument("--reset", action=argparse.BooleanOptionalAction, default=True)
    return parser.parse_args()


def resolve_output_root(output_dir: str) -> Path:
    path = Path(output_dir).expanduser()
    if path.is_absolute():
        return path
    return Path.cwd() / path


def query_limit_documents(
    dataset,
    split: str,
    category: str | None,
    doc_limit: int | None,
    queries: list[Query],
) -> list[Document]:
    if dataset.isolation_unit is not None and queries:
        query_user_ids = {q.user_id for q in queries if q.user_id}
        return dataset.load_documents(
            split,
            category=category,
            limit=doc_limit,
            user_ids=query_user_ids,
        )
    return dataset.load_documents(split, category=category, limit=doc_limit)


def slice_queries(
    queries: list[Query],
    offset: int,
    limit: int | None,
) -> list[Query]:
    if offset < 0:
        raise SystemExit(f"--query-offset must be non-negative; received {offset}")
    if limit is not None and limit < 0:
        raise SystemExit(f"--query-limit must be non-negative; received {limit}")
    selected = queries[offset:]
    if limit is not None:
        selected = selected[:limit]
    return selected


def group_by_unit(dataset, documents: list[Document], queries: list[Query]):
    queries_by_unit: dict[str, list[Query]] = {}
    for query in queries:
        if query.user_id:
            queries_by_unit.setdefault(query.user_id, []).append(query)

    docs_by_unit: dict[str, list[Document]] = {}
    for document in documents:
        unit_id = dataset.get_isolation_id(document)
        if unit_id is not None and unit_id in queries_by_unit:
            docs_by_unit.setdefault(unit_id, []).append(document)

    return docs_by_unit, queries_by_unit


async def retrieve_one(memory, query: Query) -> dict[str, Any]:
    start = time.perf_counter()
    docs, raw_response = await memory.async_retrieve(
        query.query,
        user_id=query.user_id,
        query_timestamp=query.meta.get("query_timestamp"),
    )
    retrieve_ms = (time.perf_counter() - start) * 1000
    context = "\n\n".join(
        f"## Memory {index + 1}\n{doc.content}" for index, doc in enumerate(docs)
    )
    return {
        "query_id": query.id,
        "query": query.query,
        "user_id": query.user_id,
        "gold_answers": query.gold_answers,
        "meta": query.meta,
        "context": context,
        "context_chars": len(context),
        "context_tokens": count_tokens(context),
        "retrieve_time_ms": round(retrieve_ms, 1),
        "documents": [asdict(doc) for doc in docs],
        "raw_response": raw_response,
    }


async def run() -> None:
    args = parse_args()
    dataset = get_dataset("beam")
    if args.split not in dataset.splits:
        raise SystemExit(f"Unknown BEAM split {args.split!r}; available={dataset.splits}")

    output_root = resolve_output_root(args.output_dir)
    output_file = (
        Path(args.output_file).expanduser()
        if args.output_file
        else output_root / "beam" / args.run_name / "retrieval" / f"{args.split}.json"
    )
    if not output_file.is_absolute():
        output_file = Path.cwd() / output_file
    store_dir = output_root / "beam" / args.run_name / "_store" / args.split / (args.category or "all")

    queries = slice_queries(
        dataset.load_queries(args.split, category=args.category),
        args.query_offset,
        args.query_limit,
    )
    documents = query_limit_documents(
        dataset,
        args.split,
        args.category,
        args.doc_limit,
        queries,
    )
    unit_ids = {
        unit_id
        for document in documents
        if (unit_id := dataset.get_isolation_id(document)) is not None
    } if dataset.isolation_unit is not None else None

    memory = get_memory_provider(args.memory)
    memory.initialize()
    memory.prepare(store_dir, unit_ids=unit_ids, reset=args.reset)

    started = time.perf_counter()
    ingested_docs = 0
    results: list[dict[str, Any]] = []

    try:
        if dataset.isolation_unit is not None:
            docs_by_unit, queries_by_unit = group_by_unit(dataset, documents, queries)
            for unit_id, unit_docs in docs_by_unit.items():
                memory.ingest(unit_docs)
                ingested_docs += len(unit_docs)
                for query in queries_by_unit.get(unit_id, []):
                    results.append(await retrieve_one(memory, query))
        else:
            memory.ingest(documents)
            ingested_docs = len(documents)
            for query in queries:
                results.append(await retrieve_one(memory, query))
    finally:
        memory.cleanup()

    summary = {
        "dataset": dataset.name,
        "split": args.split,
        "category": args.category,
        "memory_provider": memory.name,
        "run_name": args.run_name,
        "diagnostic": "retrieval-only",
        "total_queries": len(results),
        "loaded_documents": len(documents),
        "ingested_docs": ingested_docs,
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
        "store_dir": str(store_dir),
        "results": results,
    }
    output_file.parent.mkdir(parents=True, exist_ok=True)
    output_file.write_text(json.dumps(summary, indent=2), encoding="utf8")
    print(f"Wrote retrieval diagnostic: {output_file}")


if __name__ == "__main__":
    asyncio.run(run())
