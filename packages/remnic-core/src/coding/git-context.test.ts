/**
 * Tests for `resolveGitContext` (issue #569 PR 1).
 *
 * All fixtures synthetic — no real repositories, no real user data. The git
 * invocation layer is mocked via the `GitInvoker` seam so the tests never
 * spawn a real `git` process.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  expandTildePath,
  normalizeOriginUrl,
  resolveGitContext,
  stableHash,
  type GitInvoker,
} from "./git-context.js";

// ──────────────────────────────────────────────────────────────────────────
// Mock invoker helpers
// ──────────────────────────────────────────────────────────────────────────

type InvokeKey = string;

function keyFor(cwd: string, args: string[]): InvokeKey {
  return `${cwd}::${args.join(" ")}`;
}

/**
 * Build a deterministic mock invoker keyed on `${cwd}::${args.join(' ')}`.
 * Any unregistered call returns exitCode 1 with empty stdout so tests fail
 * loudly when they exercise an unexpected code path.
 */
function mockInvoker(responses: Record<InvokeKey, { stdout: string; exitCode: number }>): GitInvoker {
  return (cwd, args) => {
    const key = keyFor(cwd, args);
    if (key in responses) {
      const resp = responses[key];
      if (resp) return resp;
    }
    return { stdout: "", exitCode: 1 };
  };
}

// ──────────────────────────────────────────────────────────────────────────
// expandTildePath
// ──────────────────────────────────────────────────────────────────────────

test("expandTildePath: returns input unchanged when no leading `~`", () => {
  assert.equal(expandTildePath("/abs/path"), "/abs/path");
  assert.equal(expandTildePath("relative/path"), "relative/path");
});

test("expandTildePath: expands bare `~` to home dir", () => {
  const out = expandTildePath("~");
  assert.notEqual(out, "~");
  assert.ok(out.length > 1, "home dir should be non-empty");
});

test("expandTildePath: expands `~/sub` to <home>/sub", () => {
  const out = expandTildePath("~/projects/remnic");
  assert.ok(out.endsWith("/projects/remnic"), `expected suffix /projects/remnic, got: ${out}`);
  assert.ok(!out.startsWith("~"), "tilde must be expanded");
});

// ──────────────────────────────────────────────────────────────────────────
// normalizeOriginUrl
// ──────────────────────────────────────────────────────────────────────────

test("normalizeOriginUrl: scp-style ssh and https form of same repo normalize equally", () => {
  const scp = normalizeOriginUrl("git@github.com:foo/bar.git");
  const https = normalizeOriginUrl("https://github.com/foo/bar.git");
  const httpsNoDotGit = normalizeOriginUrl("https://github.com/foo/bar");
  assert.equal(scp, "github.com/foo/bar");
  assert.equal(https, "github.com/foo/bar");
  assert.equal(httpsNoDotGit, "github.com/foo/bar");
});

test("normalizeOriginUrl: ssh:// protocol form normalizes", () => {
  const sshProto = normalizeOriginUrl("ssh://git@github.com/foo/bar.git");
  assert.equal(sshProto, "github.com/foo/bar");
});

test("normalizeOriginUrl: ssh:// with non-standard port — port preserved on host", () => {
  // Port is preserved so `host:2222/foo/bar` and `host/foo/bar` route to
  // different project namespaces. Losing the port would false-coalesce
  // separate repos on custom SSH mesh setups.
  assert.equal(
    normalizeOriginUrl("ssh://git@github.com:2222/foo/bar.git"),
    "github.com:2222/foo/bar",
  );
});

test("normalizeOriginUrl: ssh://host:port and ssh://host normalize to distinct strings", () => {
  assert.notEqual(
    normalizeOriginUrl("ssh://git@github.com/foo/bar.git"),
    normalizeOriginUrl("ssh://git@github.com:2222/foo/bar.git"),
  );
});

