const tokenKey = "remnic.adminConsole.token";
const legacyTokenKey = "engram.adminConsole.token";

// One-time migration: copy any pre-existing token from the legacy
// `engram.adminConsole.token` key over to the new `remnic.*` key so
// existing operators are not logged out by the rename. Runs once on
// load; the legacy key is removed only after the new key is written.
function migrateLegacyToken() {
  try {
    const storage = window.sessionStorage;
    if (!storage) return;
    const current = storage.getItem(tokenKey);
    if (current) return;
    const legacy = storage.getItem(legacyTokenKey);
    if (!legacy) return;
    storage.setItem(tokenKey, legacy);
    storage.removeItem(legacyTokenKey);
  } catch {
    // sessionStorage can throw in private/sandboxed contexts; ignore.
  }
}
migrateLegacyToken();
const browserState = {
  sort: "updated_desc",
  limit: 25,
  offset: 0,
  total: 0,
};
const trustZoneState = {
  limit: 12,
  offset: 0,
  total: 0,
};

function $(id) {
  return document.getElementById(id);
}

function readToken() {
  return window.sessionStorage.getItem(tokenKey) || "";
}

function writeToken(token) {
  if (token) {
    window.sessionStorage.setItem(tokenKey, token);
  } else {
    window.sessionStorage.removeItem(tokenKey);
  }
}

function setStatus(id, message, tone = "default") {
  const el = $(id);
  if (!el) return;
  el.textContent = message;
  el.className = tone === "default" ? "status" : `status ${tone}`;
}

