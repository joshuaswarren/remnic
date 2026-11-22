
import { isSpecifierNotFoundError } from "./optional-module-loader.js";

type WecloneExportModule = typeof import("@remnic/export-weclone");

const SPECIFIER = "@remnic/" + "export-weclone";

let cached: WecloneExportModule | null | undefined;

async function tryImportWecloneExport(): Promise<WecloneExportModule | null> {
  try {
    return (await import(SPECIFIER)) as WecloneExportModule;
  } catch (err) {
    if (isSpecifierNotFoundError(err, SPECIFIER)) {
      return null;
    }
    throw err;
  }
}

export async function loadWecloneExportModule(): Promise<WecloneExportModule> {
  if (cached === undefined) {
    cached = await tryImportWecloneExport();
  }
  if (!cached) {
    throw new Error(
      "The weclone training-export adapter requires the optional @remnic/export-weclone package.\n" +
        "\n" +
        "Install it alongside the CLI:\n" +
        "  npm install -g @remnic/export-weclone\n" +
        "\n" +
        "Or add it to a project:\n" +
        "  pnpm add @remnic/export-weclone\n",
    );
  }
  return cached;
}