test("normalizeOriginUrl: userless scp form (`host:path`) normalizes identically to user@ form", () => {
  assert.equal(
    normalizeOriginUrl("github.com:foo/bar.git"),
    normalizeOriginUrl("git@github.com:foo/bar.git"),
  );
  assert.equal(normalizeOriginUrl("github.com:foo/bar.git"), "github.com/foo/bar");
});

test("normalizeOriginUrl: scp paths may start with digits", () => {
  // Valid scp remote where the first path segment is purely numeric.
  assert.equal(
    normalizeOriginUrl("git@host:123/repo.git"),
    "host/123/repo",
  );
});

test("normalizeOriginUrl: Windows drive-letter path is not parsed as scp", () => {
  // `git remote get-url origin` can return `C:/repos/app.git` for local
  // Windows paths. The drive-letter branch short-circuits scp parsing.
  assert.equal(
    normalizeOriginUrl("C:/repos/app.git"),
    "c:/repos/app",
  );
});

test("normalizeOriginUrl: IPv6 host in protocol URL", () => {
  // Valid git remotes may use bracketed IPv6 addresses. The brackets are
  // stripped in the normalised form since they were only for
  // URL-level port disambiguation.
  assert.equal(
    normalizeOriginUrl("ssh://git@[2001:db8::1]/org/repo.git"),
    "2001:db8::1/org/repo",
  );
  assert.equal(
    normalizeOriginUrl("https://[2001:db8::1]/org/repo.git"),
    "2001:db8::1/org/repo",
  );
  // Port is preserved. IPv6 brackets stay when a port is attached so the
  // `host:port` boundary can't collide with a longer bare IPv6 literal.
  assert.equal(
    normalizeOriginUrl("ssh://[2001:db8::1]:2222/org/repo.git"),
    "[2001:db8::1]:2222/org/repo",
  );
  // Regression: `[2001:db8::1]:2222` (IPv6 + port) must not normalize
  // to the same string as the longer bare address `2001:db8::1:2222`.
  assert.notEqual(
    normalizeOriginUrl("ssh://[2001:db8::1]:2222/org/repo.git"),
    normalizeOriginUrl("ssh://[2001:db8::1:2222]/org/repo.git"),
  );
});

test("normalizeOriginUrl: single-character scp host alias is accepted", () => {
  // `.ssh/config` host aliases may be a single character (`h:foo/bar`),
  // and git treats those as scp remotes. The Windows drive-letter check
  // only matches `[A-Za-z]:[\\/]`, so a single-char alias followed by
  // `:<path>` (no slash immediately after the colon) still falls through
  // to scp.
  assert.equal(
    normalizeOriginUrl("h:foo/bar.git"),
    "h/foo/bar",
  );
});

test("normalizeOriginUrl: https:// with non-standard port — port preserved on host", () => {
  assert.equal(
    normalizeOriginUrl("https://github.com:8443/foo/bar.git"),
    "github.com:8443/foo/bar",
  );
});

test("normalizeOriginUrl: git:// protocol form", () => {
  assert.equal(
    normalizeOriginUrl("git://github.com/foo/bar.git"),
    "github.com/foo/bar",
  );
});

test("normalizeOriginUrl: uppercase .GIT suffix stripped (case-insensitive)", () => {
  // Regression: earlier `.endsWith('.git')` was case-sensitive, so `.GIT`
  // leaked through and appeared as `.git` in the lowercased output.
  assert.equal(
    normalizeOriginUrl("https://github.com/foo/bar.GIT"),
    "github.com/foo/bar",
  );
  assert.equal(
    normalizeOriginUrl("https://github.com/foo/bar.Git"),
    "github.com/foo/bar",
  );
  assert.equal(
    normalizeOriginUrl("https://github.com/foo/bar.git"),
    normalizeOriginUrl("https://github.com/foo/bar.GIT"),
    "case of .git suffix must not affect normalization",
  );
});

