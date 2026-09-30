import { PrismaClient, UserRole, PrescriptionStatus, FillStatus } from "@prisma/client";

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
    update: {},
    create: {
      id: ids.patient1,
      siteId: ids.site,
      firstName: "Casey",
      lastName: "Example",
      dateOfBirth: new Date("1978-04-12T00:00:00Z"),
      phone: "555-0111",
      email: "casey.example@example.invalid",
    },
  });

  await db.patient.upsert({
    where: { id: ids.patient2 },
    update: {},
    create: {
      id: ids.patient2,
      siteId: ids.site,
      firstName: "Riley",
      lastName: "Sample",
      dateOfBirth: new Date("1959-09-03T00:00:00Z"),
      phone: "555-0112",
    },
  });

  await db.prescriber.upsert({
    where: { id: ids.prescriber1 },
    update: {},
    create: {
      id: ids.prescriber1,
      siteId: ids.site,
      firstName: "Avery",
      lastName: "Demo",
      npi: "0000000001",
      deaNumber: "DEMO-DEA-001",
      phone: "555-0201",
      fax: "555-0202",
    },
  });

  await db.prescriber.upsert({
    where: { id: ids.prescriber2 },
    update: {},
    create: {
      id: ids.prescriber2,
      siteId: ids.site,
      firstName: "Cameron",
      lastName: "Example",
      npi: "0000000002",
      phone: "555-0203",
      fax: "555-0204",
    },
  });

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
