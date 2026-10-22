// My Health portal. Owned by the patient UI session (see CONTRACT.md).
// Routes: #/patient (home), #/patient/alerts[/<recallId>], #/patient/alerts/for/<drug>,
//         #/patient/check[/<recallId>], #/patient/medications, #/patient/help[/<section>]
// Honesty: patient matches are drug-NAME matches ("may be affected; check your lot"), the FDA class
// is the only risk label, synthetic recalls carry "Test recall", and we never say a drug is safe or
// tell anyone to stop taking it. "Reviewed" and lot-check results are kept in this browser only.
(function () {
  const { useState, useEffect, useMemo, useRef } = React;
  const { html, ui, api } = window.SS;
  const { Icon, Badge, ClassBadge, SyntheticBadge, Empty, Spinner, ErrorNote, toast, usePoll, ago, classOf } = ui;
  const P = api.patient;

  // ---------- local (this device) storage ----------
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
    },
  };
  const K_PATIENT = "ss.patient.current";
  const kReviewed = (pid) => `ss.patient.reviewed.${pid}`;
  const kLots = (pid) => `ss.patient.lotchecks.${pid}`;

  // Re-render every component that reads device storage when it changes.
  const deviceListeners = new Set();
  function useDevice(pid) {
    const [, bump] = useState(0);
    useEffect(() => { const l = () => bump((n) => n + 1); deviceListeners.add(l); return () => deviceListeners.delete(l); }, []);
    const reviewed = store.get(kReviewed(pid), {});
    const lots = store.get(kLots(pid), {});
    const save = (key, value) => {
      const ok = store.set(key, value);
      deviceListeners.forEach((l) => l());
      if (!ok) toast("Couldn't save on this device (browser storage is blocked)", "danger");
      return ok;
    };
    return {
      reviewed, lots,
      markReviewed: (rid, on = true) => {
        const next = { ...reviewed };
        if (on) next[rid] = new Date().toISOString(); else delete next[rid];
        return save(kReviewed(pid), next);
      },
      saveLotCheck: (rid, entry) => save(kLots(pid), { ...lots, [rid]: entry }),
    };
  }

  // ---------- data helpers ----------
  const CLASS_ORDER = { "Class I": 0, "Class II": 1, "Class III": 2 };
  const sortNotes = (list) => [...(list || [])].sort((a, b) =>
    (new Date(b.createdAt) - new Date(a.createdAt)) ||
    ((CLASS_ORDER[classOf(a.classification)] ?? 3) - (CLASS_ORDER[classOf(b.classification)] ?? 3)));
  const sameDrug = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
  const fdaDate = (s) => {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s || "");
    if (!m) return s || "Not listed";
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  };
  const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
  const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "there";
  const initials = (name) => String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  const CLASS_MEANING = {
    "Class I": "Most serious: the FDA says use of the product could cause serious health problems.",
    "Class II": "The FDA says the product could cause temporary or reversible health problems.",
    "Class III": "The FDA says the product is unlikely to cause health problems.",
  };
  // Short product line: the FDA product text up to its first comma-separated detail.
  const shortProduct = (p) => {
    const s = String(p || "").replace(/\s+/g, " ").trim();
    return s.length > 110 ? s.slice(0, 107).replace(/[ ,;]+\S*$/, "") + "…" : s;
  };

  // Lot codes from the FDA free-text lot field, e.g. "Lot #: SS33053, Exp 06/2027; Lot #: SS94498, ...".
  function parseLots(lotInfo) {
    let s = String(lotInfo || "");
    s = s.replace(/\bexp(?:iry|iration|ires)?\.?\s*(?:date)?\.?\s*:?\s*\d{1,4}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?/gi, " ");
    s = s.replace(/\bNDC\s*#?:?\s*[\d-]+/gi, " ");
    const out = [];
    for (let t of s.split(/[\s,;:()#]+/)) {
      t = t.replace(/^[.\-]+|[.\-]+$/g, "");
      if (t.length < 3 || !/\d/.test(t) || !/^[A-Za-z0-9.\-\/]+$/.test(t)) continue;
      // dates the expiry pattern missed: 6/2027, 7/31/2026, Sep-25, Oct-2019
      if (/^\d{1,2}\/(\d{1,2}\/)?\d{2,4}$/.test(t) || /^(19|20)\d{2}$/.test(t) || /^[A-Za-z]{3,9}-\d{2,4}$/.test(t)) continue;
      if (!out.some((x) => x.toUpperCase() === t.toUpperCase())) out.push(t);
    }
    return out;
  }
  // Exact match, ignoring case and spaces only.
  const normLot = (s) => String(s || "").toUpperCase().replace(/\s+/g, "");
  const lotMatches = (input, lots) => lots.some((l) => normLot(l) === normLot(input));

  // ---------- shared pieces ----------
  const SectionHead = ({ title, action }) =>
    html`<div className="pt-section-head"><h2 className="ss-serif">${title}</h2>${action}</div>`;

  const NameMatchNote = () =>
    html`<div className="pt-note"><${Icon} name="info-circle" /><span>This alert matches your medication by <b>name only</b>.
      Your package may be affected; check your lot number. Don't change how you take your medicine without
      talking to your pharmacist or doctor.</span></div>`;

  const DeviceTag = () => html`<span className="pt-device"><${Icon} name="device-mobile" />Saved on this device</span>`;

  function MonitorPill({ monitor }) {
    if (!monitor) return html`<div className="pt-mon off"><span className="pt-mon-dot"></span><div><b>Checking status…</b></div></div>`;
    const on = !!monitor.running;
    return html`<div className=${`pt-mon ${on ? "" : "off"}`}>
      <span className="pt-mon-dot"></span>
      <div><b>${on ? "Monitoring Active" : "Monitoring paused"}</b>
        <small>${monitor.lastRunAt ? `Last checked ${ago(monitor.lastRunAt)}` : "Not checked yet"}</small></div>
    </div>`;
  }

  // ---------- header ----------
  function Header({ page, patients, patient, onPick, unread, navigate }) {
    const [open, setOpen] = useState(false);
    const [q, setQ] = useState("");
    const box = useRef(null);
    useEffect(() => {
      if (!open) return undefined;
      const close = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
      const esc = (e) => { if (e.key === "Escape") setOpen(false); };
      document.addEventListener("mousedown", close); document.addEventListener("keydown", esc);
      return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
    }, [open]);
    const list = (patients || []).filter((p) => !q || `${p.name} ${p.id}`.toLowerCase().includes(q.toLowerCase()));
    const tabs = [["", "Home", "home"], ["alerts", "Safety alerts", "alert-triangle"], ["check", "Check your package", "scan"],
      ["medications", "My medications", "pill"]];
    return html`<header className="pt-header">
      <div className="pt-header-row">
        <a className="pt-logo" href="#/patient" aria-label="SuperShield My Health home">
          <span className="pt-logo-mark"><${Icon} name="shield-check-filled" /></span>
          <span><b>SuperShield</b><small>My Health</small></span>
        </a>
        <nav className="pt-tabs" aria-label="My Health">
          ${tabs.map(([key, label, icon]) => html`<a key=${key} href=${`#/patient${key ? "/" + key : ""}`}
            className=${page === key ? "on" : ""} aria-current=${page === key ? "page" : null}>
            <${Icon} name=${icon} /><span>${label}</span></a>`)}
        </nav>
        <div className="pt-header-tools">
          <button className="pt-bell" onClick=${() => navigate("patient/alerts")}
            aria-label=${`Safety alerts: ${unread} not reviewed`} title="Safety alerts not yet reviewed on this device">
            <${Icon} name="bell" />${unread > 0 && html`<span className="pt-bell-count">${unread > 99 ? "99+" : unread}</span>`}
          </button>
          <div className="pt-chip-wrap" ref=${box}>
            <button className="pt-chip" onClick=${() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded=${open}>
              <span className="pt-avatar">${patient ? initials(patient.name) : "…"}</span>
              <span className="pt-chip-name">${patient ? patient.name : "Loading"}</span>
              <${Icon} name="chevron-down" />
            </button>
            ${open && html`<div className="pt-menu" role="listbox" aria-label="Switch patient">
              <div className="pt-menu-head">
                <b>Switch demo patient</b><small>${(patients || []).length} patients in the demo</small>
                <input className="ss-input" placeholder="Search by name or ID" value=${q} autoFocus
                  onInput=${(e) => setQ(e.target.value)} />
              </div>
              <div className="pt-menu-list">
                ${list.map((p) => html`<button key=${p.id} role="option" aria-selected=${patient && p.id === patient.id}
                  className=${patient && p.id === patient.id ? "on" : ""}
                  onClick=${() => { onPick(p.id); setOpen(false); setQ(""); }}>
                  <span className="pt-avatar sm">${initials(p.name)}</span>
                  <span><b>${p.name}</b><small>${p.id} · ${(p.drugs || []).length} medication${(p.drugs || []).length === 1 ? "" : "s"}</small></span>
                </button>`)}
                ${!list.length && html`<div className="pt-menu-empty">No patient matches "${q}"</div>`}
              </div>
            </div>`}
          </div>
        </div>
      </div>
    </header>`;
  }

  // ---------- home ----------
  function Greeting({ patient, monitor }) {
    return html`<section className="pt-greet">
      <div className="pt-greet-text">
        <h1 className="ss-serif">Hi, ${firstName(patient.name)},</h1>
        <p>We're monitoring FDA drug recalls so you can stay safe.</p>
      </div>
      <div className="pt-greet-art" aria-hidden="false">
        <svg className="pt-hills" viewBox="0 0 600 200" preserveAspectRatio="none" aria-hidden="true">
          <path d="M0 150 C 90 95, 170 120, 250 90 S 420 40, 600 85 L600 200 L0 200 Z" fill="rgba(31,111,235,.10)" />
          <path d="M0 175 C 120 130, 220 160, 330 128 S 500 105, 600 135 L600 200 L0 200 Z" fill="rgba(31,111,235,.16)" />
          <circle cx="470" cy="52" r="26" fill="rgba(255,196,120,.55)" />
        </svg>
        <div className="pt-greet-motto ss-serif">Your health.<br />Our watch.</div>
        <${MonitorPill} monitor=${monitor} />
      </div>
    </section>`;
  }

  function AlertHero({ note, count, reviewed, navigate }) {
    if (!note) {
      return html`<section className="ss-card pt-hero ok">
        <div className="pt-hero-icon ok"><${Icon} name="shield-check" /></div>
        <div><h2 className="ss-serif">No recall alerts for your medications</h2>
          <p>We haven't matched any FDA recall to the medication names on your list. We keep checking automatically.</p></div>
      </section>`;
    }
    const rid = note.recallId;
    return html`<section className="ss-card pt-hero" aria-labelledby="pt-hero-title">
      <div className="pt-hero-top">
        <div className="pt-hero-icon"><${Icon} name="alert-triangle-filled" /></div>
        <div className="pt-hero-headline">
          <div className="pt-hero-kicker">Important Safety Alert
            ${reviewed && html`<${Badge} tone="neutral" icon="check">Reviewed<//>`}</div>
          <h2 id="pt-hero-title">A recall matches a medication you take.</h2>
        </div>
        <span className="pt-hero-time">${ago(note.createdAt)}</span>
      </div>
      <div className="pt-hero-body" onClick=${() => navigate(`patient/alerts/${rid}`)}>
        <div className="pt-hero-drug"><${Icon} name="pill" /></div>
        <div className="pt-hero-info">
          <h3>${note.drug} <span className="pt-badges"><${ClassBadge} classification=${note.classification} /><${SyntheticBadge} rn=${rid} /></span></h3>
          <div className="pt-meta">${rid}<i>|</i>Manufacturer: ${note.firm || "Not listed"}</div>
          <div className="pt-meta"><b>Reason:</b> ${note.reason || "Not listed"}</div>
          <div className="pt-hero-may">Your package may be affected; check your lot number.</div>
        </div>
        <button className="pt-chev" aria-label="Open alert details" onClick=${(e) => { e.stopPropagation(); navigate(`patient/alerts/${rid}`); }}>
          <${Icon} name="chevron-right" /></button>
      </div>
      <div className="pt-hero-actions">
        <button className="ss-btn danger" onClick=${() => navigate(`patient/alerts/${rid}`)}>View What This Means</button>
        <button className="ss-btn" onClick=${() => navigate(`patient/check/${rid}`)}><${Icon} name="scan" />Check Your Package</button>
        ${count > 1 && html`<a className="pt-more" href="#/patient/alerts">See all ${count} alerts <${Icon} name="arrow-right" /></a>`}
      </div>
    </section>`;
  }

  // Medication list (used on Home and on My medications).
  function MedList({ patient, notes, onSave, navigate, full }) {
    const [adding, setAdding] = useState(false);
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState(null);
    const drugs = patient.drugs || [];
    const forDrug = (d) => notes.filter((n) => sameDrug(n.drug, d));

    async function add(e) {
      e.preventDefault();
      const v = name.trim();
      if (!v) return;
      if (drugs.some((d) => sameDrug(d, v))) { setErr(new Error(`${v} is already on your list`)); return; }
      if (drugs.length >= 8) { setErr(new Error("You can save up to 8 medications")); return; }
      setBusy(true); setErr(null);
      try {
        await onSave([...drugs, v]);
        setName(""); setAdding(false);
        toast(`${v} added. We'll check FDA recalls for it on the next run.`);
      } catch (x) { setErr(x); }
      setBusy(false);
    }
    async function remove(d) {
      if (!window.confirm(`Remove ${d} from your medication list? We'll stop checking recalls for it.`)) return;
      setBusy(true); setErr(null);
      try { await onSave(drugs.filter((x) => x !== d)); toast(`${d} removed from your list`); }
      catch (x) { setErr(x); }
      setBusy(false);
    }

    return html`<section className=${`pt-meds ${full ? "full" : ""}`}>
      <${SectionHead} title="My Medications" action=${html`<button className="pt-link-btn" onClick=${() => { setAdding((a) => !a); setErr(null); }}
        aria-expanded=${adding}><${Icon} name=${adding ? "x" : "plus"} />${adding ? "Cancel" : "Add Medication"}</button>`} />
      ${adding && html`<form className="ss-card pt-add" onSubmit=${add}>
        <label htmlFor="pt-add-name">Medication name</label>
        <div className="pt-add-row">
          <input id="pt-add-name" className="ss-input" value=${name} autoFocus maxLength="40" placeholder="e.g. Metformin"
            onInput=${(e) => setName(e.target.value)} />
          <button className="ss-btn primary" disabled=${busy || !name.trim()}>${busy ? "Saving…" : "Save"}</button>
        </div>
        <small>Use the name on your label. We match FDA recalls by medication name.</small>
      </form>`}
      <${ErrorNote} error=${err} />
      ${!drugs.length && html`<div className="ss-card"><${Empty} icon="pill" title="No medications saved">Add the medications you take and we'll watch FDA recalls for them.<//></div>`}
      <div className="pt-med-list">
        ${drugs.map((d) => {
          const hits = forDrug(d);
          const alert = hits.length > 0;
          const go = () => (alert ? navigate(`patient/alerts/for/${encodeURIComponent(d)}`) : null);
          return html`<div key=${d} className=${`ss-card pt-med ${alert ? "alert" : ""}`}>
            <div className="pt-med-icon"><${Icon} name="pill" /></div>
            <div className="pt-med-main" onClick=${go} role=${alert ? "button" : null} tabIndex=${alert ? 0 : null}
              onKeyDown=${(e) => { if (alert && e.key === "Enter") go(); }}>
              <b>${d}</b>
              <small>${alert ? `${hits.length} FDA recall${hits.length === 1 ? "" : "s"} matched by name` : "No recall matched by name so far"}</small>
            </div>
            ${alert ? html`<${Badge} tone="danger" icon="alert-triangle-filled">Recall Alert<//>` : html`<${Badge} tone="success">No alerts<//>`}
            <button className="pt-icon-btn" title=${`Remove ${d}`} aria-label=${`Remove ${d}`} disabled=${busy} onClick=${() => remove(d)}>
              <${Icon} name="trash" /></button>
            ${alert ? html`<button className="pt-chev" aria-label=${`Alerts for ${d}`} onClick=${go}><${Icon} name="chevron-right" /></button>`
                    : html`<span className="pt-chev ghost"></span>`}
          </div>`;
        })}
      </div>
    </section>`;
  }

  function HelpCards({ navigate }) {
    const cards = [
      ["help/check", "file-search", "How to check your medication", "Find the lot number on your package and compare it."],
      ["help/what", "stethoscope", "What should I do?", "Clear steps based on FDA recall information."],
      ["help/contact", "building-store", "Contact your pharmacy", "Reach out if you have questions."],
    ];
    return html`<section className="pt-help">
      ${cards.map(([to, icon, title, text]) => html`<button key=${to} className="ss-card pt-help-card" onClick=${() => navigate(`patient/${to}`)}>
        <span className="pt-help-icon"><${Icon} name=${icon} /></span>
        <b className="ss-serif">${title}</b><small>${text}</small>
        <${Icon} name="chevron-right" className="pt-help-chev" />
      </button>`)}
    </section>`;
  }

  function Home({ patient, notes, monitor, device, onSave, navigate }) {
    const top = notes[0];
    return html`<div className="pt-home">
      <${Greeting} patient=${patient} monitor=${monitor} />
      <div className="pt-home-grid">
        <div>
          <${AlertHero} note=${top} count=${notes.length} reviewed=${top && device.reviewed[top.recallId]} navigate=${navigate} />
          <${MedList} patient=${patient} notes=${notes} onSave=${onSave} navigate=${navigate} />
        </div>
      </div>
      <${HelpCards} navigate=${navigate} />
    </div>`;
  }

  // ---------- safety alerts ----------
  function AlertRow({ n, device, navigate }) {
    const rid = n.recallId;
    const lc = device.lots[rid];
    return html`<button className=${`ss-card pt-alert-row ${device.reviewed[rid] ? "seen" : ""}`} onClick=${() => navigate(`patient/alerts/${rid}`)}>
      <span className=${`pt-alert-dot ${{ "Class I": "c1", "Class II": "c2", "Class III": "c3" }[classOf(n.classification)] || ""}`}><${Icon} name="alert-triangle" /></span>
      <span className="pt-alert-main">
        <span className="pt-badges"><${ClassBadge} classification=${n.classification} /><${SyntheticBadge} rn=${rid} />
          ${!device.reviewed[rid] && html`<${Badge} tone="info">New<//>`}
          ${lc && html`<${Badge} tone=${lc.match ? "danger" : "neutral"} icon="scan">${lc.match ? "Lot matched" : "Lot not in list"}<//>`}</span>
        <b>${n.drug}: ${n.reason || "Reason not listed"}</b>
        <small>${rid} · ${n.firm || "Firm not listed"} · reported ${fdaDate(n.reportDate)}</small>
      </span>
      <${Icon} name="chevron-right" className="pt-alert-chev" />
    </button>`;
  }

  function AlertsList({ notes, patient, device, drugFilter, navigate }) {
    const [filter, setFilter] = useState("all");
    let list = notes;
    if (drugFilter) list = list.filter((n) => sameDrug(n.drug, drugFilter));
    if (filter === "new") list = list.filter((n) => !device.reviewed[n.recallId]);
    if (filter === "c1") list = list.filter((n) => classOf(n.classification) === "Class I");
    const unread = notes.filter((n) => !device.reviewed[n.recallId]);
    const markAll = () => {
      const next = { ...device.reviewed }; const now = new Date().toISOString();
      unread.forEach((n) => { next[n.recallId] = now; });
      if (store.set(kReviewed(patient.id), next)) { deviceListeners.forEach((l) => l()); toast("All alerts marked as reviewed on this device"); }
    };
    return html`<div className="pt-page">
      <div className="pt-page-head">
        <div><h1 className="ss-serif">Safety alerts${drugFilter ? ` for ${drugFilter}` : ""}</h1>
          <p>FDA recalls that match the names of your medications. A name match means your package <b>may</b> be affected; check your lot number.</p></div>
        ${unread.length > 0 && html`<button className="ss-btn sm" onClick=${markAll}><${Icon} name="checks" />Mark all as reviewed</button>`}
      </div>
      <div className="pt-filters" role="group" aria-label="Filter alerts">
        ${drugFilter && html`<a className="pt-filter on" href="#/patient/alerts"><${Icon} name="x" />${drugFilter}</a>`}
        ${[["all", "All"], ["new", `Not reviewed (${(drugFilter ? unread.filter((n) => sameDrug(n.drug, drugFilter)) : unread).length})`], ["c1", "Class I only"]]
          .map(([k, l]) => html`<button key=${k} className=${`pt-filter ${filter === k ? "on" : ""}`} onClick=${() => setFilter(k)}>${l}</button>`)}
        <${DeviceTag} />
      </div>
      ${!list.length && html`<div className="ss-card"><${Empty} icon="shield-check" title=${notes.length ? "No alerts in this view" : "No recall alerts"}>
        ${notes.length ? "Try another filter." : "No FDA recall matches the medication names on your list right now."}<//></div>`}
      <div className="pt-alert-list">${list.map((n) => html`<${AlertRow} key=${n.id || n.recallId} n=${n} device=${device} navigate=${navigate} />`)}</div>
    </div>`;
  }

  function Delivery({ items }) {
    if (!items || !items.length) return html`<p className="pt-muted">No delivery record for this alert.</p>`;
    const label = { sent: "Sent", simulated: "Simulated (demo, not actually sent)", failed: "Failed", pending: "Pending", skipped: "Skipped" };
    const tone = { sent: "success", simulated: "neutral", failed: "danger", pending: "warning" };
    return html`<ul className="pt-delivery">${items.map((d, i) => html`<li key=${i}>
      <${Icon} name=${{ "in-app": "app-window", slack: "brand-slack", email: "mail", sms: "message" }[d.channel] || "send"} />
      <b>${d.channel === "in-app" ? "In-app notification" : d.channel}</b>
      <${Badge} tone=${tone[d.state] || "neutral"}>${label[d.state] || d.state}<//>
    </li>`)}</ul>`;
  }

  function AlertDetail({ note, device, navigate }) {
    if (!note) return html`<div className="pt-page"><div className="ss-card"><${Empty} icon="alert-circle" title="Alert not found">
      This recall isn't in your alerts. It may belong to a medication you removed.<//></div>
      <a className="pt-back" href="#/patient/alerts"><${Icon} name="arrow-left" />All safety alerts</a></div>`;
    const rid = note.recallId;
    const c = classOf(note.classification);
    const lots = parseLots(note.lotInfo);
    const seen = device.reviewed[rid];
    const lc = device.lots[rid];
    const synthetic = note.synthetic === true || ui.isSynthetic(rid);
    return html`<div className="pt-page pt-detail">
      <a className="pt-back" href="#/patient/alerts"><${Icon} name="arrow-left" />All safety alerts</a>
      <section className="ss-card pt-detail-head">
        <div className="pt-badges"><${ClassBadge} classification=${note.classification} /><${SyntheticBadge} rn=${rid} />
          ${seen && html`<${Badge} tone="neutral" icon="check">Reviewed ${ago(seen)}<//>`}</div>
        <h1 className="ss-serif">${note.drug} recall</h1>
        <div className="pt-meta">FDA recall number <b>${rid}</b><i>|</i>Alert received ${when(note.createdAt)}</div>
        <${NameMatchNote} />
        <div className="pt-hero-actions">
          <button className="ss-btn danger" onClick=${() => navigate(`patient/check/${rid}`)}><${Icon} name="scan" />Check Your Package</button>
          <button className="ss-btn" onClick=${() => { if (device.markReviewed(rid, !seen)) toast(seen ? "Marked as not reviewed" : "Marked as reviewed on this device"); }}>
            <${Icon} name=${seen ? "arrow-back-up" : "check"} />${seen ? "Mark as not reviewed" : "Mark as reviewed"}</button>
          <${DeviceTag} />
        </div>
      </section>
      <div className="pt-detail-grid">
        <section className="ss-card pt-panel">
          <h2>Recall details</h2>
          <dl className="pt-dl">
            <dt>FDA classification</dt><dd><${ClassBadge} classification=${note.classification} /><small>${CLASS_MEANING[c] || "The FDA hasn't classified this recall yet."}</small></dd>
            <dt>Reason</dt><dd>${note.reason || "Not listed"}</dd>
            <dt>Product</dt><dd>${note.product || "Not listed"}</dd>
            <dt>Recalling firm</dt><dd>${note.firm || "Not listed"}${note.state ? `, ${note.state}` : ""}${note.country ? `, ${note.country}` : ""}</dd>
            <dt>Recall status</dt><dd>${note.status || "Not listed"}</dd>
            <dt>Recall started</dt><dd>${fdaDate(note.initiationDate)}</dd>
            <dt>FDA report date</dt><dd>${fdaDate(note.reportDate)}</dd>
            <dt>Matched your medication</dt><dd>${note.drug} (by name)</dd>
          </dl>
        </section>
        <section className="ss-card pt-panel">
          <h2>Recalled lots</h2>
          ${lots.length ? html`<div className="pt-lots">${lots.map((l) => html`<code key=${l}>${l}</code>`)}</div>`
                        : html`<p className="pt-muted">${/\ball lots\b/i.test(note.lotInfo || "") ? `The FDA lists this recall as covering all lots: "${note.lotInfo}"`
                            : "We couldn't read lot numbers from the FDA text below. Your pharmacist can check it for you."}</p>`}
          <details className="pt-raw"><summary>FDA lot text, as published</summary><p>${note.lotInfo || "Not listed"}</p></details>
          ${lc && html`<div className=${`pt-result sm ${lc.match ? "match" : "nomatch"}`}>
            <${Icon} name=${lc.match ? "alert-triangle-filled" : "list-search"} />
            <span>You checked lot <b>${lc.lot}</b> ${ago(lc.at)}: ${lc.match ? "matches a recalled lot. Call your pharmacist." : "not in the recalled lot list."} <${DeviceTag} /></span></div>`}
          <h2>How you were told</h2>
          <${Delivery} items=${note.delivery} />
          <h2>Source</h2>
          ${synthetic
            ? html`<p className="pt-muted"><${Badge} tone="synthetic">Test recall<//> This is a synthetic test record for the demo; it isn't in the FDA database.</p>`
            : html`<a className="pt-source" href=${note.sourceUrl} target="_blank" rel="noopener noreferrer"><${Icon} name="external-link" />View this recall on openFDA (FDA data)</a>`}
        </section>
      </div>
      ${note.bulletin && html`<section className="ss-card pt-panel pt-bulletin">
        <h2><${Icon} name="message-2" />What this means for you</h2>
        <small className="pt-muted">A plain-language summary of your FDA recall matches, written by Claude from the FDA data.</small>
        <div className="pt-bulletin-text">${note.bulletin}</div>
      </section>`}
    </div>`;
  }

  // ---------- check your package ----------
  function CheckPackage({ notes, id, device, navigate }) {
    const note = notes.find((n) => n.recallId === id);
    const [lot, setLot] = useState("");
    const [result, setResult] = useState(null);
    useEffect(() => { setLot(""); setResult(null); }, [id]);

    if (!note) {
      return html`<div className="pt-page">
        <div className="pt-page-head"><div><h1 className="ss-serif">Check your package</h1>
          <p>Compare the lot number on your bottle with the FDA's list of recalled lots. Pick the alert to check against.</p></div></div>
        ${id && html`<${ErrorNote} error=${"That alert isn't in your list. Pick one below."} />`}
        ${!notes.length && html`<div className="ss-card"><${Empty} icon="shield-check" title="Nothing to check">No FDA recall matches your medications right now.<//></div>`}
        <div className="pt-alert-list">
          ${notes.map((n) => html`<button key=${n.id || n.recallId} className="ss-card pt-alert-row" onClick=${() => navigate(`patient/check/${n.recallId}`)}>
            <span className="pt-alert-dot"><${Icon} name="scan" /></span>
            <span className="pt-alert-main"><span className="pt-badges"><${ClassBadge} classification=${n.classification} /><${SyntheticBadge} rn=${n.recallId} />
              ${device.lots[n.recallId] && html`<${Badge} tone="neutral" icon="check">Checked<//>`}</span>
              <b>${n.drug}: ${shortProduct(n.product)}</b><small>${n.recallId} · ${parseLots(n.lotInfo).length} recalled lot${parseLots(n.lotInfo).length === 1 ? "" : "s"} listed</small></span>
            <${Icon} name="chevron-right" className="pt-alert-chev" />
          </button>`)}
        </div>
      </div>`;
    }

    const lots = parseLots(note.lotInfo);
    const prev = device.lots[note.recallId];
    const check = (e) => {
      e.preventDefault();
      if (!lot.trim()) return;
      const match = lotMatches(lot, lots);
      const entry = { lot: lot.trim(), match, at: new Date().toISOString() };
      setResult(entry);
      device.saveLotCheck(note.recallId, entry);
    };
    const shown = result || null;
    return html`<div className="pt-page pt-check">
      <a className="pt-back" href="#/patient/check"><${Icon} name="arrow-left" />Choose another alert</a>
      <div className="pt-page-head"><div><h1 className="ss-serif">Check your package</h1>
        <p><b>${note.drug}</b> · ${note.recallId} <span className="pt-badges"><${ClassBadge} classification=${note.classification} /><${SyntheticBadge} rn=${note.recallId} /></span></p></div></div>
      <ol className="pt-steps">
        <li className="ss-card"><span className="pt-step-n">1</span><div><b>Find your package</b>
          <p>Get the bottle, box or blister pack this medication came in. Recalled product: <i>${shortProduct(note.product)}</i></p></div></li>
        <li className="ss-card"><span className="pt-step-n">2</span><div><b>Find the lot number</b>
          <p>Look for "Lot", "LOT" or "Batch" near the expiration date, often on the label edge or the bottom of the box.</p></div></li>
        ${!lots.length ? html`<li className="ss-card"><span className="pt-step-n">3</span><div className="pt-step-grow">
          ${/\ball lots\b/i.test(note.lotInfo || "")
            ? html`<div className="pt-result match"><${Icon} name="alert-triangle-filled" /><div><b>The FDA lists this recall as covering all lots: call your pharmacist.</b>
                <p>FDA lot text: "${note.lotInfo}". Your pharmacist can tell you whether your package is part of it.</p></div></div>`
            : html`<div className="pt-result nomatch"><${Icon} name="help-circle" /><div><b>We can't check lots for this recall here.</b>
                <p>We couldn't read lot numbers from the FDA text, so please ask your pharmacist to compare your package.</p></div></div>`}
        </div></li>`
        : html`<li className="ss-card"><span className="pt-step-n">3</span><div className="pt-step-grow"><b>Type it here</b>
          <form className="pt-add-row" onSubmit=${check}>
            <input className="ss-input pt-lot-input" aria-label="Lot number from your package" placeholder="Lot number as printed"
              value=${lot} onInput=${(e) => { setLot(e.target.value); setResult(null); }} autoComplete="off" spellCheck="false" />
            <button className="ss-btn primary" disabled=${!lot.trim()}><${Icon} name="list-search" />Check lot</button>
          </form>
          <small className="pt-muted">We compare it exactly, ignoring capital letters and spaces, against the ${lots.length} lot${lots.length === 1 ? "" : "s"} the FDA listed.</small>
        </div></li>`}
      </ol>
      ${shown && (shown.match
        ? html`<div className="pt-result match" role="status"><${Icon} name="alert-triangle-filled" />
            <div><b>Matches a recalled lot: call your pharmacist.</b>
            <p>Lot <code>${shown.lot}</code> is on the FDA's recalled lot list for ${note.recallId}. Your pharmacist can tell you what to do next.
              Don't change how you take your medicine without talking to them or your doctor.</p></div></div>`
        : html`<div className="pt-result nomatch" role="status"><${Icon} name="list-search" />
            <div><b>Not in the recalled lot list.</b>
            <p>Lot <code>${shown.lot}</code> isn't one of the lots the FDA listed for ${note.recallId}. Double-check that you typed it exactly as printed.
              FDA lot lists can be incomplete, so ask your pharmacist if you're unsure.</p></div></div>`)}
      ${!shown && prev && html`<div className=${`pt-result sm ${prev.match ? "match" : "nomatch"}`}><${Icon} name="history" />
        <span>Last check ${ago(prev.at)}: lot <b>${prev.lot}</b> ${prev.match ? "matched a recalled lot. Call your pharmacist." : "was not in the recalled lot list."}</span></div>`}
      ${shown && html`<p className="pt-muted pt-saved"><${DeviceTag} /> This result is kept in this browser only.</p>`}
      <section className="ss-card pt-panel">
        <h2>Recalled lots for ${note.recallId}</h2>
        ${lots.length ? html`<div className="pt-lots">${lots.map((l) => html`<code key=${l}>${l}</code>`)}</div>`
                      : html`<p className="pt-muted">We couldn't read lot numbers from the FDA text. Please ask your pharmacist to check.</p>`}
        <details className="pt-raw"><summary>FDA lot text, as published</summary><p>${note.lotInfo || "Not listed"}</p></details>
        <a className="pt-source" href=${`#/patient/alerts/${note.recallId}`}><${Icon} name="file-description" />Full alert details</a>
      </section>
    </div>`;
  }

  // ---------- help ----------
  function Help({ section, notes, navigate }) {
    const [copied, setCopied] = useState(false);
    const summary = notes.map((n) => `${n.recallId} (${classOf(n.classification)}) - ${n.drug}`).join("\n");
    const copy = async () => {
      try { await navigator.clipboard.writeText(summary); setCopied(true); toast("Copied the recall numbers"); }
      catch { toast("Couldn't copy here. Select the text and copy it yourself.", "warning"); }
    };
    useEffect(() => {
      const el = section && document.getElementById(`pt-help-${section}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, [section]);
    return html`<div className="pt-page pt-helppage">
      <div className="pt-page-head"><div><h1 className="ss-serif">Help</h1><p>What a recall alert means and what you can do about it.</p></div></div>
      <section id="pt-help-check" className=${`ss-card pt-panel ${section === "check" ? "focus" : ""}`}>
        <h2><${Icon} name="file-search" />How to check your medication</h2>
        <ol>
          <li>Open the alert and read the recalled product description: name, strength and package size.</li>
          <li>Find the lot number on your package. It's usually printed near the expiration date as "Lot" or "LOT".</li>
          <li>Use <a href="#/patient/check">Check your package</a> to compare your lot number with the FDA's recalled lot list.</li>
        </ol>
        <button className="ss-btn primary" onClick=${() => navigate("patient/check")}><${Icon} name="scan" />Check your package</button>
      </section>
      <section id="pt-help-what" className=${`ss-card pt-panel ${section === "what" ? "focus" : ""}`}>
        <h2><${Icon} name="stethoscope" />What should I do?</h2>
        <ul>
          <li><b>A name match isn't a confirmed recall of your package.</b> We match recalls to your medication names; the lot number is what tells you.</li>
          <li><b>If your lot matches</b>, call your pharmacist. They can tell you what to do next.</li>
          <li><b>Don't stop or change your medicine on your own.</b> Talk to your pharmacist or doctor first.</li>
          <li><b>The FDA class tells you how serious the recall is.</b> ${CLASS_MEANING["Class I"]} Class II: ${CLASS_MEANING["Class II"].replace("The FDA says the", "the")} Class III: ${CLASS_MEANING["Class III"].replace("The FDA says the", "the")}</li>
          <li><b>Test recall</b> labels mark synthetic records used to demo SuperShield; they aren't real FDA recalls.</li>
        </ul>
      </section>
      <section id="pt-help-contact" className=${`ss-card pt-panel ${section === "contact" ? "focus" : ""}`}>
        <h2><${Icon} name="building-store" />Contact your pharmacy</h2>
        <p>Call the pharmacy that filled your prescription; its phone number is on your prescription label. Tell them the
          FDA recall number and the lot number on your package.</p>
        ${notes.length ? html`<div className="pt-copy"><pre>${summary}</pre>
            <button className="ss-btn sm" onClick=${copy}><${Icon} name=${copied ? "check" : "copy"} />${copied ? "Copied" : "Copy recall numbers"}</button></div>`
          : html`<p className="pt-muted">You have no recall alerts to share right now.</p>`}
      </section>
    </div>`;
  }

  // ---------- portal ----------
  function Portal({ route, navigate }) {
    const patients = usePoll(() => P.list(), 0, []);
    const all = patients.data || [];
    const [pid, setPid] = useState(() => store.get(K_PATIENT, null));
    const patient = all.find((p) => p.id === pid) || null;
    useEffect(() => { // fall back to the first demo patient when nothing (valid) is stored
      if (all.length && !patient) setPid(all[0].id);
    }, [all.length, patient]);
    const pick = (id) => { setPid(id); store.set(K_PATIENT, id); };

    // Tag each load with its patient so a switch never shows the previous patient's alerts.
    const notesQ = usePoll(() => (pid ? P.notifications(pid).then((d) => ({ pid, list: (d && d.notifications) || [] }))
                                      : Promise.resolve({ pid, list: [] })), 20000, [pid]);
    const notesReady = !!notesQ.data && notesQ.data.pid === pid;
    const monitorQ = usePoll(() => P.monitor(), 30000, []);
    const device = useDevice(pid || "none");
    const notes = useMemo(() => {
      if (!notesReady) return [];
      return sortNotes(notesQ.data.list).filter((n) => n.patientId === undefined || n.patientId === pid); // only this patient's data
    }, [notesQ.data, pid, notesReady]);
    const unread = notes.filter((n) => !device.reviewed[n.recallId]).length;

    const saveDrugs = async (drugs) => {
      await P.setDrugs(patient.id, drugs);
      await patients.reload();
      notesQ.reload();
    };

    const page = ["alerts", "check", "medications", "help"].includes(route.page) ? route.page : "";
    let body;
    if (patients.error && !all.length) body = html`<div className="pt-page"><${ErrorNote} error=${patients.error} />
      <p className="pt-muted">The patient service isn't reachable right now.</p>
      <button className="ss-btn" onClick=${patients.reload}><${Icon} name="refresh" />Try again</button></div>`;
    else if (patient && !notesReady && notesQ.error && !notesQ.loading) body = html`<div className="pt-page"><${ErrorNote} error=${notesQ.error} />
      <p className="pt-muted">We couldn't load your alerts, so we can't show your recall status right now.</p>
      <button className="ss-btn" onClick=${notesQ.reload}><${Icon} name="refresh" />Try again</button></div>`;
    else if (!patient || !notesReady) body = html`<${Spinner} />`;
    else if (page === "alerts" && route.id === "for") body = html`<${AlertsList} notes=${notes} patient=${patient} device=${device} drugFilter=${route.query[0]} navigate=${navigate} />`;
    else if (page === "alerts" && route.id) body = html`<${AlertDetail} note=${notes.find((n) => n.recallId === route.id)} device=${device} navigate=${navigate} />`;
    else if (page === "alerts") body = html`<${AlertsList} notes=${notes} patient=${patient} device=${device} navigate=${navigate} />`;
    else if (page === "check") body = html`<${CheckPackage} notes=${notes} id=${route.id} device=${device} navigate=${navigate} />`;
    else if (page === "medications") body = html`<div className="pt-page">
        <div className="pt-page-head"><div><h1 className="ss-serif">My medications</h1>
          <p>Save the medications you take once. We check FDA recalls for them automatically, about every ${monitorQ.data ? Math.round((monitorQ.data.intervalSec || 60) / 60) || 1 : 1} minute${monitorQ.data && monitorQ.data.intervalSec > 119 ? "s" : ""}.</p></div>
          <${MonitorPill} monitor=${monitorQ.data} /></div>
        <${MedList} patient=${patient} notes=${notes} onSave=${saveDrugs} navigate=${navigate} full=${true} />
      </div>`;
    else if (page === "help") body = html`<${Help} section=${route.id} notes=${notes} navigate=${navigate} />`;
    else body = html`<${Home} patient=${patient} notes=${notes} monitor=${monitorQ.data} device=${device} onSave=${saveDrugs} navigate=${navigate} />`;

    return html`<div className="pt-root">
      <${Header} page=${page} patients=${all} patient=${patient} onPick=${pick} unread=${unread} navigate=${navigate} />
      <main className="pt-main">
        ${notesQ.error && notesReady && html`<${ErrorNote} error=${"Couldn't refresh your alerts. Showing the last ones we loaded."} />`}
        ${body}
      </main>
    </div>`;
  }

  window.SS.register("patient", Portal);
})();