test("normalizeOriginUrl: case-insensitive", () => {
  assert.equal(
    normalizeOriginUrl("https://GitHub.com/Foo/Bar.git"),
    "github.com/foo/bar",
  );
});

test("normalizeOriginUrl: empty input yields empty string", () => {
  assert.equal(normalizeOriginUrl(""), "");
  assert.equal(normalizeOriginUrl("   "), "");
});

test("normalizeOriginUrl: scp-style IPv6 host matches ssh:// IPv6 host", () => {
  // Regression: git accepts `git@[2001:db8::1]:org/repo.git` as an scp
  // remote. Without bracket-aware parsing the regex split on the first
  // internal `:` of the IPv6 literal, producing a malformed host and a
  // different projectId from the equivalent ssh://[...]/ form.
  assert.equal(
    normalizeOriginUrl("git@[2001:db8::1]:org/repo.git"),
    "2001:db8::1/org/repo",
  );
  assert.equal(
    normalizeOriginUrl("git@[2001:db8::1]:org/repo.git"),
    normalizeOriginUrl("ssh://git@[2001:db8::1]/org/repo.git"),
    "scp and ssh:// IPv6 forms must normalize identically",
  );
});

test("normalizeOriginUrl: file:/// URLs do not fall through to scp parser", () => {
  // Regression: `file:///path/to/repo` has an empty host component. Before the
  // fix, the protocol regex required a non-empty host and so fell through to
  // the scp regex, which mis-parsed `file` as the host and `///path/to/repo`
  // as the path, producing `file/path/to/repo`. Now the protocol regex
  // accepts an empty host and `file://` URLs normalize under a stable
  // `localhost/<path>` prefix.
  assert.equal(
    normalizeOriginUrl("file:///path/to/repo"),
    "localhost/path/to/repo",
  );
  // Two distinct local file paths must NOT collapse to the same namespace.
  assert.notEqual(
    normalizeOriginUrl("file:///home/alice/repo"),
    normalizeOriginUrl("file:///home/bob/repo"),
  );
  // file:// with an explicit host still normalizes under that host.
  assert.equal(
    normalizeOriginUrl("file://host.example/path/to/repo"),
    "host.example/path/to/repo",
  );
});

// ──────────────────────────────────────────────────────────────────────────
// stableHash
// ──────────────────────────────────────────────────────────────────────────

test("stableHash: deterministic — same input always yields same output", () => {
  const a = stableHash("github.com/foo/bar");
  const b = stableHash("github.com/foo/bar");
  assert.equal(a, b);
});

test("stableHash: different inputs produce different outputs", () => {
  const a = stableHash("github.com/foo/bar");
  const b = stableHash("github.com/foo/baz");
  assert.notEqual(a, b);
});

test("stableHash: output is 8-char lowercase hex", () => {
  const out = stableHash("anything");
  assert.match(out, /^[0-9a-f]{8}$/);
});

// ──────────────────────────────────────────────────────────────────────────
// resolveGitContext — invalid inputs
// ──────────────────────────────────────────────────────────────────────────

test("resolveGitContext: empty cwd returns null", async () => {
  const ctx = await resolveGitContext("", { invoker: mockInvoker({}) });
  assert.equal(ctx, null);
});

test("resolveGitContext: non-absolute cwd returns null (CLAUDE.md #51)", async () => {
  const ctx = await resolveGitContext("relative/path", { invoker: mockInvoker({}) });
  assert.equal(ctx, null);
});

test("resolveGitContext: non-string cwd returns null", async () => {
  // @ts-expect-error — intentionally exercising defensive branch
  const ctx = await resolveGitContext(undefined, { invoker: mockInvoker({}) });
  assert.equal(ctx, null);
});

// ──────────────────────────────────────────────────────────────────────────
// resolveGitContext — outside a repo
// ──────────────────────────────────────────────────────────────────────────

