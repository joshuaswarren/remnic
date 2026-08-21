/**
 * Deterministic first-pass timeline classification (issue #2049).
 *
 * Signal-only: application name, browser domain, and window-title keywords.
 * No LLM, no scoring, no intent inference — an app/window match says what was
 * on screen, never that the user meant it. First matching rule (in declared
 * order: domain, then app, then title) wins; no match stays visible in the
 * reserved `system.unknown` category with confidence 0.
 */

import type { TimelineCategory, TimelineObservation } from "./types.js";
import { TIMELINE_RESERVED_UNKNOWN } from "./categories.js";

const DOMAIN_CONFIDENCE = 0.85;
const APP_CONFIDENCE = 0.9;
const TITLE_CONFIDENCE = 0.7;
const UNKNOWN_CONFIDENCE = 0;

interface ClassificationRule {
  categoryId: string;
  /** Substring matches against the browser URL host (most specific signal). */
  domains?: readonly string[];
  /** Substring matches against the application name. */
  apps?: readonly string[];
  /** Substring matches against the window title (weakest signal). */
  titles?: readonly string[];
}

/**
 * Ordered rules. Domain rules come first (a browser on github.com is
 * development even though the app is Chrome), then app rules, then title
 * keywords. Order is part of the contract: inserting a rule changes only
 * classifications below it.
 */
const RULES: readonly ClassificationRule[] = [
  { categoryId: "development", domains: ["github.com", "gitlab.com", "stackoverflow.com", "linear.app", "atlassian.net"] },
  { categoryId: "communication", domains: ["mail.google.com", "gmail.com", "outlook.com", "outlook.office.com", "slack.com"] },
  { categoryId: "design", domains: ["figma.com", "canva.com"] },
  { categoryId: "documents", domains: ["docs.google.com", "notion.so", "dropbox.com"] },
  { categoryId: "entertainment", domains: ["youtube.com", "netflix.com", "spotify.com"] },
  { categoryId: "data", domains: ["metabase", "tableau", "grafana"] },

  { categoryId: "development", apps: ["code", "cursor", "neovim", "vim", "emacs", "xcode", "intellij", "terminal", "iterm", "warp", "wezterm", "kitty", "alacritty", "zed", "sublime", "datagrip"] },
  { categoryId: "communication", apps: ["slack", "discord", "teams", "mail", "outlook", "thunderbird", "messages", "signal", "whatsapp", "telegram", "zoom", "facetime", "meet"] },
  { categoryId: "design", apps: ["figma", "sketch", "photoshop", "illustrator", "indesign", "premiere", "after effects", "davinci", "blender", "ableton", "logic pro", "final cut"] },
  { categoryId: "documents", apps: ["word", "pages", "notion", "obsidian", "notes", "typora", "bear", "preview", "acrobat"] },
  { categoryId: "data", apps: ["excel", "numbers", "sheets", "tableau"] },
  { categoryId: "admin", apps: ["finder", "settings", "system preferences", "activity monitor", "files", "explorer"] },
  { categoryId: "entertainment", apps: ["spotify", "music", "youtube", "vlc", "quicktime", "steam", "netflix", "podcast", "tv"] },
  { categoryId: "browsing", apps: ["chrome", "safari", "firefox", "edge", "arc", "brave", "browser"] },

  { categoryId: "development", titles: ["pull request", "merge conflict", "terminal —", "repository"] },
  { categoryId: "communication", titles: ["inbox"] },
  { categoryId: "data", titles: ["spreadsheet", "pivot table"] },
];

export interface TimelineClassification {
  categoryId: string;
  confidence: number;
}

/**
 * Classify one observation. Throws if a rule targets a category missing from
 * the registry (configuration error must fail loudly, not fall back silently).
 */
export function classifyTimelineObservation(
  observation: Pick<TimelineObservation, "app" | "windowTitle" | "browserUrl">,
  categories: readonly TimelineCategory[],
): TimelineClassification {
  const app = observation.app.toLowerCase();
  const title = observation.windowTitle.toLowerCase();
  const domain = observation.browserUrl === undefined ? "" : hostOf(observation.browserUrl);
  for (const rule of RULES) {
    if (rule.domains !== undefined && domain !== "" && rule.domains.some((pattern) => domain.includes(pattern))) {
      return checkedRule(rule, DOMAIN_CONFIDENCE, categories);
    }
  }
  for (const rule of RULES) {
    if (rule.apps !== undefined && rule.apps.some((pattern) => app.includes(pattern))) {
      return checkedRule(rule, APP_CONFIDENCE, categories);
    }
  }
  for (const rule of RULES) {
    if (rule.titles !== undefined && rule.titles.some((pattern) => title.includes(pattern))) {
      return checkedRule(rule, TITLE_CONFIDENCE, categories);
    }
  }
  return { categoryId: TIMELINE_RESERVED_UNKNOWN, confidence: UNKNOWN_CONFIDENCE };
}

/** Verify the rule's target exists in the registry before returning it. */
function checkedRule(
  rule: ClassificationRule,
  confidence: number,
  categories: readonly TimelineCategory[],
): TimelineClassification {
  if (!categories.some((category) => category.id === rule.categoryId)) {
    throw new RangeError(`timeline classification rule targets unknown category: ${rule.categoryId}`);
  }
  return { categoryId: rule.categoryId, confidence };
}

/** Lowercased hostname of a URL, or "" when unparseable (never throws). */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}
