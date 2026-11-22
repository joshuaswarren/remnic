/**
 * @remnic/core — Onboarding
 *
 * Detects project language, shape, and documentation to produce
 * an onboarding plan for memory ingestion.
 */

import fs from "node:fs";
import path from "node:path";


export interface OnboardOptions {
  /** Directory to scan (defaults to cwd) */
  directory?: string;
  /** Max depth to walk (default: 6) */
  maxDepth?: number;
  excludeDirs?: string[];
}

export interface LanguageInfo {
  /** Language name (e.g. "TypeScript", "Python") */
  language: string;
  /** Confidence in detection (0-1) */
  confidence: number;
  /** Evidence (e.g. ["package.json", "tsconfig.json", "*.ts files"]) */
  evidence: string[];
}

export interface DocFile {
  path: string;
  relativePath: string;
  kind: "readme" | "changelog" | "contributing" | "license" | "config" | "docs" | "other";
  /** File size in bytes */
  size: number;
}

export type ProjectShape = "app" | "library" | "monorepo" | "workspace" | "script" | "unknown";

export interface OnboardResult {
  directory: string;
  /** Detected languages (sorted by confidence) */
  languages: LanguageInfo[];
  shape: ProjectShape;
  shapeEvidence: string[];
  docs: DocFile[];
  totalFiles: number;
  /** Duration in ms */
  durationMs: number;
  plan: IngestionPlan;
}

export interface IngestionPlan {
  priorityFiles: DocFile[];
  estimatedFiles: number;
  categories: string[];
  suggestedNamespace: string;
}


interface LanguageRule {
  language: string;
  extensions: string[];
  manifests: string[];
  configFiles: string[];
}

const LANGUAGE_RULES: LanguageRule[] = [
  {
    language: "TypeScript",
    extensions: [".ts", ".tsx"],
    manifests: [],
    configFiles: ["tsconfig.json", "tsup.config.ts"],
  },
  {
    language: "JavaScript",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    manifests: [],
    configFiles: [".eslintrc", ".prettierrc"],
  },
  {
    language: "Python",
    extensions: [".py", ".pyi"],
    manifests: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"],
    configFiles: ["mypy.ini", ".flake8", "tox.ini"],
  },
  {
    language: "Go",
    extensions: [".go"],
    manifests: ["go.mod", "go.sum"],
    configFiles: [],
  },
  {
    language: "Rust",
    extensions: [".rs"],
    manifests: ["Cargo.toml"],
    configFiles: [],
  },
  {
    language: "Ruby",
    extensions: [".rb"],
    manifests: ["Gemfile", "*.gemspec"],
    configFiles: [".rubocop.yml"],
  },
  {
    language: "PHP",
    extensions: [".php"],
    manifests: ["composer.json"],
    configFiles: ["phpcs.xml"],
  },
  {
    language: "Java",
    extensions: [".java", ".kt"],
    manifests: ["pom.xml", "build.gradle", "build.gradle.kts"],
    configFiles: [],
  },
  {
    language: "Swift",
    extensions: [".swift"],
    manifests: ["Package.swift", "Podfile"],
    configFiles: [],
  },
  {
    language: "C#",
    extensions: [".cs"],
    manifests: ["*.csproj", "*.sln"],
    configFiles: [],
  },
  {
    language: "Shell",
    extensions: [".sh", ".bash", ".zsh"],
    manifests: [],
    configFiles: [],
  },
  {
    language: "Dart",
    extensions: [".dart"],
    manifests: ["pubspec.yaml"],
    configFiles: [],
  },
  {
    language: "Elixir",
    extensions: [".ex", ".exs"],
    manifests: ["mix.exs"],
    configFiles: [],
  },
];

const DEFAULT_EXCLUDE = new Set([
  "node_modules",
  ".git",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "target",
  "coverage",
  ".engram",
]);