test("resolveGitContext: outside a git repo returns null", async () => {
  // rev-parse --show-toplevel exits non-zero.
  const invoker = mockInvoker({
    [keyFor("/tmp/not-a-repo", ["rev-parse", "--show-toplevel"])]: {
      stdout: "",
      exitCode: 128,
    },
  });
  const ctx = await resolveGitContext("/tmp/not-a-repo", { invoker });
  assert.equal(ctx, null);
});

test("resolveGitContext: git not on PATH (exit 127) returns null", async () => {
  const invoker: GitInvoker = () => ({ stdout: "", exitCode: 127 });
  const ctx = await resolveGitContext("/tmp/anything", { invoker });
  assert.equal(ctx, null);
});

test("resolveGitContext: custom invoker throwing synchronously → returns null (never throws contract)", async () => {
  // Regression: the documented "Never throws" contract had no top-level
  // try/catch. A misbehaving custom invoker used to propagate its error.
  const invoker: GitInvoker = () => {
    throw new Error("synthetic invoker failure");
  };
  const ctx = await resolveGitContext("/tmp/anything", { invoker });
  assert.equal(ctx, null);
});

test("resolveGitContext: custom invoker throwing on a later call → returns null", async () => {
  // First call succeeds (pretend we're in a repo), subsequent call throws.
  // Must still resolve to null rather than leaking the error.
  let callCount = 0;
  const invoker: GitInvoker = (cwd) => {
    callCount += 1;
    if (callCount === 1) return { stdout: `${cwd}\n`, exitCode: 0 };
    throw new Error(`synthetic failure on call ${callCount}`);
  };
  const ctx = await resolveGitContext("/work/repo", { invoker });
  assert.equal(ctx, null);
});

test("#2206 resolveGitContext forwards caller cancellation to an active git probe", async () => {
  const abortController = new AbortController();
  let forwardedSignal: AbortSignal | undefined;
  const pendingProbe = Promise.withResolvers<{ stdout: string; exitCode: number }>();
  const invoker: GitInvoker = (_cwd, _args, options) => {
    forwardedSignal = options?.abortSignal;
    options?.abortSignal?.addEventListener(
      "abort",
      () => pendingProbe.reject(options.abortSignal?.reason),
      { once: true },
    );
    return pendingProbe.promise;
  };

  const resolving = resolveGitContext("/work/repo", {
    invoker,
    abortSignal: abortController.signal,
  });
  await Promise.resolve();
  abortController.abort(new Error("caller cancelled"));

  await assert.rejects(resolving, /caller cancelled/);
  assert.equal(forwardedSignal, abortController.signal);
});

test("#2206 resolveGitContext gives each probe only the remaining deadline budget", async () => {
  const timeouts: number[] = [];
  let now = 1_000;
  const invoker: GitInvoker = (cwd, args, options) => {
    timeouts.push(options?.timeoutMs ?? -1);
    now += 100;
    const command = args.join(" ");
    if (command === "rev-parse --show-toplevel") return { stdout: cwd, exitCode: 0 };
    if (command === "rev-parse --abbrev-ref HEAD") return { stdout: "main", exitCode: 0 };
    return { stdout: "", exitCode: 1 };
  };

  const context = await resolveGitContext("/work/repo", {
    invoker,
    deadlineMs: 1_400,
    now: () => now,
  });

  assert.ok(context);
  assert.deepEqual(timeouts, [400, 300, 200, 100]);
});

// ──────────────────────────────────────────────────────────────────────────
// resolveGitContext — happy path (origin, branch, default branch)
// ──────────────────────────────────────────────────────────────────────────