function clearChildren(el) {
  if (!el) return;
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

function appendPill(container, value) {
  if (!container || !value) return;
  const pill = document.createElement("span");
  pill.className = "pill";
  pill.textContent = value;
  container.appendChild(pill);
}

function renderEmptyState(container, message) {
  clearChildren(container);
  if (!container) return;
  const item = document.createElement("div");
  item.className = "item";
  const strong = document.createElement("strong");
  strong.textContent = message;
  item.appendChild(strong);
  container.appendChild(item);
}

function createItem() {
  const article = document.createElement("article");
  article.className = "item";
  return article;
}

async function fetchJson(url, options = {}) {
  const token = readToken();
  const headers = new Headers(options.headers || {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(url, { ...options, headers });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

function syncBrowserControls() {
  const prevButton = $("memoryPrevButton");
  const nextButton = $("memoryNextButton");
  if (prevButton) prevButton.disabled = browserState.offset <= 0;
  if (nextButton) nextButton.disabled = browserState.offset + browserState.limit >= browserState.total;

  const pageStatus = $("memoryPageStatus");
  if (!pageStatus) return;
  if (browserState.total === 0) {
    pageStatus.textContent = "No results";
    return;
  }
  const pageOffset = Math.min(
    browserState.offset,
    Math.max(0, browserState.total - 1),
  );
  const start = pageOffset + 1;
  const end = Math.min(pageOffset + browserState.limit, browserState.total);
  pageStatus.textContent = `${start}-${end} of ${browserState.total}`;
}

function readMemoryPageSize() {
  return Number.parseInt($("memoryPageSize")?.value || String(browserState.limit || 25), 10) || 25;
}

function readTrustZonePageSize() {
  return Number.parseInt($("trustZonePageSize")?.value || String(trustZoneState.limit || 12), 10) || 12;
}

function stepMemoryPage(direction) {
  const pageSize = readMemoryPageSize();
  browserState.limit = pageSize;
  browserState.offset = Math.max(0, browserState.offset + direction * pageSize);
}

function syncTrustZoneControls() {
  const prevButton = $("trustZonePrevButton");
  const nextButton = $("trustZoneNextButton");
  if (prevButton) prevButton.disabled = trustZoneState.offset <= 0;
  if (nextButton) nextButton.disabled = trustZoneState.offset + trustZoneState.limit >= trustZoneState.total;

  const pageStatus = $("trustZonePageStatus");
  if (!pageStatus) return;
  if (trustZoneState.total === 0) {
    pageStatus.textContent = "No results";
    return;
  }
  const pageOffset = Math.min(
    trustZoneState.offset,
    Math.max(0, trustZoneState.total - 1),
  );
  const start = pageOffset + 1;
  const end = Math.min(pageOffset + trustZoneState.limit, trustZoneState.total);
  pageStatus.textContent = `${start}-${end} of ${trustZoneState.total}`;
}

function stepTrustZonePage(direction) {
  const pageSize = readTrustZonePageSize();
  trustZoneState.limit = pageSize;
  trustZoneState.offset = Math.max(0, trustZoneState.offset + direction * pageSize);
}

function renderMemoryList(memories) {
  const list = $("memoryList");
  if (!list) return;
  if (!Array.isArray(memories) || memories.length === 0) {
    renderEmptyState(list, "No memories matched.");
    return;
  }
  clearChildren(list);
  memories.forEach((memory) => {
    const article = createItem();
    const meta = document.createElement("div");
    meta.className = "meta";
    appendPill(meta, memory.category);
    appendPill(meta, memory.status);
    appendPill(meta, memory.entityRef);
    article.appendChild(meta);

    const heading = document.createElement("h3");
    heading.style.marginTop = "10px";
    heading.textContent = memory.id;
    article.appendChild(heading);

    const pathText = document.createElement("div");
    pathText.className = "status";
    pathText.textContent = memory.path;
    article.appendChild(pathText);

    const preview = document.createElement("p");
    preview.textContent = memory.preview;
    article.appendChild(preview);

    const button = document.createElement("button");
    button.className = "memory-open-button";
    button.dataset.memoryId = memory.id;
    button.textContent = "Open Memory";
    button.addEventListener("click", () => void loadMemoryDetail(memory.id));
    article.appendChild(button);

    list.appendChild(article);
  });
}

function renderReviewQueue(response) {
  const list = $("reviewQueueList");
  if (!list) return;
  if (!response?.found || !Array.isArray(response.reviewQueue) || response.reviewQueue.length === 0) {
    renderEmptyState(list, "No review queue entries found.");
    return;
  }
  clearChildren(list);
  response.reviewQueue.forEach((entry) => {
    const article = createItem();
    const meta = document.createElement("div");
    meta.className = "meta";
    appendPill(meta, entry.reasonCode);
    appendPill(meta, entry.severity);
    appendPill(
      meta,
      entry.suggestedAction ? `${entry.suggestedAction}${entry.suggestedStatus ? `:${entry.suggestedStatus}` : ""}` : "",
    );
    article.appendChild(meta);

    const heading = document.createElement("h3");
    heading.style.marginTop = "10px";
    heading.textContent = entry.memoryId;
    article.appendChild(heading);

    const pathText = document.createElement("div");
    pathText.className = "status";
    pathText.textContent = entry.path || "";
    article.appendChild(pathText);

    const toolbar = document.createElement("div");
    toolbar.className = "toolbar";
    toolbar.style.marginTop = "12px";

    const inspectButton = document.createElement("button");
    inspectButton.className = "secondary queue-open-button";
    inspectButton.dataset.memoryId = entry.memoryId;
    inspectButton.textContent = "Inspect";
    inspectButton.addEventListener("click", () => void loadMemoryDetail(entry.memoryId));
    toolbar.appendChild(inspectButton);

    [
      ["accent", "active", "Confirm"],
      ["secondary", "rejected", "Reject"],
      ["warn", "archived", "Archive"],
    ].forEach(([className, nextStatus, label]) => {
      const button = document.createElement("button");
      button.className = `${className} queue-disposition-button`;
      button.dataset.memoryId = entry.memoryId;
      button.dataset.status = nextStatus;
      button.textContent = label;
      button.addEventListener("click", () => void applyDisposition(entry.memoryId, nextStatus));
      toolbar.appendChild(button);
    });

    article.appendChild(toolbar);
    list.appendChild(article);
  });
}

function renderEntityList(entities) {
  const list = $("entityList");
  if (!list) return;
  if (!Array.isArray(entities) || entities.length === 0) {
    renderEmptyState(list, "No entities matched.");
    return;
  }
  clearChildren(list);
  entities.forEach((entity) => {
    const article = createItem();
    const meta = document.createElement("div");
    meta.className = "meta";
    appendPill(meta, entity.type);
    (entity.aliases || []).forEach((alias) => appendPill(meta, alias));
    article.appendChild(meta);

    const heading = document.createElement("h3");
    heading.style.marginTop = "10px";
    heading.textContent = entity.name;
    article.appendChild(heading);

    const summary = document.createElement("div");
    summary.className = "status";
    summary.textContent = entity.summary || "No summary.";
    article.appendChild(summary);

    const button = document.createElement("button");
    button.className = "entity-open-button";
    button.dataset.entityName = entity.name;
    button.textContent = "Open Entity";
    button.addEventListener("click", () => void loadEntityDetail(entity.name));
    article.appendChild(button);

    list.appendChild(article);
  });
}

function renderTrustZoneList(records) {
  const list = $("trustZoneList");
  if (!list) return;
  if (!Array.isArray(records) || records.length === 0) {
    renderEmptyState(list, "No trust-zone records matched.");
    return;
  }
  clearChildren(list);
  records.forEach((record) => {
    const article = createItem();
    const meta = document.createElement("div");
    meta.className = "meta";
    appendPill(meta, record.zone);
    appendPill(meta, record.kind);
    appendPill(meta, record.sourceClass);
    appendPill(meta, record.anchored ? "anchored" : "unanchored");
    if (record.trustScore) {
      appendPill(meta, `trust ${record.trustScore.total} (${record.trustScore.band})`);
    }
    article.appendChild(meta);

    const heading = document.createElement("h3");
    heading.style.marginTop = "10px";
    heading.textContent = record.recordId;
    article.appendChild(heading);

    const pathText = document.createElement("div");
    pathText.className = "status";
    pathText.textContent = `${record.recordedAt} · ${record.filePath}`;
    article.appendChild(pathText);

    const preview = document.createElement("p");
    preview.textContent = record.summary;
    article.appendChild(preview);

    const readiness = document.createElement("div");
    readiness.className = "status";
    if (record.nextPromotionTarget) {
      readiness.textContent = record.nextPromotionAllowed
        ? `Ready for promotion to ${record.nextPromotionTarget}.`
        : `Blocked on ${record.nextPromotionTarget}: ${(record.nextPromotionReasons || []).join("; ") || "operator review required"}`;
    } else {
      readiness.textContent = "No further promotion path.";
    }
    article.appendChild(readiness);

    const toolbar = document.createElement("div");
    toolbar.className = "toolbar";
    toolbar.style.marginTop = "12px";

    const inspectButton = document.createElement("button");
    inspectButton.className = "secondary";
    inspectButton.textContent = "Inspect";
    inspectButton.addEventListener("click", () => {
      $("trustZoneDetail").textContent = JSON.stringify(record, null, 2);
      setStatus("trustZoneDetailStatus", `Loaded ${record.recordId}.`, "ok");
    });
    toolbar.appendChild(inspectButton);

    if (record.nextPromotionTarget) {
      const previewButton = document.createElement("button");
      previewButton.className = "secondary";
      previewButton.textContent = `Preview → ${record.nextPromotionTarget}`;
      previewButton.addEventListener("click", () => void promoteTrustZone(record.recordId, record.nextPromotionTarget, true));
      toolbar.appendChild(previewButton);
    }

    if (record.nextPromotionTarget && record.nextPromotionAllowed) {
      const promoteButton = document.createElement("button");
      promoteButton.className = "accent";
      promoteButton.textContent = `Promote → ${record.nextPromotionTarget}`;
      promoteButton.addEventListener("click", () => void promoteTrustZone(record.recordId, record.nextPromotionTarget, false));
      toolbar.appendChild(promoteButton);
    }

    article.appendChild(toolbar);
    list.appendChild(article);
  });
}

function renderQuality(response) {
  const summary = $("qualitySummary");
  if (!summary) return;
  clearChildren(summary);
  const cards = [
    ["Memories", String(response.totalMemories ?? 0)],
    ["Pending Review", String(response.archivePressure?.pendingReview ?? 0)],
    ["Archived", String(response.archivePressure?.archived ?? 0)],
    ["Quality Score", typeof response.latestGovernanceRun?.qualityScore?.score === "number"
      ? String(response.latestGovernanceRun.qualityScore.score)
      : "n/a"],
  ];
  cards.forEach(([label, value]) => {
    const card = document.createElement("div");
    card.className = "quality-stat";
    const strong = document.createElement("strong");
    strong.textContent = value;
    card.appendChild(strong);
    const caption = document.createElement("div");
    caption.className = "status";
    caption.textContent = label;
    card.appendChild(caption);
    summary.appendChild(card);
  });
  const qualityJson = $("qualityJson");
  if (qualityJson) {
    qualityJson.textContent = JSON.stringify(response, null, 2);
  }
}

async function loadMemoryBrowser(resetOffset = false) {
  if (resetOffset) browserState.offset = 0;
  browserState.sort = $("memorySort")?.value || "updated_desc";
  browserState.limit = readMemoryPageSize();
  setStatus("memoryBrowserStatus", "Loading memory browser...");
  const params = new URLSearchParams();
  const query = $("memoryQuery")?.value?.trim();
  const status = $("memoryStatus")?.value?.trim();
  const category = $("memoryCategory")?.value?.trim();
  if (query) params.set("q", query);
  if (status) params.set("status", status);
  if (category) params.set("category", category);
  params.set("sort", browserState.sort);
  params.set("limit", String(browserState.limit));
  params.set("offset", String(browserState.offset));
  const response = await fetchJson(`/engram/v1/memories?${params.toString()}`);
  browserState.total = response.total || 0;
  const maxOffset = browserState.total > 0
    ? Math.floor((browserState.total - 1) / browserState.limit) * browserState.limit
    : 0;
  if (!resetOffset && browserState.offset > maxOffset) {
    browserState.offset = maxOffset;
    return loadMemoryBrowser(false);
  }
  renderMemoryList(response.memories);
  syncBrowserControls();
  setStatus("memoryBrowserStatus", `Loaded ${response.count} of ${response.total} memories.`, "ok");
}

async function loadMemoryDetail(memoryId) {
  if (!memoryId) return;
  setStatus("memoryDetailStatus", `Loading ${memoryId}...`);
  const [memory, timeline] = await Promise.all([
    fetchJson(`/engram/v1/memories/${encodeURIComponent(memoryId)}`),
    fetchJson(`/engram/v1/memories/${encodeURIComponent(memoryId)}/timeline?limit=50`),
  ]);
  $("memoryContent").textContent = JSON.stringify(memory.memory, null, 2);
  $("memoryTimeline").textContent = JSON.stringify(timeline.timeline, null, 2);
  $("memoryRawPath").value = memory.memory?.path || "";
  const meta = $("memoryDetailMeta");
  clearChildren(meta);
  appendPill(meta, memory.memory.category);
  appendPill(meta, memory.memory.status || "active");
  appendPill(meta, memory.memory.path);
  setStatus("memoryDetailStatus", `Loaded ${memoryId}.`, "ok");
}

async function runRecallDebugger() {
  const query = $("recallQuery")?.value?.trim() || "";
  const sessionKey = $("recallSessionKey")?.value?.trim() || "admin-console";
  setStatus("recallStatus", "Running recall...");
  const recall = await fetchJson("/engram/v1/recall", {
    method: "POST",
    body: JSON.stringify({ query, sessionKey }),
  });
  const explain = await fetchJson("/engram/v1/recall/explain", {
    method: "POST",
    body: JSON.stringify({ sessionKey }),
  });
  $("recallContext").textContent = JSON.stringify(recall, null, 2);
  $("recallExplain").textContent = JSON.stringify(explain, null, 2);
  setStatus("recallStatus", `Recall completed for ${sessionKey}.`, "ok");
}

async function loadReviewQueue() {
  setStatus("reviewQueueStatus", "Loading latest governance review queue...");
  const response = await fetchJson("/engram/v1/review-queue");
  renderReviewQueue(response);
  setStatus(
    "reviewQueueStatus",
    response?.found
      ? `Loaded run ${response.runId} with ${response.reviewQueue.length} queue entries.`
      : "No governance review queue artifacts found.",
    response?.found ? "ok" : "default",
  );
}

async function applyDisposition(memoryId, status) {
  if (!memoryId || !status) return;
  setStatus("reviewQueueStatus", `Applying ${status} to ${memoryId}...`);
  await fetchJson("/engram/v1/review-disposition", {
    method: "POST",
    body: JSON.stringify({
      memoryId,
      status,
      reasonCode: status === "active" ? "operator_confirmed" : "operator_review",
    }),
  });
  await Promise.all([
    loadReviewQueue(),
    loadMemoryBrowser(),
    loadMemoryDetail(memoryId).catch(() => {}),
    loadQuality(),
    loadMaintenance(),
  ]);
  setStatus("reviewQueueStatus", `Applied ${status} to ${memoryId}.`, "ok");
}

async function loadEntities() {
  setStatus("entityStatus", "Loading entities...");
  const params = new URLSearchParams();
  const query = $("entityQuery")?.value?.trim();
  if (query) params.set("q", query);
  const response = await fetchJson(`/engram/v1/entities?${params.toString()}`);
  renderEntityList(response.entities);
  setStatus("entityStatus", `Loaded ${response.count} of ${response.total} entities.`, "ok");
}

async function loadEntityDetail(name) {
  if (!name) return;
  const response = await fetchJson(`/engram/v1/entities/${encodeURIComponent(name)}`);
  $("entityDetail").textContent = JSON.stringify(response.entity, null, 2);
}

async function loadQuality() {
  setStatus("qualityStatus", "Loading quality dashboard...");
  const response = await fetchJson("/engram/v1/quality");
  renderQuality(response);
  setStatus(
    "qualityStatus",
    response.latestGovernanceRun?.found
      ? `Loaded quality summary for ${response.totalMemories} memories and governance run ${response.latestGovernanceRun.runId}.`
      : `Loaded quality summary for ${response.totalMemories} memories.`,
    "ok",
  );
}

async function loadMaintenance() {
  setStatus("maintenanceStatus", "Loading maintenance summary...");
  const response = await fetchJson("/engram/v1/maintenance");
  $("maintenanceJson").textContent = JSON.stringify(response, null, 2);
  setStatus("maintenanceStatus", "Maintenance summary loaded.", "ok");
}

async function loadTrustZones(resetOffset = false) {
  if (resetOffset) trustZoneState.offset = 0;
  trustZoneState.limit = readTrustZonePageSize();
  setStatus("trustZoneStatus", "Loading trust-zone state...");
  const params = new URLSearchParams();
  const query = $("trustZoneQuery")?.value?.trim();
  const zone = $("trustZoneZone")?.value?.trim();
  const sourceClass = $("trustZoneSourceClass")?.value?.trim();
  if (query) params.set("q", query);
  if (zone) params.set("zone", zone);
  if (sourceClass) params.set("sourceClass", sourceClass);
  params.set("limit", String(trustZoneState.limit));
  params.set("offset", String(trustZoneState.offset));

  const [statusResponse, browseResponse] = await Promise.all([
    fetchJson("/engram/v1/trust-zones/status"),
    fetchJson(`/engram/v1/trust-zones/records?${params.toString()}`),
  ]);
  trustZoneState.total = browseResponse.total || 0;
  const maxOffset = trustZoneState.total > 0
    ? Math.floor((trustZoneState.total - 1) / trustZoneState.limit) * trustZoneState.limit
    : 0;
  if (!resetOffset && trustZoneState.offset > maxOffset) {
    trustZoneState.offset = maxOffset;
    return loadTrustZones(false);
  }

  renderTrustZoneList(browseResponse.records);
  syncTrustZoneControls();
  const byZone = statusResponse?.status?.records?.byZone || {};
  const zoneSummary = ["quarantine", "working", "trusted"]
    .filter((name) => typeof byZone[name] === "number")
    .map((name) => `${name} ${byZone[name]}`)
    .join(" · ");
  setStatus(
    "trustZoneStatus",
    `Loaded ${browseResponse.count} of ${browseResponse.total} trust-zone records.${zoneSummary ? ` ${zoneSummary}.` : ""}`,
    "ok",
  );
}

async function promoteTrustZone(recordId, targetZone, dryRun) {
  if (!recordId || !targetZone) return;
  setStatus("trustZoneDetailStatus", `${dryRun ? "Previewing" : "Applying"} ${targetZone} promotion for ${recordId}...`);
  const response = await fetchJson("/engram/v1/trust-zones/promote", {
    method: "POST",
    body: JSON.stringify({
      recordId,
      targetZone,
      promotionReason: dryRun
        ? `Previewed in Remnic admin console for ${recordId}.`
        : `Promoted in Remnic admin console for ${recordId}.`,
      dryRun,
    }),
  });
  $("trustZoneSeedResult").textContent = JSON.stringify(response, null, 2);
  $("trustZoneDetail").textContent = JSON.stringify(response.record, null, 2);
  await loadTrustZones(false);
  setStatus(
    "trustZoneDetailStatus",
    dryRun ? `Previewed ${targetZone} promotion for ${recordId}.` : `Applied ${targetZone} promotion for ${recordId}.`,
    "ok",
  );
}

async function seedTrustZoneDemo(dryRun) {
  if (!dryRun && typeof window.confirm === "function") {
    const confirmed = window.confirm(
      "Seed the explicit trust-zone demo dataset into the current namespace? This is opt-in demo data for buyer-facing walkthroughs.",
    );
    if (!confirmed) return;
  }
  setStatus("trustZoneStatus", dryRun ? "Previewing trust-zone demo seed..." : "Seeding trust-zone demo dataset...");
  const response = await fetchJson("/engram/v1/trust-zones/demo-seed", {
    method: "POST",
    body: JSON.stringify({
      scenario: "enterprise-buyer-v1",
      dryRun,
    }),
  });
  $("trustZoneSeedResult").textContent = JSON.stringify(response, null, 2);
  if (!dryRun) {
    await loadTrustZones(true);
  }
  setStatus(
    "trustZoneStatus",
    dryRun
      ? `Previewed ${response.records.length} trust-zone demo records.`
      : `Seeded ${response.recordsWritten} trust-zone demo records into ${response.namespace}.`,
    "ok",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Memory Graph — force-directed Verlet simulation (issue #691 PR 3/5)
// Semantic search highlight + drill-through (issue #691 PR 4/5)
// No external dependencies.
// ─────────────────────────────────────────────────────────────────────────────

/** Stable colour palette keyed by category string. */
const GRAPH_CATEGORY_COLORS = [
  "#0f6b63", // accent (fact)
  "#8b3a22", // warn  (decision)
  "#2563a8", // blue  (preference)
  "#6b4f0f", // amber (entity)
  "#3d226b", // purple (procedure)
  "#1d7a3e", // green  (observation)
  "#7a2b5f", // rose
  "#2b5e7a", // teal-dark
];
const GRAPH_UNKNOWN_COLOR = "#aaa";
const GRAPH_EDGE_COLORS = { entity: "#0f6b63", time: "#c9a227", causal: "#8b3a22" };

/** Per-session category → colour mapping, built lazily. */
const graphCategoryColors = new Map();
let graphCategoryColorIndex = 0;

// ─── Highlight state (issue #691 PR 4/5) ────────────────────────────────────

/**
 * Map of highlighted node IDs → frontmatter memory IDs, populated by search.
 * Empty map = no active search.  Values are the recall result `id` field, which
 * is the frontmatter memory ID required by GET /engram/v1/memories/:id.
 */
let graphHighlightIds = new Map();

/**
 * Pulse animation state.
 * `graphPulsePhase` advances each frame; nodes use it to vary their ring size.
 */
let graphPulsePhase = 0;

/**
 * Return true if `str` ends with `suffix` at a path-segment boundary.
 * Prevents "ammemory.md" matching against suffix "memory.md".
 * Accepts an exact match or a match preceded by "/".
 *
 * @param {string} str
 * @param {string} suffix
 * @returns {boolean}
 */
/**
 * Normalize a file path to forward-slash form so Windows backslash paths
 * compare correctly against the forward-slash-normalized graph node IDs.
 * @param {string} p
 * @returns {string}
 */
function normalizeSep(p) {
  return p.replace(/\\/g, "/");
}

function pathEndsWith(str, suffix) {
  if (!str || !suffix) return false;
  // Normalize separators before comparison so Windows backslash paths
  // (from recall result.path) match forward-slash graph node IDs.
  const s = normalizeSep(str);
  const fx = normalizeSep(suffix);
  if (s === fx) return true;
  return s.endsWith("/" + fx);
}

/**
 * Pure function — given a snapshot node list and a recall result list, return a
 * Map from matched node ID → recall result frontmatter ID.
 *
 * Recall results have two identifiers:
 *   - `result.id`   — frontmatter memory ID (e.g. "fact-abc123"); used by the
 *                     memory-detail endpoint GET /engram/v1/memories/:id.
 *   - `result.path` — absolute file path (e.g. "/home/user/.remnic/facts/foo.md");
 *                     path-based matching bridges absolute backend paths to
 *                     relative graph node IDs.
 *
 * Graph snapshot `node.id` values are relative memory paths (e.g. "facts/foo.md").
 *
 * Matching rules (applied in order, first match wins per node):
 *   1. `node.id` === `result.path` (exact absolute path — rare)
 *   2. `result.path` ends with "/" + `node.id` (absolute path has node's relative tail)
 *   3. `node.id` ends with "/" + `result.path` (inverse, node has absolute prefix)
 *   4. `node.id` === `result.id` (frontmatter ID match — only for non-path IDs)
 *   5. `node.id` ends with "/" + `result.id` (relative path ends with frontmatter ID)
 *   6. `result.id` ends with "/" + `node.id` (inverse suffix)
 *
 * All suffix comparisons use path-segment boundary checks (pathEndsWith) so that
 * e.g. "ammemory.md" does NOT match a suffix of "memory.md".
 *
 * Returns a Map so callers can retrieve the frontmatter ID for the memory-detail
 * endpoint without a separate lookup.
 *
 * @param {Array<{id: string}>} nodes   - nodes from the snapshot
 * @param {Array<{id: string, path?: string}>} results - recall result objects
 * @returns {Map<string, string>}  nodeId → frontmatterMemoryId
 */
function resolveHighlights(nodes, results) {
  /** @type {Map<string, string>} */
  const matched = new Map();
  if (!Array.isArray(nodes) || !Array.isArray(results) || results.length === 0) {
    return matched;
  }
  for (const node of nodes) {
    const nid = node.id;
    if (!nid) continue;
    // Normalize the node ID once for all comparisons.
    const nidN = normalizeSep(nid);
    for (const result of results) {
      const rid = result.id;
      const rpath = result.path || "";
      // Path-based matching (handles the typical production case where graph
      // node IDs are relative paths and recall results carry absolute or
      // relative paths).  Both sides are separator-normalized so
      // Windows backslash paths compare correctly against forward-slash
      // graph node IDs.  Uses pathEndsWith() to respect path-segment
      // boundaries.
      if (rpath) {
        const rpathN = normalizeSep(rpath);
        if (nidN === rpathN || pathEndsWith(rpathN, nidN) || pathEndsWith(nidN, rpathN)) {
          matched.set(nid, rid);
          break;
        }
      }
      // Frontmatter-ID matching as fallback (e.g. custom deployments where
      // node IDs are not file paths).
      if (rid && (nid === rid || pathEndsWith(nid, rid) || pathEndsWith(rid, nid))) {
        matched.set(nid, rid);
        break;
      }
    }
  }
  return matched;
}

function graphColorForCategory(cat) {
  if (!cat || cat === "unknown") return GRAPH_UNKNOWN_COLOR;
  if (!graphCategoryColors.has(cat)) {
    graphCategoryColors.set(cat, GRAPH_CATEGORY_COLORS[graphCategoryColorIndex % GRAPH_CATEGORY_COLORS.length]);
    graphCategoryColorIndex += 1;
  }
  return graphCategoryColors.get(cat);
}

/** Current simulation state — replaced on every refresh. */
let graphSim = null;

/**
 * Run a Verlet-style force simulation on `nodes` / `edges`.
 * Mutates `nodes` in-place; every element gains `.x`, `.y`, `.vx`, `.vy`.
 * Returns a handle with `.stop()`, `.restart()`, and `.reheat()`.
 */
function createForceSimulation(nodes, edges, width, height) {
  const REPULSION = 6000;
  const SPRING_LENGTH = 90;
  const SPRING_K = 0.06;
  const DAMPING = 0.82;
  const CENTERING = 0.012;

  // Place nodes in a circle to avoid degenerate starts.
  nodes.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / nodes.length;
    const r = Math.min(width, height) * 0.3;
    n.x = width / 2 + r * Math.cos(angle);
    n.y = height / 2 + r * Math.sin(angle);
    n.vx = 0;
    n.vy = 0;
  });

  let running = true;
  let rafId = null;

  function tick() {
    if (!running) return;

    // Repulsion between all pairs (O(n²) — acceptable for ≤ 1000 nodes in admin console).
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const ni = nodes[i];
        const nj = nodes[j];
        const dx = ni.x - nj.x;
        const dy = ni.y - nj.y;
        const dist2 = dx * dx + dy * dy || 1;
        const dist = Math.sqrt(dist2);
        const force = REPULSION / dist2;
        const fx = (force * dx) / dist;
        const fy = (force * dy) / dist;
        ni.vx += fx;
        ni.vy += fy;
        nj.vx -= fx;
        nj.vy -= fy;
      }
    }

    // Spring attraction along edges.
    for (const edge of edges) {
      const src = edge._srcNode;
      const tgt = edge._tgtNode;
      if (!src || !tgt) continue;
      const dx = tgt.x - src.x;
      const dy = tgt.y - src.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const stretch = dist - SPRING_LENGTH;
      const fx = (SPRING_K * stretch * dx) / dist;
      const fy = (SPRING_K * stretch * dy) / dist;
      src.vx += fx;
      src.vy += fy;
      tgt.vx -= fx;
      tgt.vy -= fy;
    }

    // Centering pull.
    for (const n of nodes) {
      n.vx += (width / 2 - n.x) * CENTERING;
      n.vy += (height / 2 - n.y) * CENTERING;
      // Damping + integrate.
      n.vx *= DAMPING;
      n.vy *= DAMPING;
      n.x += n.vx;
      n.y += n.vy;
    }
  }

  let onDraw = null;

  function loop() {
    tick();
    if (onDraw) onDraw();
    if (running) rafId = requestAnimationFrame(loop);
  }

  return {
    start(drawFn) {
      onDraw = drawFn;
      running = true;
      rafId = requestAnimationFrame(loop);
    },
    stop() {
      running = false;
      if (rafId !== null) cancelAnimationFrame(rafId);
    },
    restart(drawFn) {
      this.stop();
      this.start(drawFn);
    },
    reheat(drawFn) {
      if (drawFn) onDraw = drawFn;
      if (!running) {
        this.start(onDraw);
        return;
      }
      if (onDraw) onDraw();
    },
  };
}

/** Pan/zoom transform for the canvas. */
const graphView = { tx: 0, ty: 0, scale: 1 };

/** Resets view transform to identity and re-draws. */
function resetGraphView() {
  graphView.tx = 0;
  graphView.ty = 0;
  graphView.scale = 1;
  drawGraph();
}

/** Last rendered snapshot, kept for re-draw on resize / pan / zoom. */
let graphData = null; // { nodes, edges }

/**
 * Guard flag: canvas interaction listeners (mouse/wheel) must be attached
 * exactly once during pane initialisation. Without this, every graph refresh
 * stacks another set of listeners that all fire simultaneously.
 */
let graphInteractionsAttached = false;

/** Node radius derived from score (clamped). */
function nodeRadius(score) {
  return Math.max(5, Math.min(14, 5 + score * 9));
}

/** Draw a single frame onto the canvas. */
function drawGraph() {
  const canvas = $("graphCanvas");
  if (!canvas || !graphData) return;
  const dpr = window.devicePixelRatio || 1;
  // Keep bitmap resolution in sync with layout size.
  const lw = canvas.offsetWidth;
  const lh = canvas.offsetHeight;
  if (canvas.width !== lw * dpr || canvas.height !== lh * dpr) {
    canvas.width = lw * dpr;
    canvas.height = lh * dpr;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, lw, lh);

  ctx.save();
  ctx.translate(graphView.tx, graphView.ty);
  ctx.scale(graphView.scale, graphView.scale);

  // Draw edges.
  for (const edge of graphData.edges) {
    const src = edge._srcNode;
    const tgt = edge._tgtNode;
    if (!src || !tgt) continue;
    ctx.beginPath();
    ctx.moveTo(src.x, src.y);
    ctx.lineTo(tgt.x, tgt.y);
    ctx.strokeStyle = GRAPH_EDGE_COLORS[edge.kind] || "#ccc";
    ctx.globalAlpha = 0.45 + edge.confidence * 0.45;
    ctx.lineWidth = 0.8 + edge.confidence * 1.2;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Draw nodes.
  const hasHighlights = graphHighlightIds.size > 0;
  graphPulsePhase = (graphPulsePhase + 0.06) % (2 * Math.PI);
  const pulseExtra = Math.sin(graphPulsePhase) * 3.5;

  for (const n of graphData.nodes) {
    const r = nodeRadius(n.score);
    const isHighlighted = hasHighlights && graphHighlightIds.has(n.id);  // Map.has()
    const isDimmed = hasHighlights && !isHighlighted;

    // Draw highlight ring + pulse halo before the node fill.
    if (isHighlighted) {
      const haloR = r + 5 + Math.max(0, pulseExtra);
      ctx.beginPath();
      ctx.arc(n.x, n.y, haloR, 0, 2 * Math.PI);
      ctx.strokeStyle = "#f5c842";
      ctx.globalAlpha = 0.55 + Math.sin(graphPulsePhase) * 0.2;
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = graphColorForCategory(n.kind);
    ctx.globalAlpha = isDimmed ? 0.22 : 1;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = isHighlighted ? "#f5c842" : "rgba(255,255,255,0.6)";
    ctx.lineWidth = isHighlighted ? 2.5 : 1.5;
    ctx.stroke();
  }

  ctx.restore();
  ctx.restore();
}

/** Convert canvas-relative point to simulation space. */
function canvasToSim(cx, cy) {
  return {
    x: (cx - graphView.tx) / graphView.scale,
    y: (cy - graphView.ty) / graphView.scale,
  };
}

/** Find the node under a canvas-relative cursor point, or null. */
function hitTestNode(cx, cy) {
  if (!graphData) return null;
  const sim = canvasToSim(cx, cy);
  for (const n of graphData.nodes) {
    const r = nodeRadius(n.score) + 4; // slight hit-padding
    const dx = sim.x - n.x;
    const dy = sim.y - n.y;
    if (dx * dx + dy * dy <= r * r) return n;
  }
  return null;
}

/** Find the edge under a canvas-relative cursor point, or null. */
function hitTestEdge(cx, cy) {
  if (!graphData) return null;
  const sim = canvasToSim(cx, cy);
  const THRESHOLD = 6;
  for (const edge of graphData.edges) {
    const src = edge._srcNode;
    const tgt = edge._tgtNode;
    if (!src || !tgt) continue;
    // Point-to-segment distance.
    const dx = tgt.x - src.x;
    const dy = tgt.y - src.y;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((sim.x - src.x) * dx + (sim.y - src.y) * dy) / len2));
    const px = src.x + t * dx - sim.x;
    const py = src.y + t * dy - sim.y;
    if (px * px + py * py <= THRESHOLD * THRESHOLD) return edge;
  }
  return null;
}

/** Show the floating tooltip near the cursor. */
function showGraphTooltip(canvas, clientX, clientY, text) {
  const tip = $("graphTooltip");
  if (!tip) return;
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left + 12;
  const y = clientY - rect.top + 12;
  tip.textContent = text;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
  tip.style.display = "block";
}

function hideGraphTooltip() {
  const tip = $("graphTooltip");
  if (tip) tip.style.display = "none";
}

/** Wire pan / zoom / tooltip mouse handlers onto the canvas.
 *  Must be called once per canvas lifetime; subsequent calls are no-ops.
 */
function attachGraphInteractions(canvas) {
  // Attach only once — re-attaching on every refresh stacks duplicate
  // listeners that each fire on the same event (Codex P2 / Cursor review).
  if (graphInteractionsAttached) return;
  graphInteractionsAttached = true;

  // Pan + click-to-drill-through.
  let dragging = false;
  let dragStart = { x: 0, y: 0 };
  let viewStart = { tx: 0, ty: 0 };
  /** Track whether the mousedown moved before mouseup (drag vs click). */
  let didDrag = false;
  /**
   * mousedownOnCanvas: set to true only when the mousedown that began the
   * gesture originated on this canvas.  Prevents a mouseup from a pan that
   * started outside the canvas (e.g. drag from a sidebar) from spuriously
   * opening the node panel.
   */
  let mousedownOnCanvas = false;

  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    didDrag = false;
    mousedownOnCanvas = true;
    dragStart = { x: e.clientX, y: e.clientY };
    viewStart = { tx: graphView.tx, ty: graphView.ty };
  });

  canvas.addEventListener("mouseup", (e) => {
    if (e.button !== 0) { dragging = false; return; }
    // Only open a node panel if this mouseup has a matching mousedown on the
    // same canvas and no drag movement occurred (click vs drag-pan).
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    if (mousedownOnCanvas && !didDrag) {
      const node = hitTestNode(cx, cy);
      if (node) {
        void openGraphNodePanel(node);
      }
    }
    dragging = false;
    mousedownOnCanvas = false;
  });

  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    if (dragging) {
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) didDrag = true;
      graphView.tx = viewStart.tx + dx;
      graphView.ty = viewStart.ty + dy;
      drawGraph();
      hideGraphTooltip();
      return;
    }

    // Tooltip: check node first, then edge.
    const node = hitTestNode(cx, cy);
    if (node) {
      const lines = [
        `id: ${node.id}`,
        `category: ${node.kind}`,
        `score: ${node.score.toFixed(3)}`,
        node.lastUpdated ? `updated: ${node.lastUpdated}` : null,
      ].filter(Boolean).join("\n");
      showGraphTooltip(canvas, e.clientX, e.clientY, lines);
      return;
    }
    const edge = hitTestEdge(cx, cy);
    if (edge) {
      const text = `kind: ${edge.kind}\nconfidence: ${edge.confidence.toFixed(3)}`;
      showGraphTooltip(canvas, e.clientX, e.clientY, text);
      return;
    }
    hideGraphTooltip();
  });

  canvas.addEventListener("mouseleave", () => { dragging = false; didDrag = false; mousedownOnCanvas = false; hideGraphTooltip(); });

  // Zoom via scroll wheel.
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    const newScale = Math.max(0.1, Math.min(10, graphView.scale * factor));
    // Keep the point under the cursor stationary.
    graphView.tx = cx - (cx - graphView.tx) * (newScale / graphView.scale);
    graphView.ty = cy - (cy - graphView.ty) * (newScale / graphView.scale);
    graphView.scale = newScale;
    drawGraph();
  }, { passive: false });
}

