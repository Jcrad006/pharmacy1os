import { useEffect, useMemo, useState } from "react";
import {
  createPayer,
  getThirdPartyWorkspace,
  removePatientCoverage,
  savePatientCoverage,
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
    useState<BillingNdcStrategy>("REQUIRE_MANUAL_SELECTION");

  const editable =
    user?.role === "ADMIN" ||
    user?.role === "PHARMACIST" ||
    user?.role === "TECHNICIAN";

  async function load(search = query) {
    if (!devUser) return;
    try {
      const result = await getThirdPartyWorkspace(devUser, search);
      setPatients(result.patients);
      setPayers(result.payers);
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
    if (!editable || !payerName.trim()) return;
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
      });
      setPayerName("");
      setPayerBin("");
      setPayerPcn("");
      setPayerGroup("");
      setClaimStandard("D0");
      setBillingNdcStrategy("REQUIRE_MANUAL_SELECTION");
      await load("");
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to add payer.");
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
                        {payers.map((item) => (
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
                        {payer.billingNdcStrategy.replaceAll("_", " ")}
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
                disabled={!editable}
                onChange={(event) => setPayerName(event.target.value)}
              />
            </label>
            <label>
              BIN
              <input
                value={payerBin}
                disabled={!editable}
                onChange={(event) => setPayerBin(event.target.value)}
              />
            </label>
            <label>
              PCN
              <input
                value={payerPcn}
                disabled={!editable}
                onChange={(event) => setPayerPcn(event.target.value)}
              />
            </label>
            <label>
              Default group
              <input
                value={payerGroup}
                disabled={!editable}
                onChange={(event) => setPayerGroup(event.target.value)}
              />
            </label>
            <label>
              Claim standard
              <select
                value={claimStandard}
                disabled={!editable}
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
                disabled={!editable}
                onChange={(event) =>
                  setBillingNdcStrategy(
                    event.target.value as BillingNdcStrategy,
                  )
                }
              >
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
          </div>
          {editable && (
            <button
              type="button"
              className="primary-button"
              disabled={busy || !payerName.trim()}
              onClick={() => void addPayer()}
            >
              Add payer
            </button>
          )}
        </section>
      </div>
    </div>
  );
}
