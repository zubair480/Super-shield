import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchEvents,
  fetchRecallDetail,
  toDate,
  hms,
  parse,
  KIND,
  CLASS_META,
  classOf,
  statusLabel,
  statusTitle,
  voluntaryLabel,
  notificationLabel,
  firmPlace,
  fmtFdaDate,
  quantityLabel,
  distributionLabel,
  reasonGist,
  parseCodeInfo,
  channelLabel,
  plainBulletin,
  wordsOf,
  clean,
  fetchRecallWire,
  recallDrugName,
  recallSourceUrl,
  type EventsResult,
  type EventPayload,
  type EventRow,
  type DetailState,
  type RecallDetail,
  type RecallWireResult,
} from "./lib";
import AddPatient from "./AddPatient";

const KIND_KEYS = ["recall_detected", "patient_matched", "bulletin_generated", "alert_sent"];

// Un retiro único visto por el agente, agregado desde la bitácora de eventos.
interface RecallCard {
  id: string;
  drug: string;
  cls: "I" | "II" | "III";
  status?: string;
  sourceUrl?: string;
  reason?: string;
  seenAt: Date;
  patientIds: string[];
}

function ClassTag({ c }: { c?: string }) {
  if (!c) return null;
  const cls = classOf(c);
  return (
    <span className={`cls cls-${cls}`} title={CLASS_META[cls].def}>
      Class {cls}
    </span>
  );
}

function Summary({
  kind,
  d,
  names,
}: {
  kind: string;
  d: EventPayload;
  names: Map<string, string>;
}) {
  switch (kind) {
    case "recall_detected": {
      const st = statusLabel(d.status);
      return (
        <>
          <strong>{d.drug}</strong>
          {d.sourceUrl ? (
            <a href={d.sourceUrl} target="_blank" rel="noreferrer" className="lnk">
              {d.recallId}
              <span className="ext" aria-hidden="true">
                ↗
              </span>
            </a>
          ) : (
            <span className="data">{d.recallId}</span>
          )}
          <ClassTag c={d.classification} />
          {st && <span className="faint">{st.toLowerCase()}</span>}
        </>
      );
    }
    case "patient_matched":
      return (
        <>
          <strong>{d.name || d.patientId}</strong>
          {d.patientId && <span className="data">{d.patientId}</span>}
          {Array.isArray(d.drugs) && d.drugs.length > 0 && (
            <span>takes {d.drugs.join(" and ")}</span>
          )}
        </>
      );
    case "bulletin_generated": {
      const w = wordsOf(d.bulletin, d.chars);
      return (
        <>
          <span>Plain-language bulletin for</span>
          <strong>{(d.patientId && names.get(d.patientId)) || `patient ${d.patientId ?? "—"}`}</strong>
          {w > 0 && <span className="faint">≈{w} words</span>}
        </>
      );
    }
    case "alert_sent":
      return (
        <>
          <strong>{(d.patientId && names.get(d.patientId)) || d.patientId}</strong>
          <span>alerted via {channelLabel(d.channel)}</span>
          {d.ok ? <span className="ok">✓ delivered</span> : <span className="fail">✗ failed</span>}
          {d.ref?.startsWith("dry-run") ? (
            <span className="faint">dry run</span>
          ) : (
            d.ref && <span className="data">{d.ref}</span>
          )}
        </>
      );
    default:
      return null;
  }
}

