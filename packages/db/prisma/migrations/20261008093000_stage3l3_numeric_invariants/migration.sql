-- Stage 3L.3: safety-critical numeric bounds and same-site allocation references.
-- Do not silently repair suspect legacy rows. VALIDATE CONSTRAINT intentionally
-- fails deployment if existing records violate the invariant; investigate first.

ALTER TABLE "Prescription"
  ADD CONSTRAINT "Prescription_refill_and_version_bounds_ck"
  CHECK ("refillsAllowed" >= 0 AND "refillsUsed" >= 0 AND "version" >= 0
    AND ("quantityWritten" IS NULL OR "quantityWritten" >= 0)) NOT VALID;

ALTER TABLE "PrescriptionFill"
  ADD CONSTRAINT "PrescriptionFill_quantity_and_sequence_bounds_ck"
  CHECK ("fillNumber" >= 0 AND "partNumber" >= 1 AND "version" >= 0
    AND "physicalDispensedQuantity" >= 0 AND "remainingOwedQuantity" >= 0
    AND ("quantity" IS NULL OR "quantity" >= 0)
    AND ("authorizedQuantity" IS NULL OR "authorizedQuantity" >= 0)
    AND ("intendedQuantity" IS NULL OR "intendedQuantity" >= 0)
    AND ("payerIntendedQuantity" IS NULL OR "payerIntendedQuantity" >= 0)
    AND ("daysSupply" IS NULL OR "daysSupply" >= 0)) NOT VALID;

ALTER TABLE "InventoryBalance"
  ADD CONSTRAINT "InventoryBalance_nonnegative_and_capacity_ck"
  CHECK ("onHandQuantity" >= 0 AND "reservedQuantity" >= 0
    AND "quarantinedQuantity" >= 0
    AND "reservedQuantity" + "quarantinedQuantity" <= "onHandQuantity") NOT VALID;

ALTER TABLE "InventoryStockPosition"
  ADD CONSTRAINT "InventoryStockPosition_nonnegative_ck"
  CHECK ("quantity" >= 0) NOT VALID;

ALTER TABLE "InventoryAllocation"
  ADD CONSTRAINT "InventoryAllocation_positive_ck"
  CHECK ("quantity" > 0) NOT VALID;

ALTER TABLE "PointOfSaleTransaction"
  ADD CONSTRAINT "PointOfSaleTransaction_nonnegative_amounts_ck"
  CHECK ("totalDue" >= 0 AND "totalTendered" >= 0 AND "changeDue" >= 0) NOT VALID;

ALTER TABLE "ExternalClaimOperation"
  ADD CONSTRAINT "ExternalClaimOperation_position_attempt_bounds_ck"
  CHECK ("coveragePosition" BETWEEN 1 AND 4 AND "attemptCount" >= 0) NOT VALID;

-- Prisma's individual foreign keys do not prove that two references agree on site.
-- A composite foreign key prevents allocations linking stock from another site.
CREATE UNIQUE INDEX "InventoryBalance_siteId_id_unique_idx"
  ON "InventoryBalance"("siteId", "id");

ALTER TABLE "InventoryAllocation"
  ADD CONSTRAINT "InventoryAllocation_site_balance_fk"
  FOREIGN KEY ("siteId", "inventoryBalanceId")
  REFERENCES "InventoryBalance"("siteId", "id")
  ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;

ALTER TABLE "Prescription" VALIDATE CONSTRAINT "Prescription_refill_and_version_bounds_ck";
ALTER TABLE "PrescriptionFill" VALIDATE CONSTRAINT "PrescriptionFill_quantity_and_sequence_bounds_ck";
ALTER TABLE "InventoryBalance" VALIDATE CONSTRAINT "InventoryBalance_nonnegative_and_capacity_ck";
ALTER TABLE "InventoryStockPosition" VALIDATE CONSTRAINT "InventoryStockPosition_nonnegative_ck";
ALTER TABLE "InventoryAllocation" VALIDATE CONSTRAINT "InventoryAllocation_positive_ck";
ALTER TABLE "PointOfSaleTransaction" VALIDATE CONSTRAINT "PointOfSaleTransaction_nonnegative_amounts_ck";
ALTER TABLE "ExternalClaimOperation" VALIDATE CONSTRAINT "ExternalClaimOperation_position_attempt_bounds_ck";
ALTER TABLE "InventoryAllocation" VALIDATE CONSTRAINT "InventoryAllocation_site_balance_fk";
