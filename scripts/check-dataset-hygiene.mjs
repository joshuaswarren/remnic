#!/usr/bin/env node
/**
 * Dataset hygiene scanner for remnic synthetic data and benchmark fixtures.
 *
 * Scans directories recursively for potential leaks or non-hygienic content:
 * - Email addresses (outside synthetic example domains .example, .synthetic, .test, .invalid, .localhost)
 * - API-key shapes (sk-*, ghp_*, AKIA*)
 * - Phone numbers (conservative 3-3-4 grouping)
 * - IPv4 addresses (outside loopback 127.0.0.0/8 and TEST-NET-1 192.0.2.0/24)
 * - URLs outside allowlist (example.com, arxiv.org, github.com/joshuaswarren/remnic paths)
 * - Names listed in scripts/dataset-name-denylist.txt (case-insensitive whole-word match)
 *
 * Test seam / configuration:
 * - REMNIC_HYGIENE_ROOTS: colon-separated list of directories/files to scan (default: packages/bench/src/fixtures, docs/research/data)
 * - REMNIC_HYGIENE_DENYLIST: path to denylist file (default: scripts/dataset-name-denylist.txt)
 */

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.REMNIC_ROOT
  ? path.resolve(process.env.REMNIC_ROOT)
  : path.resolve(SCRIPT_DIR, "..");

const ALLOWED_EXTENSIONS = new Set([
  ".json",
  ".jsonl",
  ".md",
  ".txt",
  ".ts",
  ".yaml",
  ".yml",
  ".csv",
]);

// URL host checking is restricted to data files (.json, .jsonl, .md, .txt, .yaml, .yml, .csv) and skips .ts source files to avoid false-positives on TypeScript import specifiers, mock servers, and internal test harness endpoints.
const DATA_FILE_EXTENSIONS = new Set([
  ".json",
  ".jsonl",
  ".md",
  ".txt",
  ".yaml",
  ".yml",
  ".csv",
]);

