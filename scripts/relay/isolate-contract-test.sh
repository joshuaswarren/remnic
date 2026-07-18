#!/usr/bin/env bash
set -euo pipefail

umask 077

required=(
  RELAY_ROOTFS
  RELAY_WORKSPACE
  RELAY_TEST_KIND
  RELAY_TEST_RUN
  RELAY_NODE_BIN
  RELAY_SETPRIV_BIN
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "relay contract isolation: missing ${name}" >&2
    exit 70
  fi
done

for name in RELAY_ROOTFS RELAY_WORKSPACE RELAY_NODE_BIN RELAY_SETPRIV_BIN; do
  value="${!name}"
  if [[ "${value}" != /* || "${value}" == *$'\n'* || "${value}" == *$'\r'* ]]; then
    echo "relay contract isolation: ${name} must be a safe absolute path" >&2
    exit 70
  fi
done
if [[ ! "${RELAY_TEST_RUN}" =~ ^[A-Za-z0-9._:-]{1,128}$ ]]; then
  echo "relay contract isolation: RELAY_TEST_RUN is invalid" >&2
  exit 70
fi
if [[ "${RELAY_TEST_KIND}" != "public" && "${RELAY_TEST_KIND}" != "hidden" ]]; then
  echo "relay contract isolation: RELAY_TEST_KIND must be public or hidden" >&2
  exit 70
fi
if [[ ! -d "${RELAY_ROOTFS}" || -L "${RELAY_ROOTFS}" || -n "$(find "${RELAY_ROOTFS}" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "relay contract isolation: rootfs must be an empty real directory" >&2
  exit 70
fi
if [[ ! -d "${RELAY_WORKSPACE}" || -L "${RELAY_WORKSPACE}" ]]; then
  echo "relay contract isolation: workspace must be a real directory" >&2
  exit 70
fi
for binary in "${RELAY_NODE_BIN}" "${RELAY_SETPRIV_BIN}"; do
  if [[ ! -f "${binary}" || -L "${binary}" ]]; then
    echo "relay contract isolation: runtime binaries must be regular non-symlink files" >&2
    exit 70
  fi
done
if [[ "${RELAY_TEST_KIND}" == "hidden" ]]; then
  if [[ -z "${RELAY_HIDDEN_TEST:-}" || "${RELAY_HIDDEN_TEST}" != /* || "${RELAY_HIDDEN_TEST}" == *$'\n'* || "${RELAY_HIDDEN_TEST}" == *$'\r'* ]]; then
    echo "relay contract isolation: hidden test path must be a safe absolute path" >&2
    exit 70
  fi
  if [[ ! -f "${RELAY_HIDDEN_TEST}" || -L "${RELAY_HIDDEN_TEST}" ]]; then
    echo "relay contract isolation: hidden test must be a regular non-symlink file" >&2
    exit 70
  fi
fi

# Node 22.12, the repository's CI floor, exposes the permission model only
# through the long-lived experimental spelling. Newer Node 22 releases retain
# that spelling as an alias, so use it across the compatibility window. The
# SIGUSR1 hardening flag arrived later in Node 22; add it only when the trusted
# runtime advertises support. The isolated PID and network namespaces remain
# the primary inspector boundary on older runtimes.
node_security_args=(
  --experimental-permission
  --no-addons
)
node_help="$("${RELAY_NODE_BIN}" --help)"
if [[ "${node_help}" == *"--disable-sigusr1"* ]]; then
  node_security_args+=(--disable-sigusr1)
fi

mount --make-rprivate /
mount -t tmpfs -o mode=0755,nosuid,nodev tmpfs "${RELAY_ROOTFS}"
cleanup() {
  umount -R "${RELAY_ROOTFS}" 2>/dev/null || true
}
trap cleanup EXIT

install -d -m 0755 \
  "${RELAY_ROOTFS}/usr/bin" \
  "${RELAY_ROOTFS}/dev" \
  "${RELAY_ROOTFS}/fixture" \
  "${RELAY_ROOTFS}/tmp" \
  "${RELAY_ROOTFS}/workspace"
mount -t tmpfs -o mode=1777,nosuid,nodev,noexec tmpfs "${RELAY_ROOTFS}/tmp"

bind_runtime_file() {
  local source="$1"
  local target="$2"
  local resolved
  resolved="$(realpath -e -- "${source}")"
  if [[ "${resolved}" != /* || ! -f "${resolved}" || -L "${resolved}" ]]; then
    echo "relay contract isolation: invalid runtime file ${source}" >&2
    exit 70
  fi
  install -D -m 0755 /dev/null "${RELAY_ROOTFS}${target}"
  mount --bind "${resolved}" "${RELAY_ROOTFS}${target}"
  mount -o remount,bind,ro,nosuid,nodev "${RELAY_ROOTFS}${target}"
}

bind_runtime_file "${RELAY_NODE_BIN}" /usr/bin/node
bind_runtime_file "${RELAY_SETPRIV_BIN}" /usr/bin/setpriv
mapfile -t runtime_libraries < <(
  for binary in "${RELAY_NODE_BIN}" "${RELAY_SETPRIV_BIN}"; do
    ldd "${binary}" | awk '/=> \// { print $3 } /^[[:space:]]*\// { print $1 }'
  done | sort -u
)
if [[ "${#runtime_libraries[@]}" -eq 0 ]]; then
  echo "relay contract isolation: runtime library discovery returned no files" >&2
  exit 70
fi
for library in "${runtime_libraries[@]}"; do
  if [[ "${library}" != /* || "${library}" == *$'\n'* || "${library}" == *$'\r'* ]]; then
    echo "relay contract isolation: runtime library path is unsafe" >&2
    exit 70
  fi
  bind_runtime_file "${library}" "${library}"
done

for device in null zero random urandom; do
  install -m 0600 /dev/null "${RELAY_ROOTFS}/dev/${device}"
  mount --bind "/dev/${device}" "${RELAY_ROOTFS}/dev/${device}"
done

mount --bind "${RELAY_WORKSPACE}" "${RELAY_ROOTFS}/workspace"
mount -o remount,bind,ro,nosuid,nodev,noexec "${RELAY_ROOTFS}/workspace"
if touch "${RELAY_ROOTFS}/workspace/.relay-contract-write-probe" 2>/dev/null; then
  rm -f "${RELAY_ROOTFS}/workspace/.relay-contract-write-probe"
  echo "relay contract isolation: read-only workspace mount remained writable" >&2
  exit 70
fi

test_file=/workspace/test/public.test.mjs
if [[ "${RELAY_TEST_KIND}" == "hidden" ]]; then
  install -m 0644 /dev/null "${RELAY_ROOTFS}/fixture/token-policy.hidden.test.mjs"
  mount --bind "${RELAY_HIDDEN_TEST}" "${RELAY_ROOTFS}/fixture/token-policy.hidden.test.mjs"
  mount -o remount,bind,ro,nosuid,nodev,noexec "${RELAY_ROOTFS}/fixture/token-policy.hidden.test.mjs"
  test_file=/fixture/token-policy.hidden.test.mjs
fi

/usr/bin/env -i \
  HOME=/tmp \
  TMPDIR=/tmp \
  PATH=/usr/bin \
  LANG=C.UTF-8 \
  LC_ALL=C.UTF-8 \
  REMNIC_RELAY_WORKSPACE=/workspace \
  REMNIC_RELAY_TEST_RUN="${RELAY_TEST_RUN}" \
  /usr/sbin/chroot "${RELAY_ROOTFS}" \
    /usr/bin/setpriv \
      --securebits +noroot,+noroot_locked \
      --bounding-set=-all \
      --inh-caps=-all \
      --ambient-caps=-all \
      --no-new-privs \
      /usr/bin/node \
        "${node_security_args[@]}" \
        --allow-fs-read='*' \
        --experimental-test-isolation=none \
        --test \
        --test-reporter=tap \
        "${test_file}"
