import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const RELAY_RUN_MARKER = ".remnic-relay-isolated-run";
export const RELAY_RUN_MARKER_CONTENT = "Remnic Relay isolated Build Week run v1\n";

export interface RelayRunDirectories {
  root: string;
  memoryDir: string;
  sharedContextDir: string;
  codexHomesDir: string;
  workspacesDir: string;
  outputsDir: string;
  rootfsDir: string;
}

export interface FixtureDigest {
  path: string;
  bytes: number;
  sha256: string;
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function assertNoSymlinkAncestors(targetPath: string): Promise<void> {
  const resolved = path.resolve(targetPath);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) {
        throw new Error(`Relay isolation path traverses a symlink: ${cursor}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export function allowedRelayRunParents(repoRoot: string): string[] {
  return [path.resolve(os.tmpdir()), path.join(path.resolve(repoRoot), ".remnic", "relay", "runs")];
}

export async function prepareRelayRunDirectories(
  repoRoot: string,
  requestedRoot?: string
): Promise<RelayRunDirectories> {
  const allowedParents = allowedRelayRunParents(repoRoot);
  let root: string;
  if (requestedRoot) {
    root = path.resolve(requestedRoot);
    if (!allowedParents.some((parent) => isWithin(parent, root)) || allowedParents.includes(root)) {
      throw new Error("Relay run root must be a child of the OS temp directory or .remnic/relay/runs");
    }
    await assertNoSymlinkAncestors(root);
    if (await pathExists(root)) {
      const info = await lstat(root);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error("Relay run root must be a real directory");
      }
      if ((await readdir(root)).length !== 0) {
        throw new Error("Relay run root must be empty");
      }
    } else {
      await mkdir(root, { recursive: true, mode: 0o700 });
    }
  } else {
    root = await mkdtemp(path.join(os.tmpdir(), "remnic-relay-live-"));
    await chmod(root, 0o700);
  }

  await writeFile(path.join(root, RELAY_RUN_MARKER), RELAY_RUN_MARKER_CONTENT, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  const directories: RelayRunDirectories = {
    root,
    memoryDir: path.join(root, "memory"),
    sharedContextDir: path.join(root, "shared-context"),
    codexHomesDir: path.join(root, "codex-homes"),
    workspacesDir: path.join(root, "workspaces"),
    outputsDir: path.join(root, "outputs"),
    rootfsDir: path.join(root, "rootfs"),
  };
  for (const directory of Object.values(directories).slice(1)) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  return directories;
}

export async function cleanupRelayRun(directories: RelayRunDirectories): Promise<void> {
  const marker = path.join(directories.root, RELAY_RUN_MARKER);
  const markerValue = await readFile(marker, "utf8").catch(() => "");
  if (markerValue !== RELAY_RUN_MARKER_CONTENT) {
    throw new Error("Relay cleanup refused because the isolation marker is missing or invalid");
  }
  await rm(directories.root, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
}

export async function assertTreeContainsNoSymlinks(root: string): Promise<void> {
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`Relay fixture root must be a real directory: ${root}`);
  }
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      const info = await lstat(entryPath);
      if (info.isSymbolicLink()) {
        throw new Error(`Relay fixtures may not contain symlinks: ${entryPath}`);
      }
      if (info.isDirectory()) pending.push(entryPath);
      else if (!info.isFile()) throw new Error(`Relay fixtures may contain only files and directories: ${entryPath}`);
    }
  }
}

export async function copyFixtureTree(source: string, destination: string): Promise<void> {
  await assertTreeContainsNoSymlinks(source);
  if ((await readdir(destination)).length !== 0) {
    throw new Error(`Relay workspace destination must be empty: ${destination}`);
  }
  for (const entry of (await readdir(source)).sort()) {
    await cp(path.join(source, entry), path.join(destination, entry), {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
    });
  }
  await assertTreeContainsNoSymlinks(destination);
}

export async function digestFixtureTree(root: string, excludeRelativePaths: string[] = []): Promise<FixtureDigest[]> {
  await assertTreeContainsNoSymlinks(root);
  const excluded = new Set(excludeRelativePaths.map((item) => item.split(path.sep).join("/")));
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name)
    );
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else files.push(entryPath);
    }
  }
  const digests: FixtureDigest[] = [];
  for (const filePath of files.sort()) {
    const relative = path.relative(root, filePath).split(path.sep).join("/");
    if (excluded.has(relative)) continue;
    const contents = await readFile(filePath);
    digests.push({
      path: relative,
      bytes: contents.byteLength,
      sha256: createHash("sha256").update(contents).digest("hex"),
    });
  }
  return digests;
}

export async function createRoleCodexHome(
  codexHomesDir: string,
  role: string,
  authSourcePath: string
): Promise<string> {
  const authInfo = await lstat(authSourcePath);
  if (authInfo.isSymbolicLink() || !authInfo.isFile()) {
    throw new Error("Codex auth source must be a regular non-symlink file");
  }
  if ((authInfo.mode & 0o077) !== 0) {
    throw new Error("Codex auth source permissions must not grant group or other access");
  }
  const home = path.join(codexHomesDir, `${role}-${randomBytes(6).toString("hex")}`);
  await mkdir(home, { mode: 0o700 });
  await copyFile(authSourcePath, path.join(home, "auth.json"));
  await chmod(path.join(home, "auth.json"), 0o600);
  return home;
}

export async function resolveCodexBinary(commandPath: string): Promise<string> {
  const resolved = await realpath(path.resolve(commandPath));
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error("Codex executable must resolve to a regular file");
  return resolved;
}
