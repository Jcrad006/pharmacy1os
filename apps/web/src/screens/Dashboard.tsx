import type { PrescriptionQueueItem } from "../types";
import { formatPatientName, formatPrescriberName, statusLabels } from "../workflow";

export function Dashboard({
  queue,
  counts,
  loading,
  onOpen,
  onRefresh,
}: {
  queue: PrescriptionQueueItem[];
  counts: { label: string; count: number; detail: string }[];
  loading: boolean;
  onOpen: (id: string) => void;
  onRefresh: () => void;
}) {
  return (
    <>
      <section className="workflow-grid">
        {counts.map((card) => (
          <article className="workflow-card" key={card.label}>
            <span>{card.label}</span>
            <strong>{card.count}</strong>
            <small>{card.detail}</small>
          </article>
        ))}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Live synthetic queue</p>
            <h2>Prescription workflow</h2>
          </div>
          <button className="secondary-button" onClick={onRefresh} disabled={loading}>
            {loading ? "Working…" : "Refresh"}
          </button>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Rx</th>
                <th>Patient</th>
                <th>Medication</th>
                <th>Prescriber</th>
                <th>Status</th>
                <th>Refills</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {queue.map((item) => (
                <tr key={item.id}>
                  <td className="mono">{item.rxNumber ?? "Pending"}</td>
                  <td>{formatPatientName(item.patient)}</td>
                  <td>
                    <strong>{item.medicationName}</strong>
                    <small className="cell-subtext">
                      {[item.strength, item.dosageForm].filter(Boolean).join(" · ")}
                    </small>
                  </td>
                  <td>{formatPrescriberName(item.prescriber)}</td>
                  <td>
                    <span className={`status status-${item.status.toLowerCase()}`}>
                      {statusLabels[item.status]}
                    </span>
                  </td>
                  <td>{item.refillsUsed} / {item.refillsAllowed}</td>
                  <td>
                    <button className="secondary-button table-action" onClick={() => onOpen(item.id)}>
                      Open
                    </button>
                  </td>
                </tr>
              ))}
              {queue.length === 0 && (
                <tr>
                  <td colSpan={7} className="empty-state">No synthetic prescriptions are currently in the queue.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
