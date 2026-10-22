import { useEffect, useState } from "react";
import { classOf, fetchRecallWire, recallDrugName, recallSourceUrl, type WireRecall } from "./lib";
import "./ticker.css";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LIMIT = 30;

function shortDate(d?: string): string {
  if (!d || d.length < 8) return "";
  const m = Number(d.slice(4, 6)) - 1;
  const day = Number(d.slice(6, 8));
  return MONTHS[m] ? `${MONTHS[m]} ${day}` : "";
}

function shortFirm(f?: string): string {
  if (!f) return "Unknown firm";
  const cut = f
    .replace(/\s*\(.*?\)\s*/g, " ")
    .replace(/[,.]?\s+(inc|llc|ltd|corp|corporation|co|company|limited|pvt|private|plc|gmbh|s\.?a|l\.?p)\.?\b.*$/i, "")
    .trim();
  const words = (cut || f).split(/\s+/).slice(0, 3).join(" ");
  if (words !== words.toUpperCase()) return words;
  return words.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function place(r: WireRecall): string {
  const c = (r.country ?? "").trim();
  if (r.state && (!c || /united states/i.test(c))) return r.state;
  return c || r.state || "";
}

function Item({ r, hidden }: { r: WireRecall; hidden?: boolean }) {
  const cls = classOf(r.classification);
  const meta = [shortFirm(r.recalling_firm), place(r), shortDate(r.report_date)].filter(Boolean).join(" · ");
  return (
    <a
      className="tk-item"
      href={recallSourceUrl(r.recall_number)}
      target="_blank"
      rel="noopener noreferrer"
      aria-hidden={hidden || undefined}
      tabIndex={hidden ? -1 : undefined}
      title={`Class ${cls} recall ${r.recall_number}`}
    >
      <span className={`tk-dot tk-c${cls}`} aria-hidden="true" />
      <span className="tk-drug">{recallDrugName(r)}</span>
      <span className="tk-meta">{meta}</span>
    </a>
  );
}

export default function RecallTicker() {
  const [recalls, setRecalls] = useState<WireRecall[]>([]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchRecallWire()
        .then((res) => {
          if (!alive) return;
          const sorted = [...res.recalls].sort((a, b) => (b.report_date ?? "").localeCompare(a.report_date ?? ""));
          setRecalls(sorted.slice(0, LIMIT));
        })
        .catch(() => {});
    load();
    const t = window.setInterval(load, 60_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  return (
    <section className="tk-root" aria-label="Latest FDA recalls">
      <div className="tk-label">
        <span className="tk-live" aria-hidden="true" />
        Latest FDA recalls
      </div>
      <div className="tk-viewport">
        {recalls.length > 0 && (
          <div className="tk-track">
            <div className="tk-group">
              {recalls.map((r) => (
                <Item key={r.recall_number} r={r} />
              ))}
            </div>
            <div className="tk-group tk-dup" aria-hidden="true">
              {recalls.map((r) => (
                <Item key={r.recall_number} r={r} hidden />
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
