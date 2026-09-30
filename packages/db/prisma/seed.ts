import {
  FillStatus,
  PrescriberContactType,
  PrescriberIdentifierType,
  PrescriptionStatus,
  PrismaClient,
  UserRole,
} from "@prisma/client";

const db = new PrismaClient();

const ids = {
  site: "site-demo-001",
  pharmacist: "user-demo-pharmacist",
  technician: "user-demo-technician",
  intern: "user-demo-intern",
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

  const staff = [
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
      labelName: "Lisinopril 10 mg tablet",
      packageDescription: "Bottle of 100 tablets",
      active: true,
    },
    create: {
      id: ids.productLisinoprilA,
      medicationId: ids.medicationLisinopril,
      manufacturerId: ids.manufacturerDemoGenerics,
      ndc: "99999-0001-01",
      ndcSearch: "99999000101",
      labelName: "Lisinopril 10 mg tablet",
      packageDescription: "Bottle of 100 tablets",
    },
  });

  await db.product.upsert({
    where: { id: ids.productLisinoprilB },
    update: {
      medicationId: ids.medicationLisinopril,
      manufacturerId: ids.manufacturerSamplePharma,
      ndc: "99998-0101-01",
      ndcSearch: "99998010101",
      labelName: "Lisinopril 10 mg tablet",
      packageDescription: "Bottle of 500 tablets",
      active: true,
    },
    create: {
      id: ids.productLisinoprilB,
      medicationId: ids.medicationLisinopril,
      manufacturerId: ids.manufacturerSamplePharma,
      ndc: "99998-0101-01",
      ndcSearch: "99998010101",
      labelName: "Lisinopril 10 mg tablet",
      packageDescription: "Bottle of 500 tablets",
    },
  });

  await db.product.upsert({
    where: { id: ids.productAtorvastatinA },
    update: {
      medicationId: ids.medicationAtorvastatin,
      manufacturerId: ids.manufacturerDemoGenerics,
      ndc: "99999-0020-01",
      ndcSearch: "99999002001",
      labelName: "Atorvastatin 20 mg tablet",
      packageDescription: "Bottle of 90 tablets",
      active: true,
    },
    create: {
      id: ids.productAtorvastatinA,
      medicationId: ids.medicationAtorvastatin,
      manufacturerId: ids.manufacturerDemoGenerics,
      ndc: "99999-0020-01",
      ndcSearch: "99999002001",
      labelName: "Atorvastatin 20 mg tablet",
      packageDescription: "Bottle of 90 tablets",
    },
  });

  const productLots = [
    {
      id: ids.lotLisinoprilA1,
      productId: ids.productLisinoprilA,
      lotNumber: "LIS-A1001",
      expirationDate: new Date("2027-06-30T00:00:00Z"),
    },
    {
      id: ids.lotLisinoprilA2,
      productId: ids.productLisinoprilA,
      lotNumber: "LIS-A1002",
      expirationDate: new Date("2027-12-31T00:00:00Z"),
    },
    {
      id: ids.lotLisinoprilB1,
      productId: ids.productLisinoprilB,
      lotNumber: "LIS-B2001",
      expirationDate: new Date("2028-03-31T00:00:00Z"),
    },
    {
      id: ids.lotAtorvastatinA1,
      productId: ids.productAtorvastatinA,
      lotNumber: "ATOR-A3001",
      expirationDate: new Date("2027-09-30T00:00:00Z"),
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
        expirationDate: lot.expirationDate,
        active: true,
      },
      create: {
        id: lot.id,
        siteId: ids.site,
        productId: lot.productId,
        lotNumber: lot.lotNumber,
        lotNumberSearch: lot.lotNumber.replace(/[^A-Za-z0-9]/g, "").toUpperCase(),
        expirationDate: lot.expirationDate,
      },
    });
  }

  await db.prescription.upsert({
    where: { id: ids.rx1 },
    update: {},
    create: {
      id: ids.rx1,
      siteId: ids.site,
      patientId: ids.patient1,
      prescriberId: ids.prescriber1,
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
