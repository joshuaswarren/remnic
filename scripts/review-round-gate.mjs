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
 * The ledger comment is always written. Reviewer dispatch fires only when
 * REVIEW_ROUND_ENFORCE is enabled (the shipped default, umbrella decision D);
 * with it off the driver degrades to ledger-only shadow mode. Either way it
 * never blocks a merge and never hides an unresolved thread — the
 * review-thread-guard owns that gate, and this driver surfaces the open thread
 * set in its summary.
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

// Shadow mode "changes nothing" (issue #1992 decision C): reopen the round the
// reducer closed for a would-be dispatch, so the persisted ledger never records
// a real dispatch that did not happen.
function reopenRoundForShadow(state) {
  const reopened = { ...state, status: "open", dispatchIssuedAt: null, closeReason: null, autoClosed: false };
  delete reopened.closedAt;
  return reopened;
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

  // In shadow (dry-run) mode a would-be dispatch is LOGGED via telemetry + the
  // summary, but the persisted ledger stays OPEN: recording a closed/dispatched
  // round would claim a dispatch that never happened and, once enforcement flips
  // on, make the gate wait for bot activity that was never requested (codex).
  const decisionState = decision.state;
  const dryRunDispatch =
    !enforce && decision.action === "dispatch" && decisionState?.status === "closed";
  const state = dryRunDispatch ? reopenRoundForShadow(decisionState) : decisionState;
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
  // Resolve the SINGLE PR this run is serialized for. The order matches the
  // workflow concurrency-group key exactly (pull_request.number →
  // check_run.pull_requests[0].number → issue.number), so the PR we process is
  // always the one the group serializes.
  const candidate =
    context.payload?.pull_request?.number ??
    context.payload?.check_run?.pull_requests?.[0]?.number ??
    context.payload?.issue?.number ??
    null;
  const pr = Number(candidate);
  return Number.isInteger(pr) && pr > 0 ? pr : null;
}

/**
 * actions/github-script entrypoint. Processes ONLY the PR the run's concurrency
 * group serializes. A GitHub Actions run belongs to exactly one concurrency
 * group, so a check_run attached to several PRs sharing a head SHA must NOT
 * fan out and write secondary PRs' ledgers outside their own serialized group
 * (codex) — those PRs advance through their own (separately serialized) events.
 */
export async function runRoundGate({ github, context, core, env = {} } = {}) {
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const prNumber = resolvePullNumber(context);
  if (!prNumber) {
    core.notice("review-round gate: no pull request in payload; nothing to do.");
    return null;
  }
  return runRoundGateForPr({ github, core, env, owner, repo, prNumber });
}

/** Run the round gate for a single resolved pull request. */
async function runRoundGateForPr({ github, core, env, owner, repo, prNumber }) {
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

  // decideRound throws on an empty headSha; guard here so a PR with no
  // resolvable head degrades to a no-op instead of failing the non-blocking
  // gate (cursor).
  if (typeof headSha !== "string" || headSha.length === 0) {
    core.notice(`review-round gate: PR #${prNumber} has no resolvable head SHA; skipping.`);
    return null;
  }

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

  // Order matters for the non-atomic multi-write (issue #1992):
  //  1) under enforcement, REQUEST the bot round before recording the round as
  //     dispatched, so a trigger failure leaves the round open to retry (codex);
  //  2) PERSIST the ledger;
  //  3) only AFTER a durable persist, consume the one-shot force-dispatch label
  //     and stamp the auto-closed label. Consuming the label before the write
  //     would drop the maintainer's force intent (and its manual retry) if the
  //     write then failed transiently (Main).
  let persist = true;
  let dispatchedThisRun = false;
  const forceConsumed =
    result.telemetry.dispatch && forceDispatch && result.telemetry.reason === "force-label";
  if (result.telemetry.dispatch && enforce) {
    dispatchedThisRun = await dispatchReviewers({ github, owner, repo, prNumber, core });
    if (!dispatchedThisRun) {
      persist = false;
      core.warning(
        `review-round gate PR #${prNumber}: reviewer dispatch failed; leaving the round ` +
          "open to retry (ledger not advanced).",
      );
    }
  } else if (result.telemetry.dispatch) {
    core.info(
      `review-round gate PR #${prNumber}: shadow mode — would dispatch reviewers ` +
        `(${result.telemetry.reason}); no action taken.`,
    );
  }

  // The ledger comment is the visibility mechanism in v1: upsert it (even in
  // shadow mode) unless an enforced dispatch failed above. Writes can fail on
  // fork PRs (read-only token) — that degrades to a log line, never a failed
  // (non-blocking) gate.
  let persisted = false;
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
      persisted = true;
    } catch (error) {
      const note = `review-round gate: could not write ledger comment (${error?.message ?? error}).`;
      if (dispatchedThisRun) core.warning(`${note} Reviewers were already dispatched; a retry may re-dispatch.`);
      else core.info(note);
    }
  }

  // Consume/stamp labels ONLY after the dispatched state is durably recorded, so
  // a transient ledger-write failure never removes the force-dispatch label
  // (and its manual retry) without recording the dispatch, and never leaves an
  // auto-closed label on a round whose closure was not persisted (Main).
  if (persisted && result.telemetry.dispatch) {
    if (enforce && result.telemetry.autoClosed) {
      await addLabelSafely(github, owner, repo, prNumber, AUTO_CLOSED_LABEL, core);
    }
    if (forceConsumed) {
      await removeLabelSafely(github, owner, repo, prNumber, FORCE_DISPATCH_LABEL, core);
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