test("resolveGitContext: full happy path with origin + branch + default branch", async () => {
  const cwd = "/work/proj-a";
  const root = "/work/proj-a";
  const invoker = mockInvoker({
    [keyFor(cwd, ["rev-parse", "--show-toplevel"])]: { stdout: `${root}\n`, exitCode: 0 },
    [keyFor(root, ["rev-parse", "--abbrev-ref", "HEAD"])]: { stdout: "feat/ui\n", exitCode: 0 },
    [keyFor(root, ["remote", "get-url", "origin"])]: {
      stdout: "git@github.com:acme/proj-a.git\n",
      exitCode: 0,
    },
    [keyFor(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])]: {
      stdout: "refs/remotes/origin/main\n",
      exitCode: 0,
    },
  });

  const ctx = await resolveGitContext(cwd, { invoker });
  assert.ok(ctx, "context should resolve");
  assert.equal(ctx?.rootPath, root);
  assert.equal(ctx?.branch, "feat/ui");
  assert.equal(ctx?.defaultBranch, "main");
  assert.ok(ctx?.projectId.startsWith("origin:"), `expected origin: prefix, got ${ctx?.projectId}`);
  assert.match(ctx?.projectId ?? "", /^origin:[0-9a-f]{8}$/);
});

test("resolveGitContext: projectId is equal for scp and https forms of same repo", async () => {
  const scpRoot = "/work/scp";
  const httpsRoot = "/work/https";

  const scpInvoker = mockInvoker({
    [keyFor(scpRoot, ["rev-parse", "--show-toplevel"])]: { stdout: `${scpRoot}\n`, exitCode: 0 },
    [keyFor(scpRoot, ["rev-parse", "--abbrev-ref", "HEAD"])]: { stdout: "main\n", exitCode: 0 },
    [keyFor(scpRoot, ["remote", "get-url", "origin"])]: {
      stdout: "git@github.com:acme/same.git\n",
      exitCode: 0,
    },
    [keyFor(scpRoot, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])]: {
      stdout: "",
      exitCode: 1,
    },
  });

  const httpsInvoker = mockInvoker({
    [keyFor(httpsRoot, ["rev-parse", "--show-toplevel"])]: { stdout: `${httpsRoot}\n`, exitCode: 0 },
    [keyFor(httpsRoot, ["rev-parse", "--abbrev-ref", "HEAD"])]: { stdout: "main\n", exitCode: 0 },
    [keyFor(httpsRoot, ["remote", "get-url", "origin"])]: {
      stdout: "https://github.com/acme/same\n",
      exitCode: 0,
    },
    [keyFor(httpsRoot, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])]: {
      stdout: "",
      exitCode: 1,
    },
  });

  const scpCtx = await resolveGitContext(scpRoot, { invoker: scpInvoker });
  const httpsCtx = await resolveGitContext(httpsRoot, { invoker: httpsInvoker });
  assert.ok(scpCtx && httpsCtx);
  assert.equal(scpCtx!.projectId, httpsCtx!.projectId, "same repo via different remote URL forms must share projectId");
});

// ──────────────────────────────────────────────────────────────────────────
// resolveGitContext — partial / degraded inputs
// ──────────────────────────────────────────────────────────────────────────

test("resolveGitContext: detached HEAD — branch is null", async () => {
  const cwd = "/work/detached";
  const root = "/work/detached";
  const invoker = mockInvoker({
    [keyFor(cwd, ["rev-parse", "--show-toplevel"])]: { stdout: `${root}\n`, exitCode: 0 },
    [keyFor(root, ["rev-parse", "--abbrev-ref", "HEAD"])]: { stdout: "HEAD\n", exitCode: 0 },
    [keyFor(root, ["remote", "get-url", "origin"])]: { stdout: "git@github.com:acme/x.git\n", exitCode: 0 },
    [keyFor(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])]: {
      stdout: "refs/remotes/origin/main\n",
      exitCode: 0,
    },
  });

  const ctx = await resolveGitContext(cwd, { invoker });
  assert.ok(ctx);
  assert.equal(ctx!.branch, null);
  assert.equal(ctx!.defaultBranch, "main");
});

