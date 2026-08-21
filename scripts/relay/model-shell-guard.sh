#!/opt/codex/relay-command-interpreter
# shellcheck shell=bash
set -euo pipefail

if [[ "${RELAY_MODEL_SHELL_INNER:-}" != "1" ]]; then
  for secret_name in REMNIC_RELAY_MCP_TOKEN OPENAI_API_KEY CODEX_API_KEY CHATGPT_ACCESS_TOKEN CODEX_HOME; do
    if [[ -n "${!secret_name:-}" ]]; then
      echo "relay model shell guard: trusted-only environment reached the model shell" >&2
      exit 70
    fi
  done
  exec /usr/bin/unshare \
    --mount \
    --pid \
    --fork \
    --kill-child=SIGKILL \
    --mount-proc=/proc \
    /usr/bin/env RELAY_MODEL_SHELL_INNER=1 /opt/codex/relay-shell-guard "$@"
fi

mount --make-rprivate /
mount -t tmpfs -o mode=000,nosuid,nodev,noexec tmpfs /codex-home
mount -t tmpfs -o mode=000,nosuid,nodev,noexec tmpfs /output
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs /tmp
install -d -m 0700 /tmp/relay-model-home

exec /usr/bin/setpriv \
  --securebits +noroot,+noroot_locked \
  --bounding-set=-all \
  --inh-caps=-all \
  --ambient-caps=-all \
  --no-new-privs \
  /usr/bin/env -u RELAY_MODEL_SHELL_INNER \
    HOME=/tmp/relay-model-home \
    TMPDIR=/tmp \
    /opt/codex/relay-command-interpreter "$@"
