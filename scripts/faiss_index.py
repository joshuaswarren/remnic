#!/usr/bin/env python3
"""FAISS conversation index sidecar.

JSON-in/JSON-out CLI used by src/conversation-index/faiss-adapter.ts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MODEL_CACHE: dict[str, Any] = {}
LOCK_OWNERS: dict[str, str] = {}
HASH_EMBED_DIM = 128
LOCK_TIMEOUT_SECONDS = 10.0
LOCK_STALE_SECONDS = 120.0
MANIFEST_VERSION = 1
MODEL_ID_ALIASES = {
    "text-embedding-3-small": "sentence-transformers/all-MiniLM-L6-v2",
    "text-embedding-3-large": "sentence-transformers/all-mpnet-base-v2",
    "text-embedding-ada-002": "sentence-transformers/all-MiniLM-L6-v2",
}


class SidecarError(Exception):
    pass


class DependencyError(SidecarError):
    pass


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":"), ensure_ascii=False))
    sys.stdout.flush()


def read_payload() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        raise SidecarError("empty stdin payload")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SidecarError(f"invalid JSON payload: {exc}") from exc
    if not isinstance(payload, dict):
        raise SidecarError("payload must be a JSON object")
    return payload


def ensure_index_dir(index_path: Any) -> Path:
    if not isinstance(index_path, str) or not index_path.strip():
        raise SidecarError("indexPath is required")
    path = Path(index_path)
    path.mkdir(parents=True, exist_ok=True)
    return path


def metadata_file(index_dir: Path) -> Path:
    return index_dir / "metadata.jsonl"


def index_file(index_dir: Path) -> Path:
    return index_dir / "index.faiss"


def manifest_file(index_dir: Path) -> Path:
    return index_dir / "manifest.json"


def read_metadata(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []

    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(row, dict):
            continue
        row_id = row.get("id")
        text = row.get("text")
        if not isinstance(row_id, str) or not row_id:
            continue
        if not isinstance(text, str):
            continue
        rows.append(
            {
                "id": row_id,
                "sessionKey": row.get("sessionKey") if isinstance(row.get("sessionKey"), str) else "",
                "text": text,
                "startTs": row.get("startTs") if isinstance(row.get("startTs"), str) else "",
                "endTs": row.get("endTs") if isinstance(row.get("endTs"), str) else "",
            }
        )
    return rows


def write_metadata(path: Path, rows: list[dict[str, Any]]) -> None:
    tmp = temp_artifact_path(path)
    with tmp.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, separators=(",", ":"), ensure_ascii=False))
            handle.write("\n")
    os.replace(tmp, path)


def read_manifest(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return raw if isinstance(raw, dict) else None


def write_manifest(path: Path, manifest: dict[str, Any]) -> None:
    tmp = temp_artifact_path(path)
    tmp.write_text(
        json.dumps(manifest, separators=(",", ":"), ensure_ascii=False),
        encoding="utf-8",
    )
    os.replace(tmp, path)


def load_vector_dependencies() -> tuple[Any, Any]:
    try:
        import numpy as np  # type: ignore
        import faiss  # type: ignore
    except Exception as exc:
        raise DependencyError(f"missing faiss dependencies: {exc}") from exc
    return np, faiss


def sentence_transformers_enabled() -> bool:
    if "REMNIC_FAISS_ENABLE_ST" in os.environ:
        value = os.environ["REMNIC_FAISS_ENABLE_ST"]
    else:
        value = os.environ.get("ENGRAM_FAISS_ENABLE_ST", "")
    value = value.strip().lower()
    return value in ("1", "true", "yes", "on")


def normalize_model_id(model_id: str) -> str:
    cleaned = (model_id or "").strip()
    if not cleaned:
        cleaned = "sentence-transformers/all-MiniLM-L6-v2"
    resolved = MODEL_ID_ALIASES.get(cleaned, cleaned)
    if resolved in ("__hash__", "hash"):
        return "__hash__"
    if not sentence_transformers_enabled():
        return "__hash__"
    return resolved


def get_embedder(model_id: str) -> Any:
    resolved_model_id = normalize_model_id(model_id)
    if resolved_model_id == "__hash__":
        return None
    if resolved_model_id in MODEL_CACHE:
        return MODEL_CACHE[resolved_model_id]
    try:
        from sentence_transformers import SentenceTransformer  # type: ignore
    except Exception as exc:
        raise DependencyError(f"missing sentence-transformers dependency: {exc}") from exc
    MODEL_CACHE[resolved_model_id] = SentenceTransformer(resolved_model_id)
    return MODEL_CACHE[resolved_model_id]


def embed_with_hash(texts: list[str], np: Any) -> Any:
    vectors = np.zeros((len(texts), HASH_EMBED_DIM), dtype="float32")
    for row_index, text in enumerate(texts):
        digest = hashlib.sha256(text.encode("utf-8")).digest()
        for byte_index in range(HASH_EMBED_DIM):
            vectors[row_index, byte_index] = (digest[byte_index % len(digest)] / 255.0) - 0.5
    return vectors


def embed_texts(texts: list[str], model_id: str) -> tuple[Any, Any, Any]:
    np, faiss = load_vector_dependencies()
    embedder = get_embedder(model_id)
    if embedder is None:
        arr = embed_with_hash(texts, np)
    else:
        vectors = embedder.encode(
            texts,
            normalize_embeddings=False,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
        arr = np.asarray(vectors, dtype="float32")
    if arr.ndim == 1:
        arr = arr.reshape(1, -1)
    if arr.shape[0] > 0:
        faiss.normalize_L2(arr)
    return arr, np, faiss


def write_index(path: Path, vectors: Any, faiss: Any) -> None:
    tmp = write_index_temp(path, vectors, faiss)
    os.replace(tmp, path)


def temp_artifact_path(path: Path) -> Path:
    return path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")


def write_metadata_temp(path: Path, rows: list[dict[str, Any]]) -> Path:
    tmp = temp_artifact_path(path)
    with tmp.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, separators=(",", ":"), ensure_ascii=False))
            handle.write("\n")
    return tmp


def write_manifest_temp(path: Path, manifest: dict[str, Any]) -> Path:
    tmp = temp_artifact_path(path)
    tmp.write_text(
        json.dumps(manifest, separators=(",", ":"), ensure_ascii=False),
        encoding="utf-8",
    )
    return tmp


def write_index_temp(path: Path, vectors: Any, faiss: Any) -> Path:
    dim = int(vectors.shape[1])
    index = faiss.IndexFlatIP(dim)
    if int(vectors.shape[0]) > 0:
        index.add(vectors)
    tmp = temp_artifact_path(path)
    faiss.write_index(index, str(tmp))
    return tmp


def commit_index_artifacts(artifacts: list[tuple[Path, Path]]) -> None:
    backups: list[tuple[Path, Path, bool]] = []
    try:
        for target, tmp in artifacts:
            backup = target.with_name(f".{target.name}.{os.getpid()}.{uuid.uuid4().hex}.bak")
            existed = target.exists()
            if existed:
                os.replace(target, backup)
            backups.append((target, backup, existed))
            os.replace(tmp, target)
        for _target, backup, existed in backups:
            if existed:
                try:
                    backup.unlink()
                except FileNotFoundError:
                    pass
    except Exception:
        for target, backup, existed in reversed(backups):
            try:
                if target.exists():
                    target.unlink()
                if existed and backup.exists():
                    os.replace(backup, target)
            except Exception:
                pass
        raise
    finally:
        for _target, tmp in artifacts:
            try:
                tmp.unlink()
            except FileNotFoundError:
                pass


def resolve_vector_dimension(model_id: str) -> int:
    probe, _np, _faiss = embed_texts([""], model_id)
    return int(probe.shape[1])


def build_empty_vectors(model_id: str) -> tuple[Any, Any]:
    np, faiss = load_vector_dependencies()
    dim = resolve_vector_dimension(model_id)
    vectors = np.zeros((0, dim), dtype="float32")
    return vectors, faiss


def build_manifest(
    model_id: str,
    vector_dim: int,
    chunk_count: int,
    *,
    generated_at: str | None = None,
    last_successful_rebuild_at: str | None = None,
) -> dict[str, Any]:
    normalized_model_id = normalize_model_id(model_id)
    now_iso = generated_at or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return {
        "version": MANIFEST_VERSION,
        "modelId": model_id,
        "normalizedModelId": normalized_model_id,
        "dimension": int(vector_dim),
        "chunkCount": int(chunk_count),
        "updatedAt": now_iso,
        "lastSuccessfulRebuildAt": last_successful_rebuild_at or now_iso,
    }


def validate_index_manifest(
    manifest: dict[str, Any] | None,
    *,
    requested_model_id: str,
    actual_dimension: int | None = None,
    expected_dimension: int | None = None,
) -> dict[str, Any]:
    if manifest is None:
        raise SidecarError("missing index manifest; rebuild the FAISS conversation index")

    version = manifest.get("version")
    if not isinstance(version, int) or isinstance(version, bool) or version != MANIFEST_VERSION:
        raise SidecarError("unsupported index manifest version; rebuild the FAISS conversation index")

    normalized_manifest_model_id = manifest.get("normalizedModelId")
    if not isinstance(normalized_manifest_model_id, str) or not normalized_manifest_model_id:
        raise SidecarError("index manifest missing normalized model id; rebuild the FAISS conversation index")

    requested_normalized_model_id = normalize_model_id(requested_model_id)
    if normalized_manifest_model_id != requested_normalized_model_id:
        raise SidecarError(
            "index model mismatch "
            f"(index={normalized_manifest_model_id}, query={requested_normalized_model_id}); "
            "rebuild the FAISS conversation index"
        )

    manifest_dimension = manifest.get("dimension")
    if not isinstance(manifest_dimension, int) or isinstance(manifest_dimension, bool) or manifest_dimension <= 0:
        raise SidecarError("index manifest missing vector dimension; rebuild the FAISS conversation index")

    chunk_count = manifest.get("chunkCount")
    if not isinstance(chunk_count, int) or isinstance(chunk_count, bool) or chunk_count < 0:
        raise SidecarError("index manifest missing chunk count; rebuild the FAISS conversation index")

    if actual_dimension is not None and manifest_dimension != int(actual_dimension):
        raise SidecarError(
            f"index dimension mismatch (manifest={manifest_dimension}, index={int(actual_dimension)}); "
            "rebuild the FAISS conversation index"
        )

    if expected_dimension is not None and manifest_dimension != int(expected_dimension):
        raise SidecarError(
            f"index dimension mismatch (manifest={manifest_dimension}, query={int(expected_dimension)}); "
            "rebuild the FAISS conversation index"
        )

    return {
        "version": version,
        "modelId": manifest.get("modelId") if isinstance(manifest.get("modelId"), str) else "",
        "normalizedModelId": normalized_manifest_model_id,
        "dimension": manifest_dimension,
        "chunkCount": chunk_count,
        "updatedAt": manifest.get("updatedAt") if isinstance(manifest.get("updatedAt"), str) else "",
        "lastSuccessfulRebuildAt": (
            manifest.get("lastSuccessfulRebuildAt")
            if isinstance(manifest.get("lastSuccessfulRebuildAt"), str)
            else ""
        ),
    }


def validate_artifact_counts(index: Any, rows: list[dict[str, Any]], manifest: dict[str, Any]) -> None:
    index_count = int(getattr(index, "ntotal", -1))
    metadata_count = len(rows)
    manifest_count = manifest["chunkCount"]

    if index_count != metadata_count or index_count != int(manifest_count):
        raise SidecarError(
            "index artifact count mismatch "
            f"(index={index_count}, metadata={metadata_count}, manifest={int(manifest_count)}); "
            "rebuild the FAISS conversation index"
        )


def parse_chunks(payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw_chunks = payload.get("chunks")
    if not isinstance(raw_chunks, list):
        raise SidecarError("chunks must be an array")
    chunks: list[dict[str, Any]] = []
    for index, item in enumerate(raw_chunks):
        if not isinstance(item, dict):
            raise SidecarError(f"chunks[{index}] must be an object")
        chunk_id = item.get("id")
        text = item.get("text")
        if not isinstance(chunk_id, str) or not chunk_id:
            raise SidecarError(f"chunks[{index}].id must be a non-empty string")
        if not isinstance(text, str):
            raise SidecarError(f"chunks[{index}].text must be a string")
        chunks.append(
            {
                "id": chunk_id,
                "sessionKey": item.get("sessionKey") if isinstance(item.get("sessionKey"), str) else "",
                "text": text,
                "startTs": item.get("startTs") if isinstance(item.get("startTs"), str) else "",
                "endTs": item.get("endTs") if isinstance(item.get("endTs"), str) else "",
            }
        )
    return chunks


def metadata_row_key(row: dict[str, Any]) -> tuple[str, str]:
    session_key = (
        row.get("sessionKey") if isinstance(row.get("sessionKey"), str) else ""
    )
    row_id = row.get("id") if isinstance(row.get("id"), str) else ""
    return (session_key, row_id)


def metadata_result_path(row: dict[str, Any]) -> str:
    row_id = row.get("id") if isinstance(row.get("id"), str) else ""
    session_key = row.get("sessionKey") if isinstance(row.get("sessionKey"), str) else ""
    return f"{session_key}/{row_id}" if session_key else row_id


def parse_retention_cutoff_ms(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SidecarError("retentionCutoffMs must be a finite non-negative number when provided")
    if value < 0 or value != value or value in (float("inf"), float("-inf")):
        raise SidecarError("retentionCutoffMs must be a finite non-negative number when provided")
    return int(value)


def parse_row_timestamp_ms(row: dict[str, Any]) -> int | None:
    for key in ("endTs", "startTs"):
        value = row.get(key)
        if not isinstance(value, str) or not value.strip():
            continue
        text = value.strip()
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            continue
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return int(parsed.timestamp() * 1000)
    return None


def prune_metadata_rows(rows: list[dict[str, Any]], retention_cutoff_ms: int | None) -> list[dict[str, Any]]:
    if retention_cutoff_ms is None:
        return rows
    pruned: list[dict[str, Any]] = []
    for row in rows:
        timestamp_ms = parse_row_timestamp_ms(row)
        if timestamp_ms is None or timestamp_ms >= retention_cutoff_ms:
            pruned.append(row)
    return pruned


def merge_rows(existing: list[dict[str, Any]], updates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_key: dict[tuple[str, str], dict[str, Any]] = {
        metadata_row_key(row): row for row in existing
    }
    order = [metadata_row_key(row) for row in existing]
    for update in updates:
        update_key = metadata_row_key(update)
        if update_key not in by_key:
            order.append(update_key)
        by_key[update_key] = update
    return [by_key[row_key] for row_key in order]


def lock_owner_key(lock_path: Path) -> str:
    return str(lock_path.resolve())


def make_lock_owner_token() -> str:
    return f"{os.getpid()}:{uuid.uuid4().hex}"


def read_lock_contents(lock_path: Path) -> str | None:
    try:
        raw = lock_path.read_text(encoding="utf-8").strip()
    except Exception:
        return None
    if not raw:
        return None
    return raw


def read_lock_owner_pid(lock_path: Path) -> int | None:
    raw = read_lock_contents(lock_path)
    if raw is None:
        return None
    pid_raw = raw.split(":", 1)[0].strip()
    try:
        pid = int(pid_raw)
    except ValueError:
        return None
    return pid if pid > 0 else None


def lock_stat_matches(current_stat: os.stat_result, observed_stat: os.stat_result) -> bool:
    if current_stat.st_size != observed_stat.st_size:
        return False
    if current_stat.st_mtime_ns != observed_stat.st_mtime_ns:
        return False
    if getattr(current_stat, "st_ino", 0) and getattr(observed_stat, "st_ino", 0):
        return current_stat.st_ino == observed_stat.st_ino
    return True


def unlink_lock_if_unchanged(
    lock_path: Path,
    observed_owner_token: str | None,
    observed_stat: os.stat_result,
) -> bool:
    try:
        current_stat = lock_path.stat()
    except FileNotFoundError:
        return False
    current_owner_token = read_lock_contents(lock_path)
    if current_owner_token != observed_owner_token:
        return False
    if not lock_stat_matches(current_stat, observed_stat):
        return False
    try:
        lock_path.unlink()
    except FileNotFoundError:
        return False
    return True


def is_process_alive(pid: int) -> bool:
    if pid <= 0:
        return False

    if os.name == "nt":
        try:
            probe = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                capture_output=True,
                text=True,
                timeout=2,
            )
        except Exception:
            return False
        output = probe.stdout.strip()
        if not output:
            return False
        if output.startswith("INFO:"):
            return False
        return f'"{pid}"' in output

    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def acquire_lock(index_dir: Path, lock_name: str) -> Path:
    lock_path = index_dir / lock_name
    lock_owner_token = make_lock_owner_token()
    lock_label = lock_name.strip(".")
    if lock_label.endswith(".lock"):
        lock_label = lock_label[: -len(".lock")]
    lock_label = lock_label.replace(".", " ")
    deadline = time.monotonic() + LOCK_TIMEOUT_SECONDS

    while True:
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(lock_owner_token)
            LOCK_OWNERS[lock_owner_key(lock_path)] = lock_owner_token
            return lock_path
        except FileExistsError:
            try:
                observed_stat = lock_path.stat()
            except FileNotFoundError:
                continue

            age = time.time() - observed_stat.st_mtime
            observed_owner_token = read_lock_contents(lock_path)
            owner_pid = read_lock_owner_pid(lock_path)
            owner_alive = is_process_alive(owner_pid) if owner_pid is not None else False

            if age > LOCK_STALE_SECONDS and not owner_alive:
                unlink_lock_if_unchanged(lock_path, observed_owner_token, observed_stat)
                continue

            if time.monotonic() >= deadline:
                raise SidecarError(f"timed out waiting for FAISS {lock_label} lock")
            time.sleep(0.05)


def acquire_index_lock(index_dir: Path) -> Path:
    return acquire_lock(index_dir, ".index.lock")


def acquire_writer_lock(index_dir: Path) -> Path:
    return acquire_lock(index_dir, ".writer.lock")


def release_lock(lock_path: Path) -> None:
    lock_owner_token = LOCK_OWNERS.pop(lock_owner_key(lock_path), None)
    if lock_owner_token is None:
        return
    try:
        observed_stat = lock_path.stat()
    except FileNotFoundError:
        return
    unlink_lock_if_unchanged(lock_path, lock_owner_token, observed_stat)


def release_index_lock(lock_path: Path) -> None:
    release_lock(lock_path)


def run_upsert(payload: dict[str, Any]) -> dict[str, Any]:
    model_id = payload.get("modelId")
    if not isinstance(model_id, str) or not model_id:
        raise SidecarError("modelId is required")

    index_dir = ensure_index_dir(payload.get("indexPath"))
    retention_cutoff_ms = parse_retention_cutoff_ms(payload.get("retentionCutoffMs"))
    chunks = parse_chunks(payload)

    if not chunks:
        return {"ok": True, "upserted": 0}

    meta_path = metadata_file(index_dir)
    idx_path = index_file(index_dir)
    manifest_path = manifest_file(index_dir)

    writer_lock_path = acquire_writer_lock(index_dir)
    try:
        existing = prune_metadata_rows(read_metadata(meta_path), retention_cutoff_ms)
        existing_manifest = read_manifest(manifest_path)
        merged = merge_rows(existing, chunks)

        texts = [row["text"] for row in merged]
        vectors, _np, faiss = embed_texts(texts, model_id)

        lock_path = acquire_index_lock(index_dir)
        try:
            preserved_rebuild_at = (
                existing_manifest.get("lastSuccessfulRebuildAt")
                if isinstance(existing_manifest, dict)
                and isinstance(existing_manifest.get("lastSuccessfulRebuildAt"), str)
                and existing_manifest.get("lastSuccessfulRebuildAt")
                else None
            )
            manifest = build_manifest(
                model_id,
                int(vectors.shape[1]),
                len(merged),
                last_successful_rebuild_at=preserved_rebuild_at,
            )
            commit_index_artifacts(
                [
                    (idx_path, write_index_temp(idx_path, vectors, faiss)),
                    (meta_path, write_metadata_temp(meta_path, merged)),
                    (manifest_path, write_manifest_temp(manifest_path, manifest)),
                ]
            )
        finally:
            release_index_lock(lock_path)
    finally:
        release_lock(writer_lock_path)

    return {"ok": True, "upserted": len(chunks)}


def run_rebuild(payload: dict[str, Any]) -> dict[str, Any]:
    model_id = payload.get("modelId")
    if not isinstance(model_id, str) or not model_id:
        raise SidecarError("modelId is required")

    index_dir = ensure_index_dir(payload.get("indexPath"))
    chunks = parse_chunks(payload)

    writer_lock_path = acquire_writer_lock(index_dir)
    try:
        if chunks:
            texts = [row["text"] for row in chunks]
            vectors, _np, faiss = embed_texts(texts, model_id)
            chunk_count = len(chunks)
        else:
            vectors, faiss = build_empty_vectors(model_id)
            chunk_count = 0

        lock_path = acquire_index_lock(index_dir)
        try:
            meta_path = metadata_file(index_dir)
            idx_path = index_file(index_dir)
            manifest_path = manifest_file(index_dir)

            manifest = build_manifest(model_id, int(vectors.shape[1]), chunk_count)
            commit_index_artifacts(
                [
                    (idx_path, write_index_temp(idx_path, vectors, faiss)),
                    (meta_path, write_metadata_temp(meta_path, chunks)),
                    (manifest_path, write_manifest_temp(manifest_path, manifest)),
                ]
            )
        finally:
            release_index_lock(lock_path)
    finally:
        release_lock(writer_lock_path)

    return {"ok": True, "rebuilt": len(chunks)}


def run_search(payload: dict[str, Any]) -> dict[str, Any]:
    model_id = payload.get("modelId")
    query = payload.get("query")
    top_k = payload.get("topK")
    if not isinstance(model_id, str) or not model_id:
        raise SidecarError("modelId is required")
    if not isinstance(query, str) or not query.strip():
        raise SidecarError("query is required")
    if not isinstance(top_k, int) or isinstance(top_k, bool) or top_k <= 0:
        raise SidecarError("topK must be a positive integer")

    index_dir = ensure_index_dir(payload.get("indexPath"))
    meta_path = metadata_file(index_dir)
    idx_path = index_file(index_dir)
    manifest_path = manifest_file(index_dir)

    lock_path = acquire_index_lock(index_dir)
    try:
        has_index = idx_path.exists()
        has_metadata = meta_path.exists()
        has_manifest = manifest_path.exists()
        if not has_index and not has_metadata and not has_manifest:
            return {"ok": True, "results": []}
        if not has_index or not has_metadata or not has_manifest:
            raise SidecarError("conversation index artifacts incomplete; rebuild the FAISS conversation index")

        rows = read_metadata(meta_path)
        _np, faiss = load_vector_dependencies()
        index = faiss.read_index(str(idx_path))
        manifest = validate_index_manifest(
            read_manifest(manifest_path),
            requested_model_id=model_id,
            actual_dimension=int(index.d),
        )
        validate_artifact_counts(index, rows, manifest)
    finally:
        release_index_lock(lock_path)

    if not rows:
        return {"ok": True, "results": []}

    query_vector, _np2, _faiss2 = embed_texts([query], model_id)
    query_dimension = int(query_vector.shape[1])
    if int(manifest["dimension"]) != query_dimension:
        raise SidecarError(
            f"index dimension mismatch (manifest={int(manifest['dimension'])}, query={query_dimension}); "
            "rebuild the FAISS conversation index"
        )

    distances, indices = index.search(query_vector, top_k)
    results: list[dict[str, Any]] = []
    for score, idx in zip(distances[0], indices[0]):
        idx_i = int(idx)
        if idx_i < 0 or idx_i >= len(rows):
            continue
        row = rows[idx_i]
        results.append(
            {
                "path": metadata_result_path(row),
                "snippet": row["text"][:280],
                "score": float(score),
            }
        )

    return {"ok": True, "results": results}


def build_health_response(payload: dict[str, Any], *, include_metadata: bool = False) -> dict[str, Any]:
    index_dir = ensure_index_dir(payload.get("indexPath"))
    meta_path = metadata_file(index_dir)
    idx_path = index_file(index_dir)
    manifest_path = manifest_file(index_dir)

    status = "ok"
    error = ""
    model_id = normalize_model_id(str(payload.get("modelId", "")))
    manifest_details: dict[str, Any] | None = None
    metadata_details: dict[str, Any] | None = None

    try:
        load_vector_dependencies()
        if model_id != "__hash__":
            try:
                import sentence_transformers  # type: ignore # noqa: F401
            except Exception as exc:
                raise DependencyError(f"missing sentence-transformers dependency: {exc}") from exc
    except Exception as exc:
        status = "degraded"
        error = str(exc)

    lock_path: Path | None = None
    try:
        lock_path = acquire_index_lock(index_dir)
        has_index = idx_path.exists()
        has_metadata = meta_path.exists()
        has_manifest = manifest_path.exists()
        rows: list[dict[str, Any]] | None = None

        if has_index or has_metadata or has_manifest:
            if not has_index or not has_metadata or not has_manifest:
                if status == "ok":
                    status = "degraded"
                if not error:
                    error = "conversation index artifacts incomplete; rebuild the FAISS conversation index"
            else:
                try:
                    rows = read_metadata(meta_path)
                    _np, faiss = load_vector_dependencies()
                    index = faiss.read_index(str(idx_path))
                    manifest_details = validate_index_manifest(
                        read_manifest(manifest_path),
                        requested_model_id=model_id,
                        actual_dimension=int(index.d),
                    )
                    validate_artifact_counts(index, rows, manifest_details)
                except Exception as exc:
                    if status == "ok":
                        status = "degraded"
                    if not error:
                        error = str(exc)
        elif status == "ok":
            status = "degraded"
            error = "conversation index artifacts missing; build the FAISS conversation index"

        if include_metadata:
            if rows is None:
                rows = read_metadata(meta_path)
            metadata_details = {
                "chunkCount": len(rows),
                "hasIndex": has_index,
                "hasMetadata": has_metadata,
                "hasManifest": has_manifest,
            }
    except Exception as exc:
        if status == "ok":
            status = "degraded"
        if not error:
            error = str(exc)
        if include_metadata:
            try:
                chunk_count = len(read_metadata(meta_path))
            except Exception:
                chunk_count = 0
            metadata_details = {
                "chunkCount": chunk_count,
                "hasIndex": idx_path.exists(),
                "hasMetadata": meta_path.exists(),
                "hasManifest": manifest_path.exists(),
            }
    finally:
        if lock_path is not None:
            release_index_lock(lock_path)

    response: dict[str, Any] = {"ok": True, "status": status}
    if error:
        response["error"] = error
    if manifest_details is not None:
        response["manifest"] = manifest_details
    if metadata_details is not None:
        response["metadata"] = metadata_details
    return response


def run_health(payload: dict[str, Any]) -> dict[str, Any]:
    return build_health_response(payload)


def run_inspect(payload: dict[str, Any]) -> dict[str, Any]:
    return build_health_response(payload, include_metadata=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["upsert", "rebuild", "search", "health", "inspect"])
    args = parser.parse_args()

    try:
        payload = read_payload()
        if args.command == "upsert":
            emit(run_upsert(payload))
        elif args.command == "rebuild":
            emit(run_rebuild(payload))
        elif args.command == "search":
            emit(run_search(payload))
        elif args.command == "inspect":
            emit(run_inspect(payload))
        else:
            emit(run_health(payload))
        return 0
    except (SidecarError, DependencyError) as exc:
        emit({"ok": False, "error": str(exc)})
        return 0
    except Exception as exc:
        print(f"faiss sidecar internal error: {exc}", file=sys.stderr)
        emit({"ok": False, "error": "internal sidecar error"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