/** Rebuild the legend strip below the canvas. */
function renderGraphLegend() {
  const legend = $("graphLegend");
  if (!legend) return;
  clearChildren(legend);
  for (const [cat, color] of graphCategoryColors.entries()) {
    const item = document.createElement("span");
    item.className = "graph-legend-item";
    const swatch = document.createElement("span");
    swatch.className = "graph-legend-swatch";
    swatch.style.background = color;
    item.appendChild(swatch);
    const label = document.createElement("span");
    label.textContent = cat;
    item.appendChild(label);
    legend.appendChild(item);
  }
}

/**
 * Fetch `GET /engram/v1/graph/snapshot`, build simulation, and start drawing.
 */
async function loadMemoryGraph() {
  const canvas = $("graphCanvas");
  if (!canvas) return;

  // Stop any running simulation.
  if (graphSim) { graphSim.stop(); graphSim = null; }

  setStatus("graphStatus", "Fetching graph snapshot...");

  const params = new URLSearchParams();
  const limit = $("graphLimit")?.value?.trim();
  const focus = $("graphFocusNodeId")?.value?.trim();
  if (limit) params.set("limit", limit);
  if (focus) params.set("focusNodeId", focus);

  let snapshot;
  try {
    snapshot = await fetchJson(`/engram/v1/graph/snapshot?${params.toString()}`);
  } catch (err) {
    setStatus("graphStatus", err.message || String(err), "error");
    return;
  }

  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const edges = Array.isArray(snapshot.edges) ? snapshot.edges : [];

  // Always reset highlights, invalidate in-flight searches, and close panel
  // at the start of every reload — so stale state never persists.
  graphSearchToken += 1;
  graphHighlightIds = new Map();
  closeGraphNodePanel();

  if (nodes.length === 0) {
    graphData = null;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const dpr = window.devicePixelRatio || 1;
      const lw = canvas.offsetWidth;
      const lh = canvas.offsetHeight;
      canvas.width = lw * dpr;
      canvas.height = lh * dpr;
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, lw, lh);
      ctx.fillStyle = "#aaa";
      ctx.font = "14px Avenir Next, Segoe UI, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No graph data — memory graph is empty.", lw / 2, lh / 2);
      ctx.restore();
    }
    setStatus("graphStatus", "Graph snapshot is empty.", "default");
    return;
  }

  // Reset colours on each fresh fetch so legend is consistent.
  graphCategoryColors.clear();
  graphCategoryColorIndex = 0;

  // Pre-warm category colours in node order.
  for (const n of nodes) graphColorForCategory(n.kind);

  // Build id → node index for edge wiring.
  const nodeIndex = new Map(nodes.map((n) => [n.id, n]));
  for (const edge of edges) {
    edge._srcNode = nodeIndex.get(edge.source) ?? null;
    edge._tgtNode = nodeIndex.get(edge.target) ?? null;
  }

  // Pre-bind each node's frontmatter memory ID from snapshot metadata so
  // drill-through works for every node, not just those matched by a search.
  // `node.metadata.memoryId` is the field the graph-snapshot endpoint sets
  // when it can resolve the node back to a stored memory record.
  // Any later runGraphSearch() result will overwrite this with the recall-
  // result ID (which may be more precise), but this ensures non-searched
  // nodes also open with a valid memory-detail fetch.
  for (const n of nodes) {
    n._memoryId = n.metadata?.memoryId || null;
  }

  graphData = { nodes, edges };
  // Reset view on fresh load.
  graphView.tx = 0;
  graphView.ty = 0;
  graphView.scale = 1;

  const lw = canvas.offsetWidth || 800;
  const lh = canvas.offsetHeight || 520;

  graphSim = createForceSimulation(nodes, edges, lw, lh);
  graphSim.start(drawGraph);

  attachGraphInteractions(canvas);
  renderGraphLegend();

  // Open (or re-open) the SSE stream so new edges appear in real time
  // without a full re-fetch (issue #691 PR 5/5).
  mountGraphEventSource();

  setStatus(
    "graphStatus",
    `Loaded ${nodes.length} nodes, ${edges.length} edges. Generated ${snapshot.generatedAt}.`,
    "ok",
  );
}

