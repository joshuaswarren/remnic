#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf 'Usage: %s <worktree-path> <branch> [base]\n' "$(basename "$0")" >&2
  printf 'Default base is origin/main (or github/main) after fetch, not local HEAD.\n' >&2
  exit 2
}

if (( $# < 2 || $# > 3 )); then
  usage
fi

worktree_arg=$1
if [[ $worktree_arg == *$'\n'* || $worktree_arg == *$'\r'* ]]; then
  printf 'Worktree path cannot contain a line break.\n' >&2
  exit 1
fi
branch=$2
explicit_base=${3-}
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(git -C "$script_dir" rev-parse --show-toplevel)
if [[ -n $explicit_base ]]; then
  base=$explicit_base
else
  git -C "$repo_root" fetch --quiet origin main 2>/dev/null || true
  git -C "$repo_root" fetch --quiet github main 2>/dev/null || true
  if git -C "$repo_root" rev-parse --verify --quiet refs/remotes/origin/main^{commit} >/dev/null; then
    base=origin/main
  elif git -C "$repo_root" rev-parse --verify --quiet refs/remotes/github/main^{commit} >/dev/null; then
    base=github/main
  else
    base=HEAD
  fi
fi
git_common_dir=$(git -C "$repo_root" rev-parse --git-common-dir)
if [[ $git_common_dir != /* ]]; then
  git_common_dir=$repo_root/$git_common_dir
fi
git_common_dir=$(cd -- "$git_common_dir" && pwd -P)
lock_path=$git_common_dir/dev-worktree.lock
while ! mkdir -- "$lock_path" 2>/dev/null; do
  owner_pid=
  if [[ -r $lock_path/pid ]]; then
    IFS= read -r owner_pid <"$lock_path/pid" || true
  fi
  if [[ $owner_pid =~ ^[0-9]+$ ]] && kill -0 "$owner_pid" 2>/dev/null; then
    printf 'Another worktree quickstart is already running for this repository.\n' >&2
    exit 1
  fi
  stale_lock_path=$lock_path.stale.$$
  if ! mv -- "$lock_path" "$stale_lock_path" 2>/dev/null; then
    if [[ ! -e $lock_path ]]; then
      continue
    fi
    printf 'Could not reclaim the previous worktree quickstart lock.\n' >&2
    exit 1
  fi
  if ! rm -f -- "$stale_lock_path/pid" || ! rmdir -- "$stale_lock_path" 2>/dev/null; then
    printf 'Could not reclaim the previous worktree quickstart lock.\n' >&2
    exit 1
  fi
done
printf '%s\n' "$$" >"$lock_path/pid"
release_lock() {
  rm -f -- "$lock_path/pid"
  rmdir -- "$lock_path" >/dev/null 2>&1 || true
}
trap release_lock EXIT

if [[ $worktree_arg = /* ]]; then
  worktree_path=$worktree_arg
else
  worktree_path=$PWD/$worktree_arg
fi
worktree_parent=$(dirname -- "$worktree_path")
worktree_name=$(basename -- "$worktree_path")
if [[ -e $worktree_path || -L $worktree_path ]]; then
  printf 'Refusing to clobber existing path: %s\n' "$worktree_path" >&2
  exit 1
fi
mkdir -p -- "$worktree_parent"
worktree_path="$(cd -- "$worktree_parent" && pwd -P)/$worktree_name"
if [[ -e $worktree_path || -L $worktree_path ]]; then
  printf 'Refusing to clobber existing path: %s\n' "$worktree_path" >&2
  exit 1
fi
staging_path=$worktree_path.remnic-setup-$$
if [[ -e $staging_path || -L $staging_path ]]; then
  printf 'Temporary setup path already exists: %s\n' "$staging_path" >&2
  exit 1
fi

if [[ $branch == -* || $branch == @\{-*\} ]] || ! git -C "$repo_root" check-ref-format --branch "$branch" >/dev/null 2>&1; then
  printf 'Invalid branch name: %s\n' "$branch" >&2
  exit 1
fi

if [[ $base == -* ]] || ! git -C "$repo_root" rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
  printf 'Base ref not found: %s\n' "$base" >&2
  exit 1
fi
worktree_registered() {
  local line
  while IFS= read -r line; do
    if [[ $line == "worktree $worktree_path" ]]; then
      return 0
    fi
  done < <(git -C "$repo_root" worktree list --porcelain)
  return 1
}
if worktree_registered; then
  printf 'Refusing to clobber registered worktree path: %s\n' "$worktree_path" >&2
  exit 1
fi
worktree_owned_at() {
  local expected_path=$1
  local line current_path=
  while IFS= read -r line; do
    case $line in
      "worktree "*) current_path=${line#worktree } ;;
      "branch "*) [[ $current_path == "$expected_path" && $line == "branch refs/heads/$branch" ]] && return 0 ;;
    esac
  done < <(git -C "$repo_root" worktree list --porcelain)
  return 1
}

branch_has_worktree() {
  local line
  while IFS= read -r line; do
    if [[ $line == "branch refs/heads/$branch" ]]; then
      return 0
    fi
  done < <(git -C "$repo_root" worktree list --porcelain)
  return 1
}

worktree_registered_before=0
if worktree_registered; then
  worktree_registered_before=1
fi
branch_existed_before=0
if git -C "$repo_root" show-ref --verify --quiet "refs/heads/$branch"; then
  branch_existed_before=1
  printf 'Refusing to clobber existing branch: %s\n' "$branch" >&2
  exit 1
fi
branch_created=0
cleanup() {
  if (( ! worktree_registered_before )); then
    if worktree_owned_at "$worktree_path"; then
      if git -C "$repo_root" worktree remove --force "$worktree_path" >/dev/null 2>&1; then
        if (( branch_created )); then
          git -C "$repo_root" branch -D -- "$branch" >/dev/null 2>&1 || true
        fi
      fi
    elif worktree_owned_at "$staging_path"; then
      if git -C "$repo_root" worktree remove --force "$staging_path" >/dev/null 2>&1; then
        if (( branch_created )); then
          git -C "$repo_root" branch -D -- "$branch" >/dev/null 2>&1 || true
        fi
      fi
    elif (( branch_created )) && ! branch_has_worktree; then
      git -C "$repo_root" branch -D -- "$branch" >/dev/null 2>&1 || true
    fi
  fi
  release_lock
}
trap cleanup EXIT
if ! git -C "$repo_root" branch "$branch" "$base" >/dev/null; then
  printf 'Could not create branch: %s\n' "$branch" >&2
  exit 1
fi
branch_created=1

printf 'Creating worktree at %s from %s on branch %s\n' "$worktree_path" "$base" "$branch"
git -C "$repo_root" worktree add "$staging_path" "$branch"
git -C "$repo_root" worktree move "$staging_path" "$worktree_path"
mkdir -p -- "$worktree_path/.claude"
worktree_discipline='Verify `pwd` before every write; use absolute paths rooted at this worktree; NEVER write to the main checkout or sibling worktrees; agent file tools may ignore cwd.'
if [[ -f $repo_root/.claude/napkin.md ]]; then
  cp -- "$repo_root/.claude/napkin.md" "$worktree_path/.claude/napkin.md"
  chmod u+rw -- "$worktree_path/.claude/napkin.md"
  printf '\n## Worktree Discipline\n%s\n' "$worktree_discipline" >>"$worktree_path/.claude/napkin.md"
else
  printf '%s\n' \
    '# Napkin' \
    '' \
    '## Corrections' \
    '| Date | Source | What Went Wrong | What To Do Instead |' \
    '|---|---|---|---|' \
    '' \
    '## User Preferences' \
    '' \
    '## Patterns That Work' \
    '' \
    '## Patterns That Do Not Work' \
    '' \
    '## Domain Notes' \
    '' \
    '## Worktree Discipline' \
    "$worktree_discipline" >"$worktree_path/.claude/napkin.md"
fi

printf 'Installing packages with pnpm@10.32.1\n'
if ! (
  cd -- "$worktree_path"
  npm exec --yes pnpm@10.32.1 -- install --frozen-lockfile
); then
  printf 'Package install failed; removed worktree: %s\n' "$worktree_path" >&2
  exit 1
fi

printf 'Running core type-check smoke check\n'
if ! (
  cd -- "$worktree_path"
  npm exec --yes pnpm@10.32.1 -- --filter @remnic/core run check-types
); then
  printf 'Smoke check failed; removed worktree: %s\n' "$worktree_path" >&2
  exit 1
fi

release_lock
trap - EXIT
printf '\nWorktree ready: %s\n' "$worktree_path"
printf 'Next steps:\n'
printf '  cd %q\n' "$worktree_path"
printf '  git status\n'
printf '  git push -u origin %q\n' "$branch"
printf '  node scripts/agent-checkpoint.mjs write --note "<milestone>"\n'
printf 'Worktree discipline: %s\n' "$worktree_discipline"
