const BAD_CHECK_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "timed_out",
]);

function normalizeLogin(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function bodyHasPositiveVerdict(body) {
  if (typeof body !== "string") return false;
  return /\b(PASS|APPROVED|LGTM)\b/i.test(body);
}

function isCurrentActivity(activity, headSha, headCommittedAt) {
  const shortSha = headSha?.slice(0, 7);
  const body = typeof activity.body === "string" ? activity.body : "";
  if (headSha && (body.includes(headSha) || (shortSha && body.includes(shortSha)))) {
    return true;
  }
  if (activity.commit_id && headSha) {
    return activity.commit_id === headSha;
  }
  if (activity.original_commit_id && headSha) {
    return activity.original_commit_id === headSha;
  }
  const activityTime = Date.parse(
    activity.submitted_at ?? activity.updated_at ?? activity.created_at ?? "",
  );
  const headTime = Date.parse(headCommittedAt ?? "");
  return Number.isFinite(activityTime) &&
    Number.isFinite(headTime) &&
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
  const blockers = [];
  const configuredAliases = new Set(groups.flat());

  for (const review of reviews) {
    const login = normalizeLogin(review.user?.login);
    if (!login || review.state !== "APPROVED") continue;
    if (!isCurrentActivity(review, headSha, headCommittedAt)) continue;
    positiveByAlias.set(login, { alias: login, kind: "review", state: review.state });
  }

  for (const comment of [...issueComments, ...reviewComments]) {
    const login = normalizeLogin(comment.user?.login);
    if (!login || !bodyHasPositiveVerdict(comment.body)) continue;
    if (!isCurrentActivity(comment, headSha, headCommittedAt)) continue;
    positiveByAlias.set(login, { alias: login, kind: "comment", state: "POSITIVE_COMMENT" });
  }

  for (const checkRun of checkRuns) {
    if (!isCurrentCheckRun(checkRun, headSha, headCommittedAt)) continue;
    const conclusion = normalizeLogin(checkRun.conclusion);
    const aliases = [checkRun.app?.slug, checkRun.app?.name]
      .map(normalizeLogin)
      .filter((alias) => alias && configuredAliases.has(alias));
    for (const alias of aliases) {
      if (BAD_CHECK_CONCLUSIONS.has(conclusion)) {
        blockers.push({ alias, kind: "check_run", state: conclusion || "unknown" });
      } else if (conclusion === "success") {
        positiveByAlias.set(alias, { alias, kind: "check_run", state: "success" });
      }
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

  if (blockers.length > 0) {
    return {
      ok: false,
      reason: `AI reviewer check run failed or was not positive: ${blockers.map((b) => `${b.alias}(${b.state})`).join(", ")}`,
      present,
      missing,
      blockers,
    };
  }

  if (missing.length > 0) {
    return {
      ok: false,
      reason: `Missing required positive AI review groups: ${missing.map((group) => group.join(" OR ")).join("; ")}`,
      present,
      missing,
      blockers,
    };
  }

  return {
    ok: true,
    reason: "AI review gate satisfied.",
    present,
    missing,
    blockers,
  };
}