// ─── Real-time graph SSE updates (issue #691 PR 5/5) ────────────────────────

/**
 * Pending edge-added payloads whose source or target node had not yet arrived
 * when the event was first processed.  Retried on every subsequent node-added
 * event (Codex review thread PRRT_kwDORJXyws59soGK).
 *
 * Entries are removed once both endpoint nodes exist in graphData.nodes.
 * The queue is bounded to 200 entries to prevent unbounded growth from a
 * disconnected or very busy stream.
 */
const _orphanEdgeQueue = [];
const _ORPHAN_EDGE_QUEUE_MAX = 200;

/**
 * Active EventSource connection for /engram/v1/graph/events.
 * Only one connection is maintained at a time; `mountGraphEventSource` closes
 * the previous one before opening a new one.
 */
let graphEventSource = null;

/**
 * Apply a single graph mutation event to the in-memory graphData and
 * re-render without a full re-fetch.
 *
 * Supported mutation types:
 *   node-added    — add a node if not already present
 *   node-updated  — update label/kind on an existing node
 *   edge-added    — add an edge if the source/target nodes exist
 *   edge-updated  — update weight/confidence on a matching edge
 *   edge-removed  — remove matching edges from the simulation
 */
function applyGraphEvent(event) {
  if (!graphData) return; // graph not loaded yet; skip
  const p = event.payload;

  if (event.type === "node-added") {
    const existing = graphData.nodes.find((n) => n.id === p.nodeId);
    if (!existing) {
      const node = {
        id: p.nodeId,
        label: p.label || p.nodeId,
        kind: p.kind || "unknown",
        score: 1,
        lastUpdated: p.lastUpdated || event.ts,
        // Place new nodes at a random position near the canvas centre.
        x: (Math.random() - 0.5) * 200,
        y: (Math.random() - 0.5) * 200,
        vx: 0,
        vy: 0,
        _memoryId: null,
      };
      graphData.nodes.push(node);
      graphColorForCategory(node.kind);
      // Drain any queued orphan edges now that a new node has arrived.
      // Iterate backwards so splicing by index is safe.
      let drainedAny = false;
      for (let i = _orphanEdgeQueue.length - 1; i >= 0; i--) {
        const op = _orphanEdgeQueue[i];
        const s = graphData.nodes.find((n) => n.id === op.source);
        const t = graphData.nodes.find((n) => n.id === op.target);
        if (s && t) {
          _orphanEdgeQueue.splice(i, 1);
          const alreadyExists = graphData.edges.some(
            (e) => e.source === op.source && e.target === op.target && e.kind === op.kind,
          );
          if (!alreadyExists) {
            graphData.edges.push({
              source: op.source,
              target: op.target,
              kind: op.kind,
              weight: typeof op.weight === "number" ? op.weight : 1.0,
              label: op.label || "",
              confidence: typeof op.confidence === "number" ? op.confidence : 1.0,
              _srcNode: s,
              _tgtNode: t,
            });
            drainedAny = true;
          }
        }
      }
      if (graphSim) graphSim.reheat();
      drawGraph();
      if (drainedAny && graphSim) graphSim.reheat();
    }
    return;
  }

  if (event.type === "node-updated") {
    const node = graphData.nodes.find((n) => n.id === p.nodeId);
    if (node) {
      node.label = p.label || node.label;
      node.kind = p.kind || node.kind;
      if (p.lastUpdated) node.lastUpdated = p.lastUpdated;
      drawGraph();
    }
    return;
  }

  if (event.type === "edge-added") {
    const srcNode = graphData.nodes.find((n) => n.id === p.source);
    const tgtNode = graphData.nodes.find((n) => n.id === p.target);
    if (srcNode && tgtNode) {
      const alreadyExists = graphData.edges.some(
        (e) => e.source === p.source && e.target === p.target && e.kind === p.kind,
      );
      if (!alreadyExists) {
        const edge = {
          source: p.source,
          target: p.target,
          kind: p.kind,
          weight: typeof p.weight === "number" ? p.weight : 1.0,
          label: p.label || "",
          confidence: typeof p.confidence === "number" ? p.confidence : 1.0,
          _srcNode: srcNode,
          _tgtNode: tgtNode,
        };
        graphData.edges.push(edge);
        if (graphSim) graphSim.reheat();
        drawGraph();
      }
    } else {
      // One or both endpoint nodes haven't arrived yet — queue the edge payload
      // so it can be applied once the missing nodes appear (Codex review thread
      // PRRT_kwDORJXyws59soGK).  Enforce a cap to prevent unbounded growth.
      const alreadyQueued = _orphanEdgeQueue.some(
        (e) => e.source === p.source && e.target === p.target && e.kind === p.kind,
      );
      if (!alreadyQueued) {
        if (_orphanEdgeQueue.length >= _ORPHAN_EDGE_QUEUE_MAX) {
          _orphanEdgeQueue.shift(); // drop the oldest orphan
        }
        _orphanEdgeQueue.push({
          source: p.source,
          target: p.target,
          kind: p.kind,
          weight: p.weight,
          label: p.label,
          confidence: p.confidence,
        });
      }
    }
    return;
  }

  if (event.type === "edge-updated") {
    for (const edge of graphData.edges) {
      if (edge.source === p.source && edge.target === p.target && edge.kind === p.kind) {
        if (typeof p.weight === "number") edge.weight = p.weight;
        if (typeof p.confidence === "number") edge.confidence = p.confidence;
      }
    }
    drawGraph();
    return;
  }

  if (event.type === "edge-removed") {
    // Track which nodes had at least one edge BEFORE this removal so we
    // only prune nodes that lost their last edge.  Nodes that were already
    // isolated (no edges at all) are intentional standalone nodes and must
    // not be removed (Cursor review thread `app.js:1398`).
    const hadEdges = new Set();
    for (const e of graphData.edges) {
      hadEdges.add(e.source);
      hadEdges.add(e.target);
    }
    graphData.edges = graphData.edges.filter(
      (e) => !(e.source === p.source && e.target === p.target && e.kind === p.kind),
    );
    // Build the still-connected set after removal.
    const stillConnected = new Set();
    for (const e of graphData.edges) {
      stillConnected.add(e.source);
      stillConnected.add(e.target);
    }
    // Only prune a node when it was connected before AND is now orphaned.
    graphData.nodes = graphData.nodes.filter(
      (n) => !hadEdges.has(n.id) || stillConnected.has(n.id),
    );
    if (graphSim) graphSim.reheat();
    drawGraph();
  }
}

