import { useEffect, useState } from "react";
import { getExceptions } from "../api";
import type {
  ExceptionItem,
  ExceptionKind,
  ExceptionSummary,
} from "../types";

const kinds: Array<{ value: "" | ExceptionKind; label: string }> = [
  { value: "", label: "All exceptions" },
  { value: "CLINICAL_ISSUE", label: "Clinical / DUR" },
  { value: "PHARMACIST_REVIEW", label: "Pharmacist Review" },
  { value: "ON_HOLD", label: "On Hold" },
  { value: "SCHEDULED_FILL", label: "Scheduled Fills" },
];

const kindLabels: Record<ExceptionKind, string> = {
  CLINICAL_ISSUE: "Clinical / DUR",
  PHARMACIST_REVIEW: "Pharmacist Review",
  ON_HOLD: "On Hold",
  SCHEDULED_FILL: "Scheduled Fill",
};

export function Exceptions({
  devUser,
  refreshToken,
  onOpen,
  onCountChanged,
  onError,
}: {
  devUser: string;
  refreshToken: number;
  onOpen: (id: string) => void;
  onCountChanged: (summary: ExceptionSummary) => void;
  onError: (message: string | null) => void;
}) {
  const [items, setItems] = useState<ExceptionItem[]>([]);
  const [summary, setSummary] = useState<ExceptionSummary>({
    total: 0,
    clinical: 0,
    onHold: 0,
    pharmacistReview: 0,
    scheduled: 0,
  });
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"" | ExceptionKind>("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!devUser) return;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const result = await getExceptions(devUser, { query, kind, limit: 300 });
        setItems(result.exceptions);
        setSummary(result.summary);
        onCountChanged(result.summary);
      } catch (error) {
        onError(error instanceof Error ? error.message : "Unable to load exceptions.");
      } finally {
        setLoading(false);
      }
    }, query ? 200 : 0);

    return () => window.clearTimeout(timer);
  }, [devUser, query, kind, refreshToken]);

  const cards = [
    ["Clinical / DUR", summary.clinical],
    ["Pharmacist Review", summary.pharmacistReview],
    ["On Hold", summary.onHold],
    ["Scheduled", summary.scheduled],
  ] as const;

  return (
    <>
      <section className="exception-summary">
        {cards.map(([label, count]) => (
          <article key={label} className="exception-summary-card">
            <span>{label}</span>
            <strong>{count}</strong>
          </article>
        ))}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Derived work queue</p>
            <h2>Exceptions requiring attention</h2>
          </div>
          <span className="queue-count">
            {loading ? "Updating…" : `${items.length} shown`}
          </span>
        </div>

        <div className="exception-toolbar">
          <input
            className="search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search Rx, patient, drug, or exception"
          />
          <select
            value={kind}
            onChange={(event) =>
              setKind(event.target.value as "" | ExceptionKind)
            }
          >
            {kinds.map((option) => (
              <option key={option.value || "all"} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <p className="directory-help">
          This list is derived from live prescription, fill, and DUR state. Resolve the underlying issue and the exception disappears automatically.
        </p>

        <div className="exception-list">
          {items.map((item) => (
            <article
              className={`exception-card exception-${item.severity.toLowerCase()}`}
              key={item.id}
            >
              <div className="exception-main">
                <div>
                  <div className="exception-label-row">
                    <span className="exception-kind">{kindLabels[item.kind]}</span>
                    <span className="severity-badge">{item.severity}</span>
                  </div>
                  <h3>{item.title}</h3>
                  <p>{item.patientName} · {item.medicationName}</p>
                  {item.detail && <small>{item.detail}</small>}
                </div>
                <div className="exception-side">
                  <span className="mono">{item.rxNumber ?? "Pending Rx"}</span>
                  {item.dueAt && (
                    <time>
                      Due {new Date(item.dueAt).toLocaleString()}
                    </time>
                  )}
                  <button
                    className="secondary-button"
                    onClick={() => onOpen(item.prescriptionId)}
                  >
                    Open prescription
                  </button>
                </div>
              </div>
            </article>
          ))}
          {items.length === 0 && (
            <div className="empty-state">
              No exceptions match the current filters.
            </div>
          )}
        </div>
      </section>
    </>
  );
}
