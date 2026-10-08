import { useEffect, useState, type FormEvent } from "react";
import {
  changeStaffSiteRole, listStaff, provisionStaff, revokeStaffSiteSessions,
  setStaffSiteAccess, suspendStaffGlobally, type RoutineStaffRole, type StaffMember,
} from "../api";
import type { DevUser } from "../types";

const privileged = new Set(["ADMIN", "PHARMACIST_IN_CHARGE", "PHARMACIST"]);

function displayRole(value: string) {
  return value.split("_").map((part) => part[0] + part.slice(1).toLowerCase()).join(" ");
}

/** OIDC-only management surface. Server always rechecks permissions and site. */
export function StaffAdministration({ user, onError }: {
  user?: DevUser;
  onError: (message: string) => void;
}) {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [assignableRoles, setAssignableRoles] = useState<RoutineStaffRole[]>([]);
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [role, setRole] = useState<RoutineStaffRole>("TECHNICIAN");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [globalTargetId, setGlobalTargetId] = useState("");
  const [globalReason, setGlobalReason] = useState("");

  async function refresh() {
    const response = await listStaff();
    setStaff(response.staff);
    setAssignableRoles(response.assignableRoles);
  }

  useEffect(() => {
    void refresh().catch((error) =>
      onError(error instanceof Error ? error.message : "Unable to load staff."));
  }, []);

  async function mutate(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setNotice("");
    try {
      await action();
      await refresh();
      setNotice(success);
    } catch (error) {
      // Optimistic concurrency conflicts are resolved by displaying the
      // server's most recent records, never by silently retrying.
      await refresh().catch(() => undefined);
      onError(error instanceof Error ? error.message : "Staff update failed.");
    } finally {
      setBusy(false);
    }
  }

  function create(event: FormEvent) {
    event.preventDefault();
    void mutate(async () => {
      await provisionStaff({ displayName: name, oidcSubject: subject, role });
      setName("");
      setSubject("");
    }, "Staff account created for this pharmacy site.");
  }

  return (
    <div>
      <section className="panel staff-panel">
        <h2>Site staff and permissions</h2>
        <p>Access is specific to this pharmacy. Changes are audited and invalidate affected workstation sessions. High-trust roles require an independent approval process and cannot be granted here.</p>
        {notice && <p role="status" className="message">{notice}</p>}
      </section>
      <section className="panel staff-panel">
        <h3>Provision a staff identity</h3>
        <p>Use the exact OIDC subject from the configured test identity provider. Only synthetic accounts may be enrolled during development.</p>
        <form className="staff-form" onSubmit={create}>
          <label>
            Display name
            <input value={name} onChange={(event) => setName(event.target.value)}
              minLength={2} maxLength={120} required />
          </label>
          <label>
            Identity-provider subject
            <input value={subject} onChange={(event) => setSubject(event.target.value)}
              maxLength={255} autoComplete="off" required />
          </label>
          <label>
            Site role
            <select value={role} onChange={(event) => setRole(event.target.value as RoutineStaffRole)}>
              {(assignableRoles.length ? assignableRoles : ["TECHNICIAN"] as RoutineStaffRole[]).map(
                (option) => <option key={option} value={option}>{displayRole(option)}</option>,
              )}
            </select>
          </label>
          <button disabled={busy} type="submit">Create staff identity</button>
        </form>
      </section>
      <section className="panel staff-panel">
        <h3>Access lifecycle</h3>
        <div className="staff-list">
          {staff.map((member) => {
            const restricted = privileged.has(member.role);
            const self = member.id === user?.id;
            return (
              <div key={member.assignmentId} className="staff-entry">
                <div>
                  <strong>{member.displayName}</strong>
                  <small>{displayRole(member.role)} · {member.active ? "Active" : "Suspended"}
                    {!member.accountActive ? " · Account disabled" : ""}
                    {!member.provisioned ? " · Missing OIDC identity" : ""}</small>
                </div>
                <label>
                  Role
                  <select aria-label={"Role for " + member.displayName} value={member.role}
                    disabled={busy || restricted || self || !member.active}
                    onChange={(event) => void mutate(
                      () => changeStaffSiteRole(member, event.target.value as RoutineStaffRole),
                      "Role updated; existing site sessions revoked.",
                    )}>
                    {restricted && <option value={member.role}>{displayRole(member.role)}</option>}
                    {assignableRoles.map((option) =>
                      <option key={option} value={option}>{displayRole(option)}</option>)}
                  </select>
                </label>
                <div className="staff-entry-actions">
                  <button disabled={busy || restricted || self || (member.active && !member.accountActive)}
                    onClick={() => void mutate(
                      () => setStaffSiteAccess(member, !member.active),
                      member.active ? "Site access suspended." : "Site access restored.",
                    )}>{member.active ? "Suspend access" : "Restore access"}</button>
                  <button disabled={busy || self}
                    onClick={() => void mutate(
                      () => revokeStaffSiteSessions(member),
                      "Active sessions for this staff member at this site revoked.",
                    )}>Revoke sessions</button>
                  {user?.role === "ADMIN" && !restricted && !self && member.accountActive && (
                    <button disabled={busy}
                      onClick={() => { setGlobalTargetId(member.id); setGlobalReason(""); }}>
                      Suspend across all sites
                    </button>
                  )}
                </div>
                {user?.role === "ADMIN" && globalTargetId === member.id && !restricted && (
                  <form className="staff-form" onSubmit={(event) => {
                    event.preventDefault();
                    void mutate(async () => {
                      await suspendStaffGlobally(member.id, globalReason);
                      setGlobalTargetId("");
                      setGlobalReason("");
                    }, "Account suspended organization-wide; all active sessions revoked.");
                  }}>
                    <label>
                      Global offboarding reason (required, 10–500 characters)
                      <input required minLength={10} maxLength={500}
                        value={globalReason} onChange={event => setGlobalReason(event.target.value)} />
                    </label>
                    <p>Irreversible in this prototype. This disables access at every pharmacy and will not automatically restore sessions.</p>
                    <button type="submit" disabled={busy || globalReason.trim().length < 10}>
                      Confirm global suspension
                    </button>
                    <button type="button" onClick={() => setGlobalTargetId("")}>Cancel</button>
                  </form>
                )}
                {restricted && <small>Privileged role changes require separate approval.</small>}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