/**
 * Open a Server-Sent Events connection to /engram/v1/graph/events and
 * patch graphData in-place as events arrive.
 *
 * Called once during graph pane initialisation (inside loadMemoryGraph).
 * Re-opening is handled via the EventSource's built-in reconnect logic.
 *
 * The EventSource spec requires the URL to carry auth, because the
 * EventSource constructor does not support headers.  We pass the bearer
 * token as `?token=...` — the server checks both the Authorization header
 * and this query parameter so curl/browser callers both work.
 */
function mountGraphEventSource() {
  // Close any previous connection first (e.g. after a graph refresh).
  if (graphEventSource) {
    try { graphEventSource.close(); } catch { /* ignore */ }
    graphEventSource = null;
  }

  const token = readToken();
  if (!token) return; // no token → no stream; user can still use manual refresh

  const url = `/engram/v1/graph/events?token=${encodeURIComponent(token)}`;
  let es;
  try {
    es = new EventSource(url);
  } catch {
    // EventSource not supported (e.g. test environment); silently skip.
    return;
  }
  graphEventSource = es;

  es.onmessage = (e) => {
    let parsed;
    try { parsed = JSON.parse(e.data); } catch { return; }
    if (!parsed || typeof parsed !== "object") return;

    if (parsed.type === "connected" || parsed.type === "heartbeat") {
      // Control frames — no graphData mutation needed.
      return;
    }

    if (parsed.type === "batch" && Array.isArray(parsed.events)) {
      for (const ev of parsed.events) {
        applyGraphEvent(ev);
      }
      return;
    }

    // Fallback: treat as a single event (forward compatibility).
    if (parsed.type) applyGraphEvent(parsed);
  };

  es.onerror = () => {
    // EventSource reconnects automatically; nothing to do here.
  };
}

