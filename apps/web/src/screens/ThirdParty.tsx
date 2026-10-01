import { useEffect, useMemo, useState } from "react";
import {
  adjudicateFill,
  createPayer,
  getPayerHistory,
  getThirdPartyWorkspace,
  markLabelPrintJobPrinted,
  removePatientCoverage,
  savePatientCoverage,
  updatePayer,
} from "../api";
import type {
  BillingNdcStrategy,
  ClaimStandard,
  CoverageRelationship,
  DevUser,
  PatientCoverage,
  Payer,
} from "../types";

type CoverageDraft = {
  payerId: string;
  memberId: string;
  personCode: string;
  groupId: string;
  relationship: CoverageRelationship;
  cardholderName: string;
  cardholderDateOfBirth: string;
  effectiveDate: string;
  terminationDate: string;
  active: boolean;
};

type PayerProfileDraft = {
  name: string;
  bin: string;
  pcn: string;
  defaultGroupId: string;
  claimStandard: ClaimStandard;
  billingNdcStrategy: BillingNdcStrategy;
  autoReversePaidClaimOnSourceCorrection: boolean;
  notes: string;
  active: boolean;
};

function payerProfileDraft(payer?: Payer): PayerProfileDraft {
  return {
    name: payer?.name ?? "",
    bin: payer?.bin ?? "",
    pcn: payer?.pcn ?? "",
    defaultGroupId: payer?.defaultGroupId ?? "",
    claimStandard: payer?.claimStandard ?? "D0",
    billingNdcStrategy:
      payer?.billingProfile?.billingNdcStrategy ??
      payer?.billingNdcStrategy ??
      "MAJORITY_SOURCE",
    autoReversePaidClaimOnSourceCorrection:
      payer?.billingProfile?.autoReversePaidClaimOnSourceCorrection ??
      (payer?.billingNdcStrategy ?? "MAJORITY_SOURCE") === "MAJORITY_SOURCE",
    notes: payer?.billingProfile?.notes ?? "",
    active: payer?.active ?? true,
  };
}

function blankDraft(): CoverageDraft {
  return {
    payerId: "",
    memberId: "",
    personCode: "",
    groupId: "",
    relationship: "SELF",
    cardholderName: "",
    cardholderDateOfBirth: "",
    effectiveDate: "",
    terminationDate: "",
    active: true,
  };
}

function draftFromCoverage(coverage?: PatientCoverage): CoverageDraft {
  if (!coverage) return blankDraft();
  return {
    payerId: coverage.payerId,
    memberId: coverage.memberId,
    personCode: coverage.personCode ?? "",
    groupId: coverage.groupId ?? "",
    relationship: coverage.relationship,
    cardholderName: coverage.cardholderName ?? "",
    cardholderDateOfBirth: coverage.cardholderDateOfBirth
      ? coverage.cardholderDateOfBirth.slice(0, 10)
      : "",
    effectiveDate: coverage.effectiveDate
      ? coverage.effectiveDate.slice(0, 10)
      : "",
    terminationDate: coverage.terminationDate
      ? coverage.terminationDate.slice(0, 10)
      : "",
    active: coverage.active,
  };
}

