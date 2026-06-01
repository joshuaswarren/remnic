const BAD_CHECK_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "skipped",
  "stale",
  "startup_failure",
  "timed_out",
]);
const POSITIVE_CHECK_CONCLUSIONS = new Set(["success", "neutral"]);
const NEGATIVE_REVIEW_STATES = new Set(["CHANGES_REQUESTED"]);
const NEGATIVE_VERDICT_PATTERN =
  /\b(?:changes\s+requested|do\s+not\s+merge|(?:not|no|never|cannot|can['’]?t|isn['’]?t)\s+(?:a\s+)?(?:pass|approved|lgtm))\b/i;
const POSITIVE_VERDICT_PATTERN = /\b(?:PASS|APPROVED|LGTM)\b/i;
const SHA_REFERENCE_PATTERN =
  /\b(?:sha|commit|head|rev|revision)\s*[:#]?\s*([0-9a-f]{7,40})\b|\bfor\s+([0-9a-f]{7,40})\b/gi;

function normalizeLogin(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function bodyHasPositiveVerdict(body) {
  if (typeof body !== "string") return false;
  return !NEGATIVE_VERDICT_PATTERN.test(body) && POSITIVE_VERDICT_PATTERN.test(body);
}

function bodyShaReferences(body) {
  if (typeof body !== "string") return [];
  return [...body.matchAll(SHA_REFERENCE_PATTERN)]
    .map((match) => (match[1] ?? match[2] ?? "").toLowerCase())
    .filter(Boolean);
}

function bodyReferencesCurrentHead(body, headSha) {
  if (typeof body !== "string" || typeof headSha !== "string" || !headSha.trim()) {
    return true;
  }
  const normalizedHead = headSha.trim().toLowerCase();
  const references = bodyShaReferences(body);
  if (references.length === 0) return true;
  return references.some((reference) => normalizedHead.startsWith(reference));
}

function bodyExplicitlyReferencesCurrentHead(body, headSha) {
  if (typeof headSha !== "string" || !headSha.trim()) return false;
  const normalizedHead = headSha.trim().toLowerCase();
  return bodyShaReferences(body).some((reference) => normalizedHead.startsWith(reference));
}

function checkRunTime(checkRun) {
  const parsed = Date.parse(
    checkRun.completed_at ??
      checkRun.updated_at ??
      checkRun.started_at ??
      checkRun.created_at ??
      "",
  );
  return Number.isFinite(parsed) ? parsed : 0;
}

function activityTime(activity) {
  const parsed = Date.parse(
    activity.submitted_at ??
      activity.created_at ??
      activity.updated_at ??
      "",
  );
  return Number.isFinite(parsed) ? parsed : 0;
}

function isCurrentActivity(activity, headSha, headCommittedAt) {
  if (activity.commit_id && headSha) {
    return activity.commit_id === headSha;
  }
  if (activity.original_commit_id && headSha) {
    return activity.original_commit_id === headSha;
  }
  if (!bodyReferencesCurrentHead(activity.body, headSha)) {
    return false;
  }
  const activityTime = Date.parse(activity.submitted_at ?? activity.created_at ?? "");
  const headTime = Date.parse(headCommittedAt ?? "");
  if (!Number.isFinite(headTime)) {
    return Number.isFinite(activityTime) && bodyExplicitlyReferencesCurrentHead(activity.body, headSha);
  }
  return Number.isFinite(activityTime) &&
    activityTime >= headTime;
}

function isCurrentCheckRun(checkRun, headSha, headCommittedAt) {
  const checkHeadSha = checkRun.head_sha ?? checkRun.headSha;
  if (headSha && typeof checkHeadSha === "string" && checkHeadSha.trim()) {
    return checkHeadSha === headSha;
  }
  const checkTime = Date.parse(
    checkRun.completed_at ??
      checkRun.updated_at ??
      checkRun.started_at ??
      checkRun.created_at ??
      "",
  );
  const headTime = Date.parse(headCommittedAt ?? "");
  return Number.isFinite(checkTime) &&
    Number.isFinite(headTime) &&
    checkTime >= headTime;
}

export function parseReviewerGroups(raw) {
  return String(raw ?? "")
    .split(",")
    .map((group) =>
      group
        .split("|")
        .map(normalizeLogin)
        .filter(Boolean),
    )
    .filter((group) => group.length > 0);
}

export function associatedPullRequestNumbers(payload = {}) {
  const directPr = Number(payload.pull_request?.number);
  if (Number.isInteger(directPr) && directPr > 0) {
    return [directPr];
  }

  return [
    ...new Set(
      (Array.isArray(payload.check_run?.pull_requests)
        ? payload.check_run.pull_requests
        : [])
        .map((pullRequest) => Number(pullRequest?.number))
        .filter((number) => Number.isInteger(number) && number > 0),
    ),
  ];
}

export function evaluateAiReviewGate({
  groups,
  headSha,
  headCommittedAt,
  reviews = [],
  issueComments = [],
  reviewComments = [],
  checkRuns = [],
}) {
  if (!Array.isArray(groups) || groups.length === 0) {
    return {
      ok: false,
      reason: "No required AI reviewer groups configured.",
      present: [],
      missing: [],
      blockers: [],
    };
  }

  const positiveByAlias = new Map();
  const positiveCheckRunAliases = new Set();
  const blockers = [];
  const configuredAliases = new Set(groups.flat());

  const latestReviews = new Map();
  for (const review of reviews) {
    const login = normalizeLogin(review.user?.login);
    if (!login || !configuredAliases.has(login)) continue;
    if (!isCurrentActivity(review, headSha, headCommittedAt)) continue;
    const previous = latestReviews.get(login);
    if (!previous || activityTime(review) >= activityTime(previous)) {
      latestReviews.set(login, review);
    }
  }

  for (const [login, review] of latestReviews) {
    if (review.state === "APPROVED") {
      positiveByAlias.set(login, { alias: login, kind: "review", state: review.state });
      continue;
    }
    if (NEGATIVE_REVIEW_STATES.has(review.state)) {
      blockers.push({ alias: login, kind: "review", state: review.state });
    }
  }

  for (const comment of [...issueComments, ...reviewComments]) {
    const login = normalizeLogin(comment.user?.login);
    if (!login || !configuredAliases.has(login) || !bodyHasPositiveVerdict(comment.body)) continue;
    if (!isCurrentActivity(comment, headSha, headCommittedAt)) continue;
    positiveByAlias.set(login, { alias: login, kind: "comment", state: "POSITIVE_COMMENT" });
  }

  const latestCheckRuns = new Map();
  for (const checkRun of checkRuns) {
    if (!isCurrentCheckRun(checkRun, headSha, headCommittedAt)) continue;
    const checkName = normalizeLogin(checkRun.name) || "unnamed-check";
    const aliases = [checkRun.app?.slug, checkRun.app?.name]
      .map(normalizeLogin)
      .filter((alias) => alias && configuredAliases.has(alias));
    for (const alias of aliases) {
      const key = `${alias}\0${checkName}`;
      const previous = latestCheckRuns.get(key);
      if (!previous || checkRunTime(checkRun) >= checkRunTime(previous)) {
        latestCheckRuns.set(key, { ...checkRun, alias });
      }
    }
  }

  for (const checkRun of latestCheckRuns.values()) {
    const conclusion = normalizeLogin(checkRun.conclusion);
    const alias = checkRun.alias;
    if (BAD_CHECK_CONCLUSIONS.has(conclusion)) {
      blockers.push({ alias, kind: "check_run", state: conclusion || "unknown" });
    } else if (POSITIVE_CHECK_CONCLUSIONS.has(conclusion)) {
      positiveCheckRunAliases.add(alias);
      positiveByAlias.set(alias, { alias, kind: "check_run", state: conclusion });
    }
  }

  const present = [];
  const missing = [];
  for (const group of groups) {
    const matchedAlias = group.find((alias) => positiveByAlias.has(alias));
    if (matchedAlias) {
      present.push({ group, ...positiveByAlias.get(matchedAlias) });
    } else {
      missing.push(group);
    }
  }

  const effectiveBlockers = blockers.filter(
    (blocker) => blocker.kind !== "review" || !positiveCheckRunAliases.has(blocker.alias),
  );

  if (effectiveBlockers.length > 0) {
    return {
      ok: false,
      reason: `AI reviewer check run failed or was not positive: ${effectiveBlockers.map((b) => `${b.alias}(${b.state})`).join(", ")}`,
      present,
      missing,
      blockers: effectiveBlockers,
    };
  }

  if (missing.length > 0) {
    return {
      ok: false,
      reason: `Missing required positive AI review groups: ${missing.map((group) => group.join(" OR ")).join("; ")}`,
      present,
      missing,
      blockers: effectiveBlockers,
    };
  }

  return {
    ok: true,
    reason: "AI review gate satisfied.",
    present,
    missing,
    blockers: effectiveBlockers,
  };
}
