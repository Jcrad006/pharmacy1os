import { useEffect, useMemo, useRef, useState } from "react";
import { getPrescriptionQueue } from "../api";
import type { PrescriptionQueueItem, PrescriptionStatus } from "../types";
import {
  formatPatientName,
  formatPrescriberName,
  prioritizeQueueByStatus,
  statusLabels,
} from "../workflow";

const queueStatuses: Array<{ value: "" | PrescriptionStatus; label: string }> = [
  { value: "", label: "All statuses" },
  { value: "DATA_ENTRY", label: "Data Entry" },
  { value: "DUR_REVIEW", label: "DUR Review" },
  { value: "PRODUCT_FILL", label: "Product Fill" },
  { value: "PHARMACIST_REVIEW", label: "Pharmacist Review" },
  { value: "READY", label: "Ready / Will Call" },
  { value: "ON_HOLD", label: "On Hold" },
  { value: "SOLD", label: "Sold" },
  { value: "CANCELLED", label: "Cancelled" },
  { value: "TRANSFERRED", label: "Transferred" },
];

const priorityStatuses = queueStatuses.filter(
  (option) =>
    option.value === "" ||
    !["SOLD", "CANCELLED", "TRANSFERRED"].includes(option.value),
);

function ageInfo(updatedAt: string) {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - new Date(updatedAt).getTime()) / 60000),
  );

  if (minutes < 30) return { label: `${minutes}m`, level: "fresh" };
  if (minutes < 60) return { label: `${minutes}m`, level: "watch" };
  if (minutes < 120) {
    return {
      label: `${Math.floor(minutes / 60)}h ${minutes % 60}m`,
      level: "aging",
    };
  }
  return { label: `${Math.floor(minutes / 60)}h+`, level: "late" };
}

