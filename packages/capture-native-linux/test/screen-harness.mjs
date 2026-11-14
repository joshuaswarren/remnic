import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Fake hyprctl, python3 (the AT-SPI reader), grim and tesseract. Every fake logs its argv, so a test can prove
// which window the helper asked about and which it never touched.

const LOGGING = (name, body) => `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FAKE_DIR/${name}.log"\n${body}\n`;

const TOOLS = {
  hyprctl: LOGGING(
    "hyprctl",
    `case "$*" in
  "-j activewindow") /bin/cat "$FAKE_DIR/active.json" ;;
  "-j clients") /bin/cat "$FAKE_DIR/clients.json" ;;
  "-j monitors") /bin/cat "$FAKE_DIR/monitors.json" ;;
  *) echo "unexpected hyprctl $*" >&2; exit 9 ;;
esac`,
  ),
  python3: LOGGING("python3", `/bin/cat "$FAKE_DIR/atspi.json"; exit "$(/bin/cat "$FAKE_DIR/atspi.exit")"`),
  grim: LOGGING("grim", `printf 'PNG'`),
  tesseract: LOGGING("tesseract", `/bin/cat > /dev/null; /bin/cat "$FAKE_DIR/ocr.txt"`),
};

/** One fake desktop. `without` lists tools that must be missing from PATH. */
export function fakeDesktop({ active = {}, clients = [], monitors, atspi = { found: false }, atspiExit = 0, ocrText = "", without = [] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "remnic-linux-screen-"));
  const put = (name, text) => writeFileSync(path.join(dir, name), JSON.stringify(text));
  const putRaw = (name, text) => writeFileSync(path.join(dir, name), text);
  put("active.json", active);
  put("clients.json", clients);
  put("monitors.json", monitors ?? [{ id: 0, activeWorkspace: { id: 1 }, specialWorkspace: { id: 0 } }]);
  put("atspi.json", atspi);
  putRaw("atspi.exit", String(atspiExit));
  putRaw("ocr.txt", ocrText);
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  for (const [name, script] of Object.entries(TOOLS)) {
    if (without.includes(name)) continue;
    writeFileSync(path.join(bin, name), script);
    chmodSync(path.join(bin, name), 0o755);
  }
  const calls = (name) => {
    try {
      return readFileSync(path.join(dir, `${name}.log`), "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  return { dir, env: { PATH: bin, FAKE_DIR: dir }, calls };
}

export const WORKSPACE_1 = { id: 1, name: "1" };

export function client(overrides = {}) {
  return {
    address: "0xa1",
    mapped: true,
    hidden: false,
    at: [100, 80],
    size: [800, 600],
    workspace: WORKSPACE_1,
    class: "org.example.editor",
    title: "Notes - Editor",
    pid: 4242,
    ...overrides,
  };
}
