export function resolveHomeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "~";
}

/** Expand a leading `~`, `~/`, `$HOME/`, or `${HOME}/` to the real home directory. */
export function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    return resolveHomeDir() + p.slice(1);
  }
  const home = resolveHomeDir();
  if (p === "$HOME" || p.startsWith("$HOME/") || p.startsWith("$HOME\\")) {
    return home + p.slice(5);
  }
  if (p === "${HOME}" || p.startsWith("${HOME}/") || p.startsWith("${HOME}\\")) {
    return home + p.slice(7);
  }
  return p;
}