export function onboard(options: OnboardOptions): OnboardResult {
  const startTime = Date.now();
  const {
    maxDepth = 6,
    excludeDirs = [],
  } = options;
  const directory = path.resolve(options.directory ?? process.cwd());
  let rootStat: fs.Stats;
  try {
    rootStat = fs.statSync(directory);
  } catch (err) {
    throw new Error(`Cannot scan onboarding directory ${directory}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`Cannot scan onboarding directory ${directory}: not a directory`);
  }

  const exclude = new Set([...DEFAULT_EXCLUDE, ...excludeDirs]);

  const files = walkDir(directory, exclude, maxDepth);

  const languages = detectLanguages(files, directory);

  const { shape, evidence: shapeEvidence } = detectShape(files, directory);

  const docs = discoverDocs(files, directory);

  const plan = buildPlan(languages, shape, docs, directory);

  return {
    directory,
    languages,
    shape,
    shapeEvidence,
    docs,
    totalFiles: files.length,
    durationMs: Date.now() - startTime,
    plan,
  };
}


function walkDir(
  root: string,
  exclude: Set<string>,
  maxDepth: number,
): string[] {
  const results: string[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (depth === 0) {
        throw new Error(`Cannot scan onboarding directory ${root}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    for (const entry of entries) {
      if (exclude.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }

  walk(root, 0);
  return results;
}


function detectLanguages(files: string[], root: string): LanguageInfo[] {
  const results: LanguageInfo[] = [];

  const extCounts = new Map<string, number>();
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (ext) extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
  }

  const rootFiles = new Set(
    files
      .filter((f) => path.dirname(f) === root)
      .map((f) => path.basename(f)),
  );

  for (const rule of LANGUAGE_RULES) {
    const evidence: string[] = [];
    let score = 0;

    let extMatch = 0;
    for (const ext of rule.extensions) {
      const count = extCounts.get(ext) ?? 0;
      if (count > 0) {
        extMatch += count;
        evidence.push(`${ext} files (${count})`);
      }
    }
    score += Math.min(extMatch * 0.05, 0.5);

    for (const manifest of rule.manifests) {
      if (manifest.includes("*")) {
        // Glob pattern — e.g. "*.gemspec" matches files ending with ".gemspec"
        const suffix = manifest.replaceAll(/\*/g, "");
        if ([...rootFiles].some((f) => f.endsWith(suffix))) {
          score += 0.2;
          evidence.push(manifest);
        }
      } else if (rootFiles.has(manifest)) {
        score += 0.2;
        evidence.push(manifest);
      }
    }

    for (const cfg of rule.configFiles) {
      if (rootFiles.has(cfg)) {
        score += 0.1;
        evidence.push(cfg);
      }
    }

    if (score > 0) {
      results.push({
        language: rule.language,
        confidence: Math.min(score, 1),
        evidence,
      });
    }
  }

  return results.sort((a, b) => b.confidence - a.confidence);
}


function detectShape(
  files: string[],
  root: string,
): { shape: ProjectShape; evidence: string[] } {
  const rootFiles = new Set(
    files
      .filter((f) => path.dirname(f) === root)
      .map((f) => path.basename(f)),
  );

  const rootDirs = new Set<string>();
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) rootDirs.add(entry.name);
    }
  } catch {
    // ignore
  }

  const evidence: string[] = [];

  if (rootFiles.has("package.json")) {
    const pkg = readJsonSafe(path.join(root, "package.json"));
    if (pkg?.workspaces) {
      evidence.push("package.json has workspaces");
      return { shape: "monorepo", evidence };
    }
  }

  if (rootDirs.has("packages") || rootDirs.has("libs")) {
    evidence.push("has packages/ or libs/ directory");
    return { shape: "monorepo", evidence };
  }

  if (rootFiles.has("pnpm-workspace.yaml") || rootFiles.has("go.work")) {
    evidence.push("workspace manifest found");
    return { shape: "workspace", evidence };
  }

  const cargoToml = readTomlWorkspace(path.join(root, "Cargo.toml"));
  if (cargoToml) {
    evidence.push("Cargo.toml has workspace");
    return { shape: "workspace", evidence };
  }

  if (rootFiles.has("package.json")) {
    const pkg = readJsonSafe(path.join(root, "package.json"));
    if (pkg?.exports || pkg?.main) {
      if (pkg?.bin) {
        evidence.push("package.json has bin");
        return { shape: "app", evidence };
      }
      evidence.push("package.json has exports/main");
      return { shape: "library", evidence };
    }
  }

  if (
    rootFiles.has("Dockerfile") ||
    rootFiles.has("docker-compose.yml") ||
    rootFiles.has("docker-compose.yaml") ||
    rootDirs.has("app") ||
    rootDirs.has("src") && rootDirs.has("public")
  ) {
    evidence.push("app-like structure detected");
    return { shape: "app", evidence };
  }

  if (files.length <= 5 && !rootFiles.has("package.json") && !rootFiles.has("pyproject.toml")) {
    evidence.push("few files, no manifest");
    return { shape: "script", evidence };
  }

  return { shape: "unknown", evidence: ["no strong shape signal"] };
}


