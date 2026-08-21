import { lintOkfDir } from "./lint.js";
import { runOkfConformanceSweep } from "./sweep.js";
import { runOkfIndexMaintenance } from "./index-files.js";

export async function runOkfCliCommand(
  argv: string[],
  io: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
  ctx: {
    memoryDir: string;
    conformanceEnabled: boolean;
    sweepEnabled: boolean;
    indexFilesEnabled: boolean;
  },
): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    io.stdout.write(`usage: remnic okf <lint|sweep|index> [--json]
  lint   report OKF conformance findings (exit 1 when findings remain)
  sweep  backfill missing type values (requires okf.sweepEnabled)
  index  generate or remove index.md files (okf.indexFilesEnabled)
`);
    return 0;
  }
  if (subcommand !== "lint" && subcommand !== "sweep" && subcommand !== "index") {
    io.stderr.write("okf: expected lint, sweep, or index\n");
    return 1;
  }
  for (const token of rest) {
    if (token === "--json") continue;
    io.stderr.write(`okf: unexpected argument '${token}' — usage: remnic okf <lint|sweep|index> [--json]\n`);
    return 1;
  }
  const json = rest.includes("--json");
  if (subcommand === "index") {
    const result = await runOkfIndexMaintenance(ctx.memoryDir, ctx.indexFilesEnabled);
    if (json) io.stdout.write(`${JSON.stringify(result)}\n`);
    else io.stdout.write(`okf index: wrote ${result.written.length}, removed ${result.removed.length}\n`);
    return 0;
  }
  if (subcommand === "sweep") {
    const result = runOkfConformanceSweep(ctx.memoryDir, ctx);
    if (json) io.stdout.write(`${JSON.stringify(result)}\n`);
    else io.stdout.write(`okf sweep: scanned ${result.scanned}, wrote ${result.written}\n`);
    return 0;
  }
  const result = lintOkfDir(ctx.memoryDir);
  if (json) io.stdout.write(`${JSON.stringify(result)}\n`);
  else {
    io.stdout.write(`okf lint: scanned ${result.scanned}, findings ${result.findings.length}\n`);
    for (const finding of result.findings) {
      io.stdout.write(`  ${finding.file}: ${finding.message}\n`);
    }
  }
  return result.ok ? 0 : 1;
}
