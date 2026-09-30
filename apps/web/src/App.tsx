import { useEffect, useMemo, useState } from "react";
import {
  getDevelopmentUsers,
  getPatients,
  getPrescribers,
  getPrescriptionQueue,
} from "./api";
import { Dashboard } from "./screens/Dashboard";
import { NewPrescription } from "./screens/NewPrescription";
import { Patients } from "./screens/Patients";
import { Prescribers } from "./screens/Prescribers";
import { PrescriptionDetail } from "./screens/PrescriptionDetail";
import type { DevUser, Patient, Prescriber, PrescriptionQueueItem } from "./types";
import { roleLabel } from "./workflow";

type View = "dashboard" | "new-rx" | "patients" | "prescribers" | "detail";

const viewTitles: Record<View, string> = {
  dashboard: "Dispensing Dashboard",
  "new-rx": "New Prescription",
  patients: "Patients",
  prescribers: "Prescribers",
  detail: "Prescription Detail",
};

export function App() {
  const [users, setUsers] = useState<DevUser[]>([]);
  const [selectedExternalId, setSelectedExternalId] = useState(
    () => localStorage.getItem("pharmacy1os.devUser") ?? "",
  );
  const [queue, setQueue] = useState<PrescriptionQueueItem[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [prescribers, setPrescribers] = useState<Prescriber[]>([]);
  const [view, setView] = useState<View>("dashboard");
  const [selectedPrescriptionId, setSelectedPrescriptionId] = useState<string | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const selectedUser = users.find(
    (user) => user.externalAuthId === selectedExternalId,
  );

  async function refreshWorkspace(devUser = selectedExternalId) {
    if (!devUser) return;

    setLoading(true);
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
    const count = (status: string) => queue.filter((rx) => rx.status === status).length;
    const scheduled = queue.flatMap((rx) => rx.fills).filter(
      (fill) => fill.status === "SCHEDULED",
    ).length;

    return [
      { label: "Data Entry", count: count("DATA_ENTRY"), detail: "Awaiting data/DUR progression" },
      { label: "Product Fill", count: count("PRODUCT_FILL"), detail: "Being prepared" },
      {
        label: "Pharmacist Review",
        count: count("PHARMACIST_REVIEW"),
        detail: "Awaiting final verification",
      },
      { label: "Future Fills", count: scheduled, detail: "Scheduled dispensing events" },
    ];
  }, [queue]);

  function selectUser(value: string) {
    setSelectedExternalId(value);
    localStorage.setItem("pharmacy1os.devUser", value);
  }

  function navigate(next: View) {
    setMessage(null);
    if (next !== "detail") setSelectedPrescriptionId(null);
    setView(next);
  }

  function openPrescription(id: string) {
    setSelectedPrescriptionId(id);
    setMessage(null);
    setView("detail");
  }

  async function afterMutation(messageText: string) {
    await refreshWorkspace();
    setMessage(messageText);
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
          <button className={view === "dashboard" ? "nav-item active" : "nav-item"} onClick={() => navigate("dashboard")}>Dashboard</button>
          <button className={view === "new-rx" ? "nav-item active" : "nav-item"} onClick={() => navigate("new-rx")}>New Prescription</button>
          <button className={view === "patients" ? "nav-item active" : "nav-item"} onClick={() => navigate("patients")}>Patients</button>
          <button className={view === "prescribers" ? "nav-item active" : "nav-item"} onClick={() => navigate("prescribers")}>Prescribers</button>
          <button className="nav-item" disabled>Inventory</button>
          <button className="nav-item" disabled>Reports</button>
        </nav>

        <div className="user-panel">
          <label htmlFor="staff">Synthetic staff identity</label>
          <select id="staff" value={selectedExternalId} onChange={(event) => selectUser(event.target.value)}>
            {users.map((user) => (
              <option key={user.externalAuthId} value={user.externalAuthId}>
                {user.displayName} — {roleLabel(user.role)}
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
            <h1>{viewTitles[view]}</h1>
          </div>
          <div className="header-actions">
            {selectedUser && (
              <span className="user-chip">
                {selectedUser.displayName} · {roleLabel(selectedUser.role)}
              </span>
            )}
            <span className="prototype-badge">Prototype — synthetic data only</span>
          </div>
        </header>

        <section className="notice">
          <strong>Development environment</strong>
          <span>All records shown here are synthetic. Do not enter real PHI or live prescription information.</span>
        </section>

        {message && <section className="message">{message}</section>}

        {view === "dashboard" && (
          <Dashboard
            queue={queue}
            counts={counts}
            loading={loading}
            onOpen={openPrescription}
            onRefresh={() => void refreshWorkspace()}
          />
        )}

        {view === "new-rx" && (
          <NewPrescription
            patients={patients}
            prescribers={prescribers}
            devUser={selectedExternalId}
            loading={loading}
            onCreated={async (id) => {
              await afterMutation("Synthetic prescription created.");
              openPrescription(id);
            }}
            onError={setMessage}
            setLoading={setLoading}
          />
        )}

        {view === "patients" && (
          <Patients
            patients={patients}
            devUser={selectedExternalId}
            user={selectedUser}
            loading={loading}
            setLoading={setLoading}
            onError={setMessage}
            onCreated={() => afterMutation("Synthetic patient registered.")}
          />
        )}

        {view === "prescribers" && (
          <Prescribers
            prescribers={prescribers}
            devUser={selectedExternalId}
            user={selectedUser}
            loading={loading}
            setLoading={setLoading}
            onError={setMessage}
            onCreated={() => afterMutation("Synthetic prescriber registered.")}
          />
        )}

        {view === "detail" && selectedPrescriptionId && (
          <PrescriptionDetail
            prescriptionId={selectedPrescriptionId}
            devUser={selectedExternalId}
            user={selectedUser}
            onBack={() => navigate("dashboard")}
            onMutated={async (text) => {
              await afterMutation(text);
            }}
            onError={setMessage}
          />
        )}
      </main>
    </div>
  );
}