export function ThirdParty({
  devUser,
  user,
  onError,
}: {
  devUser: string;
  user?: DevUser;
  onError: (message: string | null) => void;
}) {
  const [patients, setPatients] = useState<
    Array<{
      id: string;
      firstName: string;
      lastName: string;
      dateOfBirth: string | null;
      phone: string | null;
      email?: string | null;
      coverages: PatientCoverage[];
    }>
  >([]);
  const [payers, setPayers] = useState<Payer[]>([]);
  const [claimIssues, setClaimIssues] = useState<
    Awaited<ReturnType<typeof getThirdPartyWorkspace>>["claimIssues"]
  >([]);
  const [printQueue, setPrintQueue] = useState<
    Awaited<ReturnType<typeof getThirdPartyWorkspace>>["printQueue"]
  >([]);
  const [selectedPatientId, setSelectedPatientId] = useState("");
  const [query, setQuery] = useState("");
  const [drafts, setDrafts] = useState<Record<number, CoverageDraft>>({
    1: blankDraft(),
    2: blankDraft(),
    3: blankDraft(),
    4: blankDraft(),
  });
  const [busy, setBusy] = useState(false);

  const [payerName, setPayerName] = useState("");
  const [payerBin, setPayerBin] = useState("");
  const [payerPcn, setPayerPcn] = useState("");
  const [payerGroup, setPayerGroup] = useState("");
  const [claimStandard, setClaimStandard] = useState<ClaimStandard>("D0");
  const [billingNdcStrategy, setBillingNdcStrategy] =
    useState<BillingNdcStrategy>("MAJORITY_SOURCE");
  const [payerAutoReverse, setPayerAutoReverse] = useState(true);
  const [payerNotes, setPayerNotes] = useState("");
  const [selectedPayerId, setSelectedPayerId] = useState("");
  const [payerProfile, setPayerProfile] = useState<PayerProfileDraft>(
    payerProfileDraft(),
  );
  const [payerHistory, setPayerHistory] = useState<
    Awaited<ReturnType<typeof getPayerHistory>>["events"]
  >([]);

  const editable =
    user?.role === "ADMIN" ||
    user?.role === "PHARMACIST" ||
    user?.role === "TECHNICIAN";
  const canManagePayers =
    user?.role === "ADMIN" || user?.role === "PHARMACIST";

  async function load(search = query) {
    if (!devUser) return;
    try {
      const result = await getThirdPartyWorkspace(devUser, search);
      setPatients(result.patients);
      setPayers(result.payers);
      setClaimIssues(result.claimIssues);
      setPrintQueue(result.printQueue);
      if (
        selectedPatientId &&
        !result.patients.some((patient) => patient.id === selectedPatientId)
      ) {
        setSelectedPatientId("");
      }
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to load Third Party workspace.",
      );
    }
  }

  useEffect(() => {
    void load("");
  }, [devUser]);

  const selectedPatient = useMemo(
    () => patients.find((patient) => patient.id === selectedPatientId),
    [patients, selectedPatientId],
  );
  const selectedPayer = useMemo(
    () => payers.find((payer) => payer.id === selectedPayerId),
    [payers, selectedPayerId],
  );

  useEffect(() => {
    setPayerProfile(payerProfileDraft(selectedPayer));
    if (!selectedPayerId || !canManagePayers) {
      setPayerHistory([]);
      return;
    }
    void getPayerHistory(devUser, selectedPayerId)
      .then((result) => setPayerHistory(result.events))
      .catch(() => setPayerHistory([]));
  }, [devUser, selectedPayerId, selectedPayer, canManagePayers]);

  useEffect(() => {
    const next: Record<number, CoverageDraft> = {
      1: blankDraft(),
      2: blankDraft(),
      3: blankDraft(),
      4: blankDraft(),
    };
    for (let position = 1; position <= 4; position += 1) {
      next[position] = draftFromCoverage(
        selectedPatient?.coverages.find(
          (coverage) => coverage.position === position,
        ),
      );
    }
    setDrafts(next);
  }, [selectedPatientId, selectedPatient]);

  function updateDraft(
    position: number,
    patch: Partial<CoverageDraft>,
  ) {
    setDrafts((current) => ({
      ...current,
      [position]: { ...current[position]!, ...patch },
    }));
  }

  async function saveCoverage(position: number) {
    if (!selectedPatientId || !editable) return;
    const draft = drafts[position]!;
    if (!draft.payerId || !draft.memberId.trim()) return;

    setBusy(true);
    onError(null);
    try {
      await savePatientCoverage(devUser, selectedPatientId, position, {
        payerId: draft.payerId,
        memberId: draft.memberId.trim(),
        personCode: draft.personCode.trim() || null,
        groupId: draft.groupId.trim() || null,
        relationship: draft.relationship,
        cardholderName: draft.cardholderName.trim() || null,
        cardholderDateOfBirth: draft.cardholderDateOfBirth
          ? new Date(`${draft.cardholderDateOfBirth}T00:00:00`).toISOString()
          : null,
        effectiveDate: draft.effectiveDate
          ? new Date(`${draft.effectiveDate}T00:00:00`).toISOString()
          : null,
        terminationDate: draft.terminationDate
          ? new Date(`${draft.terminationDate}T00:00:00`).toISOString()
          : null,
        active: draft.active,
      });
      await load("");
      onError(
        `Coverage position ${position} saved for ${selectedPatient?.lastName}, ${selectedPatient?.firstName}.`,
      );
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to save coverage.");
    } finally {
      setBusy(false);
    }
  }

  async function removeCoverage(position: number) {
    if (!selectedPatientId || !editable) return;
    setBusy(true);
    onError(null);
    try {
      await removePatientCoverage(devUser, selectedPatientId, position);
      await load("");
      onError(`Coverage position ${position} removed.`);
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Unable to remove coverage.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function addPayer() {
    if (!canManagePayers || !payerName.trim()) return;
    setBusy(true);
    onError(null);
    try {
      await createPayer(devUser, {
        name: payerName.trim(),
        bin: payerBin.trim() || undefined,
        pcn: payerPcn.trim() || undefined,
        defaultGroupId: payerGroup.trim() || undefined,
        claimStandard,
        billingNdcStrategy,
        autoReversePaidClaimOnSourceCorrection: payerAutoReverse,
        billingProfileNotes: payerNotes.trim() || null,
      });
      setPayerName("");
      setPayerBin("");
      setPayerPcn("");
      setPayerGroup("");
      setClaimStandard("D0");
      setBillingNdcStrategy("MAJORITY_SOURCE");
      setPayerAutoReverse(true);
      setPayerNotes("");
      await load("");
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to add payer.");
    } finally {
      setBusy(false);
    }
  }

  async function savePayerProfile() {
    if (!canManagePayers || !selectedPayerId || !payerProfile.name.trim()) return;
    setBusy(true);
    onError(null);
    try {
      const result = await updatePayer(devUser, selectedPayerId, {
        name: payerProfile.name.trim(),
        bin: payerProfile.bin.trim() || null,
        pcn: payerProfile.pcn.trim() || null,
        defaultGroupId: payerProfile.defaultGroupId.trim() || null,
        claimStandard: payerProfile.claimStandard,
        billingNdcStrategy: payerProfile.billingNdcStrategy,
        autoReversePaidClaimOnSourceCorrection:
          payerProfile.autoReversePaidClaimOnSourceCorrection,
        billingProfileNotes: payerProfile.notes.trim() || null,
        active: payerProfile.active,
      });
      await load(query);
      const history = await getPayerHistory(devUser, selectedPayerId);
      setPayerHistory(history.events);
      setPayerProfile(payerProfileDraft(result.payer));
      onError(
        `Billing profile saved for ${result.payer.name} · version ${result.payer.billingProfile?.version ?? "—"}.`,
      );
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Unable to save payer billing profile.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function retryClaim(fillId: string) {
    if (!editable) return;
    setBusy(true);
    onError(null);
    try {
      const result = await adjudicateFill(devUser, fillId);
      await load(query);
      onError(
        result.adjudication.state === "PAID_LABEL_READY"
          ? `Claim paid. ${result.adjudication.labels.length} bottle label${result.adjudication.labels.length === 1 ? "" : "s"} queued.`
          : result.adjudication.state === "REJECTED"
            ? "Claim remains rejected. Review the payer response below."
            : result.adjudication.state === "ERROR"
              ? "Claim transmission still has an error."
              : `Adjudication state: ${result.adjudication.state.replaceAll("_", " ")}.`,
      );
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to retry claim.");
    } finally {
      setBusy(false);
    }
  }

  function openPrintableLabel(
    job: (typeof printQueue)[number],
  ) {
    const label = job.label;
    const popup = window.open("", "_blank", "noopener,noreferrer,width=720,height=720");
    if (!popup) {
      onError("The browser blocked the print window. Allow pop-ups for Pharmacy1OS and try again.");
      return;
    }

    popup.document.title = `Rx label ${label.rxNumberSnapshot ?? label.id} · Bottle ${label.bottleNumber} of ${label.bottleCount}`;
    const sheet = popup.document.createElement("pre");
    sheet.style.whiteSpace = "pre-wrap";
    sheet.style.fontFamily = "system-ui, sans-serif";
    sheet.style.fontSize = "16px";
    sheet.style.padding = "24px";
    sheet.textContent = [
      `Rx ${label.rxNumberSnapshot ?? "—"} · label set v${label.version}`,
      `BOTTLE ${label.bottleNumber} OF ${label.bottleCount}`,
      label.patientNameSnapshot,
      label.medicationSnapshot,
      label.productDescriptionSnapshot
        ? `Product: ${label.productDescriptionSnapshot}`
        : "",
      label.manufacturerSnapshot
        ? `Manufacturer: ${label.manufacturerSnapshot}`
        : "",
      label.physicalNdcSnapshot
        ? `NDC: ${label.physicalNdcSnapshot}`
        : "",
      `Quantity: ${String(label.containerQuantity)} / ${String(label.physicalQuantity)} total`,
      `SIG: ${label.sigSnapshot}`,
      `Days supply: ${label.daysSupply ?? "—"}`,
      `Prescriber: ${label.prescriberNameSnapshot}`,
      label.billedNdcSnapshot
        ? `Claim billed NDC: ${label.billedNdcSnapshot}`
        : "",
    ].filter(Boolean).join("\n");
    popup.document.body.appendChild(sheet);
    popup.focus();
    popup.print();
  }

  async function markPrinted(printJobId: string) {
    if (!editable) return;
    setBusy(true);
    onError(null);
    try {
      await markLabelPrintJobPrinted(devUser, printJobId, "Browser / local print");
      await load(query);
      onError("Label print job marked printed.");
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Unable to update print job.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="third-party-layout">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Coordination of benefits</p>
            <h2>Third Party</h2>
          </div>
          <span className="queue-count">Up to 4 payers per patient</span>
        </div>

        <form
          className="third-party-search"
          onSubmit={(event) => {
            event.preventDefault();
            void load(query);
          }}
        >
          <input
            className="search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search patient name or phone"
          />
          <button className="primary-button" type="submit" disabled={busy}>
            Search
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={busy}
            onClick={() => {
              setQuery("");
              void load("");
            }}
          >
            Clear
          </button>
        </form>

        <div className="third-party-patient-list">
          {patients.map((patient) => (
            <button
              type="button"
              key={patient.id}
              className={
                patient.id === selectedPatientId
                  ? "third-party-patient active"
                  : "third-party-patient"
              }
              onClick={() => setSelectedPatientId(patient.id)}
            >
              <strong>
                {patient.lastName}, {patient.firstName}
              </strong>
              <span>
                {patient.dateOfBirth
                  ? new Date(patient.dateOfBirth).toLocaleDateString()
                  : "DOB unavailable"}
                {patient.phone ? ` · ${patient.phone}` : ""}
              </span>
              <small>
                {patient.coverages.length} of 4 coverage positions configured
              </small>
            </button>
          ))}
        </div>
      </section>

      <div className="third-party-work-stack">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Adjudication exceptions</p>
              <h2>Rejected / error claims</h2>
            </div>
            <span className="queue-count">{claimIssues.length}</span>
          </div>
          <p className="directory-help">
            Paid claims never appear here. Rejected and transmission-error claims
            do not create a dispensing label.
          </p>
          <div className="coverage-slot-list">
            {claimIssues.map((claim) => (
              <article className="coverage-slot" key={claim.id}>
                <div className="coverage-slot-heading">
                  <div>
                    <span className="coverage-position">P{claim.coveragePosition}</span>
                    <strong>
                      {claim.fill.prescription.patient.lastName},{" "}
                      {claim.fill.prescription.patient.firstName} ·{" "}
                      {claim.fill.prescription.rxNumber ?? "Rx pending"}
                    </strong>
                  </div>
                  <span className="status-chip muted">{claim.outcome}</span>
                </div>
                <div className="coverage-payer-metadata">
                  <span>{claim.payer.name}</span>
                  <span>NDC {claim.billedNdc}</span>
                  <span>
                    Qty billed {String(claim.payerIntendedQuantity)} · physical{" "}
                    {String(claim.physicalPartQuantity)}
                  </span>
                  <span>Days {claim.daysSupply}</span>
                </div>
                {claim.rejectCodes.length > 0 && (
                  <p className="directory-help">
                    Reject code{claim.rejectCodes.length === 1 ? "" : "s"}:{" "}
                    {claim.rejectCodes.join(", ")}
                  </p>
                )}
                {claim.messages.length > 0 && (
                  <p className="directory-help">{claim.messages.join(" · ")}</p>
                )}
                {editable && (
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy}
                    onClick={() => void retryClaim(claim.fillId)}
                  >
                    Retry adjudication
                  </button>
                )}
              </article>
            ))}
            {claimIssues.length === 0 && (
              <p className="empty-state">No unresolved third-party claim exceptions.</p>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Prescription labels</p>
              <h2>Print queue</h2>
            </div>
            <span className="queue-count">{printQueue.length}</span>
          </div>
          <p className="directory-help">
            Each distinct physical NDC receives its own bottle label and queue
            item after an eligible paid claim, a linked completion of that paid
            claim, or a cash fill. Bottle 1 is the largest physical NDC quantity
            (with the claim NDC used as the tie-breaker); each label shows its
            bottle quantity out of the total physical dispense quantity.
          </p>
          <div className="coverage-slot-list">
            {printQueue.map((job) => (
              <article className="coverage-slot" key={job.id}>
                <div className="coverage-slot-heading">
                  <div>
                    <span className="coverage-position">v{job.label.version}</span>
                    <strong>
                      {job.label.patientNameSnapshot} ·{" "}
                      {job.label.rxNumberSnapshot ?? "Rx pending"}
                    </strong>
                  </div>
                  <span className="status-chip">QUEUED</span>
                </div>
                <div className="coverage-payer-metadata">
                  <span>
                    Bottle {job.label.bottleNumber} of {job.label.bottleCount}
                  </span>
                  <span>{job.label.medicationSnapshot}</span>
                  <span>
                    {job.label.productDescriptionSnapshot ?? "Physical product"}
                  </span>
                  <span>
                    Qty {String(job.label.containerQuantity)} /{" "}
                    {String(job.label.physicalQuantity)} total
                  </span>
                  <span>Days {job.label.daysSupply ?? "—"}</span>
                  <span>
                    NDC {job.label.physicalNdcSnapshot ?? "—"}
                    {job.label.manufacturerSnapshot
                      ? ` · ${job.label.manufacturerSnapshot}`
                      : ""}
                  </span>
                </div>
                <p className="directory-help">SIG: {job.label.sigSnapshot}</p>
                {editable && (
                  <div className="action-row">
                    <button
                      type="button"
                      className="primary-button"
                      disabled={busy}
                      onClick={() => openPrintableLabel(job)}
                    >
                      Open print dialog
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => void markPrinted(job.id)}
                    >
                      Mark printed
                    </button>
                  </div>
                )}
              </article>
            ))}
            {printQueue.length === 0 && (
              <p className="empty-state">No labels waiting to print.</p>
            )}
          </div>
        </section>

        <section className="panel">
          <p className="eyebrow">Payer chain</p>
          <h2>
            {selectedPatient
              ? `${selectedPatient.lastName}, ${selectedPatient.firstName}`
              : "Select a patient"}
          </h2>
          <p className="directory-help">
            Coverage positions are adjudicated in order. A later payer receives
            the applicable prior-payer COB response when claims are enabled.
          </p>

          <div className="coverage-slot-list">
            {[1, 2, 3, 4].map((position) => {
              const draft = drafts[position]!;
              const stored = selectedPatient?.coverages.find(
                (coverage) => coverage.position === position,
              );
              const payer = payers.find((item) => item.id === draft.payerId);
              return (
                <article className="coverage-slot" key={position}>
                  <div className="coverage-slot-heading">
                    <div>
                      <span className="coverage-position">P{position}</span>
                      <strong>{payer?.name ?? "Coverage not configured"}</strong>
                    </div>
                    {stored && (
                      <span className={stored.active ? "status-chip" : "status-chip muted"}>
                        {stored.active ? "Active" : "Inactive"}
                      </span>
                    )}
                  </div>

                  <div className="coverage-grid">
                    <label>
                      Payer
                      <select
                        value={draft.payerId}
                        disabled={!editable || !selectedPatient}
                        onChange={(event) => {
                          const selected = payers.find(
                            (item) => item.id === event.target.value,
                          );
                          updateDraft(position, {
                            payerId: event.target.value,
                            groupId:
                              draft.groupId ||
                              selected?.defaultGroupId ||
                              "",
                          });
                        }}
                      >
                        <option value="">Select payer</option>
                        {payers.filter((item) => item.active).map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                            {item.bin ? ` · BIN ${item.bin}` : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Member ID
                      <input
                        value={draft.memberId}
                        disabled={!editable || !selectedPatient}
                        onChange={(event) =>
                          updateDraft(position, { memberId: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      Group
                      <input
                        value={draft.groupId}
                        disabled={!editable || !selectedPatient}
                        onChange={(event) =>
                          updateDraft(position, { groupId: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      Person code
                      <input
                        value={draft.personCode}
                        disabled={!editable || !selectedPatient}
                        onChange={(event) =>
                          updateDraft(position, { personCode: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      Relationship
                      <select
                        value={draft.relationship}
                        disabled={!editable || !selectedPatient}
                        onChange={(event) =>
                          updateDraft(position, {
                            relationship:
                              event.target.value as CoverageRelationship,
                          })
                        }
                      >
                        <option value="SELF">Self</option>
                        <option value="SPOUSE">Spouse</option>
                        <option value="CHILD">Child</option>
                        <option value="OTHER">Other</option>
                      </select>
                    </label>
                    <label>
                      Cardholder
                      <input
                        value={draft.cardholderName}
                        disabled={!editable || !selectedPatient}
                        onChange={(event) =>
                          updateDraft(position, {
                            cardholderName: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      Effective
                      <input
                        type="date"
                        value={draft.effectiveDate}
                        disabled={!editable || !selectedPatient}
                        onChange={(event) =>
                          updateDraft(position, {
                            effectiveDate: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      Termination
                      <input
                        type="date"
                        value={draft.terminationDate}
                        disabled={!editable || !selectedPatient}
                        onChange={(event) =>
                          updateDraft(position, {
                            terminationDate: event.target.value,
                          })
                        }
                      />
                    </label>
                  </div>

                  {payer && (
                    <div className="coverage-payer-metadata">
                      <span>Standard: {payer.claimStandard}</span>
                      <span>
                        Billing NDC:{" "}
                        {(payer.billingProfile?.billingNdcStrategy ??
                          payer.billingNdcStrategy
                        ).replaceAll("_", " ")}
                      </span>
                      <span>BIN {payer.bin ?? "—"} / PCN {payer.pcn ?? "—"}</span>
                    </div>
                  )}

                  {editable && selectedPatient && (
                    <div className="action-row">
                      <button
                        type="button"
                        className="primary-button"
                        disabled={
                          busy || !draft.payerId || !draft.memberId.trim()
                        }
                        onClick={() => void saveCoverage(position)}
                      >
                        Save P{position}
                      </button>
                      {stored && (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={busy}
                          onClick={() =>
                            window.confirm(
                              `Remove coverage position P${position}?`,
                            ) && void removeCoverage(position)
                          }
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>

        <section className="panel">
          <p className="eyebrow">Payer directory</p>
          <h2>Add payer / PBM</h2>
          <p className="directory-help">
            The internal coverage model is independent of the wire standard.
            Current D.0 and future F6 adapters use this payer configuration.
          </p>
          <div className="coverage-grid">
            <label>
              Name
              <input
                value={payerName}
                disabled={!canManagePayers}
                onChange={(event) => setPayerName(event.target.value)}
              />
            </label>
            <label>
              BIN
              <input
                value={payerBin}
                disabled={!canManagePayers}
                onChange={(event) => setPayerBin(event.target.value)}
              />
            </label>
            <label>
              PCN
              <input
                value={payerPcn}
                disabled={!canManagePayers}
                onChange={(event) => setPayerPcn(event.target.value)}
              />
            </label>
            <label>
              Default group
              <input
                value={payerGroup}
                disabled={!canManagePayers}
                onChange={(event) => setPayerGroup(event.target.value)}
              />
            </label>
            <label>
              Claim standard
              <select
                value={claimStandard}
                disabled={!canManagePayers}
                onChange={(event) =>
                  setClaimStandard(event.target.value as ClaimStandard)
                }
              >
                <option value="D0">NCPDP D.0</option>
                <option value="F6">NCPDP F6</option>
              </select>
            </label>
            <label>
              Split-fill billing NDC rule
              <select
                value={billingNdcStrategy}
                disabled={!canManagePayers}
                onChange={(event) => {
                  const strategy = event.target.value as BillingNdcStrategy;
                  setBillingNdcStrategy(strategy);
                  setPayerAutoReverse(strategy === "MAJORITY_SOURCE");
                }}
              >
                <option value="MAJORITY_SOURCE">
                  Automatically bill majority physical NDC
                </option>
                <option value="REQUIRE_MANUAL_SELECTION">
                  Require explicit billing NDC
                </option>
                <option value="SINGLE_SOURCE_ONLY">
                  Single physical product only
                </option>
                <option value="PAYER_CONFIGURED">
                  Payer-specific adapter rule
                </option>
              </select>
            </label>
            <label>
              <span>Source correction after paid claim</span>
              <select
                value={payerAutoReverse ? "AUTO" : "MANUAL"}
                disabled={!canManagePayers}
                onChange={(event) =>
                  setPayerAutoReverse(event.target.value === "AUTO")
                }
              >
                <option value="AUTO">Auto-reverse and re-adjudicate</option>
                <option value="MANUAL">Require explicit reversal</option>
              </select>
            </label>
            <label>
              Billing profile notes
              <input
                value={payerNotes}
                disabled={!canManagePayers}
                onChange={(event) => setPayerNotes(event.target.value)}
                placeholder="Contract or payer-specific billing notes"
              />
            </label>
          </div>
          {canManagePayers ? (
            <button
              type="button"
              className="primary-button"
              disabled={busy || !payerName.trim()}
              onClick={() => void addPayer()}
            >
              Add payer
            </button>
          ) : (
            <p className="directory-help">
              Payer billing profiles can be created or changed by a pharmacist
              or administrator. Technicians can use configured payers and edit
              patient-specific coverage information.
            </p>
          )}
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Billing profiles</p>
              <h2>Manage payer rules</h2>
            </div>
            {selectedPayer?.billingProfile && (
              <span className="queue-count">
                v{selectedPayer.billingProfile.version}
              </span>
            )}
          </div>
          <p className="directory-help">
            Routing data and adjudication behavior are stored per payer. Claims
            snapshot the billing profile version used so later rule changes do
            not alter historical claim records.
          </p>

          <div className="coverage-grid">
            <label>
              Payer / PBM
              <select
                value={selectedPayerId}
                onChange={(event) => setSelectedPayerId(event.target.value)}
              >
                <option value="">Select payer</option>
                {payers.map((payer) => (
                  <option key={payer.id} value={payer.id}>
                    {payer.name}{payer.active ? "" : " · inactive"}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Name
              <input
                value={payerProfile.name}
                disabled={!canManagePayers || !selectedPayer}
                onChange={(event) =>
                  setPayerProfile((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              BIN
              <input
                value={payerProfile.bin}
                disabled={!canManagePayers || !selectedPayer}
                onChange={(event) =>
                  setPayerProfile((current) => ({
                    ...current,
                    bin: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              PCN
              <input
                value={payerProfile.pcn}
                disabled={!canManagePayers || !selectedPayer}
                onChange={(event) =>
                  setPayerProfile((current) => ({
                    ...current,
                    pcn: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Default group
              <input
                value={payerProfile.defaultGroupId}
                disabled={!canManagePayers || !selectedPayer}
                onChange={(event) =>
                  setPayerProfile((current) => ({
                    ...current,
                    defaultGroupId: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Claim standard
              <select
                value={payerProfile.claimStandard}
                disabled={!canManagePayers || !selectedPayer}
                onChange={(event) =>
                  setPayerProfile((current) => ({
                    ...current,
                    claimStandard: event.target.value as ClaimStandard,
                  }))
                }
              >
                <option value="D0">NCPDP D.0</option>
                <option value="F6">NCPDP F6</option>
              </select>
            </label>
            <label>
              Split-fill billing NDC rule
              <select
                value={payerProfile.billingNdcStrategy}
                disabled={!canManagePayers || !selectedPayer}
                onChange={(event) => {
                  const strategy = event.target.value as BillingNdcStrategy;
                  setPayerProfile((current) => ({
                    ...current,
                    billingNdcStrategy: strategy,
                    autoReversePaidClaimOnSourceCorrection:
                      strategy === "MAJORITY_SOURCE"
                        ? current.autoReversePaidClaimOnSourceCorrection
                        : false,
                  }));
                }}
              >
                <option value="MAJORITY_SOURCE">
                  Automatically bill majority physical NDC
                </option>
                <option value="REQUIRE_MANUAL_SELECTION">
                  Require explicit billing NDC
                </option>
                <option value="SINGLE_SOURCE_ONLY">
                  Single physical product only
                </option>
                <option value="PAYER_CONFIGURED">
                  Payer-specific adapter rule
                </option>
              </select>
            </label>
            <label>
              Source correction after paid claim
              <select
                value={
                  payerProfile.autoReversePaidClaimOnSourceCorrection
                    ? "AUTO"
                    : "MANUAL"
                }
                disabled={!canManagePayers || !selectedPayer}
                onChange={(event) =>
                  setPayerProfile((current) => ({
                    ...current,
                    autoReversePaidClaimOnSourceCorrection:
                      event.target.value === "AUTO",
                  }))
                }
              >
                <option value="AUTO">Auto-reverse and re-adjudicate</option>
                <option value="MANUAL">Require explicit reversal</option>
              </select>
            </label>
            <label>
              Profile status
              <select
                value={payerProfile.active ? "ACTIVE" : "INACTIVE"}
                disabled={!canManagePayers || !selectedPayer}
                onChange={(event) =>
                  setPayerProfile((current) => ({
                    ...current,
                    active: event.target.value === "ACTIVE",
                  }))
                }
              >
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
              </select>
            </label>
            <label>
              Billing profile notes
              <input
                value={payerProfile.notes}
                disabled={!canManagePayers || !selectedPayer}
                onChange={(event) =>
                  setPayerProfile((current) => ({
                    ...current,
                    notes: event.target.value,
                  }))
                }
                placeholder="Contract or implementation notes"
              />
            </label>
          </div>

          {selectedPayer && (
            <div className="coverage-payer-metadata">
              <span>
                Profile version {selectedPayer.billingProfile?.version ?? "legacy"}
              </span>
              <span>
                Updated{" "}
                {new Date(
                  selectedPayer.billingProfile?.updatedAt ??
                    selectedPayer.updatedAt,
                ).toLocaleString()}
              </span>
              <span>
                Future payer-specific fields can be added through the profile's
                structured custom-rules payload without changing the core payer
                directory model.
              </span>
            </div>
          )}

          {canManagePayers && selectedPayer && (
            <button
              type="button"
              className="primary-button"
              disabled={busy || !payerProfile.name.trim()}
              onClick={() => void savePayerProfile()}
            >
              Save billing profile
            </button>
          )}

          {canManagePayers && selectedPayer && (
            <div className="coverage-slot-list">
              <p className="directory-help">
                Recent billing-profile audit history
              </p>
              {payerHistory.slice(0, 8).map((event) => (
                <article className="coverage-slot" key={event.id}>
                  <div className="coverage-slot-heading">
                    <strong>{event.action.replaceAll("_", " ")}</strong>
                    <span className="status-chip muted">
                      {new Date(event.occurredAt).toLocaleString()}
                    </span>
                  </div>
                  <p className="directory-help">
                    {event.actor?.displayName ?? "System"} ·{" "}
                    {event.actor?.role ?? "SYSTEM"}
                  </p>
                </article>
              ))}
              {payerHistory.length === 0 && (
                <p className="empty-state">No profile changes recorded yet.</p>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