// Regex matching URL shapes
const URL_REGEX = /\bhttps?:\/\/[^\s"'<>()]+/gi;

// Email addresses: Standard regex. Synthetic example domains (.example, .synthetic, .test, .invalid, .localhost per RFC 2606 / bench conventions) are permitted in test datasets.
const EMAIL_REGEX = /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g;
// Phone numbers: Conservative pattern requiring 3-3-4 digit grouping with optional leading plus and standard delimiters to avoid false-positives on timestamps, hashes, or numeric IDs.
const PHONE_REGEX = /\b\+?\d{3}[-. ]\d{3}[-. ]\d{4}\b/;

// API-key shapes
const API_KEY_REGEXES = [
  /sk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{36}/,
  /AKIA[A-Z0-9]{16}/,
];
const CREDENTIAL_QUERY_PARAMETERS = new Set([
  "access_token",
  "api_key",
  "apikey",
  "credential",
  "credentials",
  "key",
  "password",
  "secret",
  "token",
  "authorization",
  "auth",
  "client_secret",
  "private_key",
  "signature",
  "sig",
]);


function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function loadDenylist(denylistPath) {
  if (!existsSync(denylistPath)) {
    return [];
  }
  const content = readFileSync(denylistPath, "utf8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

export function isSyntheticEmail(email) {
  const atIdx = email.indexOf("@");
  if (atIdx === -1) return false;
  const domain = email.slice(atIdx + 1).toLowerCase();
  return (
    domain === "example" ||
    domain === "synthetic" ||
    domain.endsWith(".example") ||
    domain.endsWith(".synthetic") ||
    domain.endsWith(".invalid") ||
    domain.endsWith(".localhost") ||
    domain.endsWith(".test")
  );
}

export function findDisallowedIPv4s(line) {
  const matches = line.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
  const disallowed = [];
  for (const m of matches) {
    const parts = m.split(".");
    if (parts.length !== 4) continue;
    const octets = parts.map(Number);
    if (!octets.every((o, idx) => !isNaN(o) && o >= 0 && o <= 255 && (parts[idx] === "0" || !parts[idx].startsWith("0")))) {
      continue;
    }
    const [a, b, c] = octets;
    const isLoopback = a === 127;
    const isTestNet1 = a === 192 && b === 0 && c === 2;
    if (!isLoopback && !isTestNet1) {
      disallowed.push(m);
    }
  }
  return disallowed;
}

function hasCredentialParameter(parameters) {
  return [...parameters.keys()].some((name) =>
    CREDENTIAL_QUERY_PARAMETERS.has(name.toLowerCase()),
  );
}

function urlContainsCredentials(url) {
  return (
    Boolean(url.username || url.password) ||
    hasCredentialParameter(url.searchParams) ||
    hasCredentialParameter(new URLSearchParams(url.hash.slice(1)))
  );
}

export function checkUrlAllowed(urlStr) {
  try {
    const cleaned = urlStr.replace(/[.,;:>)]+$/, "");
    const parsed = new URL(cleaned);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    if (urlContainsCredentials(parsed)) return false;
    if (
      host === "example.com" ||
      host.endsWith(".example.com") ||
      host === "example" ||
      host.endsWith(".example")
    ) {
      return true;
    }

    if (host === "arxiv.org" || host.endsWith(".arxiv.org")) {
      return true;
    }

    if (host === "github.com") {
      if (
        pathname === "/joshuaswarren/remnic" ||
        pathname.startsWith("/joshuaswarren/remnic/")
      ) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

export function stripAllowlistedUrls(line) {
  return line.replace(URL_REGEX, (urlMatch) => {
    if (checkUrlAllowed(urlMatch)) {
      return " ";
    }
    return urlMatch;
  });
}

export function collectFiles(targetPath, fileList = [], rootPath = targetPath) {
  let lstat;
  try {
    lstat = lstatSync(targetPath);
  } catch {
    return fileList;
  }

  if (lstat.isSymbolicLink()) {
    if (path.resolve(targetPath) === path.resolve(rootPath)) {
      console.error(`Error: Configured root directory is a symlink: "${targetPath}"`);
      process.exit(1);
    }
    console.error(`[symlink-skipped] Skipping symlink: ${targetPath}`);
    return fileList;
  }

  let resolvedRoot;
  let resolvedTarget;
  try {
    resolvedRoot = realpathSync(rootPath);
    resolvedTarget = realpathSync(targetPath);
  } catch {
    return fileList;
  }

  if (
    resolvedTarget !== resolvedRoot &&
    !resolvedTarget.startsWith(resolvedRoot + path.sep)
  ) {
    console.error(`[symlink-skipped] Skipping path outside allowed root: ${targetPath}`);
    return fileList;
  }

  const stat = statSync(targetPath);
  if (stat.isFile()) {
    const ext = path.extname(targetPath).toLowerCase();
    if (ALLOWED_EXTENSIONS.has(ext)) {
      fileList.push(targetPath);
    }
  } else if (stat.isDirectory()) {
    const entries = readdirSync(targetPath);
    for (const entry of entries) {
      collectFiles(path.join(targetPath, entry), fileList, rootPath);
    }
  }
  return fileList;
}

export function scanFile(filePath, denylist, rootDir = ROOT) {
  const relPath = path.relative(rootDir, filePath) || path.basename(filePath);
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const ext = path.extname(filePath).toLowerCase();
  const isDataFile = DATA_FILE_EXTENSIONS.has(ext);

  const findings = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNum = idx + 1;
    const line = lines[idx];

    // Denylist check (strip allowlisted URLs first)
    const lineForDenylist = stripAllowlistedUrls(line);
    for (const name of denylist) {
      const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, "gi");
      if (re.test(lineForDenylist)) {
        findings.push({
          file: relPath,
          line: lineNum,
          rule: "denylist",
          message: "Denylist name matched (redacted)",
        });
      }
    }
    // Email check
    const emailMatches = line.match(EMAIL_REGEX) || [];
    for (const em of emailMatches) {
      if (!isSyntheticEmail(em)) {
        findings.push({
          file: relPath,
          line: lineNum,
          rule: "email",
          message: `Non-synthetic email address found (${em.length} chars, redacted)`,
        });
      }
    }

    // API key check. Never echo the matched token: CI logs must not disclose credentials.
    for (const apiRe of API_KEY_REGEXES) {
      const match = line.match(apiRe);
      if (match) {
        const token = match[0];
        findings.push({
          file: relPath,
          line: lineNum,
          rule: "api-key",
          message: `API key shape detected (${token.length} chars, redacted)`,
        });
      }
    }

    // Phone number check
    const phoneMatch = line.match(PHONE_REGEX);
    if (phoneMatch) {
      const phoneVal = phoneMatch[0];
      findings.push({
        file: relPath,
        line: lineNum,
        rule: "phone",
        message: `Phone number detected (${phoneVal.length} chars, redacted)`,
      });
    }

    // IPv4 check
    const disallowedIPs = findDisallowedIPv4s(line);
    for (const _ip of disallowedIPs) {
      findings.push({
        file: relPath,
        line: lineNum,
        rule: "ipv4",
        message: "Non-permitted IPv4 address detected (redacted)",
      });
    }

    // URL check (data files only)
    if (isDataFile) {
      const urlMatches = line.match(URL_REGEX) || [];
      for (const rawUrl of urlMatches) {
        if (!checkUrlAllowed(rawUrl)) {
          findings.push({
            file: relPath,
            line: lineNum,
            rule: "url-allowlist",
            message: "URL host outside allowlist (redacted)",
          });
        }
      }
    }
  }

  return findings;
}

export function main() {
  const denylistPath = process.env.REMNIC_HYGIENE_DENYLIST
    ? path.resolve(process.env.REMNIC_HYGIENE_DENYLIST)
    : path.join(ROOT, "scripts/dataset-name-denylist.txt");

  const denylist = loadDenylist(denylistPath);

  const roots = process.env.REMNIC_HYGIENE_ROOTS
    ? process.env.REMNIC_HYGIENE_ROOTS.split(":")
        .map((r) => r.trim())
        .filter(Boolean)
        .map((r) => path.resolve(ROOT, r))
    : [
        path.join(ROOT, "packages/bench/src/fixtures"),
        path.join(ROOT, "docs/research/data"),
      ];

  const filesToScan = new Map();
  for (const rootPath of roots) {
    for (const filePath of collectFiles(rootPath)) {
      if (!filesToScan.has(filePath)) filesToScan.set(filePath, rootPath);
    }
  }

  const allFindings = [];
  for (const [filePath, rootPath] of filesToScan) {
    const fileFindings = scanFile(filePath, denylist, rootPath);
    allFindings.push(...fileFindings);
  }

  allFindings.sort((a, b) => {
    const fileCmp = a.file.localeCompare(b.file);
    if (fileCmp !== 0) return fileCmp;
    if (a.line !== b.line) return a.line - b.line;
    return a.rule.localeCompare(b.rule);
  });

  if (allFindings.length > 0) {
    for (const f of allFindings) {
      console.error(`${f.file}:${f.line}: [${f.rule}] ${f.message}`);
    }
    process.exit(1);
  } else {
    console.log(
      `Dataset hygiene check passed: ${filesToScan.size} files scanned across ${roots.length} target root(s), 0 findings.`
    );
    process.exit(0);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main();
}
