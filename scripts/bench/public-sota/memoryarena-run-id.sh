latest_memoryarena_run_id() {
  local candidate=""
  local name=""
  local timestamp=""
  local latest_name=""
  local latest_timestamp=""
  while IFS= read -r candidate; do
    name="$(basename "${candidate}")"
    timestamp="$(printf '%s' "${name}" | sed -nE 's/^public-(memory-arena|matrix)-codex-[[:alnum:]]+-([0-9]{8}T[0-9]{6}Z)$/\2/p')"
    if [[ -z "${timestamp}" ]]; then
      continue
    fi
    if [[ -z "${latest_timestamp}" || "${timestamp}" > "${latest_timestamp}" ]]; then
      latest_timestamp="${timestamp}"
      latest_name="${name}"
    fi
  done < <(find "${RESULTS_ROOT}" -maxdepth 1 -type d \( -name 'public-memory-arena-codex-*' -o -name 'public-matrix-codex-*' \) -print 2>/dev/null)
  printf '%s\n' "${latest_name}"
}
