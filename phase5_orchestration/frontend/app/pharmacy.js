// Pharmacy portal. Owned by the pharmacy UI session (see CONTRACT.md).
// Pages: #/pharmacy (Recall Monitor), /recalls, /customers/<rn>, /notifications, /map,
// /inventory, /reports, /settings. Every number comes from SS.api.pharmacy.*.
(function () {
  const { useState, useEffect, useMemo, useRef, useCallback } = React;
  const { html, ui } = window.SS;
  const P = window.SS.api.pharmacy;
  const { Icon, Badge, ClassBadge, SyntheticBadge, Kpi, Empty, Spinner, ErrorNote, toast, usePoll, fmt, pct, ago, classOf } = ui;

  // ---------- helpers ----------

  const FIPS_ABBR = {"01":"AL","02":"AK","04":"AZ","05":"AR","06":"CA","08":"CO","09":"CT","10":"DE","11":"DC","12":"FL","13":"GA","15":"HI","16":"ID","17":"IL","18":"IN","19":"IA","20":"KS","21":"KY","22":"LA","23":"ME","24":"MD","25":"MA","26":"MI","27":"MN","28":"MS","29":"MO","30":"MT","31":"NE","32":"NV","33":"NH","34":"NJ","35":"NM","36":"NY","37":"NC","38":"ND","39":"OH","40":"OK","41":"OR","42":"PA","44":"RI","45":"SC","46":"SD","47":"TN","48":"TX","49":"UT","50":"VT","51":"VA","53":"WA","54":"WV","55":"WI","56":"WY"};
  const ABBR_NAME = {AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",DC:"District of Columbia",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming"};
  const stateName = (a) => ABBR_NAME[a] || a || "-";

  const titleCase = (s) => (s || "").toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  // Drug label from the shared recall record; falls back to the NDC, never invented.
  function drugName(a, meta) {
    const m = meta && meta[a.recall_number];
    if (m && m.generic_name) {
      // Prefer the description clause that names the drug ("Metformin ER Tablets"), not a brand/distributor prefix.
      const key = m.generic_name.split(/[\s,]+/)[0].toLowerCase();
      const clause = (m.product_description || "").split(/,|;/).map((s) => s.trim()).find((s) => key && s.toLowerCase().includes(key));
      if (clause) return clause.length > 70 ? clause.slice(0, 67) + "..." : clause;
      return titleCase(m.generic_name);
    }
    if (m && m.product_description) return m.product_description.split(/,|;/)[0].trim().slice(0, 70);
    return a.generic_name ? titleCase(a.generic_name) : `NDC ${a.product_ndc}`;
  }
  const phoneFmt = (p) => {
    const d = String(p || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
    return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p || "-";
  };
  const isActive = (a) => a.status !== "resolved";
  const byNewest = (a, b) => String(b.detected_at || "").localeCompare(String(a.detected_at || ""));

  const ALERT_STATUS = {
    new: { label: "New", tone: "danger", next: "reviewing", action: "Start review", icon: "eye" },
    reviewing: { label: "Reviewing", tone: "warning", next: "resolved", action: "Mark resolved", icon: "circle-check" },
    resolved: { label: "Resolved", tone: "success", next: "reviewing", action: "Reopen", icon: "rotate" },
  };
  // NDC matches are candidates: default state is "Needs lot check", never "Confirmed".
  const FOLLOW = {
    pending: { label: "Needs lot check", tone: "warning" },
    contacted: { label: "Contacted", tone: "info" },
    lot_verified: { label: "Lot verified", tone: "danger" },
    not_affected: { label: "Not affected", tone: "success" },
  };
  const FOLLOW_ACTIONS = [
    ["contacted", "Mark contacted", "phone-check"],
    ["lot_verified", "Lot verified", "barcode"],
    ["not_affected", "Not affected", "circle-x"],
    ["pending", "Reset to needs lot check", "rotate"],
  ];

  // Some endpoints are added by the backend session; treat 404 as "not available yet".
  const optional = (p) => p.catch((e) => { if (e.status === 404) return null; throw e; });
  // After a 404, re-check a missing route only every few minutes (keeps the console quiet).
  const missing = {};
  function optionalRoute(key, call) {
    if (missing[key] && Date.now() - missing[key] < 300000) return Promise.resolve(null);
    return optional(call()).then((r) => { if (r === null) missing[key] = Date.now(); else delete missing[key]; return r; });
  }

  // ---------- map data (cached across pages) ----------

  const MAP_W = 960, MAP_H = 600;
  let topoP, netP;
  const loadTopo = () => topoP || (topoP = d3.json("https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json").then((us) => {
    const fc = topojson.feature(us, us.objects.states);
    const proj = d3.geoAlbersUsa().fitExtent([[12, 12], [MAP_W - 12, MAP_H - 12]], fc);
    const path = d3.geoPath(proj);
    const states = fc.features.map((f) => ({ abbr: FIPS_ABBR[String(f.id).padStart(2, "0")], d: path(f), c: path.centroid(f) }))
      .filter((s) => s.abbr && s.d);
    return { proj, states, mesh: path(topojson.mesh(us, us.objects.states, (a, b) => a !== b)) };
  }).catch((e) => { topoP = null; throw e; }));
  const loadNet = () => netP || (netP = P.network(1400).catch((e) => { netP = null; throw e; }));

  // ---------- shared widgets ----------

  function MonitorPill({ monitor }) {
    if (!monitor) return null;
    const checked = monitor.last_check || monitor.last_fda_poll;
    if (monitor.running) return html`<${ui.LivePill} label="Live Monitoring" checkedAt=${checked} />`;
    return html`<div className="ss-live ph-paused"><span className="ss-dot"></span><div><b>Monitor paused</b>
      <small>${checked ? `Last checked ${ago(checked)}` : "Not polling on this server"}</small></div></div>`;
  }

  function AlertStatus({ alert, onChanged, compact }) {
    const [busy, setBusy] = useState(false);
    const s = ALERT_STATUS[alert.status] || ALERT_STATUS.new;
    const go = async () => {
      setBusy(true);
      try {
        await P.setAlertStatus(alert.recall_number, s.next);
        toast(`${alert.recall_number} marked ${ALERT_STATUS[s.next].label.toLowerCase()}`);
        onChanged && onChanged();
      } catch (e) { toast(`Couldn't update status: ${e.message}`, "danger"); }
      setBusy(false);
    };
    return html`<div className="ph-status">
      <${Badge} tone=${s.tone}>${s.label}<//>
      <button className=${`ss-btn sm ${compact ? "" : "ph-ghost"}`} disabled=${busy} onClick=${go}>
        <${Icon} name=${s.icon} />${busy ? "Saving..." : s.action}</button>
    </div>`;
  }

  function PageHead({ title, sub, monitor, children }) {
    return html`<div className="ph-pagehead">
      <div><h1 className="ss-serif">${title}</h1>${sub && html`<p>${sub}</p>`}</div>
      <div className="ph-pagehead-right">${children}<${MonitorPill} monitor=${monitor} /></div>
    </div>`;
  }

  function Segmented({ value, options, onChange }) {
    return html`<div className="ph-seg" role="tablist">
      ${options.map(([v, label]) => html`<button key=${v} role="tab" aria-selected=${value === v}
        className=${value === v ? "on" : ""} onClick=${() => onChange(v)}>${label}</button>`)}
    </div>`;
  }

  function RecallPicker({ alerts, meta, value, onChange }) {
    return html`<select className="ss-input ph-picker" value=${value} onChange=${(e) => onChange(e.target.value)} aria-label="Recall">
      ${alerts.map((a) => html`<option key=${a.recall_number} value=${a.recall_number}>
        ${a.recall_number} · ${drugName(a, meta)}${ui.isSynthetic(a.recall_number) ? " (Test recall)" : ""}${a.status === "resolved" ? " (resolved)" : ""}</option>`)}
    </select>`;
  }

  // ---------- US map ----------

  function USMap({ statesData, mode, selected, onState, showNetwork = true, bubbles = 10 }) {
    const [geo, setGeo] = useState(null);
    const [net, setNet] = useState([]);
    const [err, setErr] = useState(null);
    useEffect(() => {
      loadTopo().then(setGeo).catch(setErr);
      if (showNetwork) loadNet().then(setNet).catch(() => {});
    }, []);
    const view = useMemo(() => {
      if (!geo) return null;
      const by = (statesData && statesData.by_state) || [];
      const top = [...by].filter((s) => s[mode] > 0).sort((a, b) => b[mode] - a[mode]).slice(0, bubbles);
      const max = d3.max(top, (s) => s[mode]) || 1;
      const r = d3.scaleSqrt().domain([0, max]).range([0, 34]);
      const cent = Object.fromEntries(geo.states.map((s) => [s.abbr, s.c]));
      const hits = ((statesData && statesData.points) || []).map((p) => geo.proj([p[0], p[1]])).filter(Boolean);
      const netPts = net.map((p) => geo.proj(p)).filter(Boolean);
      const hot = new Set(by.filter((s) => s[mode] > 0).map((s) => s.state));
      return { top: top.filter((s) => cent[s.state]).map((s) => ({ ...s, xy: cent[s.state], r: Math.max(7, r(s[mode])) })), hits, netPts, hot };
    }, [geo, statesData, mode, net, bubbles]);

    if (err) return html`<div className="ph-map ph-map-msg"><${ErrorNote} error=${"Map outline couldn't load"} /></div>`;
    if (!view) return html`<div className="ph-map ph-map-msg"><${Spinner} /></div>`;
    const unit = mode === "pharmacies" ? "pharmacies" : "customers";
    return html`<div className="ph-map">
      <svg viewBox=${`0 0 ${MAP_W} ${MAP_H}`} preserveAspectRatio="xMidYMid meet" role="img"
        aria-label=${`Map of potentially affected ${unit} by state`}>
        <defs><radialGradient id="ph-bub"><stop offset="0" stop-color="#ff5a4e" stop-opacity=".95" />
          <stop offset=".65" stop-color="#e3342a" stop-opacity=".85" /><stop offset="1" stop-color="#e3342a" stop-opacity=".25" /></radialGradient></defs>
        <g>${geo.states.map((s) => html`<path key=${s.abbr} d=${s.d}
          className=${`ph-state ${view.hot.has(s.abbr) ? "hot" : ""} ${selected === s.abbr ? "sel" : ""}`}
          onClick=${() => onState && onState(selected === s.abbr ? "" : s.abbr)}><title>${stateName(s.abbr)}</title></path>`)}</g>
        <path d=${geo.mesh} className="ph-mesh" />
        <g className="ph-net">${view.netPts.map((p, i) => html`<circle key=${i} cx=${p[0]} cy=${p[1]} r="1.3" />`)}</g>
        <g className="ph-hits">${view.hits.map((p, i) => html`<circle key=${i} cx=${p[0]} cy=${p[1]} r="2.4" />`)}</g>
        <g>${view.top.map((s) => html`<g key=${s.state} className=${`ph-bubble ${selected === s.state ? "sel" : ""}`}
            transform=${`translate(${s.xy[0]},${s.xy[1]})`} onClick=${() => onState && onState(selected === s.state ? "" : s.state)}>
          <title>${stateName(s.state)}: ${fmt(s.customers)} customers, ${fmt(s.pharmacies)} pharmacies</title>
          <circle r=${s.r * 1.6} className="ph-glow" /><circle r=${s.r} fill="url(#ph-bub)" />
          ${s.r >= 11 && html`<text dy="0.35em" style=${{ fontSize: Math.min(20, Math.max(11, s.r * 0.62)) }}>${fmt(s[mode])}</text>`}
        </g>`)}</g>
      </svg>
      <div className="ph-map-legend">
        <span><i className="dot hit"></i>Affected pharmacy</span>
        ${showNetwork && html`<span><i className="dot net"></i>Network pharmacy (sample)</span>`}
        <span><i className="dot bub"></i>Top states by ${unit}</span>
      </div>
    </div>`;
  }

  function TopStates({ statesData, mode, selected, onState, limit = 5 }) {
    const by = [...((statesData && statesData.by_state) || [])].sort((a, b) => b[mode] - a[mode]);
    if (!by.length) return html`<${Empty} icon="map-pin-off" title="No state data" />`;
    const top = by.slice(0, limit);
    const rest = by.slice(limit).reduce((n, s) => n + s[mode], 0);
    const max = Math.max(1, ...top.map((s) => s[mode]));
    const Row = ({ label, value, abbr }) => html`<button className=${`ph-srow ${abbr && selected === abbr ? "sel" : ""}`}
        disabled=${!abbr} onClick=${() => abbr && onState && onState(selected === abbr ? "" : abbr)}
        title=${abbr ? `Filter the customer list to ${label}` : ""}>
      <span className="ph-sname">${label}</span>
      <span className=${`ph-sbar ${abbr ? "" : "other"}`}><i style=${{ width: `${Math.min(100, (value / max) * 100)}%` }}></i></span>
      <b>${fmt(value)}</b></button>`;
    return html`<div className="ph-states">
      ${top.map((s) => html`<${Row} key=${s.state} label=${stateName(s.state)} value=${s[mode]} abbr=${s.state} />`)}
      ${rest > 0 && html`<${Row} label="Others" value=${rest} />`}
    </div>`;
  }

  function LocationCard({ alert, statesData, error, state, setState, title = "Affected Customers by Location" }) {
    const [mode, setMode] = useState("customers");
    return html`<section className="ss-card ph-loc">
      <div className="ph-card-head">
        <h2>${title}</h2>
        <${Segmented} value=${mode} onChange=${setMode} options=${[["customers", "Customers"], ["pharmacies", "Pharmacies"]]} />
      </div>
      <${ErrorNote} error=${error} />
      <div className="ph-loc-body">
        <${USMap} statesData=${statesData} mode=${mode} selected=${state} onState=${setState} />
        <div className="ph-loc-side">
          <h3>Top Affected States</h3>
          ${statesData ? html`<${TopStates} statesData=${statesData} mode=${mode} selected=${state} onState=${setState} />` : html`<${Spinner} />`}
          ${statesData && html`<p className="ph-muted ph-small">${fmt(statesData.total_customers)} customers at ${fmt(statesData.total_pharmacies)} pharmacies
            in ${fmt(statesData.total_states)} states match NDC ${alert.product_ndc}. Click a state to filter the list.</p>`}
        </div>
      </div>
    </section>`;
  }

  // ---------- affected customers table ----------

  function useOutside(onOut) {
    const ref = useRef(null);
    useEffect(() => {
      const h = (e) => { if (ref.current && !ref.current.contains(e.target)) onOut(); };
      document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h);
    }, [onOut]);
    return ref;
  }

  function RowMenu({ row, onSet, disabled }) {
    const [open, setOpen] = useState(false);
    const close = useCallback(() => setOpen(false), []);
    const ref = useOutside(close);
    return html`<div className="ph-menu" ref=${ref}>
      <button className="ss-btn sm ph-icon-btn" aria-label="More actions" aria-expanded=${open} disabled=${disabled}
        onClick=${() => setOpen(!open)}><${Icon} name="dots" /></button>
      ${open && html`<div className="ph-menu-pop" role="menu">
        ${FOLLOW_ACTIONS.filter(([s]) => s !== row.followup).map(([s, label, icon]) => html`<button key=${s} role="menuitem"
          onClick=${() => { setOpen(false); onSet(row, s); }}><${Icon} name=${icon} />${label}</button>`)}
      </div>`}
    </div>`;
  }

  function pageList(cur, n) {
    if (n <= 7) return [...Array(n).keys()];
    const s = new Set([0, n - 1, cur - 1, cur, cur + 1].filter((i) => i >= 0 && i < n));
    const out = []; let prev = -1;
    [...s].sort((a, b) => a - b).forEach((i) => { if (i - prev > 1) out.push("..."); out.push(i); prev = i; });
    return out;
  }

  function CustomersTable({ alert, state, setState, pageSize = 8, onCounts }) {
    const rn = alert.recall_number;
    const [page, setPage] = useState(0);
    const [q, setQ] = useState("");
    const [fs, setFs] = useState("all");
    const [res, setRes] = useState({ data: null, error: null, loading: true });
    const [sel, setSel] = useState(() => new Set());
    const [busy, setBusy] = useState("");
    const reqId = useRef(0);
    const local = q.trim() !== "" || fs !== "all"; // search/filter run over the full list client-side

    const load = useCallback(async () => {
      const id = ++reqId.current; // a slower, older response must not overwrite a newer one
      setRes((r) => ({ ...r, loading: true }));
      try {
        let data;
        if (local) {
          // Server caps limit at 500: page through offsets to search the whole list.
          data = await P.customers(rn, { state, limit: 500, offset: 0 });
          while (data.customers.length < data.total && id === reqId.current) {
            const more = await P.customers(rn, { state, limit: 500, offset: data.customers.length });
            if (!more.customers.length) break;
            data = { ...data, customers: data.customers.concat(more.customers) };
          }
        } else data = await P.customers(rn, { state, limit: pageSize, offset: page * pageSize });
        if (id !== reqId.current) return;
        setRes({ data, error: null, loading: false });
        onCounts && onCounts(data);
      } catch (error) { if (id === reqId.current) setRes((r) => ({ ...r, error, loading: false })); }
    }, [rn, state, local, page, pageSize]);
    useEffect(() => { load(); }, [load]);
    useEffect(() => { setPage(0); setSel(new Set()); }, [rn, state, q, fs]);
    const exportCsv = async () => {
      // The CSV route comes from the backend session; download it, or say so if it isn't there yet.
      try {
        const r = await fetch(P.exportUrl(rn));
        if (!r.ok) { toast(r.status === 404 ? "CSV export isn't available on this server yet" : `Export failed (HTTP ${r.status})`, "danger"); return; }
        const a = document.createElement("a");
        a.href = URL.createObjectURL(await r.blob()); a.download = `${rn}-affected-customers.csv`;
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      } catch (e) { toast(`Export failed: ${e.message}`, "danger"); }
    };

    const data = res.data;
    const counts = useMemo(() => {
      const fc = (data && data.followup_counts) || {};
      const total = data ? data.total : 0;
      const done = (fc.contacted || 0) + (fc.lot_verified || 0) + (fc.not_affected || 0);
      return { total, contacted: fc.contacted || 0, lot_verified: fc.lot_verified || 0, not_affected: fc.not_affected || 0,
        pending: Math.max(0, total - done) }; // "pending" rows only exist after a reset; untouched customers count too
    }, [data]);

    let rows = (data && data.customers) || [], shown = data ? data.total : 0, pages = Math.max(1, Math.ceil(shown / pageSize));
    if (local && data) {
      const needle = q.trim().toLowerCase(), digits = needle.replace(/\D/g, "");
      const all = rows.filter((c) => (fs === "all" || c.followup === fs) && (!needle ||
        [c.name, c.pharmacy, c.chain, c.ndc, c.customer_id, c.state].some((v) => String(v || "").toLowerCase().includes(needle)) ||
        (digits.length >= 3 && String(c.phone || "").includes(digits))));
      shown = all.length; pages = Math.max(1, Math.ceil(shown / pageSize));
      rows = all.slice(page * pageSize, page * pageSize + pageSize);
    }
    const from = shown ? page * pageSize + 1 : 0, to = Math.min(shown, page * pageSize + rows.length);

    const patch = (ids, status) => setRes((r) => r.data ? ({ ...r, data: { ...r.data,
      customers: r.data.customers.map((c) => (ids.has(c.customer_id) ? { ...c, followup: status } : c)) } }) : r);

    const setFollow = async (row, status) => {
      setBusy(row.customer_id); patch(new Set([row.customer_id]), status);
      try {
        await P.setFollowup(rn, row.customer_id, status);
        toast(`${row.name}: ${FOLLOW[status].label.toLowerCase()}`);
      } catch (e) { toast(`Couldn't save follow-up: ${e.message}`, "danger"); }
      setBusy(""); load();
    };
    const bulk = async (status) => {
      const ids = new Set(sel); setBusy("bulk"); patch(ids, status);
      const out = await Promise.allSettled([...ids].map((id) => P.setFollowup(rn, id, status)));
      const bad = out.filter((o) => o.status === "rejected").length;
      toast(bad ? `${bad} of ${ids.size} updates failed` : `${ids.size} customers: ${FOLLOW[status].label.toLowerCase()}`, bad ? "danger" : "success");
      setSel(new Set()); setBusy(""); load();
    };
    const toggle = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
    const pageIds = rows.map((r) => r.customer_id);
    const allSel = pageIds.length > 0 && pageIds.every((id) => sel.has(id));

    const primary = (c) => c.followup === "pending" ? ["contacted", "Mark contacted", "primary"]
      : c.followup === "contacted" ? ["lot_verified", "Lot verified", ""] : ["pending", "Reset", ""];

    return html`<section className="ss-card ph-table-card">
      <div className="ph-card-head ph-table-head">
        <h2>Affected Customers <span className="ph-muted">(${fmt(counts.total)})</span></h2>
        <div className="ph-tools">
          <label className="ph-search sm"><${Icon} name="search" />
            <input value=${q} onInput=${(e) => setQ(e.target.value)} placeholder="Search by name, phone, NDC or pharmacy..." aria-label="Search customers" /></label>
          <select className="ss-input ph-filter" value=${fs} onChange=${(e) => setFs(e.target.value)} aria-label="Filter by follow-up status">
            <option value="all">All statuses (${fmt(counts.total)})</option>
            ${Object.entries(FOLLOW).map(([k, f]) => html`<option key=${k} value=${k}>${f.label} (${fmt(counts[k])})</option>`)}
          </select>
          <button className="ss-btn ph-export" onClick=${exportCsv}><${Icon} name="file-export" />Export</button>
        </div>
      </div>
      <div className="ph-chips">
        <${Badge} tone="warning" icon="alert-triangle">Potentially affected: NDC match, lot not yet checked<//>
        ${state && html`<button className="ph-chip" onClick=${() => setState("")}><${Icon} name="map-pin" />${stateName(state)}<${Icon} name="x" /></button>`}
        ${sel.size > 0 && html`<span className="ph-bulk"><b>${sel.size} selected</b>
          <button className="ss-btn sm" disabled=${!!busy} onClick=${() => bulk("contacted")}><${Icon} name="phone-check" />Mark contacted</button>
          <button className="ss-btn sm" disabled=${!!busy} onClick=${() => bulk("not_affected")}><${Icon} name="circle-x" />Not affected</button>
          <button className="ss-btn sm" disabled=${!!busy} onClick=${() => setSel(new Set())}>Clear</button></span>`}
      </div>
      <${ErrorNote} error=${res.error} />
      <div className="ph-table-wrap">
        <table className="ss-table ph-table">
          <thead><tr>
            <th className="ph-cb"><input type="checkbox" aria-label="Select page" checked=${allSel}
              onChange=${() => setSel((s) => { const n = new Set(s); pageIds.forEach((id) => (allSel ? n.delete(id) : n.add(id))); return n; })} /></th>
            <th>Customer</th><th>Phone</th><th>Pharmacy</th><th>State</th><th>NDC / Product</th><th>Match Status</th><th>Action</th>
          </tr></thead>
          <tbody>
            ${rows.map((c, i) => {
              const f = FOLLOW[c.followup] || FOLLOW.pending; const [ns, nl, cls] = primary(c);
              return html`<tr key=${`${c.customer_id}-${c.pharmacy_id}-${i}`} className=${sel.has(c.customer_id) ? "sel" : ""}>
                <td className="ph-cb"><input type="checkbox" aria-label=${`Select ${c.name}`} checked=${sel.has(c.customer_id)} onChange=${() => toggle(c.customer_id)} /></td>
                <td><b>${c.name}</b><div className="ph-muted ph-small">${c.customer_id}</div></td>
                <td className="ph-nowrap">${phoneFmt(c.phone)}</td>
                <td>${c.pharmacy}</td>
                <td title=${stateName(c.state)}>${c.state}</td>
                <td className="ph-nowrap"><span className="ph-mono">${c.ndc}</span><div className="ph-muted ph-small">NDC candidate</div></td>
                <td><${Badge} tone=${f.tone}>${f.label}<//></td>
                <td><div className="ph-actions">
                  <button className=${`ss-btn sm ${cls}`} disabled=${busy === c.customer_id || busy === "bulk"} onClick=${() => setFollow(c, ns)}>${nl}</button>
                  <${RowMenu} row=${c} onSet=${setFollow} disabled=${busy === c.customer_id || busy === "bulk"} />
                </div></td>
              </tr>`;
            })}
          </tbody>
        </table>
        ${res.loading && !data && html`<${Spinner} />`}
        ${data && !rows.length && html`<${Empty} icon="users" title="No customers match">Try another search, status or state.<//>`}
      </div>
      <div className="ph-pager">
        <span className="ph-muted">Showing ${fmt(from)}–${fmt(to)} of ${fmt(shown)} customers${res.loading && data ? " · updating..." : ""}</span>
        <div className="ph-pages">
          <button aria-label="Previous page" disabled=${page === 0} onClick=${() => setPage(page - 1)}><${Icon} name="chevron-left" /></button>
          ${pageList(page, pages).map((p, i) => p === "..." ? html`<span key=${`e${i}`}>...</span>`
            : html`<button key=${p} className=${p === page ? "on" : ""} onClick=${() => setPage(p)}>${p + 1}</button>`)}
          <button aria-label="Next page" disabled=${page >= pages - 1} onClick=${() => setPage(page + 1)}><${Icon} name="chevron-right" /></button>
        </div>
      </div>
    </section>`;
  }

  // ---------- recall hero + KPIs ----------

  function Hero({ alert, meta, index, count, onNext, onChanged, navigate }) {
    const cls = classOf(alert.classification);
    const fdaUrl = /^https?:/.test(alert.source_url || "") ? alert.source_url : null;
    const risk = { "Class I": "Class I recall · highest risk", "Class II": "Class II recall", "Class III": "Class III recall" }[cls] || "FDA recall";
    return html`<section className=${`ph-hero ${cls === "Class I" ? "" : "ph-hero-amber"}`}>
      <div className="ph-hero-icon"><${Icon} name="alert-triangle-filled" /></div>
      <div className="ph-hero-main">
        <div className="ph-eyebrow">${risk} <${SyntheticBadge} rn=${alert.recall_number} /></div>
        <h2 className="ss-serif">${drugName(alert, meta)}</h2>
        <div className="ph-hero-meta">
          <span>NDC <b className="ph-mono">${alert.product_ndc}</b></span><span className="sep">|</span>
          <span>Manufacturer: ${alert.recalling_firm || "-"}</span><span className="sep">|</span>
          <span className="ph-mono">${alert.recall_number}</span>
        </div>
        <p className="ph-hero-reason"><b>Reason:</b> ${alert.reason_for_recall || "Not stated by FDA"}</p>
        <div className="ph-hero-btns">
          <button className="ss-btn danger" onClick=${() => navigate(`pharmacy/customers/${alert.recall_number}`)}>
            Review Affected Customers <${Icon} name="arrow-right" /></button>
          ${fdaUrl ? html`<a className="ss-btn" href=${fdaUrl} target="_blank" rel="noopener">View FDA Notice <${Icon} name="external-link" /></a>`
            : html`<button className="ss-btn" disabled title="Synthetic test recall: there is no FDA notice">View FDA Notice <${Icon} name="external-link" /></button>`}
        </div>
      </div>
      <div className="ph-hero-side">
        <span className="ph-muted">Detected ${ago(alert.detected_at)}</span>
        <${ClassBadge} classification=${alert.classification} />
        <${AlertStatus} alert=${alert} onChanged=${onChanged} />
        <div className="ph-hero-tile"><${Icon} name="pill" /></div>
      </div>
      ${count > 1 && html`<button className="ph-hero-next" onClick=${onNext} title="Next unresolved alert" aria-label="Next unresolved alert">
        <${Icon} name="chevron-right" /><small>${index + 1}/${count}</small></button>`}
    </section>`;
  }

  function KpiRow({ alert, summary, counts }) {
    if (summary) {
      const f = summary.followups || {};
      return html`<div className="ph-kpis" aria-label="All active recalls">
        <${Kpi} icon="users" tone="info" value=${fmt(summary.affected_customers)} label="Potentially Affected Customers" sub=${`across ${fmt(summary.active_recalls)} active recalls`} />
        <${Kpi} icon="building-store" tone="info" value=${fmt(summary.affected_pharmacies)} label="Pharmacy Locations" sub=${`in ${fmt(summary.affected_states)} states`} />
        <${Kpi} icon="package" tone="warning" value=${fmt(summary.lots_pending_verification)} label="Lots Pending Verification" sub=${`${fmt(f.lot_verified || 0)} lot verified`} />
        <${Kpi} icon="send" tone="info" value=${pct(summary.notifications_prepared_pct)} label="Notifications Prepared" sub=${`${fmt(f.contacted || 0)} contacted`} />
      </div>`;
    }
    // Fallback until /api/pharmacy/summary exists: scope KPIs to the recall shown in the hero.
    const total = counts ? counts.total : alert.customers;
    const fc = (counts && counts.followup_counts) || {};
    const done = (fc.contacted || 0) + (fc.lot_verified || 0) + (fc.not_affected || 0);
    return html`<div className="ph-kpis" aria-label=${`Impact of ${alert.recall_number}`}>
      <${Kpi} icon="users" tone="info" value=${fmt(alert.customers)} label="Potentially Affected Customers" sub="NDC candidates for this recall" />
      <${Kpi} icon="building-store" tone="info" value=${fmt(alert.pharmacies)} label="Pharmacy Locations" sub=${`in ${fmt(alert.states)} states`} />
      <${Kpi} icon="package" tone="warning" value=${counts ? fmt(Math.max(0, total - done)) : "-"} label="Need Lot Check" sub=${`${fmt(fc.lot_verified || 0)} lot verified`} />
      <${Kpi} icon="send" tone="info" value=${counts ? pct(total ? (done / total) * 100 : 0) : "-"} label="Follow-ups Done" sub=${counts ? `${fmt(done)} of ${fmt(total)}` : ""} />
    </div>`;
  }

  function useStates(rn) {
    return usePoll(() => (rn ? P.states(rn) : Promise.resolve(null)), 0, [rn]);
  }

  // ---------- pages ----------

  function Dashboard({ ctx, navigate }) {
    const { alerts, meta, summary, monitor, reloadAlerts } = ctx;
    const active = useMemo(() => alerts.filter(isActive).sort(byNewest), [alerts]);
    const [idx, setIdx] = useState(0);
    const [state, setState] = useState("");
    const [counts, setCounts] = useState(null);
    const hero = active[Math.min(idx, active.length - 1)];
    const rn = hero && hero.recall_number;
    const st = useStates(rn);
    useEffect(() => { setState(""); setCounts(null); }, [rn]);
    const head = html`<${PageHead} title="FDA Drug Recall Monitor" monitor=${monitor}
      sub="Real-time detection and customer impact analysis for your pharmacy network." />`;
    if (!hero) return html`${head}<section className="ss-card"><${Empty} icon="shield-check" title="No unresolved recall alerts">
      New FDA recalls that match an NDC in the network appear here automatically.<//></section>`;
    return html`${head}
      <${Hero} alert=${hero} meta=${meta} index=${idx} count=${active.length} navigate=${navigate}
        onNext=${() => setIdx((idx + 1) % active.length)} onChanged=${reloadAlerts} />
      <${KpiRow} alert=${hero} summary=${summary} counts=${counts} />
      <${LocationCard} alert=${hero} statesData=${st.data} error=${st.error} state=${state} setState=${setState} />
      <${CustomersTable} alert=${hero} state=${state} setState=${setState} pageSize=${5} onCounts=${state ? null : setCounts} />`;
  }

  function RecallsPage({ ctx, navigate }) {
    const { alerts, meta, monitor, reloadAlerts } = ctx;
    const [tab, setTab] = useState("active");
    const [q, setQ] = useState("");
    const list = useMemo(() => {
      const n = q.trim().toLowerCase();
      return alerts.filter((a) => (tab === "all" || (tab === "active" ? isActive(a) : a.status === "resolved")) &&
        (!n || [a.recall_number, a.product_ndc, a.recalling_firm, drugName(a, meta)].some((v) => String(v || "").toLowerCase().includes(n))))
        .sort(byNewest);
    }, [alerts, tab, q, meta]);
    const nActive = alerts.filter(isActive).length;
    return html`<${PageHead} title="Active Recalls" monitor=${monitor}
        sub="FDA enforcement reports that match NDCs dispensed in the SuperShield network." />
      <section className="ss-card ph-table-card">
        <div className="ph-card-head">
          <${Segmented} value=${tab} onChange=${setTab} options=${[["active", `Active (${nActive})`], ["resolved", `Resolved (${alerts.length - nActive})`], ["all", `All (${alerts.length})`]]} />
          <label className="ph-search sm"><${Icon} name="search" />
            <input value=${q} onInput=${(e) => setQ(e.target.value)} placeholder="Filter by recall, NDC, drug or firm..." aria-label="Filter recalls" /></label>
        </div>
        <div className="ph-table-wrap"><table className="ss-table ph-table">
          <thead><tr><th>Recall</th><th>FDA Class</th><th>Firm</th><th>NDC</th><th className="num">Customers</th><th className="num">Pharmacies</th><th>Detected</th><th>Status</th><th></th></tr></thead>
          <tbody>${list.map((a) => html`<tr key=${a.recall_number}>
            <td><b>${drugName(a, meta)}</b><div className="ph-small ph-muted"><span className="ph-mono">${a.recall_number}</span> <${SyntheticBadge} rn=${a.recall_number} /></div></td>
            <td><${ClassBadge} classification=${a.classification} /></td>
            <td className="ph-firm">${a.recalling_firm}</td>
            <td className="ph-mono ph-nowrap">${a.product_ndc}</td>
            <td className="num">${fmt(a.customers)}</td><td className="num">${fmt(a.pharmacies)}</td>
            <td className="ph-nowrap" title=${a.detected_at}>${ago(a.detected_at)}</td>
            <td><${AlertStatus} alert=${a} onChanged=${reloadAlerts} compact /></td>
            <td><button className="ss-btn sm primary" onClick=${() => navigate(`pharmacy/customers/${a.recall_number}`)}>Customers<${Icon} name="arrow-right" /></button></td>
          </tr>`)}</tbody>
        </table>
        ${!list.length && html`<${Empty} icon="search" title="No recalls match" />`}</div>
      </section>`;
  }

  function CustomersPage({ ctx, route, navigate }) {
    const { alerts, meta, monitor, reloadAlerts } = ctx;
    const sorted = useMemo(() => [...alerts].sort(byNewest), [alerts]);
    const fallback = sorted.find(isActive) || sorted[0];
    const alert = route.id ? alerts.find((a) => a.recall_number === route.id) : fallback;
    const [state, setState] = useState((route.query && route.query[0]) || "");
    useEffect(() => { setState((route.query && route.query[0]) || ""); }, [route.id]);
    const st = useStates(alert && alert.recall_number);
    const pick = (v) => navigate(`pharmacy/customers/${v}`);
    if (!alert) return html`<${PageHead} title="Affected Customers" monitor=${monitor} />
      <section className="ss-card"><${Empty} icon="file-search" title=${route.id ? `Recall ${route.id} isn't in the alert list` : "No recall alerts yet"} /></section>`;
    return html`<${PageHead} title="Affected Customers" monitor=${monitor}
        sub="Customers whose dispensed NDC matches the recall. Check each lot before treating anyone as affected.">
        <${RecallPicker} alerts=${sorted} meta=${meta} value=${alert.recall_number} onChange=${pick} />
      <//>
      <section className="ss-card ph-recall-strip">
        <div><div className="ph-eyebrow-row"><${ClassBadge} classification=${alert.classification} /><${SyntheticBadge} rn=${alert.recall_number} />
          <span className="ph-mono ph-muted">${alert.recall_number}</span></div>
          <h2 className="ss-serif">${drugName(alert, meta)}</h2>
          <p className="ph-muted">NDC ${alert.product_ndc} · ${alert.recalling_firm} · detected ${ago(alert.detected_at)}</p>
          <p className="ph-small"><b>Reason:</b> ${alert.reason_for_recall}</p></div>
        <div className="ph-strip-nums">
          <div><b>${fmt(alert.customers)}</b><span>customers</span></div>
          <div><b>${fmt(alert.pharmacies)}</b><span>pharmacies</span></div>
          <div><b>${fmt(alert.states)}</b><span>states</span></div>
          <${AlertStatus} alert=${alert} onChanged=${reloadAlerts} />
        </div>
      </section>
      <${LocationCard} alert=${alert} statesData=${st.data} error=${st.error} state=${state} setState=${setState} />
      <${CustomersTable} alert=${alert} state=${state} setState=${setState} pageSize=${15} />`;
  }

  const PUSH = (s) => {
    if (!s) return ["neutral", "Not pushed"];
    if (s.startsWith("sent:")) return ["success", `Sent via ${titleCase(s.slice(5))}`];
    if (s === "skipped_backfill") return ["neutral", "Not pushed (historical backfill)"];
    if (s.startsWith("skipped")) return ["neutral", `Not pushed (${s.replace(/^skipped_?/, "").replace(/_/g, " ") || "skipped"})`];
    return ["danger", s.replace(/_/g, " ")];
  };

  function NotificationsPage({ ctx, navigate }) {
    const { alerts, meta, monitor, events } = ctx;
    const [onlyPushed, setOnlyPushed] = useState(false);
    const list = alerts.filter((a) => !onlyPushed || String(a.push_status || "").startsWith("sent:")).sort(byNewest);
    const pushed = alerts.filter((a) => String(a.push_status || "").startsWith("sent:")).length;
    return html`<${PageHead} title="Notifications" monitor=${monitor} sub="Pharmacist alerts created by the monitor and where each was pushed." />
      <div className="ph-two">
        <section className="ss-card ph-table-card">
          <div className="ph-card-head"><h2>Pharmacist alerts</h2>
            <${Segmented} value=${onlyPushed ? "p" : "a"} onChange=${(v) => setOnlyPushed(v === "p")}
              options=${[["a", `All (${alerts.length})`], ["p", `Pushed (${pushed})`]]} /></div>
          <ul className="ph-feed">${list.map((a) => { const [tone, label] = PUSH(a.push_status); return html`<li key=${a.recall_number}>
            <div className=${`ph-feed-icon ${a.status === "new" ? "new" : ""}`}><${Icon} name=${a.status === "new" ? "bell-ringing" : "bell"} /></div>
            <div className="ph-feed-main"><b>${drugName(a, meta)}</b>
              <div className="ph-small ph-muted"><span className="ph-mono">${a.recall_number}</span> · ${fmt(a.customers)} customers · ${ago(a.detected_at)}</div>
              <div className="ph-feed-badges"><${ClassBadge} classification=${a.classification} /><${SyntheticBadge} rn=${a.recall_number} />
                <${Badge} tone=${tone} icon="send">${label}<//><${Badge} tone=${ALERT_STATUS[a.status] ? ALERT_STATUS[a.status].tone : "neutral"}>${(ALERT_STATUS[a.status] || {}).label || a.status}<//></div></div>
            <button className="ss-btn sm" onClick=${() => navigate(`pharmacy/customers/${a.recall_number}`)}>Open</button>
          </li>`; })}</ul>
          ${!list.length && html`<${Empty} icon="bell-off" title="No alerts" />`}
        </section>
        <div className="ph-col">
          <section className="ss-card ph-pad">
            <h2>Monitor</h2>
            ${monitor ? html`<dl className="ph-dl">
              <dt>State</dt><dd>${monitor.running ? html`<${Badge} tone="success">Running<//>` : html`<${Badge} tone="neutral">Paused on this server<//>`}</dd>
              <dt>Push channel</dt><dd>${monitor.push_channel ? titleCase(monitor.push_channel) : "None configured"}</dd>
              <dt>Alerts created</dt><dd>${fmt(monitor.alerts_created)} since start</dd>
              <dt>Last FDA poll</dt><dd>${monitor.last_fda_poll ? ago(monitor.last_fda_poll) : "Not yet"}</dd>
              <dt>Poll interval</dt><dd>${monitor.fda_poll_sec ? `${Math.round(monitor.fda_poll_sec / 60)} min` : "-"}</dd>
              ${monitor.last_fda_error && html`<dt>Last error</dt><dd className="ph-err">${monitor.last_fda_error}</dd>`}
            </dl>` : html`<${Spinner} />`}
          </section>
          <section className="ss-card ph-pad">
            <h2>Live events</h2>
            <p className="ph-small ph-muted">Received over the live stream while this page is open.</p>
            ${events.length ? html`<ul className="ph-events">${events.slice(0, 30).map((e, i) => html`<li key=${i}>
              <span className="ph-mono">${e.stage}</span><span>${e.recall_number || ""} <${SyntheticBadge} rn=${e.recall_number} /></span>
              <small>${e.ts ? ago(new Date(e.ts * 1000).toISOString()) : ""}</small></li>`)}</ul>`
              : html`<${Empty} icon="broadcast" title="No events yet">They appear here as the monitor processes recalls.<//>`}
          </section>
        </div>
      </div>`;
  }

  function MapPage({ ctx, navigate }) {
    const { alerts, meta, monitor, stats } = ctx;
    const sorted = useMemo(() => [...alerts].sort(byNewest), [alerts]);
    const [rn, setRn] = useState("");
    const cur = (rn && alerts.find((a) => a.recall_number === rn)) || sorted.find(isActive) || sorted[0];
    const [mode, setMode] = useState("customers");
    const [state, setState] = useState("");
    const st = useStates(cur && cur.recall_number);
    const by = st.data ? [...st.data.by_state].sort((a, b) => b[mode] - a[mode]) : [];
    return html`<${PageHead} title="Network Map" monitor=${monitor}
        sub=${stats ? `SuperShield network: ${fmt(stats.total_pharmacies)} pharmacies, ${fmt(stats.total_customers_indexed)} customers indexed.` : "SuperShield pharmacy network."}>
        ${cur && html`<${RecallPicker} alerts=${sorted} meta=${meta} value=${cur.recall_number} onChange=${(v) => { setRn(v); setState(""); }} />`}
      <//>
      ${!cur ? html`<section className="ss-card"><${Empty} icon="map" title="No recall alerts to map" /></section>` : html`
      <section className="ss-card ph-loc">
        <div className="ph-card-head"><h2>${drugName(cur, meta)} <span className="ph-muted ph-mono">${cur.recall_number}</span></h2>
          <${Segmented} value=${mode} onChange=${setMode} options=${[["customers", "Customers"], ["pharmacies", "Pharmacies"]]} /></div>
        <${ErrorNote} error=${st.error} />
        <div className="ph-map-big"><${USMap} statesData=${st.data} mode=${mode} selected=${state} onState=${setState} bubbles=${16} /></div>
      </section>
      <section className="ss-card ph-table-card">
        <div className="ph-card-head"><h2>All states</h2>
          ${state && html`<button className="ss-btn sm primary" onClick=${() => navigate(`pharmacy/customers/${cur.recall_number}/${state}`)}>
            Open customer list<${Icon} name="arrow-right" /></button>`}</div>
        ${st.data ? html`<div className="ph-table-wrap"><table className="ss-table ph-table">
          <thead><tr><th>State</th><th className="num">Customers</th><th className="num">Pharmacies</th><th>Share of customers</th></tr></thead>
          <tbody>${by.map((s) => html`<tr key=${s.state} className=${state === s.state ? "sel" : ""} onClick=${() => setState(state === s.state ? "" : s.state)} style=${{ cursor: "pointer" }}>
            <td><b>${stateName(s.state)}</b> <span className="ph-muted">${s.state}</span></td>
            <td className="num">${fmt(s.customers)}</td><td className="num">${fmt(s.pharmacies)}</td>
            <td><span className="ph-sbar wide"><i style=${{ width: `${(s.customers / Math.max(1, st.data.total_customers)) * 100}%` }}></i></span>
              <span className="ph-small ph-muted">${pct((s.customers / Math.max(1, st.data.total_customers)) * 100)}</span></td>
          </tr>`)}</tbody></table></div>` : html`<${Spinner} />`}
      </section>`}`;
  }

  const SOON = {
    inventory: ["Inventory Check", "packages", "Checking recalled lots against on-hand stock needs an inventory feed from the pharmacy system. SuperShield doesn't have one yet, so nothing is shown here rather than guessed numbers."],
    reports: ["Reports", "report-analytics", "Recall response reports aren't built yet. Until then, use the Affected Customers list (and its Export, when available) for per-recall follow-up records."],
    settings: ["Settings", "settings", "Pharmacy settings (notification channels, staff accounts, store selection) aren't configurable from the UI yet."],
  };
  function SoonPage({ page, monitor, navigate }) {
    const [title, icon, text] = SOON[page];
    return html`<${PageHead} title=${title} monitor=${monitor} />
      <section className="ss-card ph-soon"><div className="ph-soon-icon"><${Icon} name=${icon} /></div>
        <h2>Not available yet</h2><p>${text}</p>
        <button className="ss-btn" onClick=${() => navigate("pharmacy")}><${Icon} name="arrow-left" />Back to Recall Monitor</button>
      </section>`;
  }

  // ---------- chrome: sidebar + topbar ----------

  const NAV = [
    ["", "Recall Monitor", "shield-half-filled"], ["recalls", "Active Recalls", "alert-octagon"],
    ["customers", "Affected Customers", "users"], ["inventory", "Inventory Check", "clipboard-list"],
    ["notifications", "Notifications", "bell"], ["map", "Network Map", "map-2"],
    ["reports", "Reports", "chart-bar"], ["settings", "Settings", "settings"],
  ];

  function Sidebar({ page, ctx }) {
    const { alerts, monitor, stats, summary } = ctx;
    const nActive = alerts.filter(isActive).length;
    const net = (summary && summary.network) || (stats && { pharmacies: stats.total_pharmacies, customers: stats.total_customers_indexed });
    const checked = monitor && (monitor.last_check || monitor.last_fda_poll);
    return html`<aside className="ph-side">
      <a className="ph-brand" href="#/pharmacy"><span className="ph-logo"><${Icon} name="shield-check-filled" /></span>
        <span><b>SuperShield</b><small>Pharmacy</small></span></a>
      <nav>${NAV.map(([p, label, icon]) => html`<a key=${p} href=${`#/pharmacy${p ? "/" + p : ""}`}
          className=${page === p ? "on" : ""} aria-current=${page === p ? "page" : null}>
        <${Icon} name=${icon} /><span>${label}</span>
        ${p === "recalls" && nActive > 0 && html`<em>${nActive > 99 ? "99+" : nActive}</em>`}</a>`)}</nav>
      <div className="ph-side-card">
        <div className="ph-side-net"><span className="ph-side-ic"><${Icon} name="building-hospital" /></span>
          <div><b>SuperShield network</b><small>All member pharmacies</small></div></div>
        <div className="ph-side-num"><b>${net ? fmt(net.pharmacies) : "-"}</b><span>Pharmacies</span></div>
        <div className="ph-side-num"><b>${net ? fmt(net.customers) : "-"}</b><span>Customers indexed</span></div>
        <div className="ph-side-num"><b>${fmt(nActive)}</b><span>Active recalls</span></div>
        <div className=${`ph-side-live ${monitor && monitor.running ? "" : "off"}`}><span className="ss-dot"></span>
          <div><b>${monitor ? (monitor.running ? "Monitoring live" : "Monitor paused") : "Checking..."}</b>
            <small>${checked ? `Last checked ${ago(checked)}` : "No check yet on this server"}</small></div></div>
      </div>
      <div className="ph-user"><span className="ph-avatar"><${Icon} name="user" /></span>
        <div><b>Pharmacist</b><small>Pharmacy staff view</small></div></div>
    </aside>`;
  }

  function SearchBox({ ctx, navigate }) {
    const { alerts, meta } = ctx;
    const [q, setQ] = useState("");
    const [open, setOpen] = useState(false);
    const [hits, setHits] = useState([]);
    const close = useCallback(() => setOpen(false), []);
    const ref = useOutside(close);
    useEffect(() => {
      const n = q.trim();
      if (n.length < 2) { setHits([]); return undefined; }
      const local = () => {
        const l = n.toLowerCase();
        return alerts.filter((a) => [a.recall_number, a.product_ndc, a.recalling_firm, drugName(a, meta), (meta[a.recall_number] || {}).generic_name]
          .some((v) => String(v || "").toLowerCase().includes(l))).slice(0, 8)
          .map((a) => ({ recall_number: a.recall_number, name: drugName(a, meta), ndc: a.product_ndc, classification: a.classification, firm: a.recalling_firm }));
      };
      const t = setTimeout(() => {
        optionalRoute("search", () => P.search(n)).then((r) => {
          if (!r) { setHits(local()); return; }
          const known = new Set(alerts.map((a) => a.recall_number));
          setHits((r.recalls || []).slice(0, 8).map((x) => ({ recall_number: x.recall_number, name: titleCase(x.generic_name) || x.recall_number,
            ndc: (x.product_ndcs || [])[0], classification: x.classification, firm: x.recalling_firm, noAlert: !known.has(x.recall_number) })));
        }).catch(() => setHits(local()));
      }, 220);
      return () => clearTimeout(t);
    }, [q, alerts, meta]);
    const go = (h) => { if (h.noAlert) return; setOpen(false); setQ(""); navigate(`pharmacy/customers/${h.recall_number}`); };
    return html`<div className="ph-topsearch" ref=${ref}>
      <label className="ph-search"><${Icon} name="search" />
        <input value=${q} placeholder="Search recalls, NDC, drug name, manufacturer..." aria-label="Search recalls"
          onFocus=${() => setOpen(true)} onInput=${(e) => { setQ(e.target.value); setOpen(true); }}
          onKeyDown=${(e) => { if (e.key === "Enter" && hits[0]) go(hits[0]); if (e.key === "Escape") setOpen(false); }} /></label>
      ${open && q.trim().length >= 2 && html`<div className="ph-results">
        ${hits.length ? hits.map((h) => html`<button key=${h.recall_number} onClick=${() => go(h)} disabled=${h.noAlert}>
          <div><b>${h.name}</b><small><span className="ph-mono">${h.recall_number}</span> · NDC ${h.ndc || "-"} · ${h.firm || ""}</small></div>
          <span className="ph-res-badges"><${ClassBadge} classification=${h.classification} /><${SyntheticBadge} rn=${h.recall_number} />${h.noAlert && html`<${Badge}>No network match<//>`}</span>
        </button>`) : html`<div className="ph-res-empty">No recalls match "${q.trim()}"</div>`}
      </div>`}
    </div>`;
  }

  function Topbar({ ctx, navigate }) {
    const nNew = ctx.alerts.filter((a) => a.status === "new").length;
    return html`<header className="ph-top">
      <${SearchBox} ctx=${ctx} navigate=${navigate} />
      <button className="ph-bell" onClick=${() => navigate("pharmacy/notifications")} aria-label=${`${nNew} new alerts`} title=${`${nNew} new (unreviewed) alerts`}>
        <${Icon} name="bell" />${nNew > 0 && html`<em>${nNew > 99 ? "99+" : nNew}</em>`}</button>
    </header>`;
  }

  // ---------- portal ----------

  function Portal({ route, navigate }) {
    const alertsQ = usePoll(() => P.alerts(500), 30000);
    const metaQ = usePoll(() => P.recalls(1000), 120000);
    const monitorQ = usePoll(() => P.monitor(), 15000);
    const statsQ = usePoll(() => P.stats(), 300000);
    const summaryQ = usePoll(() => optionalRoute("summary", P.summary), 30000);
    const [events, setEvents] = useState([]);
    const reloadAlerts = alertsQ.reload, reloadSummary = summaryQ.reload;
    const reload = useCallback(() => { reloadAlerts(); reloadSummary(); }, []);

    useEffect(() => {
      const started = Date.now();
      return window.SS.api.stream((e) => {
        if (!e || !e.stage) return;
        setEvents((x) => [e, ...x].slice(0, 100));
        if (e.stage === "pharmacist_alert" || e.stage === "run_complete") {
          reloadAlerts(); reloadSummary();
          // The stream replays recent history on connect; only toast genuinely new alerts.
          if (e.stage === "pharmacist_alert" && Date.now() - started > 3000) toast(`New recall alert: ${e.recall_number}`, "danger");
        }
      });
    }, []);

    const meta = useMemo(() => Object.fromEntries((metaQ.data || []).map((r) => [r.recall_number, r])), [metaQ.data]);
    // Alerts without a recall number can't be routed or updated; openFDA sometimes omits it before classification.
    const alerts = useMemo(() => (alertsQ.data || []).filter((a) => a.recall_number), [alertsQ.data]);
    const ctx = { alerts, meta, monitor: monitorQ.data, stats: statsQ.data, summary: summaryQ.data,
      events, reloadAlerts: reload };
    const page = NAV.some(([p]) => p === route.page) ? route.page : "";
    let body;
    if (alertsQ.loading && !alertsQ.data) body = html`<${Spinner} />`;
    else if (alertsQ.error && !alertsQ.data) body = html`<${ErrorNote} error=${alertsQ.error} />`;
    else if (page === "recalls") body = html`<${RecallsPage} ctx=${ctx} navigate=${navigate} />`;
    else if (page === "customers") body = html`<${CustomersPage} ctx=${ctx} route=${route} navigate=${navigate} />`;
    else if (page === "notifications") body = html`<${NotificationsPage} ctx=${ctx} navigate=${navigate} />`;
    else if (page === "map") body = html`<${MapPage} ctx=${ctx} navigate=${navigate} />`;
    else if (SOON[page]) body = html`<${SoonPage} page=${page} monitor=${ctx.monitor} navigate=${navigate} />`;
    else body = html`<${Dashboard} ctx=${ctx} navigate=${navigate} />`;

    return html`<div className="ph-layout">
      <${Sidebar} page=${page} ctx=${ctx} />
      <main className="ph-main">
        <${Topbar} ctx=${ctx} navigate=${navigate} />
        ${alertsQ.error && alertsQ.data && html`<${ErrorNote} error=${`Couldn't refresh alerts: ${alertsQ.error.message}`} />`}
        <div className="ph-content" key=${page + "/" + route.id}>${body}</div>
      </main>
    </div>`;
  }

  window.SS.register("pharmacy", Portal);
})();