export default function App() {
  const [data, setData] = useState<EventsResult | null>(null);
  const [updated, setUpdated] = useState("—");
  const [offline, setOffline] = useState(false);
  const [activeKinds, setActiveKinds] = useState<Set<string>>(new Set(KIND_KEYS));
  const [patientFilter, setPatientFilter] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, DetailState>>({});
  const [openRecall, setOpenRecall] = useState<string | null>(null);
  const [wire, setWire] = useState<RecallWireResult | null>(null);
  const [scope, setScope] = useState<"registry" | "all">("registry");
  const autoOpened = useRef(false);

  // Revelado escalonado solo en la primera carga; las filas nuevas entran sin retraso.
  const firstBatch = useRef(true);
  const delays = useRef(new Map<string, number>());

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // setTimeout encadenado: las consultas nunca se traslapan ni se pisan.
    const load = async () => {
      try {
        const res = await fetchEvents();
        if (!alive) return;
        setData(res);
        setOffline(false);
        setUpdated(hms(new Date()));
      } catch {
        if (alive) setOffline(true);
      } finally {
        if (alive) timer = setTimeout(load, 5000);
      }
    };
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (data) firstBatch.current = false;
    if (delays.current.size > 2000) delays.current.clear();
  }, [data]);

  // El cable openFDA: el server acumula con una pasada por minuto, así que
  // el front repolea al mismo ritmo para que la lista crezca sola.
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchRecallWire()
        .then((res) => {
          if (alive && res.recalls?.length) setWire(res);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 60 * 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const events = useMemo(() => {
    // Dedup por fila completa: el modo continuo re-inserta pasadas idénticas.
    const seen = new Set<string>();
    return (data?.events ?? [])
      .filter((e) => {
        const k = `${e.ts}|${e.kind}|${e.payload}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => toDate(b.ts).getTime() - toDate(a.ts).getTime());
  }, [data]);

  // patientId -> nombre (para hablar de personas, no de claves).
  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of events) {
      if (e.kind !== "patient_matched") continue;
      const d = parse(e.payload);
      if (d.patientId && d.name) m.set(d.patientId, d.name);
    }
    return m;
  }, [events]);

  // Retiros únicos, del más severo al más reciente. El dossier del demo.
  const recallCards = useMemo(() => {
    const m = new Map<string, RecallCard>();
    // Recorremos del más viejo al más nuevo para que seenAt sea el primer avistamiento.
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.kind !== "recall_detected") continue;
      const d = parse(e.payload);
      if (!d.recallId) continue;
      const cur = m.get(d.recallId);
      if (cur) {
        if (d.patientId && !cur.patientIds.includes(d.patientId)) cur.patientIds.push(d.patientId);
        if (!cur.reason && d.reason) cur.reason = d.reason;
      } else {
        m.set(d.recallId, {
          id: d.recallId,
          drug: d.drug ?? "—",
          cls: classOf(d.classification),
          status: d.status,
          sourceUrl: d.sourceUrl,
          reason: d.reason,
          seenAt: toDate(e.ts),
          patientIds: d.patientId ? [d.patientId] : [],
        });
      }
    }
    return [...m.values()].sort(
      (a, b) => rank(a.cls) - rank(b.cls) || b.seenAt.getTime() - a.seenAt.getTime(),
    );
  }, [events]);

  // Pide el dossier completo (fixture u openFDA) una sola vez por recall.
  useEffect(() => {
    for (const c of recallCards) {
      if (details[c.id]) continue;
      setDetails((prev) => (prev[c.id] ? prev : { ...prev, [c.id]: { status: "loading" } }));
      fetchRecallDetail(c.id).then((res) => {
        setDetails((prev) => ({
          ...prev,
          [c.id]: res
            ? { status: "ready", source: res.source, record: res.record }
            : { status: "none" },
        }));
      });
    }
  }, [recallCards, details]);

  // El retiro más severo llega abierto: el dossier se muestra solo.
  useEffect(() => {
    if (!autoOpened.current && recallCards.length) {
      setOpenRecall(recallCards[0].id);
      autoOpened.current = true;
    }
  }, [recallCards]);

  const patients = useMemo(() => {
    const m = new Map<string, { name: string; drugs: string[]; worst: string }>();
    for (const e of events) {
      const d = parse(e.payload);
      if (e.kind === "patient_matched" && d.patientId) {
        m.set(d.patientId, {
          name: d.name ?? d.patientId,
          drugs: Array.isArray(d.drugs) ? d.drugs : [],
          worst: m.get(d.patientId)?.worst ?? "III",
        });
      }
      if (e.kind === "recall_detected" && d.patientId) {
        const cur = m.get(d.patientId);
        const cls = d.classification ?? "III";
        const worse = rank(cls) < rank(cur?.worst ?? "III") ? cls : cur?.worst ?? "III";
        m.set(d.patientId, {
          name: cur?.name ?? d.patientId,
          drugs: cur?.drugs ?? [],
          worst: worse,
        });
      }
    }
    return [...m.entries()].map(([id, v]) => ({ id, ...v })).sort(
      (a, b) => rank(a.worst) - rank(b.worst),
    );
  }, [events]);

  // Lo que sabemos del padrón vía eventos: fármacos de pacientes y recalls ya cruzados.
  const registryDrugs = useMemo(() => {
    const s = new Set<string>();
    for (const p of patients) for (const d of p.drugs) s.add(d.toLowerCase());
    return s;
  }, [patients]);

  // El cable como dossiers: cada registro del modo "All drugs" ya viene completo
  // del server, así que el detalle se sirve sin pedir nada más.
  const wireCards = useMemo(() => {
    if (!wire) return [];
    const drugs = [...registryDrugs];
    return wire.recalls.map((r) => {
      const known = recallCards.find((c) => c.id === r.recall_number);
      const hay = (r.product_description ?? "").toLowerCase();
      const hit = !!known || drugs.some((d) => hay.includes(d));
      const card: RecallCard = {
        id: r.recall_number,
        drug: known?.drug ?? recallDrugName(r),
        cls: classOf(r.classification),
        status: r.status,
        sourceUrl: recallSourceUrl(r.recall_number),
        reason: r.reason_for_recall,
        seenAt: fdaDate(r.report_date),
        patientIds: known?.patientIds ?? [],
      };
      const state: DetailState = { status: "ready", source: wire.source, record: r };
      return { card, state, hit };
    });
  }, [wire, recallCards, registryDrugs]);

  const classCounts = useMemo(() => {
    const c: Record<string, number> = { I: 0, II: 0, III: 0 };
    for (const card of recallCards) c[card.cls] = (c[card.cls] ?? 0) + 1;
    return c;
  }, [recallCards]);

  const kindCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const e of events) m[e.kind] = (m[e.kind] ?? 0) + 1;
    return m;
  }, [events]);

  const feed = events.filter((e) => {
    if (!activeKinds.has(e.kind)) return false;
    if (patientFilter) return parse(e.payload).patientId === patientFilter;
    return true;
  });

  const visibleCards = patientFilter
    ? recallCards.filter((c) => c.patientIds.includes(patientFilter))
    : recallCards;

  // Lo que muestra la columna principal según el selector: el padrón (eventos
  // del agente) o el cable completo de la FDA. El filtro de paciente solo
  // aplica al padrón; el cable es, por definición, de todos.
  const shownCards =
    scope === "all"
      ? wireCards.map((w) => ({
          ...w,
          seenNote: w.hit ? "matches your patient registry" : "no registry patient takes this drug",
        }))
      : visibleCards.map((c) => ({
          card: c,
          state: details[c.id],
          hit: false,
          seenNote: undefined as string | undefined,
        }));

  // Un boletín por paciente (el más reciente): el modo continuo regenera el mismo
  // boletín en cada pasada y la columna se llenaba de duplicados.
  const bulletins = useMemo(() => {
    const seen = new Set<string>();
    return events
      .filter((e) => e.kind === "bulletin_generated")
      .map((e) => parse(e.payload))
      .filter(
        (d) =>
          d.bulletin &&
          d.patientId &&
          !seen.has(d.patientId) &&
          (seen.add(d.patientId), true),
      )
      .filter((d) => !patientFilter || d.patientId === patientFilter);
  }, [events, patientFilter]);

  const bulletinPatients = useMemo(
    () =>
      new Set(
        events
          .filter((e) => e.kind === "bulletin_generated")
          .map((e) => parse(e.payload).patientId)
          .filter(Boolean),
      ).size,
    [events],
  );

  const source = offline ? "offline" : (data?.source ?? "backup");

  // La banda cuenta la historia del pipeline en orden: detectar -> cruzar -> explicar -> avisar.
  const stats = [
    { label: "Active recalls", sub: "found in registry drugs", value: recallCards.length },
    { label: "Patients affected", sub: "taking a recalled drug", value: patients.length },
    { label: "Bulletins", sub: "plain-language summary · Claude", value: bulletinPatients },
    {
      label: "Alerts · session",
      sub: "notices sent via Slack",
      value: events.filter((e) => e.kind === "alert_sent").length,
    },
  ];

  const toggleKind = (k: string) => {
    setActiveKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next.size === 0 ? new Set(KIND_KEYS) : next;
    });
  };

  const togglePatient = (id: string) =>
    setPatientFilter((prev) => (prev === id ? null : id));

  return (
    <div className="wrap">
      <header className="masthead">
        <div className="top">
          <div className="brand">
            <span className="mark" aria-hidden="true" />
            <div>
              <h1>FarmaWatcher</h1>
              <p>Event center · Pharmacovigilance</p>
            </div>
          </div>
          <div className="status">
            <SourceBadge source={source} />
            <span className="live">
              <span className="dot" aria-hidden="true" />
              Live
            </span>
            <span className="clock">Updated {updated}</span>
          </div>
        </div>
        <p className="strap">
          Watches the drug recalls published by the FDA, cross-checks them against the
          patient registry, and alerts — in plain language — anyone taking an affected drug.
        </p>
      </header>

      <section className="band" aria-label="Pipeline overview">
        {stats.map((s, i) => (
          <div key={s.label} className="cell">
            <div className="num">{s.value}</div>
            <div className="cap">
              <span className="step">{String(i + 1).padStart(2, "0")}</span>
              {s.label}
            </div>
            <div className="sub">{s.sub}</div>
          </div>
        ))}
      </section>

      {patientFilter && (
        <div className="filterbar">
          <span>
            Showing only <strong>{names.get(patientFilter) ?? patientFilter}</strong>
          </span>
          <button className="clear" onClick={() => setPatientFilter(null)}>
            ✕ Clear filter
          </button>
        </div>
      )}

      <div className="grid">
        <section className="col-feed">
          <div className="sec-head">
            <h2>{scope === "registry" ? "Active recalls · your patients" : "FDA wire · every drug"}</h2>
            <div className="seg" role="group" aria-label="Which recalls to show">
              <button
                className={scope === "registry" ? "on" : ""}
                aria-pressed={scope === "registry"}
                onClick={() => setScope("registry")}
              >
                My patients
                <span className="n">{recallCards.length}</span>
              </button>
              <button
                className={scope === "all" ? "on" : ""}
                aria-pressed={scope === "all"}
                onClick={() => setScope("all")}
              >
                All drugs
                <span className="n">{wire ? wire.recalls.length : "…"}</span>
              </button>
            </div>
          </div>
          {shownCards.length === 0 ? (
            <p className="empty">
              {scope === "all"
                ? "Reaching openFDA for the latest recalls…"
                : patientFilter
                  ? "This patient has no recalls on file."
                  : "No active recalls right now — the agent keeps watching openFDA."}
            </p>
          ) : (
            <div className="dossiers" key={scope}>
              {shownCards.map(({ card, state, hit, seenNote }) => (
                <RecallDossier
                  key={card.id}
                  card={card}
                  state={state}
                  hit={hit}
                  seenNote={seenNote}
                  open={openRecall === card.id}
                  onToggle={() => setOpenRecall(openRecall === card.id ? null : card.id)}
                  names={names}
                  onPatient={togglePatient}
                />
              ))}
            </div>
          )}
          {scope === "all" && wire && (
            <p className="wire-src">
              {wire.source === "openfda"
                ? "Live from openFDA · refreshed every 10 min"
                : "openFDA unreachable — showing the local record set"}
            </p>
          )}

          <div className="sec-head feed-head">
            <h2>Live log</h2>
            <div className="chips" role="group" aria-label="Filter by type">
              {KIND_KEYS.map((k) => (
                <button
                  key={k}
                  className={`chip ${activeKinds.has(k) ? "on" : ""}`}
                  aria-pressed={activeKinds.has(k)}
                  title={KIND[k]?.label}
                  onClick={() => toggleKind(k)}
                >
                  {KIND[k]?.code}
                  <span className="n">{kindCounts[k] ?? 0}</span>
                </button>
              ))}
            </div>
          </div>
          {feed.length === 0 ? (
            <p className="empty">
              No events match this filter. Turn more types back on above, or clear the
              patient filter.
            </p>
          ) : (
            <ol className="feed">
              {feed.slice(0, 120).map((e: EventRow, i: number) => {
                const meta = KIND[e.kind] ?? { label: e.kind, code: e.kind, cls: "" };
                const d = parse(e.payload);
                const key = `${e.ts}|${e.kind}|${e.payload}`;
                const sevI =
                  e.kind === "recall_detected" && d.classification === "I" ? " sev-I" : "";
                let delay = delays.current.get(key);
                if (delay === undefined) {
                  delay = firstBatch.current ? Math.min(i, 14) * 40 : 0;
                  delays.current.set(key, delay);
                }
                return (
                  <li
                    key={key}
                    className={`ev ${meta.cls}${sevI}`}
                    style={delay ? { animationDelay: `${delay}ms` } : undefined}
                  >
                    <time className="t">{hms(toDate(e.ts))}</time>
                    <span className="code" title={meta.label}>
                      {meta.code}
                    </span>
                    <div className="body">
                      <Summary kind={e.kind} d={d} names={names} />
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <aside className="rail">
          <section>
            <h2>Severity · what it means</h2>
            <SeverityLegend counts={classCounts} />
          </section>

          <section>
            <h2>Patients affected</h2>
            {patients.length === 0 ? (
              <p className="empty">None yet — the agent is watching.</p>
            ) : (
              <ul className="patients">
                {patients.map((p) => (
                  <li key={p.id}>
                    <button
                      className={`pt ${patientFilter === p.id ? "sel" : ""}`}
                      aria-pressed={patientFilter === p.id}
                      onClick={() => togglePatient(p.id)}
                    >
                      <span
                        className={`rn rn-${p.worst}`}
                        title={`Worst class: ${p.worst} — ${CLASS_META[classOf(p.worst)].risk}`}
                      >
                        {p.worst}
                      </span>
                      <span className="pt-name">{p.name}</span>
                      <span className="pt-drugs">{p.drugs.join(", ")}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <AddPatient />

          <section>
            <h2>Patient bulletins · Claude</h2>
            {bulletins.length === 0 ? (
              <p className="empty">
                No bulletins yet. They are generated when a recall matches a patient.
              </p>
            ) : (
              <div className="bulletins">
                {bulletins.map((d) => (
                  <article key={d.patientId} className="bull">
                    <div className="who">
                      For {(d.patientId && names.get(d.patientId)) || `patient ${d.patientId}`}
                    </div>
                    <p className="txt">{plainBulletin(d.bulletin)}</p>
                  </article>
                ))}
              </div>
            )}
          </section>
        </aside>
      </div>

      <footer className="creds">
        <span>
          Data <b>ClickHouse</b>
        </span>
        <span>
          Deploy <b>Render</b>
        </span>
        <span>
          LLM <b>TrueFoundry</b>
        </span>
        <span>
          Alerts <b>Composio</b>
        </span>
        <span>
          Source <b>openFDA</b>
        </span>
      </footer>
    </div>
  );
}

function rank(c: string): number {
  return c === "I" ? 0 : c === "II" ? 1 : 2;
}

/** "20260603" -> Date local (para seenAt de los recalls del cable). */
function fdaDate(s?: string): Date {
  if (s && /^\d{8}$/.test(s)) {
    return new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
  }
  return new Date(0);
}

/**
 * El dossier de un retiro: cabecera siempre legible (fármaco, clase en palabras,
 * estado) y al expandir, todo el jugo de openFDA en lenguaje llano.
 */
function RecallDossier({
  card,
  state,
  open,
  onToggle,
  names,
  onPatient,
  hit = false,
  seenNote,
}: {
  card: RecallCard;
  state?: DetailState;
  open: boolean;
  onToggle: () => void;
  names: Map<string, string>;
  onPatient: (id: string) => void;
  hit?: boolean;
  seenNote?: string;
}) {
  const [allLots, setAllLots] = useState(false);
  const rec: RecallDetail | undefined = state?.status === "ready" ? state.record : undefined;
  const meta = CLASS_META[card.cls];

  const status = statusLabel(rec?.status ?? card.status);
  const reason = clean(rec?.reason_for_recall ?? card.reason);
  const gist = reasonGist(reason ?? undefined);
  const firm = clean(rec?.recalling_firm);
  const place = rec ? firmPlace(rec) : null;
  const kind = [voluntaryLabel(rec?.voluntary_mandated), notificationLabel(rec?.initial_firm_notification)]
    .filter(Boolean)
    .join("; ");
  const scope = [distributionLabel(rec?.distribution_pattern), quantityLabel(rec?.product_quantity)]
    .filter(Boolean)
    .join(" · ");
  const codes = parseCodeInfo(rec?.code_info);
  const lots = allLots ? codes.lots : codes.lots.slice(0, 10);
  const milestones = [
    { cap: "Firm began the recall", val: fmtFdaDate(rec?.recall_initiation_date) },
    { cap: "FDA classified it", val: fmtFdaDate(rec?.center_classification_date) },
    { cap: "Published in the report", val: fmtFdaDate(rec?.report_date) },
  ].filter((s) => s.val);
  const product = clean(rec?.product_description);

  const srcNote = [
    state?.status === "ready"
      ? state.source === "openfda"
        ? "record fetched live from openFDA"
        : "local fallback record"
      : null,
    seenNote ?? `first seen at ${hms(card.seenAt)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <article className={`rc${open ? " open" : ""}`}>
      <button className="rc-head" aria-expanded={open} onClick={onToggle}>
        <span className={`rn rn-${card.cls}`} aria-hidden="true">
          {card.cls}
        </span>
        <span className="rc-title">
          <span className="rc-drug">{card.drug}</span>
          <span className="rc-meta">
            {card.id}
            {firm ? ` · ${firm}` : ""}
          </span>
        </span>
        <span className="rc-tags">
          {hit && (
            <span className="rc-hit" title="A registry patient takes this drug.">
              registry
            </span>
          )}
          <span className={`cls cls-${card.cls}`} title={meta.def}>
            Class {card.cls}
          </span>
          <span className="rc-risk">{meta.risk}</span>
          {status && (
            <span className="rc-status" title={statusTitle(rec?.status ?? card.status)}>
              {status}
            </span>
          )}
        </span>
        <span className="chev" aria-hidden="true" />
      </button>

      <div className="rc-body">
        <div className="rc-inner">
          <div className="rc-pad">
            {gist && <p className="rc-gist">{gist}</p>}

            <dl className="rc-grid">
              {reason && (
                <>
                  <dt>FDA reason</dt>
                  <dd className="rc-en">{reason}</dd>
                </>
              )}
              {(firm || place) && (
                <>
                  <dt>Recalled by</dt>
                  <dd>{[firm, place].filter(Boolean).join(" · ")}</dd>
                </>
              )}
              {kind && (
                <>
                  <dt>Type</dt>
                  <dd>{kind}</dd>
                </>
              )}
              {scope && (
                <>
                  <dt>Scope</dt>
                  <dd title={clean(rec?.distribution_pattern) ?? undefined}>{scope}</dd>
                </>
              )}
              {milestones.length > 0 && (
                <>
                  <dt>Timeline</dt>
                  <dd>
                    <ol className="tl">
                      {milestones.map((s) => (
                        <li key={s.cap}>
                          <span className="tl-date">{s.val}</span>
                          <span className="tl-cap">{s.cap}</span>
                        </li>
                      ))}
                    </ol>
                  </dd>
                </>
              )}
              {codes.lots.length > 0 && (
                <>
                  <dt>Lots</dt>
                  <dd>
                    <span className="rc-hint">
                      Compare with the “Lot” printed on your package:
                    </span>
                    <span className="lots">
                      {lots.map((l) => (
                        <code key={l} className="lot">
                          {l}
                        </code>
                      ))}
                      {codes.lots.length > 10 && (
                        <button
                          className="lot more"
                          aria-expanded={allLots}
                          onClick={() => setAllLots(!allLots)}
                        >
                          {allLots ? "show less" : `+${codes.lots.length - 10} more`}
                        </button>
                      )}
                    </span>
                  </dd>
                </>
              )}
              {codes.ndcs.length > 0 && (
                <>
                  <dt>NDC</dt>
                  <dd>
                    <span className="lots">
                      {codes.ndcs.map((n) => (
                        <code key={n} className="lot">
                          {n}
                        </code>
                      ))}
                    </span>
                  </dd>
                </>
              )}
              {product && (
                <>
                  <dt>Product</dt>
                  <dd className="rc-en rc-product" title={product}>
                    {product}
                  </dd>
                </>
              )}
              {card.patientIds.length > 0 && (
                <>
                  <dt>In the registry</dt>
                  <dd>
                    <span className="lots">
                      {card.patientIds.map((id) => (
                        <button key={id} className="lot pat" onClick={() => onPatient(id)}>
                          {names.get(id) ?? id}
                        </button>
                      ))}
                    </span>
                  </dd>
                </>
              )}
            </dl>

            {state?.status === "loading" && (
              <p className="rc-note loading">Querying openFDA…</p>
            )}
            {state?.status === "none" && (
              <p className="rc-note">Full record unavailable (openFDA unreachable).</p>
            )}

            <div className="rc-foot">
              {card.sourceUrl && (
                <a className="lnk" href={card.sourceUrl} target="_blank" rel="noreferrer">
                  View record on openFDA
                  <span className="ext" aria-hidden="true">
                    ↗
                  </span>
                </a>
              )}
              <span className="rc-src">{srcNote}</span>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

/** Las tres clases FDA con su definición en palabras: la leyenda que faltaba. */
function SeverityLegend({ counts }: { counts: Record<string, number> }) {
  const max = Math.max(1, counts.I ?? 0, counts.II ?? 0, counts.III ?? 0);
  return (
    <div className="legend">
      {(["I", "II", "III"] as const).map((c) => {
        const v = counts[c] ?? 0;
        const meta = CLASS_META[c];
        return (
          <div key={c} className={`lrow${v === 0 ? " mute" : ""}`}>
            <div className="lhead">
              <span className={`rn rn-${c}`}>{c}</span>
              <span className="lname">{meta.name}</span>
              <span className="lrisk">{meta.risk}</span>
              <span className="cval">{v}</span>
            </div>
            <div className="track">
              {v > 0 && (
                <div className={`fill f-${c}`} style={{ width: `${(v / max) * 100}%` }} />
              )}
            </div>
            <p className="ldef">{meta.def}</p>
          </div>
        );
      })}
    </div>
  );
}

function SourceBadge({ source }: { source: string }) {
  if (source === "clickhouse") return <span className="tag ok">ClickHouse</span>;
  if (source === "local") return <span className="tag ok">Source · Worker</span>;
  if (source === "offline") return <span className="tag warn">Offline</span>;
  return <span className="tag warn">Backup</span>;
}