// ─── Graph search + drill-through (issue #691 PR 4/5) ───────────────────────

/**
 * Monotonically incrementing token for in-flight graph search requests.
 * Incremented on every runGraphSearch call; the async continuation discards
 * results if the token changed while the fetch was in flight (e.g. because
 * the user refreshed the graph or cleared search before it resolved).
 */
let graphSearchToken = 0;

/**
 * Run a recall search against the existing recall endpoint and highlight the
 * matching nodes in the graph.  Uses `POST /engram/v1/recall` — the same
 * endpoint as the Recall Debugger — with a fixed `sessionKey` so it does not
 * pollute the user's recall state.
 */
async function runGraphSearch() {
  const query = $("graphSearchQuery")?.value?.trim() || "";
  if (!query) return;
  if (!graphData) {
    setStatus("graphStatus", "Load the graph first before searching.", "error");
    return;
  }
  // Claim a token before the first await so a concurrent call gets a
  // different value and this response is discarded when it resolves late.
  const myToken = ++graphSearchToken;
  setStatus("graphStatus", `Searching for "${query}"…`);
  try {
    const recall = await fetchJson("/engram/v1/recall", {
      method: "POST",
      body: JSON.stringify({ query, sessionKey: "admin-console-graph-search" }),
    });
    // Discard if a newer search (or a graph refresh/clear) ran while we awaited.
    if (myToken !== graphSearchToken) return;
    // Normalise: recall response may have results in different shapes.
    // `recall.memories`, `recall.results`, or fall back to empty.
    const rawResults =
      Array.isArray(recall.memories) ? recall.memories :
      Array.isArray(recall.results)  ? recall.results  :
      [];
    // Guard again: graphData may have been cleared during the fetch.
    if (!graphData) return;
    // Second token check immediately before mutating shared highlight state.
    // A graph reload that ran between the first guard and here will have bumped
    // graphSearchToken, so stale responses from a superseded search are dropped
    // even if graphData was coincidentally re-populated in the interim.
    if (myToken !== graphSearchToken) return;
    graphHighlightIds = resolveHighlights(graphData.nodes, rawResults);
    // Store frontmatter IDs on matched nodes for drill-through.
    // Preserve any snapshot-bound _memoryId for nodes that weren't in results
    // by only overwriting nodes that are actually in the highlight set.
    for (const [nodeId, memId] of graphHighlightIds.entries()) {
      const node = graphData.nodes.find((n) => n.id === nodeId);
      if (node) node._memoryId = memId;
    }
    drawGraph();
    const count = graphHighlightIds.size;
    setStatus(
      "graphStatus",
      count > 0
        ? `Highlighted ${count} node${count === 1 ? "" : "s"} matching "${query}".`
        : `No graph nodes matched "${query}".`,
      count > 0 ? "ok" : "default",
    );
  } catch (err) {
    if (myToken !== graphSearchToken) return;
    setStatus("graphStatus", err.message || String(err), "error");
  }
}

