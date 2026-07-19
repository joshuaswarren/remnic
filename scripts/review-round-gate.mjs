/**
 * Transactional review-round gate driver (issue #1992, umbrella #1988 decision E).
 *
 * Turns the pure round state machine in review-rounds.mjs into a PR-scoped
 * ledger + dispatch decision. The gate:
 *
 *   1. Recovers prior round state from an owned PR comment (the ledger).
 *   2. Detects current-head bot activity and folds pushes/threads into the
 *      SAME round (commits stay incremental — see umbrella non-goal), so a
 *      push during an open round updates the head but does NOT re-dispatch
 *      reviewers.
 *   3. Dispatches the next bot round only when every round thread is addressed
 *      and the head has been stable for the debounce window, when a maintainer
 *      applies the force-dispatch label, or when the round exceeds its max age.
 *   4. Tracks micro-push telemetry ("pushes this round: N", warning at N>3).
 *
 * v1 is visibility-first (umbrella decision C): the ledger comment is always
 * written, but reviewer dispatch is a no-op unless REVIEW_ROUND_ENFORCE is
 * explicitly enabled. The enforcement flip and the review-thread-guard
 * pending-state change are deferred to PR3 (shadow data must land first,
 * decision D), so this driver never blocks a merge and never hides an
 * unresolved thread — it surfaces the open thread set in its summary.
 *
 * The decision core (computeRoundGateDecision) is pure so fixture replay can
 * validate it without GitHub. runRoundGate is the thin actions/github-script
 * wrapper; the workflow imports this module directly (no inline mirror).
 */

import {
  DEFAULT_ROUND_DEBOUNCE_MS,
  DEFAULT_ROUND_MAX_AGE_MS,
  ROUND_COMMENT_MARKER,
  decideRound,
  getGuardUnresolvedThreads,
  hasCurrentBotActivity,
  parseRoundLedger,
  renderRoundLedger,
} from "./review-rounds.mjs";

export const FORCE_DISPATCH_LABEL = "review-round:force-dispatch";
export const AUTO_CLOSED_LABEL = "review-round:auto-closed";
/** Micro-push telemetry warns once the round crosses this many pushes (issue #1992 §4). */
export const PUSH_WARN_THRESHOLD = 3;
export const DEFAULT_REQUIRED_AI_REVIEWER_GROUPS =
  "cursor-bugbot[bot]|cursor[bot]|cursor-bugbot|cursor|" +
  "coderabbitai[bot]|coderabbitai|chatgpt-codex-connector[bot]|chatgpt-codex-connector";

