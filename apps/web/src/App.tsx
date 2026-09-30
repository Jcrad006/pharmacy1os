import { useEffect, useMemo, useState } from "react";
import {
  createPrescription,
  getDevelopmentUsers,
  getPatients,
  getPrescribers,
  getPrescriptionQueue,
  transitionPrescription,
} from "./api";
import type {
  DevUser,
  Patient,
  Prescriber,
  PrescriptionQueueItem,
  PrescriptionStatus,
} from "./types";

const statusLabels: Record<PrescriptionStatus, string> = {
  RECEIVED: "Received",
  DATA_ENTRY: "Data Entry",
  DUR_REVIEW: "DUR Review",
  PRODUCT_FILL: "Product Fill",
  PHARMACIST_REVIEW: "Pharmacist Review",
  READY: "Ready",
  SOLD: "Sold",
  ON_HOLD: "On Hold",
  CANCELLED: "Cancelled",
  TRANSFERRED: "Transferred",
};

const preferredNext: Partial<Record<PrescriptionStatus, PrescriptionStatus>> = {
  RECEIVED: "DATA_ENTRY",
  DATA_ENTRY: "DUR_REVIEW",
  DUR_REVIEW: "PRODUCT_FILL",
  PRODUCT_FILL: "PHARMACIST_REVIEW",
  PHARMACIST_REVIEW: "READY",
  READY: "SOLD",
};

function roleCanVerify(user: DevUser | undefined) {
  return user?.role === "PHARMACIST" || user?.role === "ADMIN";
}

function formatPatientName(patient: Patient) {
  return `${patient.lastName}, ${patient.firstName}`;
}

function formatPrescriberName(prescriber: Prescriber) {
  return `${prescriber.lastName}, ${prescriber.firstName}`;
}

