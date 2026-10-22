// Shared UI primitives for both portals. Owned by the foundation.
(function () {
  const { useState, useEffect, useRef, useCallback } = React;
  const html = htm.bind(React.createElement);

  const fmt = (n) => (n == null ? "-" : Number(n).toLocaleString());
  const pct = (n) => `${Math.round(n || 0)}%`;
  function ago(iso) {
    if (!iso) return "-";
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return `${Math.round(s)}s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }
  const isSynthetic = (rn) => /^(D-SS-|DEMO-)/.test(rn || "");
  // FDA classification is the official label; never derive it from ML severity.
  const classOf = (c) => {
    const m = /(III|II|I)\b/.exec(c || "");
    return m ? `Class ${m[1]}` : "Unclassified";
  };
  const riskOf = (c) => ({ "Class I": "high", "Class II": "medium", "Class III": "low" }[classOf(c)] || "low");

  const Icon = ({ name, size, className }) =>
    html`<i className=${`ti ti-${name} ${className || ""}`} style=${size ? { fontSize: size } : null} aria-hidden="true"></i>`;

  // tone: danger | warning | success | info | neutral | synthetic
  const Badge = ({ tone = "neutral", icon, children }) =>
    html`<span className=${`ss-badge ss-${tone}`}>${icon && html`<${Icon} name=${icon} />`}${children}</span>`;

  const ClassBadge = ({ classification }) => {
    const c = classOf(classification);
    const tone = { "Class I": "danger", "Class II": "warning", "Class III": "info" }[c] || "neutral";
    return html`<${Badge} tone=${tone} icon="alert-triangle">${c}<//>`;
  };
  const SyntheticBadge = ({ rn }) => (isSynthetic(rn) ? html`<${Badge} tone="synthetic">Test recall<//>` : null);

  const LivePill = ({ label = "Live monitoring", checkedAt }) =>
    html`<div className="ss-live"><span className="ss-dot"></span><div><b>${label}</b><small>Last checked ${ago(checkedAt)}</small></div></div>`;

  const Kpi = ({ icon, value, label, sub, tone = "info" }) =>
    html`<div className="ss-card ss-kpi"><div className=${`ss-kpi-icon ss-${tone}`}><${Icon} name=${icon} /></div>
      <div><div className="ss-kpi-value">${value}</div><div className="ss-kpi-label">${label}</div>${sub && html`<div className="ss-kpi-sub">${sub}</div>`}</div></div>`;

  const Empty = ({ icon = "mood-check", title, children }) =>
    html`<div className="ss-empty"><${Icon} name=${icon} size=${28} /><b>${title}</b>${children && html`<p>${children}</p>`}</div>`;
  const Spinner = () => html`<div className="ss-spinner" role="status" aria-label="Loading"></div>`;
  const ErrorNote = ({ error }) => (error ? html`<div className="ss-error"><${Icon} name="alert-circle" />${String(error.message || error)}</div>` : null);

  // Poll an async loader; returns {data, error, loading, reload}.
  function usePoll(loader, ms, deps = []) {
    const [state, set] = useState({ data: null, error: null, loading: true });
    const ref = useRef(loader); ref.current = loader;
    const reload = useCallback(async () => {
      try { const data = await ref.current(); set({ data, error: null, loading: false }); }
      catch (error) { set((s) => ({ ...s, error, loading: false })); }
    }, []);
    useEffect(() => {
      set((s) => ({ ...s, loading: true })); reload();
      if (!ms) return undefined;
      const t = setInterval(reload, ms); return () => clearInterval(t);
    }, deps);
    return { ...state, reload };
  }

  // Toasts: SS.ui.toast("Saved") from anywhere.
  const listeners = new Set();
  const toast = (msg, tone = "success") => listeners.forEach((l) => l({ msg, tone, id: Math.random() }));
  function Toasts() {
    const [items, setItems] = useState([]);
    useEffect(() => {
      const l = (t) => { setItems((x) => [...x, t]); setTimeout(() => setItems((x) => x.filter((i) => i.id !== t.id)), 3500); };
      listeners.add(l); return () => listeners.delete(l);
    }, []);
    return html`<div className="ss-toasts">${items.map((t) => html`<div key=${t.id} className=${`ss-toast ss-${t.tone}`}>${t.msg}</div>`)}</div>`;
  }

  window.SS = window.SS || {};
  window.SS.html = html;
  window.SS.portals = window.SS.portals || {};
  // Portals call SS.register("pharmacy" | "patient", Component). Component gets {route, navigate}.
  window.SS.register = (key, Component) => { window.SS.portals[key] = Component; };
  window.SS.ui = { Icon, Badge, ClassBadge, SyntheticBadge, LivePill, Kpi, Empty, Spinner, ErrorNote,
    Toasts, toast, usePoll, fmt, pct, ago, isSynthetic, classOf, riskOf };
})();