function parseReviewerAliases(raw) {
  return [
    ...new Set(
      String(raw ?? "")
        .split(",")
        .flatMap((group) => group.split("|"))
        .map((alias) => alias.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

function threadLabel(thread) {
  const comment = thread?.comments?.nodes?.[0] ?? thread?.comments?.[0];
  const author = comment?.author?.login ?? comment?.user?.login ?? "unknown";
  const path = comment?.path ?? "unknown-file";
  return `${author} on ${path}`;
}

/**
 * Pure round-gate decision from an activity snapshot. Returns the next state,
 * the fully-rendered ledger comment body, telemetry, and a human summary.
 */
export function computeRoundGateDecision({
  ledgerBody = "",
  headSha,
  headCommittedAt = null,
  reviews = [],
  issueComments = [],
  reviewComments = [],
  checkRuns = [],
  threads = [],
  botAliases = [],
  forceDispatch = false,
  enforce = false,
  now,
  debounceMs = DEFAULT_ROUND_DEBOUNCE_MS,
  maxAgeMs = DEFAULT_ROUND_MAX_AGE_MS,
} = {}) {
  const priorState = parseRoundLedger(ledgerBody);
  const botActivity = hasCurrentBotActivity({
    aliases: botAliases,
    headSha,
    headCommittedAt,
    reviews,
    issueComments,
    reviewComments,
    checkRuns,
  });

  const decision = decideRound({
    state: priorState,
    headSha,
    now,
    threads,
    botActivity,
    botAliases,
    forceDispatch,
    debounceMs,
    maxAgeMs,
  });

  const state = decision.state;
  const unresolved = state
    ? getGuardUnresolvedThreads(state, threads, botAliases)
    : [];

  const pushes = state?.pushes ?? 0;
  const telemetry = {
    round: state?.round ?? 0,
    status: state?.status ?? "none",
    action: decision.action,
    reason: decision.reason,
    pushes,
    batchWarning: pushes > PUSH_WARN_THRESHOLD,
    threadCount: state?.threadIds?.length ?? 0,
    unresolvedCount: unresolved.length,
    dispatch: decision.action === "dispatch",
    autoClosed: state?.autoClosed === true,
    enforce,
    dryRun: !enforce,
  };

  return {
    priorState,
    botActivity,
    decision,
    state,
    unresolved,
    telemetry,
    summary: renderRoundSummary({ telemetry, unresolved }),
    commentBody: renderRoundComment({ state, telemetry, unresolved }),
  };
}

function renderRoundSummary({ telemetry, unresolved }) {
  const lines = [];
  lines.push("### Transactional review round");
  lines.push("");
  lines.push(`- Round: **${telemetry.round}** (${telemetry.status})`);
  lines.push(`- Round thread set: ${telemetry.threadCount}`);
  lines.push(`- Unresolved in round: **${telemetry.unresolvedCount}**`);
  lines.push(`- Pushes this round: **${telemetry.pushes}**`);
  if (telemetry.batchWarning) {
    lines.push(
      `- ⚠️ ${telemetry.pushes} pushes this round exceeds the batch rule ` +
        "(batch review fixes by subsystem, push once per round). " +
        "Telemetry only in v1 — no failure (issue #1992 §4).",
    );
  }
  const verb = telemetry.dispatch ? "DISPATCH" : "WAIT";
  const mode = telemetry.dryRun ? " (shadow — reviewers NOT dispatched in v1)" : "";
  lines.push(`- Decision: **${verb}** — ${telemetry.reason}${mode}`);
  if (telemetry.autoClosed) {
    lines.push("- Round auto-closed at max age; dispatch unblocked (auditable).");
  }
  if (unresolved.length > 0) {
    lines.push("");
    lines.push("Unresolved round threads (not hidden — still gate via review-thread-guard):");
    for (const thread of unresolved.slice(0, 10)) {
      lines.push(`- ${threadLabel(thread)}`);
    }
    if (unresolved.length > 10) {
      lines.push(`- …and ${unresolved.length - 10} more.`);
    }
  }
  return lines.join("\n");
}

function renderRoundComment({ state, telemetry, unresolved }) {
  const summary = renderRoundSummary({ telemetry, unresolved });
  const ledger = state ? renderRoundLedger(state) : `<!-- ${ROUND_COMMENT_MARKER}\n{}\n-->`;
  return `${summary}\n\n${ledger}\n`;
}

// Trust only the workflow bot's own ledger comment: another commenter pasting
// the marker must never become the authoritative round state (issue #1992).
const LEDGER_COMMENT_AUTHORS = new Set(["github-actions[bot]", "github-actions"]);

function isWorkflowLedgerComment(comment) {
  if (!(comment?.body ?? "").includes(ROUND_COMMENT_MARKER)) return false;
  const login = (comment?.user?.login ?? "").toLowerCase();
  return LEDGER_COMMENT_AUTHORS.has(login);
}

async function findOwnedLedgerComment(github, owner, repo, prNumber) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });
  return comments.find(isWorkflowLedgerComment) ?? null;
}

async function fetchReviewThreads(github, owner, repo, prNumber) {
  const query = `
    query($owner: String!, $repo: String!, $pr: Int!, $after: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pr) {
          reviewThreads(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              isResolved
              isOutdated
              comments(first: 100) {
                nodes { path author { login } }
              }
            }
          }
        }
      }
    }
  `;
  const threads = [];
  let after = null;
  // Paginate to completion: the worst observed PR had 59 threads (issue #1992).
  for (;;) {
    const result = await github.graphql(query, { owner, repo, pr: prNumber, after });
    const conn = result.repository.pullRequest.reviewThreads;
    threads.push(...(conn.nodes ?? []));
    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return threads;
}

function resolvePullNumber(context) {
  // check_run.completed carries the PR under check_run.pull_requests[]; the
  // PR/review/comment events carry pull_request or issue.
  const candidate =
    context.payload?.pull_request?.number ??
    context.payload?.issue?.number ??
    context.payload?.check_run?.pull_requests?.[0]?.number ??
    null;
  const pr = Number(candidate);
  return Number.isInteger(pr) && pr > 0 ? pr : null;
}

/**
 * actions/github-script entrypoint. The workflow imports this module directly
 * so the tested decision core is the only copy of the logic.
 */
export async function runRoundGate({ github, context, core, env = {} } = {}) {
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const prNumber = resolvePullNumber(context);
  if (!prNumber) {
    core.notice("review-round gate: no pull request in payload; nothing to do.");
    return null;
  }

  const enforce = String(env.REVIEW_ROUND_ENFORCE ?? "").toLowerCase() === "true";
  const botAliases = parseReviewerAliases(
    env.REQUIRED_AI_REVIEWER_GROUPS || DEFAULT_REQUIRED_AI_REVIEWER_GROUPS,
  );

  // The read path must never fail the (non-blocking) gate: any GitHub API error
  // degrades to a warning + no-op rather than an uncaught exception that would
  // fail the github-script step (issue #1992 — the gate never fails a check).
  let pull;
  let reviews;
  let issueComments;
  let reviewComments;
  let threads;
  let headSha;
  let headCommittedAt;
  let checkRuns;
  let existing;
  try {
    pull = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
    if (pull.data.draft === true) {
      core.notice(`review-round gate: PR #${prNumber} is a draft; skipping.`);
      return null;
    }
    [reviews, issueComments, reviewComments, threads] = await Promise.all([
      github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: prNumber, per_page: 100 }),
      github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: prNumber, per_page: 100 }),
      github.paginate(github.rest.pulls.listReviewComments, { owner, repo, pull_number: prNumber, per_page: 100 }),
      fetchReviewThreads(github, owner, repo, prNumber),
    ]);
    headSha = pull.data.head?.sha;
    const headCommit = headSha
      ? await github.rest.repos.getCommit({ owner, repo, ref: headSha })
      : null;
    headCommittedAt =
      headCommit?.data?.commit?.committer?.date ??
      headCommit?.data?.commit?.author?.date ??
      null;
    checkRuns = headSha
      ? await github.paginate(github.rest.checks.listForRef, { owner, repo, ref: headSha, per_page: 100 })
      : [];
    existing = await findOwnedLedgerComment(github, owner, repo, prNumber);
  } catch (error) {
    core.warning(
      `review-round gate PR #${prNumber}: read path failed (${error?.message ?? error}); ` +
        "skipping (non-blocking).",
    );
    return null;
  }

  const labels = (pull.data.labels ?? []).map((label) =>
    (typeof label === "string" ? label : label?.name ?? "").toLowerCase(),
  );
  const forceDispatch = labels.includes(FORCE_DISPATCH_LABEL);

  const result = computeRoundGateDecision({
    ledgerBody: existing?.body ?? "",
    headSha,
    headCommittedAt,
    reviews,
    issueComments,
    reviewComments,
    checkRuns,
    threads,
    botAliases,
    forceDispatch,
    enforce,
    now: new Date().toISOString(),
  });

  // Decide dispatch and label side effects BEFORE persisting the ledger. Under
  // enforcement the bot round must be requested before the round is recorded as
  // dispatched: if the trigger fails we leave the round OPEN (skip the ledger
  // write) so the next run retries, instead of waiting for a review that was
  // never requested and silently dropping the round (codex).
  let persist = true;
  let dispatchedThisRun = false;
  const forceConsumed =
    result.telemetry.dispatch && forceDispatch && result.telemetry.reason === "force-label";
  if (result.telemetry.dispatch && enforce) {
    const dispatched = await dispatchReviewers({ github, owner, repo, prNumber, core });
    if (dispatched) {
      dispatchedThisRun = true;
      if (result.telemetry.autoClosed) {
        await addLabelSafely(github, owner, repo, prNumber, AUTO_CLOSED_LABEL, core);
      }
      if (forceConsumed) {
        await removeLabelSafely(github, owner, repo, prNumber, FORCE_DISPATCH_LABEL, core);
      }
    } else {
      persist = false;
      core.warning(
        `review-round gate PR #${prNumber}: reviewer dispatch failed; leaving the round ` +
          "open to retry (ledger not advanced).",
      );
    }
  } else if (result.telemetry.dispatch) {
    // Shadow mode: never trigger reviewers or mutate the auto-closed label, but
    // DO consume the one-shot force-dispatch label so it cannot re-fire on every
    // later round and corrupt telemetry / defeat batching (cursor).
    if (forceConsumed) {
      await removeLabelSafely(github, owner, repo, prNumber, FORCE_DISPATCH_LABEL, core);
    }
    core.info(
      `review-round gate PR #${prNumber}: shadow mode — would dispatch reviewers ` +
        `(${result.telemetry.reason}); no action taken.`,
    );
  }

  // The ledger comment is the visibility mechanism in v1: upsert it (even in
  // shadow mode) unless an enforced dispatch failed above. Writes can fail on
  // fork PRs (read-only token) — that degrades to a log line, never a failed
  // (non-blocking) gate.
  if (persist) {
    try {
      if (existing) {
        await github.rest.issues.updateComment({
          owner,
          repo,
          comment_id: existing.id,
          body: result.commentBody,
        });
      } else {
        await github.rest.issues.createComment({
          owner,
          repo,
          issue_number: prNumber,
          body: result.commentBody,
        });
      }
    } catch (error) {
      // A ledger write that fails AFTER reviewers were already pinged means the
      // next run may re-dispatch (non-atomic two-write; reviewer bots coalesce
      // duplicate requests). Surface it loudly for the PR3 enforcement rollout;
      // in shadow mode it is a benign visibility miss (cursor).
      const note = `review-round gate: could not write ledger comment (${error?.message ?? error}).`;
      if (dispatchedThisRun) core.warning(`${note} Reviewers were already dispatched; a retry may re-dispatch.`);
      else core.info(note);
    }
  }

  core.notice(
    `review-round gate PR #${prNumber}: round ${result.telemetry.round} ` +
      `${result.telemetry.action}/${result.telemetry.reason} — ` +
      `pushes ${result.telemetry.pushes}, unresolved ${result.telemetry.unresolvedCount}` +
      `${result.telemetry.dryRun ? " (shadow)" : ""}`,
  );

  return result;
}

async function dispatchReviewers({ github, owner, repo, prNumber, core }) {
  // Request a fresh bot round against the settled head. Returns true only when
  // the trigger comment is posted, so the caller can withhold the dispatched
  // ledger state on failure and retry (issue #1992).
  try {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: "@coderabbitai review\n@codex review",
    });
    core.notice(`review-round gate PR #${prNumber}: dispatched next bot review round.`);
    return true;
  } catch (error) {
    core.info(`review-round gate PR #${prNumber}: dispatch comment failed (${error?.message ?? error}).`);
    return false;
  }
}

async function addLabelSafely(github, owner, repo, prNumber, label, core) {
  try {
    await github.rest.issues.addLabels({ owner, repo, issue_number: prNumber, labels: [label] });
  } catch (error) {
    core.info(`review-round gate PR #${prNumber}: could not add label ${label} (${error?.message ?? error}).`);
  }
}

async function removeLabelSafely(github, owner, repo, prNumber, label, core) {
  try {
    await github.rest.issues.removeLabel({ owner, repo, issue_number: prNumber, name: label });
  } catch (error) {
    core.info(`review-round gate PR #${prNumber}: could not remove label ${label} (${error?.message ?? error}).`);
  }
}
