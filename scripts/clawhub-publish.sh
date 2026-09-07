#!/usr/bin/env bash
# Best-effort ClawHub publish of @remnic/plugin-openclaw for the checked-out
# release source. npm and the GitHub release are already published by the time
# this runs, so known-transient ClawHub backend failures exit 0 with a notice;
# unknown failures stay fatal. Re-runnable for an existing tag via
# .github/workflows/clawhub-publish.yml.
#
# Env: CLAWHUB_TOKEN (required, else skip), SOURCE_REF (tag name),
#      GITHUB_REPOSITORY, RUNNER_TEMP.
set -euo pipefail

CLAWHUB_OWNER="${CLAWHUB_OWNER:-remnic}"
CLAWHUB_PACKAGE_NAME="${CLAWHUB_PACKAGE_NAME:-@remnic/plugin-openclaw}"
NPM_PACKAGE_NAME="${NPM_PACKAGE_NAME:-@remnic/plugin-openclaw}"
NPM_PACKAGE_PATH="${NPM_PACKAGE_PATH:-packages/plugin-openclaw}"
# ponytail: fixed 3 attempts / 30s backoff; ClawHub's rate limit says "reset in ~23s".
CLAWHUB_PUBLISH_ATTEMPTS="${CLAWHUB_PUBLISH_ATTEMPTS:-3}"
CLAWHUB_PUBLISH_BACKOFF_SECONDS="${CLAWHUB_PUBLISH_BACKOFF_SECONDS:-30}"

if [ -z "${CLAWHUB_TOKEN:-}" ]; then
  echo "::notice title=ClawHub publish skipped::CLAWHUB_TOKEN secret is not configured."
  exit 0
fi
if [ -z "${SOURCE_REF:-}" ]; then
  echo "SOURCE_REF (release tag) is required" >&2
  exit 1
fi

npm install -g clawhub@0.18.0
clawhub login --token "${CLAWHUB_TOKEN}" --no-browser

package_version="$(node -p "require('./${NPM_PACKAGE_PATH}/package.json').version")"
if clawhub package inspect "${CLAWHUB_PACKAGE_NAME}" --version "${package_version}" --json >/dev/null 2>&1; then
  echo "::notice title=ClawHub publish skipped::${CLAWHUB_PACKAGE_NAME}@${package_version} is already published."
  exit 0
fi

pack_dir="${RUNNER_TEMP:-/tmp}/clawhub-openclaw-pack"
rm -rf "${pack_dir}"
mkdir -p "${pack_dir}"
pnpm --filter "${NPM_PACKAGE_NAME}" pack --pack-destination "${pack_dir}"
tarball="$(find "${pack_dir}" -maxdepth 1 -name '*.tgz' -print -quit)"
if [ -z "${tarball}" ]; then
  echo "No ${NPM_PACKAGE_NAME} tarball produced" >&2
  exit 1
fi

source_commit="$(git rev-parse HEAD)"
publish_log="$(mktemp)"
trap 'rm -f "${publish_log}"' EXIT

is_transient() {
  grep -qE "Too many bytes read in a single function execution|Your request couldn't be completed\. Try again later" "$1"
}

attempt=1
while :; do
  publish_status=0
  clawhub package publish "${tarball}" \
    --family code-plugin \
    --name "${CLAWHUB_PACKAGE_NAME}" \
    --owner "${CLAWHUB_OWNER}" \
    --display-name "Remnic OpenClaw Plugin" \
    --version "${package_version}" \
    --host-targets openclaw \
    --source-repo "${GITHUB_REPOSITORY}" \
    --source-ref "${SOURCE_REF}" \
    --source-commit "${source_commit}" \
    --source-path "${NPM_PACKAGE_PATH}" \
    --changelog "Publish ${CLAWHUB_PACKAGE_NAME}@${package_version} from the GitHub release workflow." \
    --json >"${publish_log}" 2>&1 || publish_status=$?
  cat "${publish_log}"
  if [ "${publish_status}" -eq 0 ]; then
    break
  fi
  if grep -q "publisher does not exist on ClawHub" "${publish_log}"; then
    echo "::notice title=ClawHub publish skipped::The authenticated ClawHub account is not provisioned as a package publisher yet."
    exit 0
  fi
  if is_transient "${publish_log}"; then
    if [ "${attempt}" -lt "${CLAWHUB_PUBLISH_ATTEMPTS}" ]; then
      echo "ClawHub publish attempt ${attempt}/${CLAWHUB_PUBLISH_ATTEMPTS} hit a transient backend error; retrying in ${CLAWHUB_PUBLISH_BACKOFF_SECONDS}s."
      sleep "${CLAWHUB_PUBLISH_BACKOFF_SECONDS}"
      attempt=$((attempt + 1))
      continue
    fi
    echo "::notice title=ClawHub publish skipped::ClawHub publish hit its backend read limit or rate limit after ${CLAWHUB_PUBLISH_ATTEMPTS} attempts. npm and GitHub release publication already completed; re-run .github/workflows/clawhub-publish.yml for ${SOURCE_REF} once ClawHub recovers."
    exit 0
  fi
  exit "${publish_status}"
done

clawhub package rescan "${CLAWHUB_PACKAGE_NAME}" --yes --json || true
