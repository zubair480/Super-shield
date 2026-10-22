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

  // US map: states shaded by byState[metric], red bubbles at affected pharmacies.
  // byState: [{state:"CA", customers, pharmacies}], points: [[lon, lat, n]].
  const FIPS = {"01":"AL","02":"AK","04":"AZ","05":"AR","06":"CA","08":"CO","09":"CT","10":"DE","11":"DC","12":"FL","13":"GA","15":"HI","16":"ID","17":"IL","18":"IN","19":"IA","20":"KS","21":"KY","22":"LA","23":"ME","24":"MD","25":"MA","26":"MI","27":"MN","28":"MS","29":"MO","30":"MT","31":"NE","32":"NV","33":"NH","34":"NJ","35":"NM","36":"NY","37":"NC","38":"ND","39":"OH","40":"OK","41":"OR","42":"PA","44":"RI","45":"SC","46":"SD","47":"TN","48":"TX","49":"UT","50":"VT","51":"VA","53":"WA","54":"WV","55":"WI","56":"WY"};
  let atlas = null;
  const loadAtlas = () => (atlas = atlas || fetch("https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/states-10m.json").then((r) => r.json()));
  function USMap({ byState = [], points = [], metric = "customers", height = 300, onState }) {
    const ref = useRef(null);
    const [tip, setTip] = useState(null);
    useEffect(() => {
      let dead = false;
      loadAtlas().then((us) => {
        if (dead || !ref.current) return;
        const W = 760, H = 470;
        const fc = topojson.feature(us, us.objects.states);
        const proj = d3.geoAlbersUsa().fitSize([W, H], fc);
        const path = d3.geoPath(proj);
        const val = Object.fromEntries(byState.map((s) => [s.state, s[metric] || 0]));
        const max = d3.max(byState, (s) => s[metric] || 0) || 1;
        const shade = d3.scaleLinear().domain([0, max]).range(["#1b2f52", "#4f7bd1"]);
        const svg = d3.select(ref.current).attr("viewBox", `0 0 ${W} ${H}`);
        svg.selectAll("*").remove();
        svg.append("g").selectAll("path").data(fc.features).join("path")
          .attr("d", path).attr("fill", (f) => (val[FIPS[f.id]] ? shade(val[FIPS[f.id]]) : "#15284a"))
          .attr("stroke", "#2b4675").attr("stroke-width", 0.6).style("cursor", onState ? "pointer" : "default")
          .on("mousemove", (e, f) => setTip({ x: e.offsetX, y: e.offsetY, st: FIPS[f.id], v: val[FIPS[f.id]] || 0 }))
          .on("mouseleave", () => setTip(null))
          .on("click", (e, f) => onState && onState(FIPS[f.id]));
        const pts = points.map((p) => [proj([p[0], p[1]]), p[2] || 1]).filter((p) => p[0]);
        const r = d3.scaleSqrt().domain([1, d3.max(pts, (p) => p[1]) || 1]).range([2.5, 11]);
        svg.append("g").selectAll("circle").data(pts).join("circle")
          .attr("cx", (p) => p[0][0]).attr("cy", (p) => p[0][1]).attr("r", (p) => r(p[1]))
          .attr("fill", "rgba(239,68,68,.55)").attr("stroke", "#f87171").attr("stroke-width", 0.8);
      });
      return () => { dead = true; };
    }, [byState, points, metric]);
    return html`<div style=${{ position: "relative", background: "#0e1f3d", borderRadius: 12, overflow: "hidden", height }}>
      <svg ref=${ref} style=${{ width: "100%", height: "100%" }} role="img" aria-label=${`Map of affected ${metric} by state`}></svg>
      ${tip && html`<div style=${{ position: "absolute", left: tip.x + 12, top: tip.y + 12, background: "#fff", color: "#0f172a",
        padding: "4px 8px", borderRadius: 6, fontSize: 12, pointerEvents: "none", boxShadow: "0 2px 8px rgba(0,0,0,.2)" }}>
        <b>${tip.st}</b> ${fmt(tip.v)} ${metric}</div>`}
    </div>`;
  }

  window.SS = window.SS || {};
  window.SS.html = html;
  window.SS.portals = window.SS.portals || {};
  // Portals call SS.register("pharmacy" | "patient", Component). Component gets {route, navigate}.
  window.SS.register = (key, Component) => { window.SS.portals[key] = Component; };
  window.SS.ui = { USMap, Icon, Badge, ClassBadge, SyntheticBadge, LivePill, Kpi, Empty, Spinner, ErrorNote,
    Toasts, toast, usePoll, fmt, pct, ago, isSynthetic, classOf, riskOf };
})();
