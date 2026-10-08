import { useEffect, useState, type FormEvent } from "react";
import {
  decideCredentialReview, listCredentialReviews, listSecurityEvents,
  listStaff, submitCredentialReview, listProtectedOffboarding,
  requestProtectedOffboarding, reviewProtectedOffboarding, cancelProtectedOffboarding,
  type CredentialReview, type SecurityIncident, type StaffMember,
  type ProtectedOffboardingRequest,
} from "../api";
import type { DevUser } from "../types";

function roleTitle(role: string) {
  return role.split("_").map(s => s.charAt(0) + s.slice(1).toLowerCase()).join(" ");
}

/** Test-only professional credential attestation and denied-request telemetry. */
export function WorkforceSecurity({ user, onError }: {
  user?: DevUser; onError: (message: string) => void;
}) {
  const [reviews, setReviews] = useState<CredentialReview[]>([]);
  const [offboarding, setOffboarding] = useState<ProtectedOffboardingRequest[]>([]);
  const [offboardingTarget, setOffboardingTarget] = useState("");
  const [offboardingReason, setOffboardingReason] = useState("");
  const [offboardingNote, setOffboardingNote] = useState("");
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [events, setEvents] = useState<SecurityIncident[]>([]);
  const [failures, setFailures] = useState<number | null>(null);
  const [unattributed, setUnattributed] = useState(0);
  const [targetId, setTargetId] = useState("");
  const [role, setRole] = useState<"PHARMACIST" | "PHARMACIST_IN_CHARGE">("PHARMACIST");
  const [authority, setAuthority] = useState("");
  const [reference, setReference] = useState("");
  const [rationale, setRationale] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  async function refresh() {
    const [credentialResult, staffResult, securityResult, offboardingResult] = await Promise.all([
      listCredentialReviews(),
      listStaff(),
      user?.role === "ADMIN" ? listSecurityEvents() : Promise.resolve(null),
      listProtectedOffboarding(),
    ]);
    setReviews(credentialResult.reviews);
    setOffboarding(offboardingResult.requests);
    setStaff(staffResult.staff);
    if (securityResult) {
      setEvents(securityResult.events);
      setFailures(securityResult.siteFailures);
      setUnattributed(securityResult.unattributedLoginFailures);
    }
  }
  useEffect(() => {
    void refresh().catch(error => onError(error instanceof Error
      ? error.message : "Unable to read site security records."));
  }, [user?.siteId]);

  async function mutate(action: () => Promise<unknown>, text: string) {
    setBusy(true);
    setNotice("");
    try {
      await action();
      await refresh();
      setNotice(text);
    } catch (error) {
      await refresh().catch(() => undefined);
      onError(error instanceof Error ? error.message : "Security review failed.");
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
    void mutate(async () => {
      await submitCredentialReview({
        targetUserId: targetId, role, authority,
        evidenceReference: reference, rationale, expiresAt,
      });
      setAuthority("");
      setReference("");
      setRationale("");
    }, "Test-only credential evidence submitted for a second person's review.");
  }
  const isAdmin = user?.role === "ADMIN";
  const isPic = user?.role === "PHARMACIST_IN_CHARGE";
  return (
    <div>
      <section className="panel staff-panel">
        <h2>Workforce security and credential evidence</h2>
        <p>These records demonstrate independent review only. Pharmacy1OS does not automatically query licensing boards or authenticate pharmacist credentials. They must never be used as evidence of real clinical authorization.</p>
        {notice && <p role="status" className="message">{notice}</p>}
      </section>
      {isAdmin && (
        <section className="panel staff-panel">
          <h3>Record test credential evidence</h3>
          <p>A different authenticated site PIC must review the submission. A demonstration attestation automatically expires 30 days after submission; this is not a licensing-board validity period.</p>
          <form className="staff-form" onSubmit={submit}>
            <label>Staff member
              <select required value={targetId} onChange={e => setTargetId(e.target.value)}>
                <option value="">Select a staff identity</option>
                {staff.filter(s => s.accountActive && s.active && s.provisioned && s.id !== user?.id)
                  .map(s => <option key={s.id} value={s.id}>{s.displayName}</option>)}
              </select>
            </label>
            <label>Professional role for review
              <select value={role} onChange={e => setRole(e.target.value as typeof role)}>
                <option value="PHARMACIST">Pharmacist</option>
                <option value="PHARMACIST_IN_CHARGE">Pharmacist in Charge</option>
              </select>
            </label>
            <label>Named evidence source
              <input required minLength={5} maxLength={160} value={authority}
                onChange={e => setAuthority(e.target.value)} />
            </label>
            <label>Internal evidence reference (not a password)
              <input required minLength={5} maxLength={240} value={reference}
                onChange={e => setReference(e.target.value)} />
            </label>
            <label>Rationale
              <input required minLength={10} maxLength={500} value={rationale}
                onChange={e => setRationale(e.target.value)} />
            </label>
            <button type="submit" disabled={busy || !targetId}>Submit test credential review</button>
          </form>
        </section>
      )}
      <section className="panel staff-panel">
        <h3>Credential review ledger</h3>
        {isPic && <label>Review note (required, 10–500 characters)
          <input minLength={10} maxLength={500} value={reviewNote}
            onChange={e => setReviewNote(e.target.value)} />
        </label>}
        <div className="staff-list">
          {reviews.map(entry => (
            <div className="staff-entry" key={entry.id}>
              <div>
                <strong>{staff.find(s => s.id === entry.targetUserId)?.displayName ?? entry.targetUserId}</strong>
                <small>{roleTitle(entry.role)} · {entry.status}</small>
                <small>Evidence source: {entry.authority} · Expires {new Date(entry.expiresAt).toLocaleDateString()}</small>
                <small>Review rationale: {entry.rationale}</small>
                {entry.reviewNote && <small>Reviewer note: {entry.reviewNote}</small>}
              </div>
              {isPic && entry.status === "PENDING" && user?.id !== entry.submittedById &&
                user?.id !== entry.targetUserId && (
                  <div className="staff-entry-actions">
                    <button disabled={busy || reviewNote.trim().length < 10}
                      onClick={() => void mutate(
                        () => decideCredentialReview(entry.id, "TEST_ATTESTED", reviewNote),
                        "Synthetic evidence attested. No external licensing authority was contacted.",
                      )}>Attest test evidence</button>
                    <button disabled={busy || reviewNote.trim().length < 10}
                      onClick={() => void mutate(
                        () => decideCredentialReview(entry.id, "REJECTED", reviewNote),
                        "Synthetic evidence rejected.",
                      )}>Reject</button>
                  </div>
                )}
            </div>
          ))}
          {reviews.length === 0 && <p>No credential review records at this site.</p>}
        </div>
      </section>
      <section className="panel staff-panel">
        <h3>Protected-account offboarding</h3>
        <p>Administrators may request global suspension of professional and leadership accounts. A separate pharmacist-in-charge must authorize the decision at every affected pharmacy. The last active administrator or PIC cannot be disabled; all affected sessions are revoked after approval.</p>
        {isAdmin && (
          <form className="staff-form" onSubmit={event => {
            event.preventDefault();
            void mutate(async () => {
              await requestProtectedOffboarding(offboardingTarget, offboardingReason);
              setOffboardingTarget("");
              setOffboardingReason("");
            }, "Protected staff offboarding submitted for independent PIC review.");
          }}>
            <label>Protected staff account
              <select required value={offboardingTarget}
                onChange={event => setOffboardingTarget(event.target.value)}>
                <option value="">Select account</option>
                {staff.filter(s =>
                  ["ADMIN", "PHARMACIST", "PHARMACIST_IN_CHARGE"].includes(s.role) &&
                  s.accountActive && s.active && s.id !== user?.id,
                ).map(s => <option key={s.id} value={s.id}>
                  {s.displayName} — {roleTitle(s.role)}
                </option>)}
              </select>
            </label>
            <label>Documented offboarding reason
              <input required minLength={10} maxLength={500}
                value={offboardingReason} onChange={e => setOffboardingReason(e.target.value)} />
            </label>
            <button type="submit" disabled={busy || !offboardingTarget || offboardingReason.trim().length < 10}>
              Request second-person offboarding
            </button>
          </form>
        )}
        {isPic && <label>Independent offboarding review note (10–500 characters)
          <input value={offboardingNote} minLength={10} maxLength={500}
            onChange={e => setOffboardingNote(e.target.value)} />
        </label>}
        <div className="staff-list">
          {offboarding.map(entry => {
            const pending = entry.status === "PENDING" &&
              new Date(entry.reviewDeadlineAt).getTime() > Date.now();
            const mayReview = isPic && pending &&
              entry.requestedById !== user?.id && entry.targetUserId !== user?.id;
            const mayCancel = pending && entry.requestedById === user?.id;
            return (
              <div className="staff-entry" key={entry.id}>
                <div>
                  <strong>{staff.find(s => s.id === entry.targetUserId)?.displayName ?? entry.targetUserId}</strong>
                  <small>{entry.status === "PENDING" && !pending ? "EXPIRED" : entry.status}
                    {" · "}Requested {new Date(entry.createdAt).toLocaleString()}</small>
                  <small>Reason: {entry.reason}</small>
                  {entry.reviewNote && <small>Decision: {entry.reviewNote}</small>}
                </div>
                <div className="staff-entry-actions">
                  {mayReview && (
                    <>
                      <button disabled={busy || offboardingNote.trim().length < 10}
                        onClick={() => void mutate(
                          () => reviewProtectedOffboarding(entry.id, "APPROVED", offboardingNote),
                          "Protected account suspended across approved sites.",
                        )}>Approve suspension</button>
                      <button disabled={busy || offboardingNote.trim().length < 10}
                        onClick={() => void mutate(
                          () => reviewProtectedOffboarding(entry.id, "DENIED", offboardingNote),
                          "Offboarding request denied.",
                        )}>Deny</button>
                    </>
                  )}
                  {mayCancel && <button disabled={busy} onClick={() => void mutate(
                    () => cancelProtectedOffboarding(entry.id),
                    "Protected offboarding request cancelled.",
                  )}>Cancel request</button>}
                </div>
              </div>
            );
          })}
          {offboarding.length === 0 && <p>No protected staff offboarding requests at this pharmacy.</p>}
        </div>
      </section>
      {isAdmin && (
        <section className="panel staff-panel">
          <h3>Security monitoring — previous 24 hours</h3>
          <p>{failures ?? "—"} denied requests attributed to this site; {unattributed} unattributed login denials across the prototype.</p>
          <p>Network fingerprints and raw IP addresses are not displayed. This is diagnostic monitoring, not a tamper-evident production security log.</p>
          <div className="staff-list">
            {events.map(event => (
              <div key={event.id} className="staff-entry">
                <strong>{event.kind}</strong>
                <small>HTTP {event.httpStatus} · {event.requestPath} · {new Date(event.occurredAt).toLocaleString()}</small>
              </div>
            ))}
            {events.length === 0 && <p>No attributed denied requests recorded in this window.</p>}
          </div>
        </section>
      )}
    </div>
  );
}
