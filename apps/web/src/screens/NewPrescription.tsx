import { useEffect, useState, type FormEvent } from "react";
import { createPrescription } from "../api";
import type { Patient, Prescriber } from "../types";
import { formatPatientName, formatPrescriberName } from "../workflow";

export function NewPrescription({
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
  onCreated: (id: string) => Promise<void>;
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
  const [writtenDate, setWrittenDate] = useState("");
  const [doNotFillBefore, setDoNotFillBefore] = useState("");

  useEffect(() => {
    if (!patientId && patients[0]) setPatientId(patients[0].id);
    if (!prescriberId && prescribers[0]) setPrescriberId(prescribers[0].id);
  }, [patients, prescribers, patientId, prescriberId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!devUser) return;

    setLoading(true);
    onError(null);
    try {
      const result = await createPrescription(devUser, {
        patientId,
        prescriberId,
        rxNumber: rxNumber || undefined,
        medicationName,
        strength: strength || undefined,
        dosageForm: dosageForm || undefined,
        sig,
        quantityWritten: quantity ? Number(quantity) : undefined,
        refillsAllowed: refills ? Number(refills) : 0,
        writtenDate: writtenDate ? new Date(`${writtenDate}T00:00:00`).toISOString() : undefined,
        doNotFillBefore: doNotFillBefore ? new Date(`${doNotFillBefore}T00:00:00`).toISOString() : undefined,
      });
      await onCreated(result.prescription.id);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to create prescription.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="panel form-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Synthetic data entry</p>
          <h2>Create prescription</h2>
        </div>
      </div>

      <form className="form-grid" onSubmit={submit}>
        <label>
          Patient
          <select value={patientId} onChange={(event) => setPatientId(event.target.value)} required>
            {patients.map((patient) => <option key={patient.id} value={patient.id}>{formatPatientName(patient)}</option>)}
          </select>
        </label>
        <label>
          Prescriber
          <select value={prescriberId} onChange={(event) => setPrescriberId(event.target.value)} required>
            {prescribers.map((prescriber) => <option key={prescriber.id} value={prescriber.id}>{formatPrescriberName(prescriber)}</option>)}
          </select>
        </label>
        <label>Rx number<input value={rxNumber} onChange={(event) => setRxNumber(event.target.value)} placeholder="Optional" /></label>
        <label>Medication<input value={medicationName} onChange={(event) => setMedicationName(event.target.value)} required /></label>
        <label>Strength<input value={strength} onChange={(event) => setStrength(event.target.value)} placeholder="e.g., 10 mg" /></label>
        <label>Dosage form<input value={dosageForm} onChange={(event) => setDosageForm(event.target.value)} /></label>
        <label className="wide">Directions / Sig<input value={sig} onChange={(event) => setSig(event.target.value)} required /></label>
        <label>Quantity<input type="number" min="0" step="0.001" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
        <label>Refills<input type="number" min="0" step="1" value={refills} onChange={(event) => setRefills(event.target.value)} /></label>
        <label>Written date<input type="date" value={writtenDate} onChange={(event) => setWrittenDate(event.target.value)} /></label>
        <label>Do not fill before<input type="date" value={doNotFillBefore} onChange={(event) => setDoNotFillBefore(event.target.value)} /></label>
        <div className="form-actions wide">
          <button className="primary-button" type="submit" disabled={loading || !patientId || !prescriberId}>
            {loading ? "Saving…" : "Create synthetic prescription"}
          </button>
        </div>
      </form>
    </section>
  );
}