export function Dashboard({
  queue,
  counts,
  loading,
  devUser,
  onOpen,
  onRefresh,
}: {
  queue: PrescriptionQueueItem[];
  counts: { label: string; count: number; detail: string }[];
  loading: boolean;
  devUser: string;
  onOpen: (id: string) => void;
  onRefresh: () => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const selectedRowRef = useRef<HTMLTableRowElement>(null);
  const [query, setQuery] = useState(
    () => localStorage.getItem("pharmacy1os.queue.query") ?? "",
  );
  const [status, setStatus] = useState<"" | PrescriptionStatus>(
    () =>
      (localStorage.getItem("pharmacy1os.queue.status") as
        | ""
        | PrescriptionStatus
        | null) ?? "",
  );
  const [sort, setSort] = useState<"oldest" | "newest">(
    () =>
      (localStorage.getItem("pharmacy1os.queue.sort") as
        | "oldest"
        | "newest"
        | null) ?? "oldest",
  );
  const [priorityStatus, setPriorityStatus] = useState<"" | PrescriptionStatus>(
    () =>
      (localStorage.getItem("pharmacy1os.queue.priority") as
        | ""
        | PrescriptionStatus
        | null) ?? "",
  );
  const [visibleQueue, setVisibleQueue] = useState(queue);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [searching, setSearching] = useState(false);

  const workingQueue = useMemo(
    () => prioritizeQueueByStatus(visibleQueue, priorityStatus),
    [visibleQueue, priorityStatus],
  );

  useEffect(() => {
    setVisibleQueue(queue);
  }, [queue]);

  useEffect(() => {
    setSelectedIndex((current) =>
      workingQueue.length === 0
        ? 0
        : Math.min(current, workingQueue.length - 1),
    );
  }, [workingQueue.length]);

  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }, [selectedIndex]);

  useEffect(() => {
    function focusSearch() {
      searchRef.current?.focus();
      searchRef.current?.select();
    }
    window.addEventListener("pharmacy1os-focus-queue-search", focusSearch);
    return () =>
      window.removeEventListener("pharmacy1os-focus-queue-search", focusSearch);
  }, []);

  useEffect(() => {
    localStorage.setItem("pharmacy1os.queue.query", query);
    localStorage.setItem("pharmacy1os.queue.status", status);
    localStorage.setItem("pharmacy1os.queue.sort", sort);
    localStorage.setItem("pharmacy1os.queue.priority", priorityStatus);

    if (!devUser) return;
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const results = await getPrescriptionQueue(devUser, {
          query,
          status,
          sort,
          limit: 200,
        });
        setVisibleQueue(results);
        setSelectedIndex(0);
      } finally {
        setSearching(false);
      }
    }, 250);

    return () => window.clearTimeout(timer);
  }, [devUser, query, status, sort, priorityStatus]);

  useEffect(() => {
    function handleQueueKeys(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      const editing =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable;

      if (editing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (workingQueue.length === 0) return;

      if (event.key === "ArrowDown" || event.key.toLowerCase() === "j") {
        event.preventDefault();
        setSelectedIndex((index) =>
          Math.min(workingQueue.length - 1, index + 1),
        );
      } else if (event.key === "ArrowUp" || event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSelectedIndex((index) => Math.max(0, index - 1));
      } else if (event.key === "Home") {
        event.preventDefault();
        setSelectedIndex(0);
      } else if (event.key === "End") {
        event.preventDefault();
        setSelectedIndex(workingQueue.length - 1);
      } else if (event.key === "Enter" && workingQueue[selectedIndex]) {
        event.preventDefault();
        onOpen(workingQueue[selectedIndex].id);
      }
    }

    window.addEventListener("keydown", handleQueueKeys);
    return () => window.removeEventListener("keydown", handleQueueKeys);
  }, [workingQueue, selectedIndex, onOpen]);

  const activeFilterCount = useMemo(
    () =>
      Number(Boolean(query.trim())) +
      Number(Boolean(status)) +
      Number(sort !== "oldest") +
      Number(Boolean(priorityStatus)),
    [query, status, sort, priorityStatus],
  );

  function resetFilters() {
    setQuery("");
    setStatus("");
    setSort("oldest");
    setPriorityStatus("");
    setSelectedIndex(0);
    searchRef.current?.focus();
  }

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
          <div className="queue-header-actions">
            <span className="queue-count">
              {searching ? "Searching…" : `${workingQueue.length} shown`}
            </span>
            <button
              className="secondary-button"
              onClick={onRefresh}
              disabled={loading}
            >
              {loading ? "Working…" : "Refresh"}
            </button>
          </div>
        </div>

        <div className="queue-toolbar queue-toolbar-priority">
          <label className="queue-search">
            <span>Search</span>
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && workingQueue[0]) {
                  event.preventDefault();
                  onOpen(workingQueue[0].id);
                }
              }}
              placeholder="Rx #, drug, patient, or prescriber  (/)"
            />
          </label>

          <label>
            <span>Status</span>
            <select
              value={status}
              onChange={(event) =>
                setStatus(event.target.value as "" | PrescriptionStatus)
              }
            >
              {queueStatuses.map((option) => (
                <option key={option.value || "all"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Prioritize</span>
            <select
              value={priorityStatus}
              onChange={(event) => {
                setPriorityStatus(
                  event.target.value as "" | PrescriptionStatus,
                );
                setSelectedIndex(0);
              }}
            >
              {priorityStatuses.map((option) => (
                <option key={option.value || "none"} value={option.value}>
                  {option.value ? option.label : "No priority pin"}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Sort</span>
            <select
              value={sort}
              onChange={(event) =>
                setSort(event.target.value as "oldest" | "newest")
              }
            >
              <option value="oldest">Oldest activity first</option>
              <option value="newest">Newest activity first</option>
            </select>
          </label>

          <button
            className="secondary-button queue-reset"
            onClick={resetFilters}
            disabled={activeFilterCount === 0}
          >
            Reset {activeFilterCount ? `(${activeFilterCount})` : ""}
          </button>
        </div>

        <div className="queue-help">
          Saved on this workstation. <kbd>/</kbd> search · <kbd>J</kbd>/<kbd>↓</kbd>
          next · <kbd>K</kbd>/<kbd>↑</kbd> previous · <kbd>Home</kbd>/<kbd>End</kbd>
          jump · <kbd>Enter</kbd> open highlighted Rx.
        </div>

        <div className="table-wrap queue-table-wrap">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Age</th>
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
              {workingQueue.map((item, index) => {
                const age = ageInfo(item.updatedAt);
                const selected = index === selectedIndex;
                return (
                  <tr
                    key={item.id}
                    ref={selected ? selectedRowRef : undefined}
                    className={selected ? "queue-row-selected" : undefined}
                    aria-selected={selected}
                    onClick={() => setSelectedIndex(index)}
                  >
                    <td className="queue-cursor">
                      {selected ? "▶" : ""}
                    </td>
                    <td>
                      <span
                        className={`age-badge age-${age.level}`}
                        title={new Date(item.updatedAt).toLocaleString()}
                      >
                        {age.label}
                      </span>
                    </td>
                    <td className="mono">{item.rxNumber ?? "Pending"}</td>
                    <td>{formatPatientName(item.patient)}</td>
                    <td>
                      <strong>{item.medicationName}</strong>
                      <small className="cell-subtext">
                        {[item.strength, item.dosageForm]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    </td>
                    <td>{formatPrescriberName(item.prescriber)}</td>
                    <td>
                      <span
                        className={`status status-${item.status.toLowerCase()}`}
                      >
                        {statusLabels[item.status]}
                      </span>
                    </td>
                    <td>
                      {item.refillsUsed} / {item.refillsAllowed}
                    </td>
                    <td>
                      <button
                        className="secondary-button table-action"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpen(item.id);
                        }}
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                );
              })}
              {workingQueue.length === 0 && (
                <tr>
                  <td colSpan={9} className="empty-state">
                    No prescriptions match the current queue filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
