import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SyntheticFile } from "./types.js";

export interface MaterializeOptions {
  authorName?: string;
  authorEmail?: string;
  commitDate?: string;
  commitMessage?: string;
}

export interface MaterializedRepo {
  dir: string;
  commitSha: string;
  cleanup: () => Promise<void>;
}

export function isSafeSyntheticPath(filePath: string): boolean {
  const segments = filePath.split("/");
  return (
    filePath.length > 0 &&
    !filePath.startsWith("/") &&
    !filePath.includes("\\") &&
    !segments.some((segment) => segment === "" || segment === ".") &&
    !segments.includes("..") &&
    !segments.includes(".git")
  );
}

function assertSafeSyntheticFiles(files: SyntheticFile[]): void {
  const paths = new Set<string>();
  for (const file of files) {
    if (!isSafeSyntheticPath(file.path)) {
      throw new Error(`Synthetic file path escapes repository: ${file.path}`);
    }
    if (paths.has(file.path)) {
      throw new Error(`Duplicate synthetic file path: ${file.path}`);
    }
    paths.add(file.path);
  }
}
function controlledGitEnvironment(
  authorName: string,
  authorEmail: string,
  commitDate: string,
): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => !key.startsWith("GIT_") && value !== undefined),
  );
  return {
    ...inherited,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_AUTHOR_DATE: commitDate,
    GIT_COMMITTER_NAME: authorName,
    GIT_COMMITTER_EMAIL: authorEmail,
    GIT_COMMITTER_DATE: commitDate,
  };
}

function runControlledGit(cwd: string, env: NodeJS.ProcessEnv, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "commit.gpgSign=false", "-c", `core.hooksPath=${devNull}`, ...args],
    { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
}


export async function materializeTaskRepo(
  files: SyntheticFile[],
  options: MaterializeOptions = {},
): Promise<MaterializedRepo> {
  assertSafeSyntheticFiles(files);
  const prefix = join(tmpdir(), "h6-bench-git-");
  const tempDir = await mkdtemp(prefix);

  const authorName = options.authorName ?? "H6 Bench";
  const authorEmail = options.authorEmail ?? "bench@remnic.internal";
  const commitDate = options.commitDate ?? "2026-01-01T00:00:00.000Z";
  const commitMessage = options.commitMessage ?? "Initial synthetic task repository";

  for (const file of files) {
    const fullPath = join(tempDir, file.path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, file.content, {
      encoding: "utf8",
      mode: file.isExecutable ? 0o755 : 0o644,
    });
  }

  const env = controlledGitEnvironment(authorName, authorEmail, commitDate);
  const git = (args: string[]) => runControlledGit(tempDir, env, args);

  git(["init", "-q", "--object-format=sha1", "--initial-branch=main"]);
  git(["config", "user.name", authorName]);
  git(["config", "user.email", authorEmail]);
  git(["add", "."]);
  git(["commit", "-m", commitMessage, "--quiet", "--no-gpg-sign"]);

  const commitSha = git(["rev-parse", "HEAD"]);

  const cleanup = async () => {
    rmSync(tempDir, { recursive: true, force: true });
  };

  return {
    dir: tempDir,
    commitSha,
    cleanup,
  };
}

export async function applyPatchAndCommit(
  dir: string,
  patchFiles: SyntheticFile[],
  message = "Apply patch",
): Promise<string> {
  assertSafeSyntheticFiles(patchFiles);
  const env = controlledGitEnvironment(
    "H6 Bench",
    "bench@remnic.internal",
    "2026-01-01T00:00:01.000Z",
  );

  for (const file of patchFiles) {
    const fullPath = join(dir, file.path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, file.content, "utf8");
  }

  const git = (args: string[]) => runControlledGit(dir, env, args);
  git(["add", "."]);
  git(["commit", "-m", message, "--quiet", "--no-gpg-sign"]);

  return git(["rev-parse", "HEAD"]);
}

export interface RevisionShas {
  cleanSha: string;
  trapSha: string;
  rightSha: string;
  noTrapSha: string;
}

export async function computeRevisionShas(
  cleanFiles: SyntheticFile[],
  badPatchFiles: SyntheticFile[],
  goodPatchFiles: SyntheticFile[],
  noTrapFiles: SyntheticFile[],
): Promise<RevisionShas> {
  assertSafeSyntheticFiles(cleanFiles);
  assertSafeSyntheticFiles(badPatchFiles);
  assertSafeSyntheticFiles(goodPatchFiles);
  assertSafeSyntheticFiles(noTrapFiles);

  const [cleanRepo, trapRepo, rightRepo, noTrapRepo] = await Promise.all([
    materializeTaskRepo(cleanFiles),
    materializeTaskRepo(cleanFiles),
    materializeTaskRepo(cleanFiles),
    materializeTaskRepo(noTrapFiles),
  ]);

  try {
    const trapSha = await applyPatchAndCommit(
      trapRepo.dir,
      badPatchFiles,
      "apply bad strategy patch",
    );
    const rightSha = await applyPatchAndCommit(
      rightRepo.dir,
      goodPatchFiles,
      "apply good strategy patch",
    );
    return {
      cleanSha: cleanRepo.commitSha,
      trapSha,
      rightSha,
      noTrapSha: noTrapRepo.commitSha,
    };
  } finally {
    await Promise.all([
      cleanRepo.cleanup(),
      trapRepo.cleanup(),
      rightRepo.cleanup(),
      noTrapRepo.cleanup(),
    ]);
  }
}