test("resolveGitContext: no origin remote — falls back to root: projectId", async () => {
  const cwd = "/work/no-origin";
  const root = "/work/no-origin";
  const invoker = mockInvoker({
    [keyFor(cwd, ["rev-parse", "--show-toplevel"])]: { stdout: `${root}\n`, exitCode: 0 },
    [keyFor(root, ["rev-parse", "--abbrev-ref", "HEAD"])]: { stdout: "main\n", exitCode: 0 },
    // origin lookup fails
    [keyFor(root, ["remote", "get-url", "origin"])]: { stdout: "", exitCode: 128 },
    [keyFor(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])]: { stdout: "", exitCode: 1 },
  });

  const ctx = await resolveGitContext(cwd, { invoker });
  assert.ok(ctx);
  assert.match(ctx!.projectId, /^root:[0-9a-f]{8}$/);
  assert.equal(ctx!.defaultBranch, null);
});

test("resolveGitContext: no origin HEAD symref — defaultBranch is null", async () => {
  const cwd = "/work/no-head";
  const root = "/work/no-head";
  const invoker = mockInvoker({
    [keyFor(cwd, ["rev-parse", "--show-toplevel"])]: { stdout: `${root}\n`, exitCode: 0 },
    [keyFor(root, ["rev-parse", "--abbrev-ref", "HEAD"])]: { stdout: "main\n", exitCode: 0 },
    [keyFor(root, ["remote", "get-url", "origin"])]: {
      stdout: "git@github.com:acme/x.git\n",
      exitCode: 0,
    },
    [keyFor(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])]: {
      stdout: "",
      exitCode: 1,
    },
  });

  const ctx = await resolveGitContext(cwd, { invoker });
  assert.ok(ctx);
  assert.equal(ctx!.defaultBranch, null);
});

test("resolveGitContext: unborn HEAD repo — branch recovered from symbolic-ref HEAD", async () => {
  // Fresh `git init` leaves HEAD unborn: `rev-parse --abbrev-ref HEAD`
  // fails, but `symbolic-ref HEAD` still returns `refs/heads/main`.
  const cwd = "/work/fresh";
  const root = "/work/fresh";
  const invoker = mockInvoker({
    [keyFor(cwd, ["rev-parse", "--show-toplevel"])]: { stdout: `${root}\n`, exitCode: 0 },
    [keyFor(root, ["rev-parse", "--abbrev-ref", "HEAD"])]: { stdout: "", exitCode: 128 },
    [keyFor(root, ["symbolic-ref", "--quiet", "HEAD"])]: {
      stdout: "refs/heads/main\n",
      exitCode: 0,
    },
    [keyFor(root, ["remote", "get-url", "origin"])]: { stdout: "", exitCode: 1 },
    [keyFor(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])]: {
      stdout: "",
      exitCode: 1,
    },
  });

  const ctx = await resolveGitContext(cwd, { invoker });
  assert.ok(ctx);
  assert.equal(ctx!.branch, "main");
});

// ──────────────────────────────────────────────────────────────────────────
// resolveGitContext — rootPath vs cwd
// ──────────────────────────────────────────────────────────────────────────

test("resolveGitContext: cwd inside repo returns repo root, not cwd", async () => {
  const cwd = "/work/proj/src/deep/dir";
  const root = "/work/proj";
  const invoker = mockInvoker({
    [keyFor(cwd, ["rev-parse", "--show-toplevel"])]: { stdout: `${root}\n`, exitCode: 0 },
    [keyFor(root, ["rev-parse", "--abbrev-ref", "HEAD"])]: { stdout: "main\n", exitCode: 0 },
    [keyFor(root, ["remote", "get-url", "origin"])]: {
      stdout: "git@github.com:acme/proj.git\n",
      exitCode: 0,
    },
    [keyFor(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])]: {
      stdout: "refs/remotes/origin/main\n",
      exitCode: 0,
    },
  });

  const ctx = await resolveGitContext(cwd, { invoker });
  assert.ok(ctx);
  assert.equal(ctx!.rootPath, root);
});
