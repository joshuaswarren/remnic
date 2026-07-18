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

for name in RELAY_ROOTFS RELAY_WORKSPACE RELAY_CODEX_HOME RELAY_OUTPUT_DIR RELAY_CODEX_BIN; do
  value="${!name}"
  if [[ "${value}" != /* || "${value}" == *$'\n'* || "${value}" == *$'\r'* ]]; then
    echo "relay isolation: ${name} must be a safe absolute path" >&2
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

mount --make-rprivate /
mount -t tmpfs -o mode=0755,nosuid,nodev tmpfs "${RELAY_ROOTFS}"
cleanup() {
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

exec /usr/sbin/chroot "${RELAY_ROOTFS}" /usr/bin/env -i \
  HOME=/codex-home \
  CODEX_HOME=/codex-home \
  TMPDIR=/tmp \
  PATH=/usr/local/bin:/usr/bin:/bin \
  LANG=C.UTF-8 \
  LC_ALL=C.UTF-8 \
  SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
  REMNIC_RELAY_MCP_TOKEN="${REMNIC_RELAY_MCP_TOKEN}" \
  /opt/codex/codex "$@"
