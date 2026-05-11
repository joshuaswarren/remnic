import test from "node:test";
import assert from "node:assert/strict";

import { patchAmbMemoryRegistry } from "./install-remnic-provider.mjs";

test("patchAmbMemoryRegistry handles compact single-line registries", () => {
  const compactRegistry =
    "from .base import MemoryProvider; from .bm25 import BM25MemoryProvider; from .hindsight import HindsightMemoryProvider; REGISTRY: dict[str, type[MemoryProvider]] = {\"bm25\": BM25MemoryProvider, \"hindsight\": HindsightMemoryProvider}; def get_memory_provider(name: str) -> MemoryProvider: raise ValueError(f\"Unknown memory provider: '{name}'. Available: {list(REGISTRY)}\")";

  const patched = patchAmbMemoryRegistry(compactRegistry);

  assert.match(patched, /from \.remnic import RemnicMemoryProvider/);
  assert.match(patched, /["']remnic["']:\s*RemnicMemoryProvider/);
  assert.match(
    patched,
    /from \.remnic import RemnicMemoryProvider\nREGISTRY/,
    "Remnic import should remain on its own physical line before REGISTRY",
  );
  assert.ok(
    patched.indexOf("from .remnic import RemnicMemoryProvider") <
      patched.indexOf("REGISTRY"),
    "Remnic import should be inserted before the registry object",
  );
  assert.ok(
    patched.indexOf('"remnic": RemnicMemoryProvider') <
      patched.indexOf('"bm25": BM25MemoryProvider'),
    "Remnic registry entry should be inserted at the start of REGISTRY",
  );
  assert.match(
    patched,
    /def get_memory_provider\(name: str\) -> MemoryProvider:/,
    "the registry patch must not insert text inside the provider function",
  );
});

test("patchAmbMemoryRegistry remains idempotent for existing Remnic entries", () => {
  const registry = `from .base import MemoryProvider
from .bm25 import BM25MemoryProvider
from .remnic import RemnicMemoryProvider

REGISTRY: dict[str, type[MemoryProvider]] = {
    "remnic": RemnicMemoryProvider,
    "bm25": BM25MemoryProvider,
}
`;

  const patched = patchAmbMemoryRegistry(registry);

  assert.equal(
    patched.match(/from \.remnic import RemnicMemoryProvider/g)?.length,
    1,
  );
  assert.equal(
    patched.match(/["']remnic["']:\s*RemnicMemoryProvider/g)?.length,
    1,
  );
});
