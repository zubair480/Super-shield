// SuperShield API client. One origin: the pharmacy FastAPI server (:8000) serves this app,
// its own /api/* routes, and proxies the patient service under /api/patient/*.
// Owned by the foundation; portals call these, never fetch() directly.
(function () {
  async function req(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error((data && (data.error || data.detail)) || `HTTP ${res.status}`);
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  }
  const get = (u) => req("GET", u);
  const enc = encodeURIComponent;
  const qs = (o) => {
    const p = Object.entries(o || {}).filter(([, v]) => v !== undefined && v !== null && v !== "");
    return p.length ? "?" + p.map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&") : "";
  };

  const pharmacy = {
    monitor: () => get("/api/monitor/status"),
    stats: () => get("/api/stats"),
    alerts: (limit = 50) => get(`/api/pharmacy/alerts${qs({ limit })}`),
    setAlertStatus: (rn, status) => req("POST", `/api/pharmacy/alerts/${enc(rn)}/status`, { status }),
    customers: (rn, { state, limit = 25, offset = 0 } = {}) =>
      get(`/api/pharmacy/alerts/${enc(rn)}/customers${qs({ state, limit, offset })}`),
    setFollowup: (rn, customerId, status) =>
      req("POST", `/api/pharmacy/alerts/${enc(rn)}/customers/${enc(customerId)}`, { status }),
    states: (rn) => get(`/api/pharmacy/alerts/${enc(rn)}/states`),
    network: (sample = 1400) => get(`/api/pharmacies${qs({ sample })}`),
    recalls: (limit = 100) => get(`/api/shared/recalls${qs({ limit })}`),
    demoRecall: (opts = {}) => req("POST", `/api/demo/recall${qs(opts)}`),
    // Added by the backend session (see CONTRACT.md); portals must handle 404 until merged.
    summary: () => get("/api/pharmacy/summary"),
    search: (q) => get(`/api/search${qs({ q })}`),
    exportUrl: (rn) => `/api/pharmacy/alerts/${enc(rn)}/customers.csv`,
  };

  const patient = {
    list: () => get("/api/patient/patients"),
    create: (name, drugs) => req("POST", "/api/patient/patients", { name, drugs }),
    setDrugs: (id, drugs) => req("PUT", `/api/patient/patients/${enc(id)}/drugs`, { drugs }),
    notifications: (id) => get(`/api/patient/patients/${enc(id)}/notifications`),
    monitor: () => get("/api/patient/monitor/status"),
    recall: (recallId) => get(`/api/patient/recall/${enc(recallId)}`),
    drugCheck: (name) => get(`/api/patient/drug-check${qs({ name })}`),
    latestRecalls: () => get("/api/patient/recalls/latest"),
  };

  // Live pharmacy events (WebSocket). Returns an unsubscribe function.
  function stream(onEvent) {
    let ws, closed = false;
    const open = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/stream`);
      ws.onmessage = (m) => { try { onEvent(JSON.parse(m.data)); } catch {} };
      ws.onclose = () => { if (!closed) setTimeout(open, 2000); };
    };
    open();
    return () => { closed = true; ws && ws.close(); };
  }

  window.SS = window.SS || {};
  window.SS.api = { pharmacy, patient, stream };
})();
