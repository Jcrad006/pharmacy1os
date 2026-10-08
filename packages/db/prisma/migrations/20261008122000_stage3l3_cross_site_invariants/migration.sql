-- Stage 3L.3: site boundaries are database invariants, not API-only checks.
-- Backwards-safe: foreign keys enter NOT VALID and then must validate existing rows.
-- On mismatch, fail deployment; never silently rewrite a patient, site, or stock link.

CREATE UNIQUE INDEX "Patient_siteId_id_3l3_key" ON "Patient"("siteId", "id");
CREATE UNIQUE INDEX "Prescriber_siteId_id_3l3_key" ON "Prescriber"("siteId", "id");
CREATE UNIQUE INDEX "Prescription_siteId_id_3l3_key" ON "Prescription"("siteId", "id");
CREATE UNIQUE INDEX "Document_siteId_id_3l3_key" ON "Document"("siteId", "id");
CREATE UNIQUE INDEX "Payer_siteId_id_3l3_key" ON "Payer"("siteId", "id");
CREATE UNIQUE INDEX "ProductLot_siteId_id_3l3_key" ON "ProductLot"("siteId", "id");
CREATE UNIQUE INDEX "ProductExpiration_siteId_id_3l3_key" ON "ProductExpiration"("siteId", "id");
CREATE UNIQUE INDEX "InventoryLocation_siteId_id_3l3_key" ON "InventoryLocation"("siteId", "id");

ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_site_patient_3l3_fk"
  FOREIGN KEY ("siteId", "patientId") REFERENCES "Patient"("siteId", "id")
  ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_site_prescriber_3l3_fk"
  FOREIGN KEY ("siteId", "prescriberId") REFERENCES "Prescriber"("siteId", "id")
  ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;
ALTER TABLE "PatientCoverage" ADD CONSTRAINT "PatientCoverage_site_patient_3l3_fk"
  FOREIGN KEY ("siteId", "patientId") REFERENCES "Patient"("siteId", "id")
  ON UPDATE RESTRICT ON DELETE CASCADE NOT VALID;
ALTER TABLE "PatientCoverage" ADD CONSTRAINT "PatientCoverage_site_payer_3l3_fk"
  FOREIGN KEY ("siteId", "payerId") REFERENCES "Payer"("siteId", "id")
  ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;
ALTER TABLE "Document" ADD CONSTRAINT "Document_site_patient_3l3_fk"
  FOREIGN KEY ("siteId", "patientId") REFERENCES "Patient"("siteId", "id")
  ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;
ALTER TABLE "Document" ADD CONSTRAINT "Document_site_prescription_3l3_fk"
  FOREIGN KEY ("siteId", "prescriptionId") REFERENCES "Prescription"("siteId", "id")
  ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;
ALTER TABLE "PrescriptionAnnotation" ADD CONSTRAINT "PrescriptionAnnotation_site_document_3l3_fk"
  FOREIGN KEY ("siteId", "documentId") REFERENCES "Document"("siteId", "id")
  ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;
ALTER TABLE "PrescriptionAnnotation" ADD CONSTRAINT "PrescriptionAnnotation_site_prescription_3l3_fk"
  FOREIGN KEY ("siteId", "prescriptionId") REFERENCES "Prescription"("siteId", "id")
  ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;
ALTER TABLE "PrescriptionChangeRecord" ADD CONSTRAINT "PrescriptionChangeRecord_site_prescription_3l3_fk"
  FOREIGN KEY ("siteId", "prescriptionId") REFERENCES "Prescription"("siteId", "id")
  ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;
ALTER TABLE "ClaimTransaction" ADD CONSTRAINT "ClaimTransaction_site_payer_3l3_fk"
  FOREIGN KEY ("siteId", "payerId") REFERENCES "Payer"("siteId", "id")
  ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;
ALTER TABLE "PayerBillingProfile" ADD CONSTRAINT "PayerBillingProfile_site_payer_3l3_fk"
  FOREIGN KEY ("siteId", "payerId") REFERENCES "Payer"("siteId", "id")
  ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;
ALTER TABLE "WillCallPackage" ADD CONSTRAINT "WillCallPackage_site_location_3l3_fk"
  FOREIGN KEY ("siteId", "locationId") REFERENCES "InventoryLocation"("siteId", "id")
  ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;
