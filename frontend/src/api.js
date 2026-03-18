const API_BASE = (import.meta.env.VITE_API_URL || "").replace(/\/+$/, "");

async function fetchJSON(path, params = {}) {
  const url = new URL(API_BASE + path, window.location.origin);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  });
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json();
}

export async function getTokens(opts = {}) {
  return fetchJSON("/api/tokens", opts);
}

export async function getToken(address) {
  return fetchJSON(`/api/tokens/${address}`);
}

export async function getAlerts() {
  return fetchJSON("/api/alerts");
}

export async function getStats() {
  return fetchJSON("/api/stats");
}

export async function getHealth() {
  return fetchJSON("/api/health");
}

export async function pingBackend() {
  try {
    const res = await fetch(API_BASE + "/api/ping");
    return res.ok;
  } catch {
    return false;
  }
}

export async function analyzeToken(address) {
  const url = API_BASE + "/api/analyze/" + address;
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `API ${res.status}`);
  }
  return res.json();
}
