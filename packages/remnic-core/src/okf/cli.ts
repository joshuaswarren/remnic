import { lintOkfDir } from "./lint.js";
import { runOkfConformanceSweep } from "./sweep.js";

export async function runOkfCliCommand(
  argv: string[],
  io: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
  ctx: { memoryDir: string; conformanceEnabled: boolean; sweepEnabled: boolean },
): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand !== "lint" && subcommand !== "sweep") {
    io.stderr.write("okf: expected lint or sweep\n");
    return 1;
  }
  const jsonIndex = rest.indexOf("--json");
  if (jsonIndex !== -1 && rest[jsonIndex + 1] === undefined && rest.includes("--json") && rest.some((t) => t.startsWith("--json="))) {
    // keep --json as a boolean flag; value-taking flags are rejected below
  }
  for (const token of rest) {
    if (token === "--json") continue;
    if (token.startsWith("--") && !token.includes("=") && rest[rest.indexOf(token) + 1] === undefined) {
      io.stderr.write(`okf: ${token} expects a value\n`);
      return 1;
    }
  }
  const json = rest.includes("--json");
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
