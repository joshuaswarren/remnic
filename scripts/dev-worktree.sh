#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf 'Usage: %s <worktree-path> <branch> [base]\n' "$(basename "$0")" >&2
  exit 2
}

if (( $# < 2 || $# > 3 )); then
  usage
fi

worktree_arg=$1
branch=$2
base=${3:-HEAD}
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(git -C "$script_dir" rev-parse --show-toplevel)
git_common_dir=$(git -C "$repo_root" rev-parse --git-common-dir)
if [[ $git_common_dir != /* ]]; then
  git_common_dir=$repo_root/$git_common_dir
fi
git_common_dir=$(cd -- "$git_common_dir" && pwd -P)
# Serialize helper invocations so ownership checks cannot race another helper.
lock_path=$git_common_dir/dev-worktree.lock
if ! mkdir -- "$lock_path" 2>/dev/null; then
  printf 'Another worktree quickstart is already running for this repository.\n' >&2
  exit 1
fi
release_lock() {
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

worktree_owned() {
  local line current_path=
  while IFS= read -r line; do
    case $line in
      "worktree "*) current_path=${line#worktree } ;;
      "branch "*) [[ $current_path == "$worktree_path" && $line == "branch refs/heads/$branch" ]] && return 0 ;;
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
fi
cleanup() {
  if (( ! worktree_registered_before )); then
    if worktree_owned; then
      if git -C "$repo_root" worktree remove --force "$worktree_path" >/dev/null 2>&1; then
        git -C "$repo_root" branch -D -- "$branch" >/dev/null 2>&1 || true
      fi
    elif (( ! branch_existed_before )) && ! branch_has_worktree; then
      git -C "$repo_root" branch -D -- "$branch" >/dev/null 2>&1 || true
    fi
  fi
  release_lock
}
trap cleanup EXIT

printf 'Creating worktree at %s from %s on branch %s\n' "$worktree_path" "$base" "$branch"
git -C "$repo_root" worktree add -b "$branch" "$worktree_path" "$base"

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
