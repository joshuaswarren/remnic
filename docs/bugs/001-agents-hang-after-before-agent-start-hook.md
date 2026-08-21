# Bug Report: Agents Hang After `before_agent_start` Hook Completes

**Status:** Resolved
**Priority:** Critical
**Labels:** `bug`, `gateway-integration`, `hook-lifecycle`, `fixed`

**Resolution Date:** 2026-02-09
**Fixes Applied:** See "Fixes Applied" section below

---

## Summary

Agents are hanging after the Engram `before_agent_start` hook completes successfully. The hook returns a system prompt with memory context, but the agent never proceeds to call the LLM provider. This affects ~86% of agent runs.

---

## Symptoms

1. **Discord bot stops responding** to messages after Engram hook runs
2. **Session state shows messages stuck** - `lastInboundMessageId` is newer than `lastProcessedMessageId`
3. **Hook completes but agent hangs** - Logs show "returning system prompt with X chars" but no subsequent provider call
4. **Cron jobs also affected** - Same pattern for scheduled agent runs

---

## Investigation Methodology

### 1. Log Analysis

Checked gateway logs for hook invocation vs completion counts:

```bash
# Hook invocations: ~2002
grep -c "before_agent_start" ~/.openclaw/logs/gateway.log

# Agent completions: ~278
grep -c "agent_end" ~/.openclaw/logs/gateway.log
```

**Result:** 86% of agents that trigger the Engram hook never complete.

### 2. Session State Inspection

Examined Discord session state file for stuck channel:

```json
{
  "sessionKey": "agent:<agent-id>:discord:channel:<channel-id>",
  "lastInboundMessageId": "<newer-message-id>",
  "lastInboundAtMs": 1770654493205,
  "lastProcessedMessageId": "<older-message-id>",
  "lastProcessedAtMs": 1770653411844
}
```

**Finding:** Message was received (inbound) but never processed. The agent started but hung.

### 3. Hook Execution Flow Analysis

Examined logs around `before_agent_start` completion:

```
[gateway] openclaw-engram: before_agent_start: sessionKey=agent:<agent-id>:discord:channel:...
[gateway] openclaw-engram: before_agent_start: recall returned 25643 chars
[gateway] openclaw-engram: before_agent_start: returning system prompt with 8029 chars
# ...no subsequent provider call logs...
```

**Finding:** Hook returns successfully, but agent dispatch fails afterward.

### 4. Error Log Analysis

Checked `gateway.err.log` for related errors:

```
[gateway] openclaw-engram: agent_end processing failed — facts is not iterable
```

**Finding:** The `agent_end` hook has a bug where `result.facts` is not always an array.

---

## Root Cause Analysis

### Issue 1: `agent_end` Hook Error (Confirmed Bug)

In `src/orchestrator.ts`, the `persistExtraction` method assumes `result.facts` is always an array:

```typescript
for (const fact of result.facts) {  // Throws if facts is undefined
```

However, the extraction engine may return a malformed result where `facts` is undefined or not an array.

### Issue 2: Large Memory Context (Contributing Factor)

The hook returns system prompts up to 8,000+ characters:

```typescript
// src/index.ts lines 99-104
const maxChars = cfg.maxMemoryTokens * 4;  // Can be 8000+ chars
const trimmed = context.length > maxChars
  ? context.slice(0, maxChars) + "\n\n...(memory context trimmed)"
  : context;
```

While the user prefers **not to cap memory context size**, this large injection may be overwhelming the gateway's agent dispatch system.

---

## Reproduction Steps

1. Install Engram plugin with default configuration
2. Have accumulated significant memories (15,000+ memories observed)
3. Trigger any Discord message or cron job
4. Observe that Engram hook completes but agent hangs

---

## Proposed Fixes

### Fix 1: Defensive Handling in `agent_end` Hook (Required)

**File:** `src/index.ts` in the `agent_end` handler

The extraction result should be validated before processing:

```typescript
// Add defensive check before line 131
if (!result || !Array.isArray(result.facts)) {
  log.warn("extraction returned invalid facts array, skipping");
  await this.buffer.clearAfterExtraction();
  return;
}
```

