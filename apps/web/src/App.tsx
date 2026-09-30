import { useEffect, useMemo, useState } from "react";
import {
  getDevelopmentUsers,
  getPatients,
  getPrescribers,
  getPrescriptionQueue,
  getWillCall,
  getExceptions,
} from "./api";
import { Dashboard } from "./screens/Dashboard";
import { NewPrescription } from "./screens/NewPrescription";
import { Patients } from "./screens/Patients";
import { Prescribers } from "./screens/Prescribers";
import { PrescriptionDetail } from "./screens/PrescriptionDetail";
import { Exceptions } from "./screens/Exceptions";
import { WillCall } from "./screens/WillCall";
import { DrugCatalog } from "./screens/DrugCatalog";
import type { DevUser, ExceptionSummary, Patient, Prescriber, PrescriptionQueueItem } from "./types";
import { roleLabel } from "./workflow";

type View =
  | "dashboard"
  | "exceptions"
  | "will-call"
  | "new-rx"
  | "patients"
  | "prescribers"
  | "catalog"
  | "detail";

const viewTitles: Record<View, string> = {
  dashboard: "Dispensing Dashboard",
  exceptions: "Exceptions",
  "will-call": "Will Call",
  "new-rx": "New Prescription",
  patients: "Patients",
  prescribers: "Providers",
  catalog: "Drug / Product Catalog",
  detail: "Prescription Detail",
};

export function App() {
  const [users, setUsers] = useState<DevUser[]>([]);
  const [selectedExternalId, setSelectedExternalId] = useState(
    () => localStorage.getItem("pharmacy1os.devUser") ?? "",
  );
  const [queue, setQueue] = useState<PrescriptionQueueItem[]>([]);
  const [willCall, setWillCall] = useState<PrescriptionQueueItem[]>([]);
  const [exceptionSummary, setExceptionSummary] = useState<ExceptionSummary>({
    total: 0,
    clinical: 0,
    onHold: 0,
    pharmacistReview: 0,
    scheduled: 0,
  });
  const [exceptionRefreshToken, setExceptionRefreshToken] = useState(0);
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
      const [nextQueue, nextWillCall, nextExceptions, nextPatients, nextPrescribers] =
        await Promise.all([
          getPrescriptionQueue(devUser),
          getWillCall(devUser),
          getExceptions(devUser),
          getPatients(devUser),
          getPrescribers(devUser),
        ]);
      setQueue(nextQueue);
      setWillCall(nextWillCall);
      setExceptionSummary(nextExceptions.summary);
      setExceptionRefreshToken((value) => value + 1);
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

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      const editing =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable;

      if (event.key === "/" && !editing) {
        event.preventDefault();
        navigate("dashboard");
        window.setTimeout(() => {
          window.dispatchEvent(new Event("pharmacy1os-focus-queue-search"));
        }, 0);
        return;
      }

      if (event.key === "Escape" && view === "detail") {
        navigate("dashboard");
        return;
      }

      const functionKeyMap: Partial<Record<string, View>> = {
        F1: "dashboard",
        F2: "exceptions",
        F3: "will-call",
        F4: "new-rx",
        F5: "patients",
        F6: "prescribers",
        F7: "catalog",
      };

      const destination = functionKeyMap[event.key];
      if (!destination) return;

      event.preventDefault();
      event.stopPropagation();
      navigate(destination);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [view]);

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
      { label: "Will Call", count: willCall.length, detail: "Ready for pickup" },
      { label: "Future Fills", count: scheduled, detail: "Scheduled dispensing events" },
    ];
  }, [queue, willCall]);

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
          <button className={view === "dashboard" ? "nav-item active" : "nav-item"} onClick={() => navigate("dashboard")}><span>Dashboard</span><kbd>F1</kbd></button>
          <button className={view === "exceptions" ? "nav-item active" : "nav-item"} onClick={() => navigate("exceptions")}><span>Exceptions <span className="nav-count">{exceptionSummary.total}</span></span><kbd>F2</kbd></button>
          <button className={view === "will-call" ? "nav-item active" : "nav-item"} onClick={() => navigate("will-call")}><span>Will Call <span className="nav-count">{willCall.length}</span></span><kbd>F3</kbd></button>
          <button className={view === "new-rx" ? "nav-item active" : "nav-item"} onClick={() => navigate("new-rx")}><span>New Prescription</span><kbd>F4</kbd></button>
          <button className={view === "patients" ? "nav-item active" : "nav-item"} onClick={() => navigate("patients")}><span>Patients</span><kbd>F5</kbd></button>
          <button className={view === "prescribers" ? "nav-item active" : "nav-item"} onClick={() => navigate("prescribers")}><span>Providers</span><kbd>F6</kbd></button>
          <button className={view === "catalog" ? "nav-item active" : "nav-item"} onClick={() => navigate("catalog")}><span>Drug / Product</span><kbd>F7</kbd></button>
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
          <div className="shortcut-hint">
            <span><kbd>F1</kbd> Dashboard</span>
            <span><kbd>F2</kbd> Exceptions</span>
            <span><kbd>F3</kbd> Will Call</span>
            <span><kbd>F4</kbd> New Rx</span>
            <span><kbd>F5</kbd> Patients</span>
            <span><kbd>F6</kbd> Providers</span>
            <span><kbd>F7</kbd> Drug / Product</span>
          </div>
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

        {view === "exceptions" && (
          <Exceptions
            devUser={selectedExternalId}
            refreshToken={exceptionRefreshToken}
            onOpen={openPrescription}
            onCountChanged={setExceptionSummary}
            onError={setMessage}
          />
        )}

        {view === "dashboard" && (
          <Dashboard
            queue={queue}
            counts={counts}
            loading={loading}
            devUser={selectedExternalId}
            onOpen={openPrescription}
            onRefresh={() => void refreshWorkspace()}
          />
        )}

        {view === "will-call" && (
          <WillCall
            prescriptions={willCall}
            devUser={selectedExternalId}
            user={selectedUser}
            loading={loading}
            onOpen={openPrescription}
            onMutated={afterMutation}
            onError={setMessage}
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

        {view === "catalog" && (
          <DrugCatalog
            devUser={selectedExternalId}
            user={selectedUser}
            onError={setMessage}
          />
        )}

        {view === "detail" && selectedPrescriptionId && (
          <PrescriptionDetail
            prescriptionId={selectedPrescriptionId}
            devUser={selectedExternalId}
            user={selectedUser}
            prescribers={prescribers}
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