ALTER TABLE "InventoryBalance" ADD CONSTRAINT "InventoryBalance_site_lot_3l3_fk"
  FOREIGN KEY ("siteId", "productLotId") REFERENCES "ProductLot"("siteId", "id")
  ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;
ALTER TABLE "InventoryBalance" ADD CONSTRAINT "InventoryBalance_site_expiration_3l3_fk"
  FOREIGN KEY ("siteId", "productExpirationId") REFERENCES "ProductExpiration"("siteId", "id")
  ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;
ALTER TABLE "InventoryHold" ADD CONSTRAINT "InventoryHold_site_balance_3l3_fk"
  FOREIGN KEY ("siteId", "inventoryBalanceId") REFERENCES "InventoryBalance"("siteId", "id")
  ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;
ALTER TABLE "InventoryTransaction" ADD CONSTRAINT "InventoryTransaction_site_balance_3l3_fk"
  FOREIGN KEY ("siteId", "inventoryBalanceId") REFERENCES "InventoryBalance"("siteId", "id")
  ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;

-- StockPosition has no denormalized siteId. Enforce same-site joins explicitly.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "InventoryStockPosition" p
    JOIN "InventoryBalance" b ON b."id" = p."inventoryBalanceId"
    JOIN "InventoryLocation" l ON l."id" = p."locationId"
    WHERE b."siteId" <> l."siteId"
  ) THEN
    RAISE EXCEPTION 'Existing InventoryStockPosition cross-site mismatch; manual review required';
  END IF;
END $$;

CREATE FUNCTION "stage3l3_stock_position_site_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "InventoryBalance" b
    JOIN "InventoryLocation" l ON l."id" = NEW."locationId"
    WHERE b."id" = NEW."inventoryBalanceId" AND b."siteId" = l."siteId"
  ) THEN
    RAISE EXCEPTION 'InventoryStockPosition location must match balance site'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "stage3l3_stock_position_site_guard_trigger"
  BEFORE INSERT OR UPDATE OF "inventoryBalanceId", "locationId"
  ON "InventoryStockPosition" FOR EACH ROW
  EXECUTE FUNCTION "stage3l3_stock_position_site_guard"();

ALTER TABLE "Prescription" VALIDATE CONSTRAINT "Prescription_site_patient_3l3_fk";
ALTER TABLE "Prescription" VALIDATE CONSTRAINT "Prescription_site_prescriber_3l3_fk";
ALTER TABLE "PatientCoverage" VALIDATE CONSTRAINT "PatientCoverage_site_patient_3l3_fk";
ALTER TABLE "PatientCoverage" VALIDATE CONSTRAINT "PatientCoverage_site_payer_3l3_fk";
ALTER TABLE "Document" VALIDATE CONSTRAINT "Document_site_patient_3l3_fk";
ALTER TABLE "Document" VALIDATE CONSTRAINT "Document_site_prescription_3l3_fk";
ALTER TABLE "PrescriptionAnnotation" VALIDATE CONSTRAINT "PrescriptionAnnotation_site_document_3l3_fk";
ALTER TABLE "PrescriptionAnnotation" VALIDATE CONSTRAINT "PrescriptionAnnotation_site_prescription_3l3_fk";
ALTER TABLE "PrescriptionChangeRecord" VALIDATE CONSTRAINT "PrescriptionChangeRecord_site_prescription_3l3_fk";
ALTER TABLE "ClaimTransaction" VALIDATE CONSTRAINT "ClaimTransaction_site_payer_3l3_fk";
ALTER TABLE "PayerBillingProfile" VALIDATE CONSTRAINT "PayerBillingProfile_site_payer_3l3_fk";
ALTER TABLE "WillCallPackage" VALIDATE CONSTRAINT "WillCallPackage_site_location_3l3_fk";
ALTER TABLE "InventoryBalance" VALIDATE CONSTRAINT "InventoryBalance_site_lot_3l3_fk";
ALTER TABLE "InventoryBalance" VALIDATE CONSTRAINT "InventoryBalance_site_expiration_3l3_fk";
ALTER TABLE "InventoryHold" VALIDATE CONSTRAINT "InventoryHold_site_balance_3l3_fk";
ALTER TABLE "InventoryTransaction" VALIDATE CONSTRAINT "InventoryTransaction_site_balance_3l3_fk";