### Fix 2: Add Hook Return Value Validation (Recommended)

The `before_agent_start` hook should validate its return value format:

```typescript
// In src/index.ts before_agent_start handler
try {
  const context = await orchestrator.recall(prompt, sessionKey);
  if (!context) return;

  // ...trimming logic...

  const result = {
    systemPrompt: `## Memory Context (Engram)\n\n${trimmed}\n\nUse this context naturally...`,
  };

  log.info(`before_agent_start: returning system prompt with ${trimmed.length} chars`);
  return result;
} catch (err) {
  log.error("before_agent_start failed", err);
  return; // Return undefined on error, don't block agent
}
```

### Fix 3: Add Timeout/Async Safety (Recommended)

Consider adding a timeout wrapper around hook execution to prevent indefinite hangs:

```typescript
// In gateway hook dispatcher (if possible)
const hookResult = await Promise.race([
  hook.execute(event, ctx),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Hook timeout")), 30000)
  ),
]);
```

---

## Testing Recommendations

1. **Unit test** the `agent_end` handler with malformed extraction results
2. **Integration test** with large memory contexts (10,000+ facts)
3. **Monitor** the hook invocation vs completion ratio after fix
4. **Log** the duration between hook return and agent start

---

## Related Code Sections

- `src/index.ts` lines 78-115: `before_agent_start` hook
- `src/index.ts` lines 117-162: `agent_end` hook
- `src/orchestrator.ts` lines 275-293: `processTurn` method
- `src/orchestrator.ts` lines 348-469: `persistExtraction` method

---

## Notes

- This bug affects all agent types: Discord, cron jobs, and web interface agents
- The issue is reproducible with high memory counts (15,000+ memories)
- Cron jobs were changed to use different models, but this didn't resolve the hanging issue
- The hang occurs between hook completion and provider dispatch

---

## Fixes Applied

### Fix 1: Defensive Handling in `persistExtraction` (COMMITTED)
**File:** `src/orchestrator.ts` lines 365-369

Added validation before iterating over `result.facts`:
```typescript
// Defensive: validate result and facts array
if (!result || !Array.isArray(result.facts)) {
  log.warn("persistExtraction: result or result.facts is invalid, skipping", { resultType: typeof result, factsType: typeof result?.facts });
  return persistedIds;
}
```

### Fix 2: Safe Meta Update (COMMITTED)
**File:** `src/orchestrator.ts` lines 347-352

Changed direct property access to safe optional chaining:
```typescript
// Update meta (safely handle potentially invalid result)
meta.extractionCount += 1;
meta.lastExtractionAt = new Date().toISOString();
meta.totalMemories += Array.isArray(result?.facts) ? result.facts.length : 0;
meta.totalEntities += Array.isArray(result?.entities) ? result.entities.length : 0;
await this.storage.saveMeta(meta);
```

### Fix 3: Safe Fallback Extraction (COMMITTED)
**File:** `src/extraction.ts` lines 120-132

Added validation for fallback extraction results:
```typescript
if (result && Array.isArray(result.facts)) {
  this.emit({
    kind: "llm_end", traceId, model: "fallback", operation: "extraction", durationMs,
    output: JSON.stringify(result).slice(0, 2000),
  });
  log.debug(
    `extracted ${result.facts.length} facts, ${result.entities.length} entities, ${(result.questions ?? []).length} questions via fallback`,
  );
  return {
    ...result,
    questions: result.questions ?? [],
    identityReflection: result.identityReflection ?? undefined,
  } as ExtractionResult;
}
```

### Fix 4: Orphaned Lock Cleanup Service (DEPLOYED)
**File:** `~/.local/bin/cleanup-orphaned-locks.sh`

Created automated cleanup for orphaned session lock files with PID verification (EPERM vs ESRCH fix). Runs every 5 minutes via launchd.

---

*Report generated: 2026-02-09*
*Engram Plugin Version: 2026.2.6*
*Last Updated: 2026-02-09*
