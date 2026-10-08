import { useEffect, useMemo, useState } from "react";
import {
  getDevelopmentUsers,
  getAuthStatus,
  getAuthenticatedUser,
  endAuthenticatedSession,
  setAuthCsrfToken,
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
import { Receiving } from "./screens/Receiving";
import { Inventory } from "./screens/Inventory";
import { ThirdParty } from "./screens/ThirdParty";
import { StaffAdministration } from "./screens/StaffAdministration";
import { WorkforceSecurity } from "./screens/WorkforceSecurity";
import { PrivilegeApprovals } from "./screens/PrivilegeApprovals";
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
  | "receiving"
  | "inventory"
  | "third-party"
  | "staff"
  | "privileges"
  | "security"
  | "detail";

const viewTitles: Record<View, string> = {
  dashboard: "Dispensing Dashboard",
  exceptions: "Exceptions",
  "will-call": "Will Call",
  "new-rx": "New Prescription",
  patients: "Patients",
  prescribers: "Providers",
  catalog: "Drug / Product Catalog",
  receiving: "Inventory Receiving",
  inventory: "Inventory Ledger",
  "third-party": "Third Party / COB",
  staff: "Staff Administration",
  privileges: "Access Approvals",
  security: "Workforce Security",
  detail: "Prescription Detail",
};

export function App() {
  const [authMode, setAuthMode] = useState<"loading" | "development" | "oidc">("loading");
  const [authReady, setAuthReady] = useState(false);
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
    emergencyFollowUp: 0,
    biologicCommunication: 0,
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
    void getAuthStatus().then(async (status) => {
      setAuthMode(status.mode);
      if (status.mode === "oidc") {
        try {
          const result = await getAuthenticatedUser();
          setAuthCsrfToken(result.csrfToken);
          setUsers([result.user]);
          setSelectedExternalId("authenticated");
          setAuthReady(true);
        } catch {
          // A locked, expired, or absent session must show the sign-in screen.
          setAuthCsrfToken(null);
          setSelectedExternalId("");
          setAuthReady(false);
        }
        return;
      }
      try {
        const nextUsers = await getDevelopmentUsers();
        setUsers(nextUsers);
        const stored = localStorage.getItem("pharmacy1os.devUser");
        if (stored && nextUsers.some((user) => user.externalAuthId === stored)) {
          setSelectedExternalId(stored);
        } else if (nextUsers[0]) {
          setSelectedExternalId(nextUsers[0].externalAuthId);
          localStorage.setItem("pharmacy1os.devUser", nextUsers[0].externalAuthId);
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Unable to load demo staff.");
      } finally {
        setAuthReady(true);
      }
    }).catch((error) => {
      setAuthMode("development");
      setMessage(error instanceof Error ? error.message : "Authentication status unavailable.");
    });
  }, []);

  useEffect(() => {
    if (authReady && selectedExternalId) {
      void refreshWorkspace(selectedExternalId);
    }
  }, [authReady, selectedExternalId]);

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
        F8: "receiving",
        F9: "inventory",
        F10: "third-party",
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
    if (authMode !== "development") return;
    setSelectedExternalId(value);
    localStorage.setItem("pharmacy1os.devUser", value);
  }

  async function refreshAuthenticatedIdentity() {
    if (authMode !== "oidc" || !authReady) return;
    try {
      const result = await getAuthenticatedUser();
      setAuthCsrfToken(result.csrfToken);
      setUsers([result.user]);
    } catch {
      // Never continue to display privileged workstation controls
      // against a missing, revoked, or expired server session.
      setAuthCsrfToken(null);
      setUsers([]);
      setSelectedExternalId("");
      setAuthReady(false);
    }
  }

  function navigate(next: View) {
    if (authMode === "oidc") void refreshAuthenticatedIdentity();
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

  async function endSession(action: "lock" | "logout") {
    try {
      await endAuthenticatedSession(action);
    } finally {
      setAuthCsrfToken(null);
      setSelectedExternalId("");
      setUsers([]);
      setQueue([]);
      setPatients([]);
      setPrescribers([]);
      setAuthReady(false);
    }
  }

  // Human inactivity drives workstation lock; server independently expires
  // sessions on inactivity and enforces every API permission.
  useEffect(() => {
    if (authMode !== "oidc" || !authReady) return;
    let timeout: ReturnType<typeof setTimeout>;
    let lastActivity = Date.now();
    const lock = () => { void endSession("lock").catch(() => undefined); };
    const activity = () => {
      if (Date.now() - lastActivity >= 15 * 60_000) { lock(); return; }
      lastActivity = Date.now();
      clearTimeout(timeout);
      timeout = setTimeout(lock, 15 * 60_000);
    };
    timeout = setTimeout(lock, 15 * 60_000);
    for (const eventName of ["pointerdown", "keydown", "focus"]) {
      window.addEventListener(eventName, activity);
    }
    return () => {
      clearTimeout(timeout);
      for (const eventName of ["pointerdown", "keydown", "focus"]) {
        window.removeEventListener(eventName, activity);
      }
    };
  }, [authMode, authReady]);

  if (authMode === "loading") {
    return <main className="app-shell"><section className="notice">Checking workstation identity…</section></main>;
  }

  if (authMode === "oidc" && !authReady) {
    return (
      <main className="app-shell">
        <section className="notice">
          <h1>Pharmacy1OS workstation locked</h1>
          <p>Sign in using your assigned staff identity and multifactor authentication.</p>
          <p><a href="/api/auth/login">Sign in with identity provider</a></p>
          <small>Stage 3M development prototype. Synthetic data only; clinical use is prohibited.</small>
        </section>
      </main>
    );
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
          <button className={view === "receiving" ? "nav-item active" : "nav-item"} onClick={() => navigate("receiving")}><span>Receiving</span><kbd>F8</kbd></button>
          <button className={view === "inventory" ? "nav-item active" : "nav-item"} onClick={() => navigate("inventory")}><span>Inventory</span><kbd>F9</kbd></button>
          <button className={view === "third-party" ? "nav-item active" : "nav-item"} onClick={() => navigate("third-party")}><span>Third Party / COB</span><kbd>F10</kbd></button>
          {authMode === "oidc" && (
            <button className={view === "privileges" ? "nav-item active" : "nav-item"} onClick={() => navigate("privileges")}>Access Approvals</button>
          )}
          {authMode === "oidc" && ["ADMIN", "PHARMACIST_IN_CHARGE"].includes(selectedUser?.role ?? "") && (
            <button className={view === "security" ? "nav-item active" : "nav-item"}
              onClick={() => navigate("security")}>Workforce Security</button>
          )}
          {authMode === "oidc" && ["ADMIN", "PHARMACIST_IN_CHARGE"].includes(selectedUser?.role ?? "") && (
            <button className={view === "staff" ? "nav-item active" : "nav-item"} onClick={() => navigate("staff")}>Staff Administration</button>
          )}
          <button className="nav-item" disabled>Reports</button>
        </nav>

        <div className="user-panel">
          {authMode === "development" ? (
            <>
              <label htmlFor="staff">Synthetic staff identity</label>
              <select id="staff" value={selectedExternalId} onChange={(event) => selectUser(event.target.value)}>
                {users.map((user) => (
                  <option key={user.externalAuthId} value={user.externalAuthId}>
                    {user.displayName} — {roleLabel(user.role)}
                  </option>
                ))}
              </select>
              <small>Development only. This is not production authentication.</small>
            </>
          ) : (
            <>
              <strong>{selectedUser?.displayName}</strong>
              <small>Authenticated staff · {selectedUser?.siteName}</small>
              <button onClick={() => void endSession("lock").catch((error) => setMessage(error instanceof Error ? error.message : "Unable to end session."))}>Lock workstation</button>
              <button onClick={() => void endSession("logout").catch((error) => setMessage(error instanceof Error ? error.message : "Unable to end session."))}>Sign out</button>
            </>
          )}
          <div className="shortcut-hint">
            <span><kbd>F1</kbd> Dashboard</span>
            <span><kbd>F2</kbd> Exceptions</span>
            <span><kbd>F3</kbd> Will Call</span>
            <span><kbd>F4</kbd> New Rx</span>
            <span><kbd>F5</kbd> Patients</span>
            <span><kbd>F6</kbd> Providers</span>
            <span><kbd>F7</kbd> Drug / Product</span>
            <span><kbd>F8</kbd> Receiving</span>
            <span><kbd>F9</kbd> Inventory</span>
            <span><kbd>F10</kbd> Third Party</span>
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
                {selectedUser.displayName} · {roleLabel(selectedUser.role)} ·{" "}
                {selectedUser.siteName}
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

        {view === "receiving" && (
          <Receiving
            devUser={selectedExternalId}
            user={selectedUser}
            onError={setMessage}
            onOpenCatalog={() => navigate("catalog")}
          />
        )}

        {view === "inventory" && (
          <Inventory
            devUser={selectedExternalId}
            user={selectedUser}
            onError={setMessage}
          />
        )}

        {view === "third-party" && (
          <ThirdParty
            devUser={selectedExternalId}
            user={selectedUser}
            onError={setMessage}
          />
        )}

        {view === "privileges" && authMode === "oidc" && (
          <PrivilegeApprovals user={selectedUser} onError={setMessage}
            onAccessChanged={refreshAuthenticatedIdentity} />
        )}

        {view === "security" && authMode === "oidc" && (
          <WorkforceSecurity user={selectedUser} onError={setMessage} />
        )}

        {view === "staff" && authMode === "oidc" && (
          <StaffAdministration user={selectedUser} onError={setMessage} />
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