function discoverDocs(files: string[], root: string): DocFile[] {
  const docs: DocFile[] = [];
  const docPatterns: Array<{ pattern: RegExp; kind: DocFile["kind"] }> = [
    { pattern: /^readme(\.\w+)?$/i, kind: "readme" },
    { pattern: /^changelog(\.\w+)?$/i, kind: "changelog" },
    { pattern: /^changes(\.\w+)?$/i, kind: "changelog" },
    { pattern: /^contributing(\.\w+)?$/i, kind: "contributing" },
    { pattern: /^code[_-]of[_-]conduct(\.\w+)?$/i, kind: "contributing" },
    { pattern: /^license(\.\w+)?$/i, kind: "license" },
    { pattern: /^copying(\.\w+)?$/i, kind: "license" },
    { pattern: /^\.env\.example$/i, kind: "config" },
    { pattern: /^\.editorconfig$/i, kind: "config" },
  ];

  for (const filePath of files) {
    const basename = path.basename(filePath).toLowerCase();
    const relPath = path.relative(root, filePath);
    let kind: DocFile["kind"] | undefined;

    for (const { pattern, kind: k } of docPatterns) {
      if (pattern.test(basename)) {
        kind = k;
        break;
      }
    }

    if (!kind && isUnderDocsDir(relPath)) {
      kind = "docs";
    }

    if (!kind && (basename.endsWith(".md") || basename.endsWith(".mdx"))) {
      if (path.dirname(relPath) === "." || isUnderDocsDir(relPath)) {
        kind = "docs";
      }
    }

    if (kind) {
      let size = 0;
      try {
        size = fs.statSync(filePath).size;
      } catch {
        // ignore
      }
      docs.push({
        path: filePath,
        relativePath: relPath,
        kind,
        size,
      });
    }
  }

  return docs;
}

function isUnderDocsDir(relPath: string): boolean {
  const parts = relPath.split(path.sep);
  return parts[0] === "docs" || parts[0] === "doc" || parts[0] === "documentation";
}


function buildPlan(
  languages: LanguageInfo[],
  shape: ProjectShape,
  docs: DocFile[],
  _root: string,
): IngestionPlan {
  const priorityOrder: Record<DocFile["kind"], number> = {
    readme: 0,
    contributing: 1,
    changelog: 2,
    license: 3,
    docs: 4,
    config: 5,
    other: 6,
  };

  const priorityFiles = [...docs]
    .filter((d) => d.size > 0)
    .sort((a, b) => priorityOrder[a.kind] - priorityOrder[b.kind]);

  const categories: string[] = ["fact", "preference", "decision", "principle"];
  if (shape === "monorepo" || shape === "workspace") {
    categories.push("entity");
  }

  const suggestedNamespace = languages.length > 0
    ? languages[0].language.toLowerCase()
    : "project";

  return {
    priorityFiles,
    estimatedFiles: docs.filter((d) => d.size > 0).length,
    categories,
    suggestedNamespace,
  };
}


function readJsonSafe(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readTomlWorkspace(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return content.includes("[workspace]");
  } catch {
    return false;
  }
}
