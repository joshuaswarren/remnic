import os from "node:os";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { loadBenchResultSummaries } from "./src/results.js";

export function resolveResultsDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir(),
): string {
  const configuredDir = env.REMNIC_BENCH_RESULTS_DIR;
  if (configuredDir && configuredDir.trim().length > 0) {
    return path.resolve(expandTilde(configuredDir.trim(), homeDir));
  }

  return path.join(homeDir, ".remnic", "bench", "results");
}

function expandTilde(value: string, homeDir: string): string {
  if (value === "~") {
    return homeDir;
  }
  if (value.startsWith("~/")) {
    return path.join(homeDir, value.slice(2));
  }
  return value;
}

type BenchResultsRequest = { method?: string | undefined };
type BenchResultsResponse = {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body: string): void;
};
type MiddlewareServer = {
  middlewares: {
    use(
      route: string,
      handler: (req: BenchResultsRequest, res: BenchResultsResponse) => Promise<void>,
    ): void;
  };
};

export function createBenchResultsHandler(
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir(),
) {
  return async (req: BenchResultsRequest, res: BenchResultsResponse): Promise<void> => {
    if ((req.method ?? "GET") !== "GET") {
      res.statusCode = 405;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    try {
      const payload = await loadBenchResultSummaries(resolveResultsDir(env, homeDir));
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(payload));
    } catch (error) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };
}

function registerBenchResultsApi(server: MiddlewareServer): void {
  server.middlewares.use("/api/results", createBenchResultsHandler());
}

async function writeStaticBenchResultsApi(outDir: string): Promise<void> {
  const payload = await loadBenchResultSummaries(resolveResultsDir());
  const apiDir = path.join(outDir, "api");
  await mkdir(apiDir, { recursive: true });
  await writeFile(path.join(apiDir, "results"), JSON.stringify(payload), "utf8");
}

export function benchResultsApi() {
  return {
    name: "remnic-bench-results-api",
    configureServer(server: MiddlewareServer) {
      registerBenchResultsApi(server);
    },
    configurePreviewServer(server: MiddlewareServer) {
      registerBenchResultsApi(server);
    },
    async writeBundle(options: { dir?: string; file?: string }) {
      const outDir = options.dir ?? path.dirname(options.file ?? path.resolve("dist/index.html"));
      await writeStaticBenchResultsApi(outDir);
    },
  };
}

export default defineConfig({
  plugins: [react(), benchResultsApi()],
});
