/**
 * Synthetic token pools for the MemCorrect corpus generator (issue #1584).
 *
 * Shared between `generator.ts` (draws from the pools) and `schema.ts`
 * (asserts every fact token originates from a pool — the no-PII-by-
 * construction guarantee). None of these are real people, products, or
 * places; they are deliberately generic tokens.
 */

export const PERSONAS = [
  "Avery",
  "Blair",
  "Cassidy",
  "Dakota",
  "Emerson",
  "Finley",
  "Harper",
  "Jordan",
  "Kendall",
  "Logan",
] as const;

export const SUBJECTS = [
  "coffee",
  "editor",
  "database",
  "calendar",
  "standup",
  "deploy",
  "notebook",
  "keyboard",
] as const;

export const VALUES_A = [
  "oat-milk",
  "helix",
  "postgres",
  "monday",
  "nine-am",
  "blue-green",
  "dotgrid",
  "mechanical",
] as const;

export const VALUES_B = [
  "black-coffee",
  "neovim",
  "mysql",
  "wednesday",
  "ten-am",
  "canary",
  "lined",
  "membrane",
] as const;
