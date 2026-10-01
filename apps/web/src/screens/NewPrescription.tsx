import { useEffect, useState, type FormEvent } from "react";
import { createPrescription, getMedications } from "../api";
import type {
  Medication,
  Patient,
  Prescriber,
  ProductSelectionDirective,
} from "../types";
import { formatPatientName, formatPrescriberName } from "../workflow";

function medicationLabel(medication: Medication) {
  return [
    medication.genericName,
    medication.strength,
    medication.dosageForm,
    medication.route,
  ]
    .filter(Boolean)
    .join(" · ");
}

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
  const [medications, setMedications] = useState<Medication[]>([]);
  const [medicationId, setMedicationId] = useState("");
  const [productSelectionDirective, setProductSelectionDirective] =
    useState<ProductSelectionDirective>("UNSPECIFIED");
  const [prescribedProductId, setPrescribedProductId] = useState("");
  const [rxNumber, setRxNumber] = useState("");
  const [sig, setSig] = useState("");
  const [quantity, setQuantity] = useState("30");
  const [refills, setRefills] = useState("0");
  const [writtenDate, setWrittenDate] = useState("");
  const [doNotFillBefore, setDoNotFillBefore] = useState("");

  useEffect(() => {
    if (!patientId && patients[0]) setPatientId(patients[0].id);
    if (!prescriberId && prescribers[0]) setPrescriberId(prescribers[0].id);
  }, [patients, prescribers, patientId, prescriberId]);

  useEffect(() => {
    if (!devUser) return;
    void getMedications(devUser)
      .then((items) => {
        const active = items.filter((item) => item.active);
        setMedications(active);
        if (!medicationId && active[0]) setMedicationId(active[0].id);
      })
      .catch((error) => {
        onError(
          error instanceof Error
            ? error.message
            : "Unable to load the drug catalog for Data Entry.",
        );
      });
  }, [devUser]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!devUser || !medicationId) return;

    setLoading(true);
    onError(null);
    try {
      const result = await createPrescription(devUser, {
        patientId,
        prescriberId,
        medicationId,
        productSelectionDirective,
        prescribedProductId: prescribedProductId || undefined,
        rxNumber: rxNumber || undefined,
        sig,
        quantityWritten: quantity ? Number(quantity) : undefined,
        refillsAllowed: refills ? Number(refills) : 0,
        writtenDate: writtenDate
          ? new Date(`${writtenDate}T00:00:00`).toISOString()
          : undefined,
        doNotFillBefore: doNotFillBefore
          ? new Date(`${doNotFillBefore}T00:00:00`).toISOString()
          : undefined,
      });
      await onCreated(result.prescription.id);
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Unable to create prescription.",
      );
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
          <select
            value={patientId}
            onChange={(event) => setPatientId(event.target.value)}
            required
          >
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
          Drug
          <select
            value={medicationId}
            onChange={(event) => {
              setMedicationId(event.target.value);
              setPrescribedProductId("");
            }}
            required
          >
            <option value="">Select drug</option>
            {medications.map((medication) => (
              <option key={medication.id} value={medication.id}>
                {medicationLabel(medication)}
              </option>
            ))}
          </select>
        </label>

        <label>
          Product selection
          <select
            value={productSelectionDirective}
            onChange={(event) =>
              setProductSelectionDirective(
                event.target.value as ProductSelectionDirective,
              )
            }
          >
            <option value="UNSPECIFIED">Unspecified</option>
            <option value="SELECTION_PERMITTED">
              Product selection permitted
            </option>
            <option value="DISPENSE_AS_WRITTEN">
              Dispense as written / no product selection
            </option>
          </select>
        </label>

        <label>
          Prescribed NDC / manufacturer
          <select
            value={prescribedProductId}
            onChange={(event) =>
              setPrescribedProductId(event.target.value)
            }
            required={productSelectionDirective === "DISPENSE_AS_WRITTEN"}
          >
            <option value="">
              {productSelectionDirective === "DISPENSE_AS_WRITTEN"
                ? "Select prescribed product"
                : "Not specified"}
            </option>
            {(medications.find((item) => item.id === medicationId)?.products ??
              []).map((product) => (
              <option key={product.id} value={product.id}>
                {product.manufacturer.name} · NDC {product.ndc} ·{" "}
                {product.descriptor}
              </option>
            ))}
          </select>
        </label>

        <label>
          Rx number
          <input
            value={rxNumber}
            onChange={(event) => setRxNumber(event.target.value)}
            placeholder="Optional"
          />
        </label>

        <label className="wide">
          Directions / Sig
          <input
            value={sig}
            onChange={(event) => setSig(event.target.value)}
            required
          />
        </label>

        <label>
          Quantity
          <input
            type="number"
            min="0"
            step="0.001"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
          />
        </label>

        <label>
          Refills
          <input
            type="number"
            min="0"
            step="1"
            value={refills}
            onChange={(event) => setRefills(event.target.value)}
          />
        </label>

        <label>
          Written date
          <input
            type="date"
            value={writtenDate}
            onChange={(event) => setWrittenDate(event.target.value)}
          />
        </label>

        <label>
          Do not fill before
          <input
            type="date"
            value={doNotFillBefore}
            onChange={(event) => setDoNotFillBefore(event.target.value)}
          />
        </label>

        <p className="permission-note wide">
          Data Entry selects the Drug and records the prescriber's product-selection
          directive. Product Fill may use up to four eligible physical NDC/lot/expiration
          sources unless the order prohibits product selection.
        </p>

        <div className="form-actions wide">
          <button
            className="primary-button"
            type="submit"
            disabled={
              loading ||
              !patientId ||
              !prescriberId ||
              !medicationId ||
              (productSelectionDirective === "DISPENSE_AS_WRITTEN" &&
                !prescribedProductId)
            }
          >
            {loading ? "Saving…" : "Create synthetic prescription"}
          </button>
        </div>
      </form>
    </section>
  );
}
