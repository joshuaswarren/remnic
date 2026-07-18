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
  return threadComments(thread).some((comment) => {
    const author = normalizeLogin(comment?.author?.login ?? comment?.user?.login);
    return author.length > 0 && !bots.has(author);
  });
}

function eligibleThreadIds(threads) {
  if (!Array.isArray(threads)) return [];
  return [...new Set(threads.filter(threadIsRoundEligible).map(currentThreadId).filter(Boolean))];
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

function openRound({ state, headSha, now, threads }) {
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

/**
 * Decide the next round action from a snapshot of GitHub activity.
 * The reducer is pure so fixture replay can validate the state machine without GitHub.
 */
export function decideRound({
  state = null,
  headSha,
  now,
  threads = [],
  botActivity = false,
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

  if (!state) {
    return botActivity
      ? { action: "open", reason: "first-bot-activity", state: openRound({ state, headSha, now, threads }) }
      : wait(null, "awaiting-first-bot-activity");
  }

  if (state.status === "closed") {
    if (botActivity && state.dispatchIssuedAt) {
      return { action: "open", reason: "next-bot-activity", state: openRound({ state, headSha, now, threads }) };
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

  const next = noteHead(state, headSha, now);
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

export function parseRoundLedger(body) {
  if (typeof body !== "string") return null;
  const match = body.match(ledgerPattern());
  if (!match) return null;
  try {
    const state = JSON.parse(match[1]);
    if (state?.version !== 1 || !Array.isArray(state.threadIds)) return null;
    return state;
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

function isCurrentActivity(activity, headSha, headCommittedAt) {
  if (activity?.commit_id && headSha) return activity.commit_id === headSha;
  if (activity?.original_commit_id && headSha) return activity.original_commit_id === headSha;
  const activityTime = parseTime(activity?.submitted_at ?? activity?.created_at ?? activity?.updated_at);
  const headTime = parseTime(headCommittedAt);
  return activityTime > 0 && (headTime === 0 || activityTime >= headTime);
}

/** Detect any current-head activity from an alias in the configured bot groups. */
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
  const activities = [...reviews, ...issueComments, ...reviewComments];
  if (activities.some((activity) => {
    const login = normalizeLogin(activity?.user?.login ?? activity?.author?.login);
    return configured.has(login) && isCurrentActivity(activity, headSha, headCommittedAt);
  })) return true;

  return checkRuns.some((checkRun) => {
    const checkHead = checkRun?.head_sha ?? checkRun?.headSha;
    const current = checkHead ? checkHead === headSha : isCurrentActivity(checkRun, headSha, headCommittedAt);
    const checkAliases = [checkRun?.app?.slug, checkRun?.app?.name].map(normalizeLogin);
    return current && checkAliases.some((alias) => configured.has(alias));
  });
}