/** Clear the current highlight selection and redraw. */
function clearGraphSearch() {
  // Invalidate any in-flight search so its response is discarded.
  graphSearchToken += 1;
  graphHighlightIds = new Map();
  // Clear search-assigned _memoryId from all nodes so subsequent drill-through
  // fetches fall back to the snapshot-bound metadata ID rather than using a
  // stale frontmatter ID from a previous search query.
  if (graphData) {
    for (const n of graphData.nodes) {
      n._memoryId = n.metadata?.memoryId || null;
    }
  }
  const input = $("graphSearchQuery");
  if (input) input.value = "";
  if (graphData) drawGraph();
  closeGraphNodePanel();
  setStatus("graphStatus", "Search cleared.", "default");
}

/** Close the node detail panel. */
function closeGraphNodePanel() {
  const panel = $("graphNodePanel");
  if (panel) panel.classList.remove("visible");
}

/**
 * Monotonically incrementing token for in-flight node-panel requests.
 * Incremented on every openGraphNodePanel call; the async continuation
 * compares against the token at the time the fetch resolved to discard
 * stale responses when the user clicks multiple nodes in quick succession.
 */
let graphNodePanelToken = 0;

/**
 * Fetch `GET /engram/v1/memories/:id` and render the result into the
 * node detail side panel.  Builds a frontmatter table, renders raw content,
 * and lists related edges from the in-memory snapshot.
 *
 * Uses a monotonic token to discard stale responses when the user clicks
 * a second node before the first fetch resolves (race-free panel updates).
 *
 * @param {object} node - graph node object (has `.id`, `.kind`, `.score`, etc.)
 */
