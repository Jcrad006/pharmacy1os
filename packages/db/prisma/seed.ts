import { ensureSiteInventoryInfrastructure } from "../src/inventoryBootstrap.js";
import {
  FillStatus,
  InventoryTransactionType,
  PrescriberContactType,
  PrescriberIdentifierType,
  PrescriptionStatus,
  PrismaClient,
  UserRole,
} from "@prisma/client";

const db = new PrismaClient();

const ids = {
  site: "site-demo-001",
  site2: "site-demo-002",
  admin: "user-demo-admin",
  pharmacist: "user-demo-pharmacist",
  technician: "user-demo-technician",
  intern: "user-demo-intern",
  pharmacist2: "user-demo-pharmacist-002",
  technician2: "user-demo-technician-002",
  patient1: "patient-demo-001",
  patient2: "patient-demo-002",
  prescriber1: "prescriber-demo-001",
  prescriber2: "prescriber-demo-002",
  providerNpi1: "provider-npi-demo-001",
  providerDea1: "provider-dea-demo-001",
  providerState1: "provider-state-demo-001",
  providerPhone1: "provider-phone-demo-001",
  providerPhone1b: "provider-phone-demo-001b",
  providerFax1: "provider-fax-demo-001",
  providerNpi2: "provider-npi-demo-002",
  providerDea2: "provider-dea-demo-002",
  providerState2: "provider-state-demo-002",
  providerPhone2: "provider-phone-demo-002",
  providerFax2: "provider-fax-demo-002",
  prescriberAddress1: "prescriber-address-demo-001",
  prescriberAddress2: "prescriber-address-demo-002",
  medicationLisinopril: "medication-demo-lisinopril-10",
  medicationAtorvastatin: "medication-demo-atorvastatin-20",
  manufacturerDemoGenerics: "manufacturer-demo-generics",
  manufacturerSamplePharma: "manufacturer-sample-pharma",
  productLisinoprilA: "product-demo-lisinopril-a",
  productLisinoprilB: "product-demo-lisinopril-b",
  productAtorvastatinA: "product-demo-atorvastatin-a",
  lotLisinoprilA1: "lot-demo-lisinopril-a1",
  lotLisinoprilA2: "lot-demo-lisinopril-a2",
  lotLisinoprilB1: "lot-demo-lisinopril-b1",
  lotAtorvastatinA1: "lot-demo-atorvastatin-a1",
  expirationLisinoprilA1: "expiration-demo-lisinopril-a1",
  expirationLisinoprilA2: "expiration-demo-lisinopril-a2",
  expirationLisinoprilB1: "expiration-demo-lisinopril-b1",
  expirationAtorvastatinA1: "expiration-demo-atorvastatin-a1",
  barcodeLisinoprilA: "barcode-demo-lisinopril-a",
  barcodeLisinoprilB: "barcode-demo-lisinopril-b",
  barcodeAtorvastatinA: "barcode-demo-atorvastatin-a",
  inventoryLisinoprilA1: "inventory-demo-lisinopril-a1",
  inventoryLisinoprilA2: "inventory-demo-lisinopril-a2",
  inventoryLisinoprilB1: "inventory-demo-lisinopril-b1",
  inventoryAtorvastatinA1: "inventory-demo-atorvastatin-a1",
  inventoryTxLisinoprilA1: "inventory-tx-demo-lisinopril-a1",
  inventoryTxLisinoprilA2: "inventory-tx-demo-lisinopril-a2",
  inventoryTxLisinoprilB1: "inventory-tx-demo-lisinopril-b1",
  inventoryTxAtorvastatinA1: "inventory-tx-demo-atorvastatin-a1",
  rx1: "rx-demo-001",
  rx2: "rx-demo-002",
};

