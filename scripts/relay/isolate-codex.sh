#!/usr/bin/env bash
set -euo pipefail

umask 077

required=(
  RELAY_ROOTFS
  RELAY_WORKSPACE
  RELAY_CODEX_HOME
  RELAY_OUTPUT_DIR
  RELAY_CODEX_BIN
  RELAY_WORKSPACE_READ_ONLY
  RELAY_NETWORK_PROXY_SCRIPT
  RELAY_NETWORK_GATEWAY_SOCKET
  RELAY_NETWORK_PROXY_PORT
  RELAY_NETWORK_MCP_TARGET_PORT
  REMNIC_RELAY_MCP_TOKEN
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "relay isolation: missing ${name}" >&2
    exit 70
  fi
done

if [[ "${RELAY_WORKSPACE_READ_ONLY}" != "0" && "${RELAY_WORKSPACE_READ_ONLY}" != "1" ]]; then
  echo "relay isolation: RELAY_WORKSPACE_READ_ONLY must be 0 or 1" >&2
  exit 70
fi

for name in RELAY_ROOTFS RELAY_WORKSPACE RELAY_CODEX_HOME RELAY_OUTPUT_DIR RELAY_CODEX_BIN RELAY_NETWORK_PROXY_SCRIPT RELAY_NETWORK_GATEWAY_SOCKET; do
  value="${!name}"
  if [[ "${value}" != /* || "${value}" == *$'\n'* || "${value}" == *$'\r'* ]]; then
    echo "relay isolation: ${name} must be a safe absolute path" >&2
    exit 70
  fi
done

for name in RELAY_NETWORK_PROXY_PORT RELAY_NETWORK_MCP_TARGET_PORT; do
  value="${!name}"
  if [[ ! "${value}" =~ ^[0-9]+$ || "${value}" -lt 1 || "${value}" -gt 65535 ]]; then
    echo "relay isolation: ${name} must be an integer TCP port" >&2
    exit 70
  fi
done

if [[ ! -d "${RELAY_ROOTFS}" || -n "$(find "${RELAY_ROOTFS}" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "relay isolation: rootfs must be an empty directory" >&2
  exit 70
fi
for directory in "${RELAY_WORKSPACE}" "${RELAY_CODEX_HOME}" "${RELAY_OUTPUT_DIR}"; do
  if [[ ! -d "${directory}" || -L "${directory}" ]]; then
    echo "relay isolation: bind roots must be real directories" >&2
    exit 70
  fi
done
if [[ ! -f "${RELAY_CODEX_BIN}" || -L "${RELAY_CODEX_BIN}" ]]; then
  echo "relay isolation: Codex binary must be a regular non-symlink file" >&2
  exit 70
fi
if [[ ! -f "${RELAY_NETWORK_PROXY_SCRIPT}" || -L "${RELAY_NETWORK_PROXY_SCRIPT}" ]]; then
  echo "relay isolation: network proxy must be a regular non-symlink file" >&2
  exit 70
fi
model_shell_guard="${RELAY_NETWORK_PROXY_SCRIPT%/*}/model-shell-guard.sh"
if [[ ! -f "${model_shell_guard}" || -L "${model_shell_guard}" || ! -x "${model_shell_guard}" ]]; then
  echo "relay isolation: model shell guard must be an executable regular sibling file" >&2
  exit 70
fi
if [[ ! -f /usr/bin/bash || -L /usr/bin/bash ]]; then
  echo "relay isolation: trusted command interpreter must be regular /usr/bin/bash" >&2
  exit 70
fi
if [[ "${RELAY_NETWORK_GATEWAY_SOCKET}" != "${RELAY_OUTPUT_DIR}/network-gateway.sock" || ! -S "${RELAY_NETWORK_GATEWAY_SOCKET}" || -L "${RELAY_NETWORK_GATEWAY_SOCKET}" ]]; then
  echo "relay isolation: network gateway must be the run-scoped output socket" >&2
  exit 70
fi

mount --make-rprivate /
mount -t tmpfs -o mode=0755,nosuid,nodev tmpfs "${RELAY_ROOTFS}"
network_proxy_pid=""
cleanup() {
  if [[ -n "${network_proxy_pid}" ]]; then
    kill "${network_proxy_pid}" 2>/dev/null || true
    wait "${network_proxy_pid}" 2>/dev/null || true
  fi
  rm -f "${RELAY_OUTPUT_DIR}/network-proxy.ready"
  umount -R "${RELAY_ROOTFS}" 2>/dev/null || true
}
trap cleanup EXIT

install -d -m 0755 \
  "${RELAY_ROOTFS}/usr" \
  "${RELAY_ROOTFS}/etc" \
  "${RELAY_ROOTFS}/etc/ssl" \
  "${RELAY_ROOTFS}/dev" \
  "${RELAY_ROOTFS}/proc" \
  "${RELAY_ROOTFS}/tmp" \
  "${RELAY_ROOTFS}/opt/codex" \
  "${RELAY_ROOTFS}/workspace" \
  "${RELAY_ROOTFS}/codex-home" \
  "${RELAY_ROOTFS}/output"
chmod 1777 "${RELAY_ROOTFS}/tmp"
ln -s usr/bin "${RELAY_ROOTFS}/bin"
ln -s usr/sbin "${RELAY_ROOTFS}/sbin"
ln -s usr/lib "${RELAY_ROOTFS}/lib"
ln -s usr/lib64 "${RELAY_ROOTFS}/lib64"

mount --rbind /usr "${RELAY_ROOTFS}/usr"
mount -o remount,bind,ro,nosuid,nodev "${RELAY_ROOTFS}/usr"

for source in /etc/resolv.conf /etc/hosts /etc/nsswitch.conf /etc/passwd /etc/group; do
  if [[ -f "${source}" ]]; then
    target="${RELAY_ROOTFS}${source}"
    install -d -m 0755 "$(dirname "${target}")"
    install -m 0644 /dev/null "${target}"
    mount --bind "${source}" "${target}"
    mount -o remount,bind,ro,nosuid,nodev "${target}"
  fi
done
mount --rbind /etc/ssl "${RELAY_ROOTFS}/etc/ssl"
mount -o remount,bind,ro,nosuid,nodev "${RELAY_ROOTFS}/etc/ssl"

for device in null zero random urandom; do
  install -m 0600 /dev/null "${RELAY_ROOTFS}/dev/${device}"
  mount --bind "/dev/${device}" "${RELAY_ROOTFS}/dev/${device}"
done
mount -t proc -o nosuid,nodev,noexec proc "${RELAY_ROOTFS}/proc"

install -m 0755 /dev/null "${RELAY_ROOTFS}/opt/codex/codex"
mount --bind "${RELAY_CODEX_BIN}" "${RELAY_ROOTFS}/opt/codex/codex"
mount -o remount,bind,ro,nosuid,nodev "${RELAY_ROOTFS}/opt/codex/codex"
install -m 0755 /dev/null "${RELAY_ROOTFS}/opt/codex/relay-network-proxy.mjs"
mount --bind "${RELAY_NETWORK_PROXY_SCRIPT}" "${RELAY_ROOTFS}/opt/codex/relay-network-proxy.mjs"
mount -o remount,bind,ro,nosuid,nodev "${RELAY_ROOTFS}/opt/codex/relay-network-proxy.mjs"
install -m 0755 /dev/null "${RELAY_ROOTFS}/opt/codex/relay-command-interpreter"
# Relay disables Codex unified_exec, so the model-visible shell_command tool can
# only submit a script to Codex's already-selected /bin/bash or /bin/sh. Those
# entrypoints are replaced by relay-shell-guard below. If model-authored script
# text names this interpreter directly, that invocation therefore occurs only
# after the guard has entered its masked mount/PID namespace and dropped caps.
mount --bind /usr/bin/bash "${RELAY_ROOTFS}/opt/codex/relay-command-interpreter"
mount -o remount,bind,ro,nosuid,nodev "${RELAY_ROOTFS}/opt/codex/relay-command-interpreter"
install -m 0755 /dev/null "${RELAY_ROOTFS}/opt/codex/relay-shell-guard"
mount --bind "${model_shell_guard}" "${RELAY_ROOTFS}/opt/codex/relay-shell-guard"
mount -o remount,bind,ro,nosuid,nodev "${RELAY_ROOTFS}/opt/codex/relay-shell-guard"

for shell_name in bash dash zsh pwsh powershell; do
  shell_target="${RELAY_ROOTFS}/usr/bin/${shell_name}"
  if [[ -f "${shell_target}" && ! -L "${shell_target}" ]]; then
    mount --bind "${model_shell_guard}" "${shell_target}"
    mount -o remount,bind,ro,nosuid,nodev "${shell_target}"
  fi
done

mount --bind "${RELAY_WORKSPACE}" "${RELAY_ROOTFS}/workspace"
if [[ "${RELAY_WORKSPACE_READ_ONLY}" == "1" ]]; then
  mount -o remount,bind,ro,nosuid,nodev "${RELAY_ROOTFS}/workspace"
  if touch "${RELAY_ROOTFS}/workspace/.relay-write-probe" 2>/dev/null; then
    rm -f "${RELAY_ROOTFS}/workspace/.relay-write-probe"
    echo "relay isolation: read-only workspace mount remained writable" >&2
    exit 70
  fi
fi
mount --bind "${RELAY_CODEX_HOME}" "${RELAY_ROOTFS}/codex-home"
mount --bind "${RELAY_OUTPUT_DIR}" "${RELAY_ROOTFS}/output"

/usr/bin/ip link set lo up
/usr/sbin/chroot "${RELAY_ROOTFS}" /usr/bin/env -i \
  HOME=/tmp \
  TMPDIR=/tmp \
  PATH=/usr/bin:/bin \
  LANG=C.UTF-8 \
  LC_ALL=C.UTF-8 \
  /usr/bin/node /opt/codex/relay-network-proxy.mjs \
    --gateway /output/network-gateway.sock \
    --listen-port "${RELAY_NETWORK_PROXY_PORT}" \
    --mcp-target-port "${RELAY_NETWORK_MCP_TARGET_PORT}" &
network_proxy_pid=$!

for ((attempt = 0; attempt < 100; attempt += 1)); do
  if [[ -f "${RELAY_OUTPUT_DIR}/network-proxy.ready" ]]; then
    break
  fi
  if ! kill -0 "${network_proxy_pid}" 2>/dev/null; then
    echo "relay isolation: network proxy exited before readiness" >&2
    exit 70
  fi
  sleep 0.05
done
if [[ ! -f "${RELAY_OUTPUT_DIR}/network-proxy.ready" ]]; then
  echo "relay isolation: network proxy did not become ready" >&2
  exit 70
fi

set +e
/usr/sbin/chroot "${RELAY_ROOTFS}" /usr/bin/env -i \
  HOME=/codex-home \
  CODEX_HOME=/codex-home \
  TMPDIR=/tmp \
  PATH=/usr/local/bin:/usr/bin:/bin \
  LANG=C.UTF-8 \
  LC_ALL=C.UTF-8 \
  SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
  HTTP_PROXY="http://127.0.0.1:${RELAY_NETWORK_PROXY_PORT}" \
  HTTPS_PROXY="http://127.0.0.1:${RELAY_NETWORK_PROXY_PORT}" \
  ALL_PROXY="http://127.0.0.1:${RELAY_NETWORK_PROXY_PORT}" \
  http_proxy="http://127.0.0.1:${RELAY_NETWORK_PROXY_PORT}" \
  https_proxy="http://127.0.0.1:${RELAY_NETWORK_PROXY_PORT}" \
  all_proxy="http://127.0.0.1:${RELAY_NETWORK_PROXY_PORT}" \
  NO_PROXY=127.0.0.1,localhost \
  no_proxy=127.0.0.1,localhost \
  REMNIC_RELAY_MCP_TOKEN="${REMNIC_RELAY_MCP_TOKEN}" \
  /opt/codex/codex "$@"
status=$?
set -e
exit "${status}"