async function openGraphNodePanel(node) {
  const panel = $("graphNodePanel");
  if (!panel) return;

  // Claim this request's token before any await so concurrent calls get a
  // different value and their responses are discarded when they resolve.
  const myToken = ++graphNodePanelToken;

  // Show panel immediately with loading state.
  panel.classList.add("visible");
  const title = $("graphNodePanelTitle");
  const status = $("graphNodePanelStatus");
  const frontmatterEl = $("graphNodeFrontmatter");
  const contentEl = $("graphNodeContent");
  const edgesEl = $("graphNodeEdges");

  if (title) title.textContent = node.id;
  if (status) { status.textContent = `Loading ${node.id}…`; status.className = "status"; }
  if (frontmatterEl) {
    clearChildren(frontmatterEl);
    const em = document.createElement("em");
    em.textContent = "Loading…";
    frontmatterEl.appendChild(em);
  }
  if (contentEl) contentEl.textContent = "Loading…";
  if (edgesEl) {
    clearChildren(edgesEl);
    const strong = document.createElement("strong");
    strong.textContent = "Loading edges…";
    edgesEl.appendChild(strong);
  }

  // Resolve the frontmatter memory ID to use for GET /engram/v1/memories/:id.
  // Priority order:
  //   1. node._memoryId  — set by runGraphSearch() from recall result.id, or
  //                        pre-bound from snapshot metadata in loadMemoryGraph()
  //   2. node.metadata?.memoryId — snapshot field (direct access, in case
  //                        _memoryId was not pre-bound for some reason)
  //   3. node.id         — last resort; the endpoint will 404 for path IDs but
  //                        the caller handles 404 gracefully by showing snapshot
  //                        data, so the panel is still informative.
  const lookupId = node._memoryId || node.metadata?.memoryId || node.id;

  let response = null;
  try {
    response = await fetchJson(`/engram/v1/memories/${encodeURIComponent(lookupId)}`);
  } catch (err) {
    // Discard stale errors.
    if (myToken !== graphNodePanelToken) return;
    // On 404 (no frontmatter ID known yet) fall through with null response so
    // the panel still shows snapshot data.  Surface real errors as-is.
    const isNotFound = err?.payload?.error === "Not found" ||
      (err?.message || "").includes("404");
    if (!isNotFound) {
      if (status) { status.textContent = err.message || String(err); status.className = "status error"; }
      if (contentEl) contentEl.textContent = "Failed to load memory content.";
      return;
    }
    // 404 — fall through with response = null; we'll show snapshot data.
  }

  // Discard if a newer openGraphNodePanel call was made while we awaited.
  if (myToken !== graphNodePanelToken) return;

  // When lookup succeeded, use the full memory record.
  // When it 404-ed (response === null), synthesise from snapshot node data
  // so the panel is informative for every node, not just searched ones.
  const mem = response?.memory || {};
  const isSnapshotOnly = !response?.found;

  // Build frontmatter table from top-level scalar fields.
  if (frontmatterEl) {
    const table = document.createElement("table");
    const FRONTMATTER_KEYS = [
      "id", "category", "status", "importance", "entityRef",
      "created", "updated", "path",
    ];
    FRONTMATTER_KEYS.forEach((key) => {
      const val = mem[key];
      if (val == null) return;
      const tr = document.createElement("tr");
      const tdKey = document.createElement("td");
      tdKey.textContent = key;
      const tdVal = document.createElement("td");
      tdVal.textContent = String(val);
      tr.appendChild(tdKey);
      tr.appendChild(tdVal);
      table.appendChild(tr);
    });
    clearChildren(frontmatterEl);
    frontmatterEl.appendChild(table);
  }

  // Render content — raw text, or snapshot summary when no detail loaded.
  if (contentEl) {
    if (isSnapshotOnly) {
      contentEl.textContent = [
        `id: ${node.id}`,
        `category: ${node.kind || "unknown"}`,
        `score: ${typeof node.score === "number" ? node.score.toFixed(3) : "?"}`,
        node.lastUpdated ? `updated: ${node.lastUpdated}` : null,
        "",
        "(Run a graph search to load the full memory detail for this node.)",
      ].filter((l) => l !== null).join("\n");
    } else {
      contentEl.textContent = typeof mem.content === "string"
        ? mem.content
        : JSON.stringify(mem, null, 2);
    }
  }

  // Render related edges from the snapshot already in memory.
  // Uses DOM methods exclusively — no innerHTML — to avoid XSS.
  if (edgesEl && graphData) {
    const related = graphData.edges.filter(
      (e) => e._srcNode?.id === node.id || e._tgtNode?.id === node.id,
    );
    clearChildren(edgesEl);
    if (related.length === 0) {
      edgesEl.textContent = "No edges in current snapshot.";
    } else {
      const ul = document.createElement("ul");
      related.forEach((e) => {
        const li = document.createElement("li");
        const isSource = e._srcNode?.id === node.id;
        const peerId = isSource ? e._tgtNode?.id : e._srcNode?.id;
        const direction = isSource ? "→" : "←";
        const strong = document.createElement("strong");
        strong.textContent = `${direction} ${e.kind ?? ""}`;
        li.appendChild(strong);
        li.appendChild(document.createTextNode(
          ` ${peerId || "?"} (confidence ${e.confidence?.toFixed(2) ?? "?"})`,
        ));
        ul.appendChild(li);
      });
      edgesEl.appendChild(ul);
    }
  }

  if (status) {
    status.textContent = isSnapshotOnly
      ? `Snapshot data for ${node.id}. Search to load full detail.`
      : `Loaded ${lookupId}.`;
    status.className = isSnapshotOnly ? "status" : "status ok";
  }
}

async function connectAndBootstrap() {
  const input = $("tokenInput");
  const token = input?.value?.trim() || readToken();
  if (!token) {
    setStatus("authStatus", "Enter a bearer token first.", "error");
    return;
  }
  writeToken(token);
  if (input) input.value = token;
  setStatus("authStatus", "Connecting...", "default");
  try {
    await fetchJson("/engram/v1/health");
    setStatus("authStatus", "Connected to Remnic access API.", "ok");
    await Promise.allSettled([
      loadMemoryBrowser(true),
      loadTrustZones(true),
      loadReviewQueue(),
      loadEntities(),
      loadQuality(),
      loadMaintenance(),
      loadMemoryGraph(),
    ]);
  } catch (error) {
    setStatus("authStatus", error.message || String(error), "error");
  }
}

function copyMemoryPath() {
  const rawPathField = $("memoryRawPath");
  const value = rawPathField?.value?.trim();
  if (!value) {
    setStatus("memoryDetailStatus", "No memory path to copy.", "error");
    return;
  }
  if (!navigator.clipboard?.writeText) {
    setStatus("memoryDetailStatus", "Clipboard API is unavailable in this browser.", "error");
    return;
  }
  navigator.clipboard.writeText(value)
    .then(() => {
      setStatus("memoryDetailStatus", "Copied raw memory path.", "ok");
    })
    .catch((error) => {
      setStatus("memoryDetailStatus", error.message || String(error), "error");
    });
}

function bootstrap() {
  const remembered = readToken();
  if (remembered && $("tokenInput")) {
    $("tokenInput").value = remembered;
  }

  $("connectButton")?.addEventListener("click", () => void connectAndBootstrap());
  $("clearTokenButton")?.addEventListener("click", () => {
    writeToken("");
    if ($("tokenInput")) $("tokenInput").value = "";
    setStatus("authStatus", "Cleared stored token.", "default");
  });
  $("searchMemoriesButton")?.addEventListener("click", () => void loadMemoryBrowser(true));
  $("memoryPrevButton")?.addEventListener("click", () => {
    stepMemoryPage(-1);
    void loadMemoryBrowser(false);
  });
  $("memoryNextButton")?.addEventListener("click", () => {
    stepMemoryPage(1);
    void loadMemoryBrowser(false);
  });
  $("runRecallButton")?.addEventListener("click", () => void runRecallDebugger());
  $("refreshTrustZonesButton")?.addEventListener("click", () => void loadTrustZones(true));
  $("trustZonePrevButton")?.addEventListener("click", () => {
    stepTrustZonePage(-1);
    void loadTrustZones(false);
  });
  $("trustZoneNextButton")?.addEventListener("click", () => {
    stepTrustZonePage(1);
    void loadTrustZones(false);
  });
  $("previewTrustZoneSeedButton")?.addEventListener("click", () => void seedTrustZoneDemo(true));
  $("seedTrustZoneDemoButton")?.addEventListener("click", () => void seedTrustZoneDemo(false));
  $("refreshQueueButton")?.addEventListener("click", () => void loadReviewQueue());
  $("searchEntitiesButton")?.addEventListener("click", () => void loadEntities());
  $("copyMemoryPathButton")?.addEventListener("click", copyMemoryPath);
  $("refreshGraphButton")?.addEventListener("click", () => void loadMemoryGraph());
  $("resetGraphViewButton")?.addEventListener("click", resetGraphView);
  $("graphSearchButton")?.addEventListener("click", () => void runGraphSearch());
  $("graphClearSearchButton")?.addEventListener("click", clearGraphSearch);
  $("graphSearchQuery")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void runGraphSearch();
  });

  if (remembered) {
    void connectAndBootstrap();
  } else {
    syncBrowserControls();
    syncTrustZoneControls();
  }
}

bootstrap();
