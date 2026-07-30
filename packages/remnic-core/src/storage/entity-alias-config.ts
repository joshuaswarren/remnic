import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import { isErrnoCode } from "../utils/errno.js";
import { assertPathInsideRoot } from "../utils/path-containment.js";

function resolveSafeAliasRoots(baseDir: string, configDir: string): string | undefined {
  let baseStat;
  try {
    baseStat = lstatSync(baseDir);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return undefined;
    throw error;
  }
  if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) {
    throw new Error(`Refusing unsafe entity alias memory root: ${baseDir}.`);
  }

  let configStat;
  try {
    configStat = lstatSync(configDir);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return undefined;
    throw error;
  }
  if (configStat.isSymbolicLink() || !configStat.isDirectory()) {
    throw new Error(`Refusing unsafe entity alias config root: ${configDir}.`);
  }

  const memoryRoot = realpathSync(baseDir);
  assertPathInsideRoot(memoryRoot, realpathSync(configDir), configDir);
  return memoryRoot;
}

export function readEntityAliasConfigSync(baseDir: string): string | undefined {
  const configDir = path.join(baseDir, "config");
  const aliasPath = path.join(configDir, "aliases.json");
  let memoryRoot = resolveSafeAliasRoots(baseDir, configDir);
  if (memoryRoot === undefined) return undefined;

  let aliasPreflight;
  try {
    aliasPreflight = lstatSync(aliasPath);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return undefined;
    throw error;
  }
  if (aliasPreflight.isSymbolicLink() || !aliasPreflight.isFile()) {
    throw new Error(`Refusing unsafe entity alias config file: ${aliasPath}.`);
  }

  let fd: number;
  try {
    fd = openSync(
      aliasPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      resolveSafeAliasRoots(baseDir, configDir);
      return undefined;
    }
    if (isErrnoCode(error, "ELOOP")) {
      throw new Error(`Refusing unsafe entity alias config file: ${aliasPath}.`);
    }
    throw error;
  }
  try {
    const opened = fstatSync(fd);
    memoryRoot = resolveSafeAliasRoots(baseDir, configDir);
    if (memoryRoot === undefined) {
      throw new Error(`Refusing unsafe entity alias config root: ${configDir}.`);
    }
    const aliasStat = lstatSync(aliasPath);
    if (
      !opened.isFile() ||
      aliasStat.isSymbolicLink() ||
      !aliasStat.isFile() ||
      aliasStat.dev !== opened.dev ||
      aliasStat.ino !== opened.ino
    ) {
      throw new Error(`Refusing unsafe entity alias config file: ${aliasPath}.`);
    }
    assertPathInsideRoot(memoryRoot, realpathSync(aliasPath), aliasPath);
    return readFileSync(fd, "utf-8");
  } finally {
    closeSync(fd);
  }
}
