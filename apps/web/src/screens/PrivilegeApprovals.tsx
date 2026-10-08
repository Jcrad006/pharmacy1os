import { useEffect, useState, type FormEvent } from "react";
import {
  cancelPrivilegedRequest, createPrivilegedRequest,
  listPrivilegedRequests, listStaff, reviewPrivilegedRequest,
  type PrivilegedAccessRequest, type StaffMember,
} from "../api";
import type { DevUser } from "../types";

const isLeader = (role: string | undefined) => role === "ADMIN" || role === "PHARMACIST_IN_CHARGE";
function display(value: string) {
  return value.split("_").map(v => v.charAt(0) + v.slice(1).toLowerCase()).join(" ");
}

export function PrivilegeApprovals({ user, onError }: {
  user?: DevUser;
  onError: (value: string) => void;
}) {
  const [requests, setRequests] = useState<PrivilegedAccessRequest[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [reason, setReason] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [permission, setPermission] = useState<"inventory:correct" | "thirdparty:override">("inventory:correct");
  const [requestedRole, setRequestedRole] = useState<"PHARMACIST" | "PHARMACIST_IN_CHARGE" | "ADMIN">("PHARMACIST");
  const [targetId, setTargetId] = useState("");
  const [kind, setKind] = useState<"ROLE_GRANT" | "TEMP_PERMISSION">("TEMP_PERMISSION");
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState("");

  async function refresh() {
    const [result, siteStaff] = await Promise.all([
      listPrivilegedRequests(),
      isLeader(user?.role) ? listStaff() : Promise.resolve(null),
    ]);
    setRequests(result.requests);
    setStaff(siteStaff?.staff ?? []);
  }

  useEffect(() => {
    void refresh().catch(error =>
      onError(error instanceof Error ? error.message : "Unable to load requests."),
    );
  }, [user?.siteId]);

  async function submit(action: () => Promise<unknown>, text: string) {
    setWorking(true);
    setNotice("");
    try {
      await action();
      await refresh();
      setNotice(text);
    } catch (error) {
      await refresh().catch(() => undefined);
      onError(error instanceof Error ? error.message : "Authorization action failed.");
    } finally {
      setWorking(false);
    }
  }

  function requestAccess(event: FormEvent) {
    event.preventDefault();
    const target = staff.find(item => item.id === targetId);
    if (kind === "ROLE_GRANT" && !target) {
      onError("Choose a target staff account from this site.");
      return;
    }
    void submit(async () => {
      await createPrivilegedRequest(kind === "ROLE_GRANT" ? {
        kind, reason, targetUserId: target!.id,
        requestedRole, expectedAssignmentUpdatedAt: target!.updatedAt,
      } : { kind, reason, requestedPermission: permission });
      setReason("");
    }, "Access request created. A different authorized site leader must review it.");
  }

  const canRequestRole = user?.role === "ADMIN" || user?.role === "PHARMACIST_IN_CHARGE";
  const temporaryEligible = user?.role === "TECHNICIAN";
  const permittedRole = user?.role === "PHARMACIST_IN_CHARGE" ? ["ADMIN"] as const
    : ["PHARMACIST", "PHARMACIST_IN_CHARGE"] as const;
  const roleOptions = (requestedRole === "ADMIN" && user?.role === "ADMIN")
    ? permittedRole : permittedRole;
  const visibleStatus = (entry: PrivilegedAccessRequest) =>
    entry.status === "PENDING" && new Date(entry.reviewDeadlineAt).getTime() <= Date.now()
      ? "Expired" : display(entry.status);

  return (
    <div>
      <section className="panel staff-panel">
        <h2>Privileged access approvals</h2>
        <p>Every request requires a separately authenticated approving staff member. Requests expire after 10 minutes; temporary permission grants last no more than 15 minutes. Fresh multifactor authentication is required to request or approve.</p>
        <p>Development-only demonstration: dual approval does not verify pharmacist licensure, certify legal authorization, or make Pharmacy1OS production-ready.</p>
        {notice && <p role="status" className="message">{notice}</p>}
      </section>
      {(temporaryEligible || canRequestRole) && (
        <section className="panel staff-panel">
          <h3>Request authorization</h3>
          <form className="staff-form" onSubmit={requestAccess}>
            {temporaryEligible && canRequestRole && <label>Request type
              <select value={kind} onChange={event => setKind(event.target.value as typeof kind)}>
                <option value="TEMP_PERMISSION">Temporary permission</option>
                <option value="ROLE_GRANT">Privileged role review</option>
              </select>
            </label>}
            {canRequestRole && !temporaryEligible && (
              <label>Request type
                <select value="ROLE_GRANT" onChange={() => undefined}>
                  <option value="ROLE_GRANT">Privileged role review</option>
                </select>
              </label>
            )}
            {(canRequestRole && !temporaryEligible) || kind === "ROLE_GRANT" ? (
              <>
                <label>Target staff
                  <select required value={targetId} onChange={event => setTargetId(event.target.value)}>
                    <option value="">Select staff account</option>
                    {staff.filter(s => s.id !== user?.id && s.active && s.accountActive && s.provisioned).map(
                      member => <option key={member.id} value={member.id}>
                        {member.displayName} — {display(member.role)}
                      </option>,
                    )}
                  </select>
                </label>
                <label>Requested high-trust role
                  <select value={roleOptions.includes(requestedRole as never) ? requestedRole : roleOptions[0]}
                    onChange={event => setRequestedRole(event.target.value as typeof requestedRole)}>
                    {roleOptions.map(option =>
                      <option key={option} value={option}>{display(option)}</option>)}
                  </select>
                </label>
              </>
            ) : (
              <label>Temporary permission
                <select value={permission}
                  onChange={event => setPermission(event.target.value as typeof permission)}>
                  <option value="inventory:correct">Correct inventory</option>
                  <option value="thirdparty:override">Override third-party exception</option>
                </select>
              </label>
            )}
            <label>Clinical/operational reason (10–500 characters)
              <input required minLength={10} maxLength={500}
                value={reason} onChange={event => setReason(event.target.value)} />
            </label>
            <button disabled={working} type="submit">Submit for second-person review</button>
          </form>
        </section>
      )}
      <section className="panel staff-panel">
        <h3>Requests at this site</h3>
        <p>Approval and denial actions are disabled for the requester or the beneficiary. The server independently verifies reviewer qualifications.</p>
        {isLeader(user?.role) && <label>Reviewer note (required, 10–500 characters)
          <input value={reviewNote} onChange={event => setReviewNote(event.target.value)} minLength={10} maxLength={500} />
        </label>}
        <div className="staff-list">
          {requests.map(entry => {
            const pending = entry.status === "PENDING" &&
              new Date(entry.reviewDeadlineAt).getTime() > Date.now();
            const reviewerEligible = pending && isLeader(user?.role) &&
              user?.id !== entry.requestedById && user?.id !== entry.targetUserId;
            const cancellable = (entry.status === "PENDING" ||
              (entry.status === "APPROVED" && entry.kind === "TEMP_PERMISSION")) &&
              (user?.id === entry.requestedById || user?.id === entry.targetUserId);
            return <div className="staff-entry" key={entry.id}>
              <div>
                <strong>{entry.kind === "ROLE_GRANT" ? display(entry.requestedRole ?? "") :
                  entry.requestedPermission} — {visibleStatus(entry)}</strong>
                <small>Requested {new Date(entry.createdAt).toLocaleString()}</small>
                <small>Site: {entry.siteId} · Staff: {staff.find(s => s.id === entry.targetUserId)?.displayName ?? entry.targetUserId}</small>
                <small>Reason: {entry.reason}</small>
                {entry.effectiveUntil && <small>Permission expires {new Date(entry.effectiveUntil).toLocaleString()}</small>}
                {entry.reviewNote && <small>Reviewer: {entry.reviewNote}</small>}
              </div>
              <div className="staff-entry-actions">
                {reviewerEligible && (
                  <>
                    <button disabled={working || reviewNote.trim().length < 10} onClick={() =>
                      void submit(() => reviewPrivilegedRequest(entry.id, "APPROVED", reviewNote),
                        "Independently approved and recorded.")}>Approve</button>
                    <button disabled={working || reviewNote.trim().length < 10} onClick={() =>
                      void submit(() => reviewPrivilegedRequest(entry.id, "DENIED", reviewNote),
                        "Request denied and recorded.")}>Deny</button>
                  </>
                )}
                {cancellable && <button disabled={working} onClick={() =>
                  void submit(() => cancelPrivilegedRequest(entry.id),
                    "Request cancelled; any temporary access ended.")}>Cancel</button>}
              </div>
            </div>;
          })}
          {requests.length === 0 && <p>No privileged access requests are visible at this site.</p>}
        </div>
      </section>
    </div>
  );
}