export function App() {
  const [users, setUsers] = useState<DevUser[]>([]);
  const [selectedExternalId, setSelectedExternalId] = useState(
    () => localStorage.getItem("pharmacy1os.devUser") ?? "",
  );
  const [queue, setQueue] = useState<PrescriptionQueueItem[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [prescribers, setPrescribers] = useState<Prescriber[]>([]);
  const [view, setView] = useState<"dashboard" | "new-rx">("dashboard");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const selectedUser = users.find(
    (user) => user.externalAuthId === selectedExternalId,
  );

  async function refreshWorkspace(devUser = selectedExternalId) {
    if (!devUser) return;

    setLoading(true);
    setMessage(null);
    try {
      const [nextQueue, nextPatients, nextPrescribers] = await Promise.all([
        getPrescriptionQueue(devUser),
        getPatients(devUser),
        getPrescribers(devUser),
      ]);
      setQueue(nextQueue);
      setPatients(nextPatients);
      setPrescribers(nextPrescribers);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to load workstation.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    getDevelopmentUsers()
      .then((nextUsers) => {
        setUsers(nextUsers);
        const stored = localStorage.getItem("pharmacy1os.devUser");
        if (stored && nextUsers.some((user) => user.externalAuthId === stored)) {
          setSelectedExternalId(stored);
        } else if (nextUsers[0]) {
          setSelectedExternalId(nextUsers[0].externalAuthId);
          localStorage.setItem("pharmacy1os.devUser", nextUsers[0].externalAuthId);
        }
      })
      .catch((error) => {
        setMessage(error instanceof Error ? error.message : "Unable to load demo staff.");
      });
  }, []);

  useEffect(() => {
    if (selectedExternalId) {
      void refreshWorkspace(selectedExternalId);
    }
  }, [selectedExternalId]);

  const counts = useMemo(() => {
    const count = (status: PrescriptionStatus) =>
      queue.filter((item) => item.status === status).length;

    return [
      { label: "Data Entry", count: count("DATA_ENTRY"), detail: "New and edited prescriptions" },
      {
        label: "Product Fill",
        count: count("PRODUCT_FILL"),
        detail: "Ready for preparation",
      },
      {
        label: "Pharmacist Review",
        count: count("PHARMACIST_REVIEW"),
        detail: "Awaiting verification",
      },
      { label: "Ready", count: count("READY"), detail: "Prepared for pickup" },
    ];
  }, [queue]);

  function selectUser(value: string) {
    setSelectedExternalId(value);
    localStorage.setItem("pharmacy1os.devUser", value);
  }

  async function advancePrescription(item: PrescriptionQueueItem) {
    if (!selectedExternalId) return;

    const target = preferredNext[item.status];
    if (!target) return;

    if (target === "READY" && !roleCanVerify(selectedUser)) {
      setMessage("A pharmacist must perform the final verification before this prescription can become Ready.");
      return;
    }

    setLoading(true);
    setMessage(null);
    try {
      await transitionPrescription(selectedExternalId, item.id, target);
      await refreshWorkspace(selectedExternalId);
      setMessage(
        target === "READY"
          ? "Pharmacist verification recorded; prescription is Ready."
          : `Prescription moved to ${statusLabels[target]}.`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Workflow update failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">Rx</span>
          <div>
            <strong>Pharmacy1OS</strong>
            <small>Synthetic dispensing prototype</small>
          </div>
        </div>

        <nav>
          <button
            className={view === "dashboard" ? "nav-item active" : "nav-item"}
            onClick={() => setView("dashboard")}
          >
            Dashboard
          </button>
          <button
            className={view === "new-rx" ? "nav-item active" : "nav-item"}
            onClick={() => setView("new-rx")}
          >
            New Prescription
          </button>
          <button className="nav-item" disabled>Patients</button>
          <button className="nav-item" disabled>Prescribers</button>
          <button className="nav-item" disabled>Inventory</button>
          <button className="nav-item" disabled>Reports</button>
        </nav>

        <div className="user-panel">
          <label htmlFor="staff">Synthetic staff identity</label>
          <select
            id="staff"
            value={selectedExternalId}
            onChange={(event) => selectUser(event.target.value)}
          >
            {users.map((user) => (
              <option key={user.externalAuthId} value={user.externalAuthId}>
                {user.displayName} — {user.role}
              </option>
            ))}
          </select>
          <small>Development only. This is not production authentication.</small>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div>
            <p className="eyebrow">Pharmacy operations</p>
            <h1>{view === "dashboard" ? "Dispensing Dashboard" : "New Prescription"}</h1>
          </div>
          <div className="header-actions">
            {selectedUser && (
              <span className="user-chip">
                {selectedUser.displayName} · {selectedUser.role}
              </span>
            )}
            <span className="prototype-badge">Prototype — synthetic data only</span>
          </div>
        </header>

        <section className="notice">
          <strong>Development environment</strong>
          <span>
            This workstation uses synthetic records. Do not enter real patient or prescription information.
          </span>
        </section>

        {message && <section className="message">{message}</section>}

        {view === "dashboard" ? (
          <Dashboard
            queue={queue}
            counts={counts}
            loading={loading}
            selectedUser={selectedUser}
            onAdvance={advancePrescription}
            onRefresh={() => void refreshWorkspace()}
          />
        ) : (
          <NewPrescription
            patients={patients}
            prescribers={prescribers}
            devUser={selectedExternalId}
            loading={loading}
            onCreated={async () => {
              await refreshWorkspace();
              setView("dashboard");
              setMessage("Synthetic prescription created and placed in Data Entry.");
            }}
            onError={setMessage}
            setLoading={setLoading}
          />
        )}
      </main>
    </div>
  );
}

function Dashboard({
  queue,
  counts,
  loading,
  selectedUser,
  onAdvance,
  onRefresh,
}: {
  queue: PrescriptionQueueItem[];
  counts: { label: string; count: number; detail: string }[];
  loading: boolean;
  selectedUser?: DevUser;
  onAdvance: (item: PrescriptionQueueItem) => Promise<void>;
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
                <th>Next action</th>
              </tr>
            </thead>
            <tbody>
              {queue.map((item) => {
                const next = preferredNext[item.status];
                const pharmacistRequired =
                  next === "READY" && !roleCanVerify(selectedUser);

                return (
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
                    <td>
                      {next ? (
                        <button
                          className="primary-button table-action"
                          disabled={loading || pharmacistRequired}
                          onClick={() => void onAdvance(item)}
                          title={pharmacistRequired ? "Pharmacist verification required" : undefined}
                        >
                          {pharmacistRequired
                            ? "Pharmacist required"
                            : next === "READY"
                              ? "Verify & Ready"
                              : `Move to ${statusLabels[next]}`}
                        </button>
                      ) : (
                        <span className="muted">No standard next step</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {queue.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty-state">
                    No synthetic prescriptions are currently in the queue.
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

function NewPrescription({
  patients,
  prescribers,
  devUser,
  loading,
  onCreated,
  onError,
  setLoading,
}: {
  patients: Patient[];
  prescribers: Prescriber[];
  devUser: string;
  loading: boolean;
  onCreated: () => Promise<void>;
  onError: (message: string | null) => void;
  setLoading: (value: boolean) => void;
}) {
  const [patientId, setPatientId] = useState("");
  const [prescriberId, setPrescriberId] = useState("");
  const [rxNumber, setRxNumber] = useState("");
  const [medicationName, setMedicationName] = useState("");
  const [strength, setStrength] = useState("");
  const [dosageForm, setDosageForm] = useState("tablet");
  const [sig, setSig] = useState("");
  const [quantity, setQuantity] = useState("30");
  const [refills, setRefills] = useState("0");
  const [doNotFillBefore, setDoNotFillBefore] = useState("");

  useEffect(() => {
    if (!patientId && patients[0]) setPatientId(patients[0].id);
    if (!prescriberId && prescribers[0]) setPrescriberId(prescribers[0].id);
  }, [patients, prescribers, patientId, prescriberId]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!devUser) return;

    setLoading(true);
    onError(null);
    try {
      await createPrescription(devUser, {
        patientId,
        prescriberId,
        rxNumber: rxNumber || undefined,
        medicationName,
        strength: strength || undefined,
        dosageForm: dosageForm || undefined,
        sig,
        quantityWritten: quantity ? Number(quantity) : undefined,
        refillsAllowed: refills ? Number(refills) : 0,
        doNotFillBefore: doNotFillBefore
          ? new Date(`${doNotFillBefore}T00:00:00`).toISOString()
          : undefined,
      });
      await onCreated();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to create prescription.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="panel rx-entry-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Synthetic data entry</p>
          <h2>Create prescription</h2>
        </div>
      </div>

      <form className="rx-form" onSubmit={submit}>
        <label>
          Patient
          <select value={patientId} onChange={(event) => setPatientId(event.target.value)} required>
            {patients.map((patient) => (
              <option key={patient.id} value={patient.id}>
                {formatPatientName(patient)}
              </option>
            ))}
          </select>
        </label>

        <label>
          Prescriber
          <select
            value={prescriberId}
            onChange={(event) => setPrescriberId(event.target.value)}
            required
          >
            {prescribers.map((prescriber) => (
              <option key={prescriber.id} value={prescriber.id}>
                {formatPrescriberName(prescriber)}
              </option>
            ))}
          </select>
        </label>

        <label>
          Rx number
          <input value={rxNumber} onChange={(event) => setRxNumber(event.target.value)} placeholder="Optional" />
        </label>

        <label>
          Medication
          <input value={medicationName} onChange={(event) => setMedicationName(event.target.value)} required />
        </label>

        <label>
          Strength
          <input value={strength} onChange={(event) => setStrength(event.target.value)} placeholder="e.g., 10 mg" />
        </label>

        <label>
          Dosage form
          <input value={dosageForm} onChange={(event) => setDosageForm(event.target.value)} />
        </label>

        <label className="wide">
          Directions / Sig
          <input value={sig} onChange={(event) => setSig(event.target.value)} required />
        </label>

        <label>
          Quantity
          <input type="number" min="0" step="0.001" value={quantity} onChange={(event) => setQuantity(event.target.value)} />
        </label>

        <label>
          Refills
          <input type="number" min="0" step="1" value={refills} onChange={(event) => setRefills(event.target.value)} />
        </label>

        <label>
          Do not fill before
          <input type="date" value={doNotFillBefore} onChange={(event) => setDoNotFillBefore(event.target.value)} />
        </label>

        <div className="form-actions wide">
          <button className="primary-button" type="submit" disabled={loading || !patientId || !prescriberId}>
            {loading ? "Saving…" : "Create synthetic prescription"}
          </button>
        </div>
      </form>
    </section>
  );
}
