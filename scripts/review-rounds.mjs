export const ROUND_COMMENT_MARKER = "remnic-review-round:v1";
export const DEFAULT_ROUND_DEBOUNCE_MS = 10 * 60 * 1000;
export const DEFAULT_ROUND_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const CODEQL_AUTHORS = new Set([
  "github-advanced-security",
  "github-advanced-security[bot]",
  "github-code-scanning[bot]",
]);

function normalizeLogin(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function parseTime(value) {
  const parsed = Date.parse(typeof value === "string" ? value : "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function currentThreadId(thread) {
  return typeof thread?.id === "string" && thread.id.length > 0 ? thread.id : null;
}

function threadIsRoundEligible(thread) {
  return currentThreadId(thread) !== null &&
    thread?.isResolved === false &&
    !CODEQL_AUTHORS.has(normalizeLogin(thread.comments?.nodes?.[0]?.author?.login ?? thread.comments?.[0]?.author?.login));
}

function threadComments(thread) {
  if (Array.isArray(thread?.comments)) return thread.comments;
  if (Array.isArray(thread?.comments?.nodes)) return thread.comments.nodes;
  return [];
}

function threadIsAddressed(thread, botAliases) {
  if (thread?.isResolved === true) return true;
  const bots = new Set(botAliases.map(normalizeLogin).filter(Boolean));
  if (bots.size === 0) return false;
  return threadComments(thread).some((comment) => {
    const author = normalizeLogin(comment?.author?.login ?? comment?.user?.login);
    return author.length > 0 && !bots.has(author);
  });
}

function eligibleThreadIds(threads) {
  if (!Array.isArray(threads)) return [];
  return [...new Set(threads.filter(threadIsRoundEligible).map(currentThreadId).filter(Boolean))];
}

function mergeThreadIds(state, threads) {
  const next = copyState(state);
  const ids = new Set(next.threadIds);
  for (const id of eligibleThreadIds(threads)) {
    if (!ids.has(id)) {
      ids.add(id);
      next.threadIds.push(id);
    }
  }
  return next;
}

function copyState(state) {
  return state ? { ...state, threadIds: [...(state.threadIds ?? [])] } : null;
}

function stableSince(state, headSha) {
  if (!state || state.headSha !== headSha) return 0;
  return parseTime(state.lastHeadChangedAt ?? state.openedAt);
}

function noteHead(state, headSha, now) {
  const next = copyState(state);
  if (next.headSha === headSha) return next;
  next.headSha = headSha;
  next.lastHeadChangedAt = now;
  next.pushes += 1;
  return next;
}

function openRound({ state, headSha, now, threads, botActivity }) {
  return {
    version: 1,
    status: "open",
    round: (state?.round ?? 0) + 1,
    openedAt: now,
    openedHeadSha: headSha,
    headSha,
    lastHeadChangedAt: now,
    pushes: 0,
    threadIds: eligibleThreadIds(threads),
    dispatchIssuedAt: null,
    closeReason: null,
    autoClosed: false,
    lastBotActivity: botActivity,
  };
}

function closeForDispatch(state, now, reason) {
  return {
    ...copyState(state),
    status: "closed",
    closedAt: now,
    closeReason: reason,
    autoClosed: reason === "max-age",
    dispatchIssuedAt: now,
  };
}

function wait(state, reason) {
  return { action: "wait", reason, state: copyState(state) };
}

function normalizeBotActivity(value) {
  if (!value || typeof value !== "object") return null;
  const id = typeof value.id === "string" && value.id.length > 0 ? value.id : null;
  const at = typeof value.at === "string" && parseTime(value.at) > 0 ? value.at : null;
  return id || at ? { id, at } : null;
}

function isNewBotActivity(activity, state) {
  if (!activity) return false;
  const activityTime = parseTime(activity.at);
  const dispatchTime = parseTime(state?.dispatchIssuedAt);
  const previous = state?.lastBotActivity;
  if (dispatchTime > 0) {
    if (activityTime > dispatchTime) return true;
    return Boolean(activity.id && previous?.id && activity.id !== previous.id);
  }
  if (!previous) return true;
  if (activity.id && previous.id) return activity.id !== previous.id;
  const previousTime = parseTime(previous.at);
  if (activityTime > 0 && previousTime > 0) return activityTime > previousTime;
  return true;
}

/**
 * Decide the next round action from a snapshot of GitHub activity.
 * The reducer is pure so fixture replay can validate the state machine without GitHub.
 */
export function decideRound({
  state = null,
  headSha,
  now,
  threads = [],
  botActivity = null,
  botAliases = [],
  forceDispatch = false,
  debounceMs = DEFAULT_ROUND_DEBOUNCE_MS,
  maxAgeMs = DEFAULT_ROUND_MAX_AGE_MS,
} = {}) {
  if (typeof headSha !== "string" || headSha.length === 0) {
    throw new Error("headSha must be a non-empty string");
  }
  if (typeof now !== "string" || parseTime(now) === 0) {
    throw new Error("now must be a valid ISO timestamp");
  }

  const activity = normalizeBotActivity(botActivity);
  if (!state) {
    return activity
      ? { action: "open", reason: "first-bot-activity", state: openRound({ state, headSha, now, threads, botActivity: activity }) }
      : wait(null, "awaiting-first-bot-activity");
  }

  if (state.status === "closed") {
    if (isNewBotActivity(activity, state)) {
      return {
        action: "open",
        reason: "next-bot-activity",
        state: openRound({ state, headSha, now, threads, botActivity: activity }),
      };
    }
    if (forceDispatch && !state.dispatchIssuedAt) {
      return {
        action: "dispatch",
        reason: "force-label",
        state: closeForDispatch(noteHead(state, headSha, now), now, "force-label"),
      };
    }
    return wait(state, "round-dispatched");
  }

  let next = noteHead(state, headSha, now);
  next = mergeThreadIds(next, threads);
  if (activity && isNewBotActivity(activity, next)) next.lastBotActivity = activity;
  const age = parseTime(now) - parseTime(next.openedAt);
  if (age >= maxAgeMs) {
    return {
      action: "dispatch",
      reason: "max-age",
      state: closeForDispatch(next, now, "max-age"),
    };
  }

  const unresolved = getGuardUnresolvedThreads(next, threads, botAliases);
  if (unresolved.length > 0) return wait(next, "round-threads-open");
  if (next.threadIds.length === 0 && next.pushes === 0) return wait(next, "no-round-work");

  if (forceDispatch) {
    return {
      action: "dispatch",
      reason: "force-label",
      state: closeForDispatch(next, now, "force-label"),
    };
  }

  const stableAt = stableSince(next, headSha);
  if (stableAt > 0 && parseTime(now) - stableAt >= debounceMs) {
    return {
      action: "dispatch",
      reason: "round-complete",
      state: closeForDispatch(next, now, "round-complete"),
    };
  }
  return wait(next, "debounce");
}

/** Return unresolved threads in the current round, using existing guard semantics. */
export function getGuardUnresolvedThreads(state, threads, botAliases = []) {
  const candidates = Array.isArray(threads) ? threads : [];
  const roundIds = state ? new Set(state.threadIds ?? []) : null;
  return candidates.filter((thread) => {
    if (!threadIsRoundEligible(thread)) return false;
    if (roundIds && !roundIds.has(currentThreadId(thread))) return false;
    return !threadIsAddressed(thread, botAliases);
  });
}

function escapedMarker() {
  return ROUND_COMMENT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ledgerPattern() {
  return new RegExp(`<!--\\s*${escapedMarker()}\\s*\\n([\\s\\S]*?)\\n?-->`);
}

export function renderRoundLedger(state) {
  return `<!-- ${ROUND_COMMENT_MARKER}\n${JSON.stringify(state)}\n-->`;
}


function isValidBotActivity(value) {
  if (value === null) return true;
  return value && typeof value === "object" &&
    (value.id === null || typeof value.id === "string") &&
    (value.at === null || typeof value.at === "string") &&
    (value.id !== null || value.at !== null) &&
    (value.at === null || parseTime(value.at) > 0);
}

function isValidRoundState(state) {
  if (!state || state.version !== 1 || !["open", "closed"].includes(state.status)) return false;
  if (!Number.isInteger(state.round) || state.round < 1) return false;
  if (!Number.isInteger(state.pushes) || state.pushes < 0) return false;
  if (!Array.isArray(state.threadIds) || state.threadIds.some((id) => typeof id !== "string" || id.length === 0)) return false;
  if (new Set(state.threadIds).size !== state.threadIds.length) return false;
  if (typeof state.openedAt !== "string" || parseTime(state.openedAt) === 0) return false;
  if (typeof state.openedHeadSha !== "string" || state.openedHeadSha.length === 0) return false;
  if (typeof state.headSha !== "string" || state.headSha.length === 0) return false;
  if (typeof state.lastHeadChangedAt !== "string" || parseTime(state.lastHeadChangedAt) === 0) return false;
  if (!isValidBotActivity(state.lastBotActivity ?? null)) return false;
  if (state.status === "open") {
    return state.dispatchIssuedAt === null &&
      state.closeReason === null &&
      state.autoClosed === false &&
      state.closedAt === undefined;
  }
  return typeof state.closedAt === "string" &&
    parseTime(state.closedAt) > 0 &&
    typeof state.dispatchIssuedAt === "string" &&
    parseTime(state.dispatchIssuedAt) > 0 &&
    ["round-complete", "force-label", "max-age"].includes(state.closeReason) &&
    typeof state.autoClosed === "boolean";
}
export function parseRoundLedger(body) {
  if (typeof body !== "string") return null;
  const match = body.match(ledgerPattern());
  if (!match) return null;
  try {
    const state = JSON.parse(match[1]);
    return isValidRoundState(state) ? state : null;
  } catch {
    return null;
  }
}

export function upsertRoundLedgerComment(body, state) {
  const existing = typeof body === "string" ? body : "";
  const rendered = renderRoundLedger(state);
  return ledgerPattern().test(existing)
    ? existing.replace(ledgerPattern(), rendered)
    : `${existing}${existing.length > 0 ? "\n\n" : ""}${rendered}\n`;
}

function activityTime(activity) {
  return activity?.submitted_at ?? activity?.submittedAt ??
    activity?.created_at ?? activity?.createdAt ??
    activity?.updated_at ?? activity?.updatedAt ??
    activity?.completed_at ?? activity?.completedAt ?? null;
}

function activityId(activity, kind) {
  const raw = activity?.node_id ?? activity?.database_id ?? activity?.databaseId ?? activity?.id;
  const hasId = (typeof raw === "string" && raw.length > 0) ||
    (typeof raw === "number" && Number.isSafeInteger(raw));
  if (hasId) return `${kind}:${String(raw)}`;
  const commit = activity?.commit_id ?? activity?.original_commit_id ?? activity?.head_sha ?? activity?.headSha;
  const at = activityTime(activity);
  return commit || at ? `${kind}:${commit ?? ""}:${at ?? ""}` : null;
}

const SHA_REFERENCE_PATTERN =
  /\b(?:sha|commit|head|rev|revision)\s*[:#]?\s*([0-9a-f]{7,40})\b|\bfor\s+([0-9a-f]{7,40})\b/gi;

function bodyShaReferences(body) {
  if (typeof body !== "string") return [];
  return [...body.matchAll(SHA_REFERENCE_PATTERN)]
    .map((match) => (match[1] ?? match[2] ?? "").toLowerCase())
    .filter(Boolean);
}

function bodyReferencesCurrentHead(body, headSha) {
  if (typeof body !== "string" || typeof headSha !== "string" || !headSha.trim()) return true;
  const references = bodyShaReferences(body);
  if (references.length === 0) return false;
  const normalizedHead = headSha.trim().toLowerCase();
  return references.some((reference) => normalizedHead.startsWith(reference));
}

function activityBody(activity) {
  return [activity?.body, activity?.text].find((value) => typeof value === "string");
}

function activityMentionsHead(activity, headSha) {
  if (!headSha) return false;
  const commit = activity?.commit_id ?? activity?.original_commit_id ?? activity?.head_sha ?? activity?.headSha;
  if (commit) return commit === headSha;
  const body = activityBody(activity);
  if (typeof body !== "string") return false;
  return body.includes(headSha) || bodyReferencesCurrentHead(body, headSha);
}

function isCurrentActivity(activity, headSha, headCommittedAt) {
  if (activityMentionsHead(activity, headSha)) return true;
  const body = activityBody(activity);
  if (typeof body === "string" && bodyShaReferences(body).length > 0) return false;
  const activityTimeValue = parseTime(activityTime(activity));
  const headTime = parseTime(headCommittedAt);
  return activityTimeValue > 0 && headTime > 0 && activityTimeValue >= headTime;
}

function toActivityMarker(activity, kind) {
  const id = activityId(activity, kind);
  const at = activityTime(activity);
  if (!id && !at) return null;
  return {
    id,
    at: typeof at === "string" && parseTime(at) > 0 ? at : null,
  };
}

/** Return the newest current-head activity from configured bot groups. */
export function hasCurrentBotActivity({
  aliases = [],
  headSha,
  headCommittedAt,
  reviews = [],
  issueComments = [],
  reviewComments = [],
  checkRuns = [],
} = {}) {
  const configured = new Set(aliases.map(normalizeLogin).filter(Boolean));
  const matches = [];
  for (const [kind, activities] of [
    ["review", reviews],
    ["issue-comment", issueComments],
    ["review-comment", reviewComments],
  ]) {
    for (const activity of Array.isArray(activities) ? activities : []) {
      const login = normalizeLogin(activity?.user?.login ?? activity?.author?.login);
      if (configured.has(login) && isCurrentActivity(activity, headSha, headCommittedAt)) {
        const marker = toActivityMarker(activity, kind);
        if (marker) matches.push(marker);
      }
    }
  }
  for (const checkRun of Array.isArray(checkRuns) ? checkRuns : []) {
    const checkHead = checkRun?.head_sha ?? checkRun?.headSha;
    const current = checkHead ? checkHead === headSha : isCurrentActivity(checkRun, headSha, headCommittedAt);
    const checkAliases = [checkRun?.app?.slug, checkRun?.app?.name].map(normalizeLogin);
    if (current && checkAliases.some((alias) => configured.has(alias))) {
      const marker = toActivityMarker(checkRun, "check-run");
      if (marker) matches.push(marker);
    }
  }
  return matches.reduce((newest, candidate) => {
    if (!newest) return candidate;
    const newestTime = parseTime(newest.at);
    const candidateTime = parseTime(candidate.at);
    return candidateTime > newestTime ||
      (candidateTime === newestTime && String(candidate.id) > String(newest.id))
      ? candidate
      : newest;
  }, null);
}