async function main() {
  await db.pharmacySite.upsert({
    where: { id: ids.site },
    update: {},
    create: {
      id: ids.site,
      name: "Pharmacy1OS Demonstration Pharmacy",
      phone: "555-0100",
      ncpdpId: "DEMO001",
    },
  });

  await db.pharmacySite.upsert({
    where: { id: ids.site2 },
    update: {
      name: "Pharmacy1OS Demonstration Pharmacy — North",
      phone: "555-0102",
      ncpdpId: "DEMO002",
    },
    create: {
      id: ids.site2,
      name: "Pharmacy1OS Demonstration Pharmacy — North",
      phone: "555-0102",
      ncpdpId: "DEMO002",
    },
  });

  await ensureSiteInventoryInfrastructure(db, ids.site);
  await ensureSiteInventoryInfrastructure(db, ids.site2);

  const staff = [
    [ids.admin, "dev-admin", "Avery Administrator", UserRole.ADMIN],
    [ids.pharmacist, "dev-pharmacist", "Morgan Pharmacist", UserRole.PHARMACIST],
    [ids.technician, "dev-technician", "Taylor Technician", UserRole.TECHNICIAN],
    [ids.intern, "dev-intern", "Jordan Intern", UserRole.INTERN],
  ] as const;

  for (const [id, externalAuthId, displayName, role] of staff) {
    await db.user.upsert({
      where: { id },
      update: { externalAuthId, displayName, role, active: true },
      create: { id, siteId: ids.site, externalAuthId, displayName, role },
    });
  }

  const secondaryStaff = [
    [
      ids.pharmacist2,
      "dev-pharmacist-002",
      "Alex North Pharmacist",
      UserRole.PHARMACIST,
    ],
    [
      ids.technician2,
      "dev-technician-002",
      "Sam North Technician",
      UserRole.TECHNICIAN,
    ],
  ] as const;

  for (const [id, externalAuthId, displayName, role] of secondaryStaff) {
    await db.user.upsert({
      where: { id },
      update: {
        siteId: ids.site2,
        externalAuthId,
        displayName,
        role,
        active: true,
      },
      create: {
        id,
        siteId: ids.site2,
        externalAuthId,
        displayName,
        role,
      },
    });
  }

  await db.patient.upsert({
    where: { id: ids.patient1 },
    update: {
      dateOfBirth: new Date("1978-04-12T00:00:00Z"),
      phone: "555-0111",
      phoneSearch: "5550111",
    },
    create: {
      id: ids.patient1,
      siteId: ids.site,
      firstName: "Casey",
      lastName: "Example",
      dateOfBirth: new Date("1978-04-12T00:00:00Z"),
      phone: "555-0111",
      phoneSearch: "5550111",
      email: "casey.example@example.invalid",
    },
  });

  await db.patient.upsert({
    where: { id: ids.patient2 },
    update: {
      dateOfBirth: new Date("1959-09-03T00:00:00Z"),
      phone: "555-0112",
      phoneSearch: "5550112",
    },
    create: {
      id: ids.patient2,
      siteId: ids.site,
      firstName: "Riley",
      lastName: "Sample",
      dateOfBirth: new Date("1959-09-03T00:00:00Z"),
      phone: "555-0112",
      phoneSearch: "5550112",
    },
  });

  await db.prescriber.upsert({
    where: { id: ids.prescriber1 },
    update: {
      firstName: "Avery",
      lastName: "Demo",
      practiceLevel: "NP",
      dateOfBirth: new Date("1970-01-15T00:00:00Z"),
    },
    create: {
      id: ids.prescriber1,
      siteId: ids.site,
      firstName: "Avery",
      lastName: "Demo",
      practiceLevel: "NP",
      dateOfBirth: new Date("1970-01-15T00:00:00Z"),
    },
  });

  await db.prescriber.upsert({
    where: { id: ids.prescriber2 },
    update: {
      firstName: "Cameron",
      lastName: "Example",
      practiceLevel: "MD",
      dateOfBirth: new Date("1981-06-22T00:00:00Z"),
    },
    create: {
      id: ids.prescriber2,
      siteId: ids.site,
      firstName: "Cameron",
      lastName: "Example",
      practiceLevel: "MD",
      dateOfBirth: new Date("1981-06-22T00:00:00Z"),
    },
  });

  const identifiers = [
    [ids.providerNpi1, ids.prescriber1, PrescriberIdentifierType.NPI, "0000000001", "", true],
    [ids.providerDea1, ids.prescriber1, PrescriberIdentifierType.DEA, "DEMO-DEA-001", "NC", true],
    [ids.providerState1, ids.prescriber1, PrescriberIdentifierType.STATE_ID, "NC-DEMO-1001", "NC", true],
    [ids.providerNpi2, ids.prescriber2, PrescriberIdentifierType.NPI, "0000000002", "", true],
    [ids.providerDea2, ids.prescriber2, PrescriberIdentifierType.DEA, "DEMO-DEA-002", "NC", true],
    [ids.providerState2, ids.prescriber2, PrescriberIdentifierType.STATE_ID, "NC-DEMO-1002", "NC", true],
  ] as const;

  for (const [id, prescriberId, type, number, jurisdiction, isPrimary] of identifiers) {
    await db.prescriberIdentifier.upsert({
      where: { id },
      update: {
        siteId: ids.site,
        type,
        number,
        numberSearch: number.replace(/[^A-Za-z0-9]/g, "").toUpperCase(),
        jurisdiction,
        isPrimary,
      },
      create: {
        id,
        siteId: ids.site,
        prescriberId,
        type,
        number,
        numberSearch: number.replace(/[^A-Za-z0-9]/g, "").toUpperCase(),
        jurisdiction,
        isPrimary,
      },
    });
  }

  const contacts = [
    [ids.providerPhone1, ids.prescriber1, PrescriberContactType.PHONE, "Main office", "555-0201", null, true],
    [ids.providerPhone1b, ids.prescriber1, PrescriberContactType.PHONE, "Direct line", "555-0205", "104", false],
    [ids.providerFax1, ids.prescriber1, PrescriberContactType.FAX, "Main fax", "555-0202", null, true],
    [ids.providerPhone2, ids.prescriber2, PrescriberContactType.PHONE, "Main office", "555-0203", null, true],
    [ids.providerFax2, ids.prescriber2, PrescriberContactType.FAX, "Main fax", "555-0204", null, true],
  ] as const;

  for (const [id, prescriberId, type, label, value, extension, isPrimary] of contacts) {
    await db.prescriberContact.upsert({
      where: { id },
      update: {
        type,
        label,
        value,
        valueSearch: value.replace(/\D/g, ""),
        extension,
        isPrimary,
      },
      create: {
        id,
        prescriberId,
        type,
        label,
        value,
        valueSearch: value.replace(/\D/g, ""),
        extension,
        isPrimary,
      },
    });
  }

  await db.prescriberAddress.upsert({
    where: { id: ids.prescriberAddress1 },
    update: {
      label: "Main office",
      addressLine1: "100 Demo Medical Plaza",
      city: "Sample City",
      state: "NC",
      postalCode: "27000",
      isPrimary: true,
    },
    create: {
      id: ids.prescriberAddress1,
      prescriberId: ids.prescriber1,
      label: "Main office",
      addressLine1: "100 Demo Medical Plaza",
      city: "Sample City",
      state: "NC",
      postalCode: "27000",
      isPrimary: true,
    },
  });

  await db.prescriberAddress.upsert({
    where: { id: ids.prescriberAddress2 },
    update: {
      label: "Clinic",
      addressLine1: "200 Example Health Way",
      addressLine2: "Suite 12",
      city: "Sample City",
      state: "NC",
      postalCode: "27001",
      isPrimary: true,
    },
    create: {
      id: ids.prescriberAddress2,
      prescriberId: ids.prescriber2,
      label: "Clinic",
      addressLine1: "200 Example Health Way",
      addressLine2: "Suite 12",
      city: "Sample City",
      state: "NC",
      postalCode: "27001",
      isPrimary: true,
    },
  });

  await db.medication.upsert({
    where: { id: ids.medicationLisinopril },
    update: {
      genericName: "Lisinopril",
      brandName: "Synthetic Zestril",
      strength: "10 mg",
      dosageForm: "tablet",
      route: "oral",
      active: true,
    },
    create: {
      id: ids.medicationLisinopril,
      genericName: "Lisinopril",
      brandName: "Synthetic Zestril",
      strength: "10 mg",
      dosageForm: "tablet",
      route: "oral",
    },
  });

  await db.medication.upsert({
    where: { id: ids.medicationAtorvastatin },
    update: {
      genericName: "Atorvastatin",
      brandName: "Synthetic Lipitor",
      strength: "20 mg",
      dosageForm: "tablet",
      route: "oral",
      active: true,
    },
    create: {
      id: ids.medicationAtorvastatin,
      genericName: "Atorvastatin",
      brandName: "Synthetic Lipitor",
      strength: "20 mg",
      dosageForm: "tablet",
      route: "oral",
    },
  });

  await db.manufacturer.upsert({
    where: { id: ids.manufacturerDemoGenerics },
    update: {
      name: "Demo Generics, Inc.",
      labelerCode: "99999",
      active: true,
    },
    create: {
      id: ids.manufacturerDemoGenerics,
      name: "Demo Generics, Inc.",
      labelerCode: "99999",
    },
  });

  await db.manufacturer.upsert({
    where: { id: ids.manufacturerSamplePharma },
    update: {
      name: "Sample Pharma LLC",
      labelerCode: "99998",
      active: true,
    },
    create: {
      id: ids.manufacturerSamplePharma,
      name: "Sample Pharma LLC",
      labelerCode: "99998",
    },
  });

  await db.product.upsert({
    where: { id: ids.productLisinoprilA },
    update: {
      medicationId: ids.medicationLisinopril,
      manufacturerId: ids.manufacturerDemoGenerics,
      ndc: "99999-0001-01",
      ndcSearch: "99999000101",
      descriptor: "Lisinopril 10 mg tablet — 100 count bottle",
      packageDescription: "Bottle of 100 tablets",
      packageType: "bottle",
      unitsPerPackage: 100,
      dispensingUnit: "EACH",
      unitPrice: 0.03,
      packagePrice: 3.0,
      active: true,
    },
    create: {
      id: ids.productLisinoprilA,
      medicationId: ids.medicationLisinopril,
      manufacturerId: ids.manufacturerDemoGenerics,
      ndc: "99999-0001-01",
      ndcSearch: "99999000101",
      descriptor: "Lisinopril 10 mg tablet — 100 count bottle",
      packageDescription: "Bottle of 100 tablets",
      packageType: "bottle",
      unitsPerPackage: 100,
      dispensingUnit: "EACH",
      unitPrice: 0.03,
      packagePrice: 3.0,
    },
  });

  await db.product.upsert({
    where: { id: ids.productLisinoprilB },
    update: {
      medicationId: ids.medicationLisinopril,
      manufacturerId: ids.manufacturerSamplePharma,
      ndc: "99998-0101-01",
      ndcSearch: "99998010101",
      descriptor: "Lisinopril 10 mg tablet — 500 count bottle",
      packageDescription: "Bottle of 500 tablets",
      packageType: "bottle",
      unitsPerPackage: 500,
      dispensingUnit: "EACH",
      unitPrice: 0.024,
      packagePrice: 12.0,
      active: true,
    },
    create: {
      id: ids.productLisinoprilB,
      medicationId: ids.medicationLisinopril,
      manufacturerId: ids.manufacturerSamplePharma,
      ndc: "99998-0101-01",
      ndcSearch: "99998010101",
      descriptor: "Lisinopril 10 mg tablet — 500 count bottle",
      packageDescription: "Bottle of 500 tablets",
      packageType: "bottle",
      unitsPerPackage: 500,
      dispensingUnit: "EACH",
      unitPrice: 0.024,
      packagePrice: 12.0,
    },
  });

  await db.product.upsert({
    where: { id: ids.productAtorvastatinA },
    update: {
      medicationId: ids.medicationAtorvastatin,
      manufacturerId: ids.manufacturerDemoGenerics,
      ndc: "99999-0020-01",
      ndcSearch: "99999002001",
      descriptor: "Atorvastatin 20 mg tablet — 90 count bottle",
      packageDescription: "Bottle of 90 tablets",
      packageType: "bottle",
      unitsPerPackage: 90,
      dispensingUnit: "EACH",
      unitPrice: 0.04,
      packagePrice: 3.6,
      active: true,
    },
    create: {
      id: ids.productAtorvastatinA,
      medicationId: ids.medicationAtorvastatin,
      manufacturerId: ids.manufacturerDemoGenerics,
      ndc: "99999-0020-01",
      ndcSearch: "99999002001",
      descriptor: "Atorvastatin 20 mg tablet — 90 count bottle",
      packageDescription: "Bottle of 90 tablets",
      packageType: "bottle",
      unitsPerPackage: 90,
      dispensingUnit: "EACH",
      unitPrice: 0.04,
      packagePrice: 3.6,
    },
  });

  const productBarcodes = [
    {
      id: ids.barcodeLisinoprilA,
      productId: ids.productLisinoprilA,
      type: "GTIN_14" as const,
      identifier: "00999990001015",
      identifierSearch: "00999990001015",
      isPrimary: true,
      note: "Synthetic GS1 GTIN for Demo Generics lisinopril.",
    },
    {
      id: ids.barcodeLisinoprilB,
      productId: ids.productLisinoprilB,
      type: "GTIN_14" as const,
      identifier: "00999980101015",
      identifierSearch: "00999980101015",
      isPrimary: true,
      note: "Synthetic GS1 GTIN for Sample Pharma lisinopril.",
    },
    {
      id: ids.barcodeAtorvastatinA,
      productId: ids.productAtorvastatinA,
      type: "GTIN_14" as const,
      identifier: "00999990020016",
      identifierSearch: "00999990020016",
      isPrimary: true,
      note: "Synthetic GS1 GTIN for Demo Generics atorvastatin.",
    },
  ];

  for (const barcode of productBarcodes) {
    await db.productBarcode.upsert({
      where: { id: barcode.id },
      update: barcode,
      create: barcode,
    });
  }

  const productLots = [
    {
      id: ids.lotLisinoprilA1,
      productId: ids.productLisinoprilA,
      lotNumber: "LIS-A1001",
    },
    {
      id: ids.lotLisinoprilA2,
      productId: ids.productLisinoprilA,
      lotNumber: "LIS-A1002",
    },
    {
      id: ids.lotLisinoprilB1,
      productId: ids.productLisinoprilB,
      lotNumber: "LIS-B2001",
    },
    {
      id: ids.lotAtorvastatinA1,
      productId: ids.productAtorvastatinA,
      lotNumber: "ATOR-A3001",
    },
  ];

  for (const lot of productLots) {
    await db.productLot.upsert({
      where: { id: lot.id },
      update: {
        siteId: ids.site,
        productId: lot.productId,
        lotNumber: lot.lotNumber,
        lotNumberSearch: lot.lotNumber.replace(/[^A-Za-z0-9]/g, "").toUpperCase(),
        active: true,
      },
      create: {
        id: lot.id,
        siteId: ids.site,
        productId: lot.productId,
        lotNumber: lot.lotNumber,
        lotNumberSearch: lot.lotNumber.replace(/[^A-Za-z0-9]/g, "").toUpperCase(),
      },
    });
  }

  const productExpirations = [
    {
      id: ids.expirationLisinoprilA1,
      productId: ids.productLisinoprilA,
      expirationDate: new Date("2027-06-30T00:00:00Z"),
    },
    {
      id: ids.expirationLisinoprilA2,
      productId: ids.productLisinoprilA,
      expirationDate: new Date("2027-12-31T00:00:00Z"),
    },
    {
      id: ids.expirationLisinoprilB1,
      productId: ids.productLisinoprilB,
      expirationDate: new Date("2028-03-31T00:00:00Z"),
    },
    {
      id: ids.expirationAtorvastatinA1,
      productId: ids.productAtorvastatinA,
      expirationDate: new Date("2027-09-30T00:00:00Z"),
    },
  ];

  for (const expiration of productExpirations) {
    await db.productExpiration.upsert({
      where: { id: expiration.id },
      update: {
        siteId: ids.site,
        productId: expiration.productId,
        expirationDate: expiration.expirationDate,
        active: true,
      },
      create: {
        id: expiration.id,
        siteId: ids.site,
        productId: expiration.productId,
        expirationDate: expiration.expirationDate,
      },
    });
  }

  const inventorySeeds = [
    {
      balanceId: ids.inventoryLisinoprilA1,
      transactionId: ids.inventoryTxLisinoprilA1,
      productId: ids.productLisinoprilA,
      productLotId: ids.lotLisinoprilA1,
      productExpirationId: ids.expirationLisinoprilA1,
      quantity: 1000,
    },
    {
      balanceId: ids.inventoryLisinoprilA2,
      transactionId: ids.inventoryTxLisinoprilA2,
      productId: ids.productLisinoprilA,
      productLotId: ids.lotLisinoprilA2,
      productExpirationId: ids.expirationLisinoprilA2,
      quantity: 500,
    },
    {
      balanceId: ids.inventoryLisinoprilB1,
      transactionId: ids.inventoryTxLisinoprilB1,
      productId: ids.productLisinoprilB,
      productLotId: ids.lotLisinoprilB1,
      productExpirationId: ids.expirationLisinoprilB1,
      quantity: 2000,
    },
    {
      balanceId: ids.inventoryAtorvastatinA1,
      transactionId: ids.inventoryTxAtorvastatinA1,
      productId: ids.productAtorvastatinA,
      productLotId: ids.lotAtorvastatinA1,
      productExpirationId: ids.expirationAtorvastatinA1,
      quantity: 900,
    },
  ];

  for (const item of inventorySeeds) {
    await db.inventoryBalance.upsert({
      where: { id: item.balanceId },
      update: {
        siteId: ids.site,
        productId: item.productId,
        productLotId: item.productLotId,
        productExpirationId: item.productExpirationId,
        onHandQuantity: item.quantity,
        reservedQuantity: 0,
      },
      create: {
        id: item.balanceId,
        siteId: ids.site,
        productId: item.productId,
        productLotId: item.productLotId,
        productExpirationId: item.productExpirationId,
        onHandQuantity: item.quantity,
        reservedQuantity: 0,
      },
    });

    await db.inventoryTransaction.upsert({
      where: { id: item.transactionId },
      update: {
        siteId: ids.site,
        inventoryBalanceId: item.balanceId,
        type: InventoryTransactionType.RECEIVE,
        onHandDelta: item.quantity,
        reservedDelta: 0,
        reason: "Synthetic opening inventory",
        source: "SEED",
        reference: "PHARMACY1OS_DEMO",
      },
      create: {
        id: item.transactionId,
        siteId: ids.site,
        inventoryBalanceId: item.balanceId,
        type: InventoryTransactionType.RECEIVE,
        onHandDelta: item.quantity,
        reservedDelta: 0,
        reason: "Synthetic opening inventory",
        source: "SEED",
        reference: "PHARMACY1OS_DEMO",
      },
    });
  }

  // Reconcile physical positions after opening balances are seeded.
  await ensureSiteInventoryInfrastructure(db, ids.site);
  await ensureSiteInventoryInfrastructure(db, ids.site2);

  await db.prescription.upsert({
    where: { id: ids.rx1 },
    update: {},
    create: {
      id: ids.rx1,
      siteId: ids.site,
      patientId: ids.patient1,
      prescriberId: ids.prescriber1,
      medicationId: ids.medicationLisinopril,
      rxNumber: "100001",
      medicationName: "Lisinopril",
      strength: "10 mg",
      dosageForm: "tablet",
      sig: "Take 1 tablet by mouth once daily",
      quantityWritten: 30,
      refillsAllowed: 2,
      writtenDate: new Date("2026-09-25T00:00:00Z"),
      status: PrescriptionStatus.DATA_ENTRY,
    },
  });

  await db.prescription.upsert({
    where: { id: ids.rx2 },
    update: {},
    create: {
      id: ids.rx2,
      siteId: ids.site,
      patientId: ids.patient2,
      prescriberId: ids.prescriber2,
      medicationId: ids.medicationAtorvastatin,
      rxNumber: "100002",
      medicationName: "Atorvastatin",
      strength: "20 mg",
      dosageForm: "tablet",
      sig: "Take 1 tablet by mouth every evening",
      quantityWritten: 90,
      refillsAllowed: 1,
      writtenDate: new Date("2026-09-28T00:00:00Z"),
      status: PrescriptionStatus.PRODUCT_FILL,
      fills: {
        create: {
          fillNumber: 0,
          quantity: 90,
          status: FillStatus.IN_PROGRESS,
        },
      },
    },
  });

  console.log("Synthetic Pharmacy1OS data seeded.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
