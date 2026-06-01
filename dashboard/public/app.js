const DASHBOARD_TOKEN_STORAGE_KEY = "remnic.dashboard.token";

function readTokenFromUrl() {
  const current = new URL(window.location.href);
  const token = current.searchParams.get("token");
  if (!token) return "";
  current.searchParams.delete("token");
  window.history.replaceState(null, document.title, current.toString());
  return token;
}

function readStoredToken() {
  try {
    return window.sessionStorage.getItem(DASHBOARD_TOKEN_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeToken(token) {
  try {
    if (token) {
      window.sessionStorage.setItem(DASHBOARD_TOKEN_STORAGE_KEY, token);
    } else {
      window.sessionStorage.removeItem(DASHBOARD_TOKEN_STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures; the token can still be kept in memory.
  }
}

function requestToken() {
  const token = window.prompt("Dashboard token")?.trim() ?? "";
  storeToken(token);
  return token;
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

async function fetchJson(url, tokenState) {
  let res = await fetch(url, { headers: authHeaders(tokenState.value) });
  if (res.status === 401) {
    tokenState.value = requestToken();
    res = await fetch(url, { headers: authHeaders(tokenState.value) });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function webSocketUrl(token) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL("/", `${protocol}//${window.location.host}`);
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = String(value);
}

function renderGraph(graph) {
  setText("nodes", graph?.stats?.nodes ?? 0);
  setText("edges", graph?.stats?.edges ?? 0);
  const graphEl = document.getElementById("graph");
  if (graphEl) graphEl.textContent = JSON.stringify(graph, null, 2);
}

function renderPatch(patch) {
  const patchEl = document.getElementById("patch");
  if (patchEl) patchEl.textContent = JSON.stringify(patch, null, 2);
}

async function bootstrap() {
  const tokenState = { value: readTokenFromUrl() || readStoredToken() };
  storeToken(tokenState.value);
  try {
    const health = await fetchJson("/api/health", tokenState);
    const graph = await fetchJson("/api/graph", tokenState);
    setText("status", health?.ok ? "ok" : "degraded");
    setText("clients", health?.clients ?? 0);
    renderGraph(graph);
  } catch (err) {
    setText("status", `error: ${err?.message ?? String(err)}`);
  }

  const ws = new WebSocket(webSocketUrl(tokenState.value));
  ws.addEventListener("open", () => setText("status", "streaming"));
  ws.addEventListener("close", () => setText("status", "closed"));
  ws.addEventListener("error", () => setText("status", "error"));
  ws.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "hello" && data.graph) {
        renderGraph(data.graph);
        return;
      }
      if (data.type === "graph_patch") {
        if (data.graph) renderGraph(data.graph);
        renderPatch(data.patch ?? data);
      }
    } catch {
      // ignore malformed messages
    }
  });
}

void bootstrap();
