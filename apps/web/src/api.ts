import type {
  AuditEvent,
  DevUser,
  DurIssue,
  DurSeverity,
  ExceptionItem,
  ExceptionKind,
  ExceptionSummary,
  InterventionNote,
  Patient,
  PatientCoverage,
  Payer,
  CoverageRelationship,
  ClaimStandard,
  BillingNdcStrategy,
  ProductSelectionDirective,
  Prescriber,
  Medication,
  Manufacturer,
  Product,
  ProductLot,
  ProductExpiration,
  ProductBarcode,
  ParsedBarcode,
  InventoryBalance,
  InventoryTransaction,
  CycleCountSession,
  InventoryHold,
  InventoryHoldReason,
  InventoryDispositionType,
  InventoryLocation,
  InventoryLocationType,
  InventoryStockState,
  InventoryDemand,
  InventoryPolicy,
  ReceivingDiscrepancy,
  ReceivingDiscrepancyType,
  InventoryException,
  InventoryCustodyEvent,
  PharmacySiteSummary,
  InventoryTransfer,
  RecallCase,
  PurchaseOrder,
  PrescriptionFill,
  FillInterruptionReason,
  PrescriptionQueueItem,
  PrescriptionStatus,
} from "./types";

type ApiOptions = RequestInit & {
  devUser?: string;
};

async function request<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");

  if (options.devUser) {
    headers.set("x-dev-user", options.devUser);
  }

  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed with status ${response.status}`);
  }

  return payload as T;
}

export async function getDevelopmentUsers() {
  const result = await request<{
    users: Array<DevUser & { externalAuthId: string | null }>;
  }>("/api/dev/users");

  return result.users.filter(
    (user): user is DevUser => typeof user.externalAuthId === "string",
  );
}

export async function getPrescriptionQueue(
  devUser: string,
  options?: {
    query?: string;
    status?: PrescriptionStatus | "";
    sort?: "oldest" | "newest";
    limit?: number;
  },
) {
  const params = new URLSearchParams();
  if (options?.query?.trim()) params.set("query", options.query.trim());
  if (options?.status) params.set("status", options.status);
  if (options?.sort) params.set("sort", options.sort);
  if (options?.limit) params.set("limit", String(options.limit));

  const suffix = params.toString() ? `?${params.toString()}` : "";
  const result = await request<{ prescriptions: PrescriptionQueueItem[] }>(
    `/api/prescriptions/queue${suffix}`,
    { devUser },
  );
  return result.prescriptions;
}

export async function getWillCall(devUser: string) {
  const result = await request<{ prescriptions: PrescriptionQueueItem[] }>(
    "/api/prescriptions/will-call",
    { devUser },
  );
  return result.prescriptions;
}

export async function getPrescription(devUser: string, id: string) {
  const result = await request<{ prescription: PrescriptionQueueItem }>(
    `/api/prescriptions/${id}`,
    { devUser },
  );
  return result.prescription;
}

export async function getPrescriptionAudit(devUser: string, id: string) {
  const result = await request<{ events: AuditEvent[] }>(
    `/api/prescriptions/${id}/audit`,
    { devUser },
  );
  return result.events;
}

export type DirectoryFilters = {
  lastName?: string;
  firstName?: string;
  dateOfBirth?: string;
  phone?: string;
  query?: string;
};

function addDirectoryFilters(params: URLSearchParams, filters?: string | DirectoryFilters) {
  if (typeof filters === "string") {
    if (filters.trim()) params.set("query", filters.trim());
    return;
  }

  if (!filters) return;
  for (const [key, value] of Object.entries(filters)) {
    if (value?.trim()) params.set(key, value.trim());
  }
}

export async function getPatients(
  devUser: string,
  filters?: string | DirectoryFilters,
) {
  const params = new URLSearchParams();
  addDirectoryFilters(params, filters);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const result = await request<{ patients: Patient[] }>(
    `/api/patients${suffix}`,
    { devUser },
  );
  return result.patients;
}

export async function createPatient(
  devUser: string,
  input: {
    firstName: string;
    lastName: string;
    dateOfBirth?: string;
    phone?: string;
    email?: string;
  },
) {
  return request<{ patient: Patient }>("/api/patients", {
    method: "POST",
    devUser,
    body: JSON.stringify(input),
  });
}

export async function getPrescribers(
  devUser: string,
  filters?: string | DirectoryFilters,
) {
  const params = new URLSearchParams();
  addDirectoryFilters(params, filters);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const result = await request<{ prescribers: Prescriber[] }>(
    `/api/prescribers${suffix}`,
    { devUser },
  );
  return result.prescribers;
}

export async function createPrescriber(
  devUser: string,
  input: {
    firstName: string;
    lastName: string;
    practiceLevel: string;
    dateOfBirth?: string;
    identifiers?: Array<{
      type: "NPI" | "DEA" | "STATE_ID";
      number: string;
      jurisdiction?: string;
      isPrimary?: boolean;
    }>;
    contacts?: Array<{
      type: "PHONE" | "FAX";
      label?: string;
      value: string;
      extension?: string;
      isPrimary?: boolean;
    }>;
    addresses?: Array<{
      label?: string;
      addressLine1: string;
      addressLine2?: string;
      city: string;
      state: string;
      postalCode: string;
      isPrimary?: boolean;
    }>;
  },
) {
  return request<{ prescriber: Prescriber }>("/api/prescribers", {
    method: "POST",
    devUser,
    body: JSON.stringify(input),
  });
}

export async function transitionPrescription(
  devUser: string,
  id: string,
  status: PrescriptionStatus,
) {
  return request<{ prescription: PrescriptionQueueItem }>(
    `/api/prescriptions/${id}/status`,
    {
      method: "PATCH",
      devUser,
      body: JSON.stringify({ status }),
    },
  );
}

export async function updatePrescription(
  devUser: string,
  id: string,
  input: {
    prescriberId?: string;
    medicationId?: string;
    prescribedProductId?: string | null;
    productSelectionDirective?: ProductSelectionDirective;
    medicationName?: string;
    strength?: string | null;
    dosageForm?: string | null;
    sig?: string;
    quantityWritten?: number;
    refillsAllowed?: number;
    writtenDate?: string | null;
    expirationDate?: string | null;
    doNotFillBefore?: string | null;
    minimumDaysBetweenFills?: number | null;
  },
) {
  return request<{ prescription: PrescriptionQueueItem }>(
    `/api/prescriptions/${id}`,
    {
      method: "PATCH",
      devUser,
      body: JSON.stringify(input),
    },
  );
}

export async function createPrescription(
  devUser: string,
  input: {
    patientId: string;
    prescriberId: string;
    medicationId?: string;
    prescribedProductId?: string;
    productSelectionDirective?: ProductSelectionDirective;
    rxNumber?: string;
    medicationName?: string;
    strength?: string;
    dosageForm?: string;
    sig: string;
    quantityWritten?: number;
    refillsAllowed?: number;
    writtenDate?: string;
    doNotFillBefore?: string;
  },
) {
  return request<{ prescription: PrescriptionQueueItem }>("/api/prescriptions", {
    method: "POST",
    devUser,
    body: JSON.stringify(input),
  });
}

export async function createFill(
  devUser: string,
  prescriptionId: string,
  input: { quantity?: number; scheduledFor?: string },
) {
  return request<{
    fill: PrescriptionFill;
    prescription: PrescriptionQueueItem;
  }>(`/api/prescriptions/${prescriptionId}/fills`, {
    method: "POST",
    devUser,
    body: JSON.stringify(input),
  });
}

export async function createPartialFill(
  devUser: string,
  fillId: string,
  input: {
    dispenseQuantity: number;
    completionScheduledFor: string;
    interruptionReason?: FillInterruptionReason;
    reason?: string;
  },
) {
  return request<{
    partialFill: PrescriptionFill;
    completionFill: PrescriptionFill;
    inventoryException: InventoryException | null;
    prescription: PrescriptionQueueItem;
  }>(`/api/fills/${fillId}/partial`, {
    method: "POST",
    devUser,
    body: JSON.stringify(input),
  });
}

export async function createEmergencySupply(
  devUser: string,
  prescriptionId: string,
  input: {
    quantity: number;
    reason: string;
    followUpDueAt: string;
  },
) {
  return request<{
    fill: PrescriptionFill;
    prescription: PrescriptionQueueItem;
  }>(`/api/prescriptions/${prescriptionId}/emergency-supply`, {
    method: "POST",
    devUser,
    body: JSON.stringify(input),
  });
}

export async function completeEmergencySupplyFollowUp(
  devUser: string,
  fillId: string,
  note: string,
) {
  return request<{ fill: PrescriptionFill }>(
    `/api/fills/${fillId}/emergency-follow-up/complete`,
    {
      method: "POST",
      devUser,
      body: JSON.stringify({ note }),
    },
  );
}

export async function scanFillProduct(
  devUser: string,
  fillId: string,
  input: {
    ndc: string;
    lotNumber: string;
    expirationDate: string;
    sourceQuantity?: number;
  },
) {
  return request<{
    fill: PrescriptionFill;
    verifiedProduct: {
      drug: Medication;
      product: {
        id: string;
        ndc: string;
        descriptor: string;
        manufacturer: Manufacturer;
      };
      lot: ProductLot;
      expiration: ProductExpiration;
    };
  }>(`/api/fills/${fillId}/scan-product`, {
    method: "POST",
    devUser,
    body: JSON.stringify(input),
  });
}

export async function startFill(devUser: string, fillId: string) {
  return request<{
    fill: PrescriptionFill;
    prescription: PrescriptionQueueItem;
  }>(`/api/fills/${fillId}/start`, {
    method: "POST",
    devUser,
  });
}

export async function returnFillToStock(devUser: string, fillId: string) {
  return request<{
    fill: PrescriptionFill;
    prescription: PrescriptionQueueItem;
  }>(`/api/fills/${fillId}/return-to-stock`, {
    method: "POST",
    devUser,
  });
}

export async function getClinicalRecord(devUser: string, prescriptionId: string) {
  return request<{ issues: DurIssue[]; interventions: InterventionNote[] }>(
    `/api/prescriptions/${prescriptionId}/clinical`,
    { devUser },
  );
}

export async function createDurIssue(
  devUser: string,
  prescriptionId: string,
  input: {
    code: string;
    title: string;
    description?: string;
    severity?: DurSeverity;
  },
) {
  return request<{ issue: DurIssue }>(
    `/api/prescriptions/${prescriptionId}/dur/issues`,
    {
      method: "POST",
      devUser,
      body: JSON.stringify(input),
    },
  );
}

export async function resolveDurIssue(
  devUser: string,
  issueId: string,
  note: string,
) {
  return request<{ issue: DurIssue }>(
    `/api/dur/issues/${issueId}/resolve`,
    {
      method: "PATCH",
      devUser,
      body: JSON.stringify({ note }),
    },
  );
}

export async function createIntervention(
  devUser: string,
  prescriptionId: string,
  note: string,
) {
  return request<{ intervention: InterventionNote }>(
    `/api/prescriptions/${prescriptionId}/interventions`,
    {
      method: "POST",
      devUser,
      body: JSON.stringify({ note }),
    },
  );
}

export async function getExceptions(
  devUser: string,
  options?: { query?: string; kind?: ExceptionKind | ""; limit?: number },
) {
  const params = new URLSearchParams();
  if (options?.query?.trim()) params.set("query", options.query.trim());
  if (options?.kind) params.set("kind", options.kind);
  if (options?.limit) params.set("limit", String(options.limit));
  const suffix = params.toString() ? `?${params.toString()}` : "";

  return request<{ exceptions: ExceptionItem[]; summary: ExceptionSummary }>(
    `/api/exceptions${suffix}`,
    { devUser },
  );
}


export async function getMedications(devUser: string, query?: string) {
  const params = new URLSearchParams();
  if (query?.trim()) params.set("query", query.trim());
  const suffix = params.toString() ? `?${params.toString()}` : "";

  const result = await request<{ medications: Medication[] }>(
    `/api/medications${suffix}`,
    { devUser },
  );
  return result.medications;
}

export async function createMedication(
  devUser: string,
  input: {
    genericName: string;
    brandName?: string;
    strength: string;
    dosageForm: string;
    route?: string;
  },
) {
  return request<{ medication: Medication }>("/api/medications", {
    method: "POST",
    devUser,
    body: JSON.stringify(input),
  });
}

export async function createProduct(
  devUser: string,
  medicationId: string,
  input: {
    ndc: string;
    manufacturerName: string;
    manufacturerLabelerCode?: string;
    descriptor: string;
    packageDescription?: string;
    packageType: string;
    unitsPerPackage: number;
    dispensingUnit: "EACH" | "GRAM" | "MILLILITER";
    unitPrice?: number;
    packagePrice?: number;
  },
) {
  return request<{ product: Product }>(
    `/api/medications/${medicationId}/products`,
    {
      method: "POST",
      devUser,
      body: JSON.stringify(input),
    },
  );
}

export async function createProductLot(
  devUser: string,
  productId: string,
  input: {
    lotNumber: string;
    receivedAt?: string;
  },
) {
  return request<{ lot: ProductLot }>(
    `/api/products/${productId}/lots`,
    {
      method: "POST",
      devUser,
      body: JSON.stringify(input),
    },
  );
}

export async function createProductExpiration(
  devUser: string,
  productId: string,
  expirationDate: string,
) {
  return request<{ expiration: ProductExpiration }>(
    `/api/products/${productId}/expirations`,
    {
      method: "POST",
      devUser,
      body: JSON.stringify({ expirationDate }),
    },
  );
}


export async function assignProductBarcode(
  devUser: string,
  productId: string,
  rawBarcode: string,
  options?: { isPrimary?: boolean; note?: string },
) {
  return request<{
    barcode: ProductBarcode;
    parsed: ParsedBarcode;
    product: Product;
    lot: ProductLot | null;
    expiration: ProductExpiration | null;
  }>(`/api/products/${productId}/barcodes`, {
    method: "POST",
    devUser,
    body: JSON.stringify({
      rawBarcode,
      isPrimary: options?.isPrimary,
      note: options?.note,
    }),
  });
}

export async function scanReceivingBarcode(
  devUser: string,
  rawBarcode: string,
) {
  return request<{
    status: "KNOWN" | "UNKNOWN";
    parsed: ParsedBarcode;
    barcode: ProductBarcode | null;
    product: (Product & { medication: Medication }) | null;
    traceability:
      | { lot: ProductLot | null; expiration: ProductExpiration | null }
      | null;
  }>("/api/receiving/scan", {
    method: "POST",
    devUser,
    body: JSON.stringify({ rawBarcode }),
  });
}

export async function assignReceivingBarcode(
  devUser: string,
  rawBarcode: string,
  productId: string,
  options?: { isPrimary?: boolean; note?: string },
) {
  return request<{
    status: "ASSIGNED";
    parsed: ParsedBarcode;
    barcode: ProductBarcode;
    product: Product & { medication: Medication };
    traceability: {
      lot: ProductLot | null;
      expiration: ProductExpiration | null;
    };
  }>("/api/receiving/assign", {
    method: "POST",
    devUser,
    body: JSON.stringify({
      rawBarcode,
      productId,
      isPrimary: options?.isPrimary,
      note: options?.note,
    }),
  });
}

export async function scanFillBarcode(
  devUser: string,
  fillId: string,
  rawBarcode: string,
  sourceQuantity?: number,
) {
  return request<{
    fill: PrescriptionFill;
    parsed: ParsedBarcode;
    barcode: ProductBarcode;
    verifiedProduct: {
      drug: Medication;
      product: {
        id: string;
        ndc: string;
        descriptor: string;
        manufacturer: Manufacturer;
      };
      lot: ProductLot;
      expiration: ProductExpiration;
    };
  }>(`/api/fills/${fillId}/scan-barcode`, {
    method: "POST",
    devUser,
    body: JSON.stringify({ rawBarcode, sourceQuantity }),
  });
}

export async function removeFillProductSource(
  devUser: string,
  fillId: string,
  sourceId: string,
) {
  return request<{
    fill: PrescriptionFill;
    sourceSummary: {
      requiredQuantity: string;
      reservedQuantity: string;
      remainingQuantity: string;
      complete: boolean;
    };
  }>(`/api/fills/${fillId}/product-sources/${sourceId}`, {
    method: "DELETE",
    devUser,
  });
}

export async function documentNtiManufacturerConsent(
  devUser: string,
  fillId: string,
  input: {
    priorManufacturerId: string;
    newManufacturerId: string;
    prescriberConsentAt: string;
    patientConsentAt: string;
    note: string;
  },
) {
  return request<{ consent: unknown }>(
    `/api/fills/${fillId}/nti-manufacturer-consent`,
    {
      method: "POST",
      devUser,
      body: JSON.stringify(input),
    },
  );
}

export async function completeBiologicCommunication(
  devUser: string,
  fillId: string,
  note: string,
) {
  return request<{ task: unknown }>(
    `/api/fills/${fillId}/biologic-communication/complete`,
    {
      method: "POST",
      devUser,
      body: JSON.stringify({ note }),
    },
  );
}

export async function updateMedicationCompliance(
  devUser: string,
  medicationId: string,
  input: {
    ncNarrowTherapeuticIndex?: boolean;
    isBiological?: boolean;
    hasFdaInterchangeableBiologicAlternative?: boolean;
  },
) {
  return request<{ medication: Medication }>(
    `/api/medications/${medicationId}/compliance`,
    {
      method: "PATCH",
      devUser,
      body: JSON.stringify(input),
    },
  );
}

export async function updateProductCompliance(
  devUser: string,
  productId: string,
  input: {
    therapeuticEquivalenceCode?: string | null;
    isInterchangeableBiological?: boolean;
  },
) {
  return request<{ product: Product }>(
    `/api/products/${productId}/compliance`,
    {
      method: "PATCH",
      devUser,
      body: JSON.stringify(input),
    },
  );
}

export async function getThirdPartyWorkspace(
  devUser: string,
  query?: string,
) {
  const params = new URLSearchParams();
  if (query?.trim()) params.set("query", query.trim());
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return request<{
    patients: Array<Patient & { coverages: PatientCoverage[] }>;
    payers: Payer[];
    maxCoveragePositions: number;
  }>(`/api/third-party/workspace${suffix}`, { devUser });
}

export async function getPayers(devUser: string) {
  const result = await request<{ payers: Payer[] }>(
    "/api/third-party/payers",
    { devUser },
  );
  return result.payers;
}

export async function createPayer(
  devUser: string,
  input: {
    name: string;
    bin?: string;
    pcn?: string;
    defaultGroupId?: string;
    claimStandard?: ClaimStandard;
    billingNdcStrategy?: BillingNdcStrategy;
  },
) {
  return request<{ payer: Payer }>("/api/third-party/payers", {
    method: "POST",
    devUser,
    body: JSON.stringify(input),
  });
}

export async function savePatientCoverage(
  devUser: string,
  patientId: string,
  position: number,
  input: {
    payerId: string;
    memberId: string;
    personCode?: string | null;
    groupId?: string | null;
    relationship?: CoverageRelationship;
    cardholderName?: string | null;
    cardholderDateOfBirth?: string | null;
    effectiveDate?: string | null;
    terminationDate?: string | null;
    active?: boolean;
  },
) {
  return request<{ coverage: PatientCoverage }>(
    `/api/patients/${patientId}/coverages/${position}`,
    {
      method: "PUT",
      devUser,
      body: JSON.stringify(input),
    },
  );
}

export async function removePatientCoverage(
  devUser: string,
  patientId: string,
  position: number,
) {
  return request<void>(
    `/api/patients/${patientId}/coverages/${position}`,
    { method: "DELETE", devUser },
  );
}

export async function correctReceivingBarcode(
  devUser: string,
  barcodeId: string,
  input: {
    productId: string;
    reason: string;
    rawBarcode?: string;
  },
) {
  return request<{
    status: "CORRECTED";
    barcode: ProductBarcode;
    product: Product & { medication: Medication };
    traceability: {
      lot: ProductLot | null;
      expiration: ProductExpiration | null;
    };
    safetyReview: {
      oldProduct: Product & { medication: Medication };
      historicalUseCount: number;
      oldTraceabilityMatches: {
        lot: boolean;
        expiration: boolean;
      };
      message: string | null;
    };
  }>(`/api/receiving/barcodes/${barcodeId}/correct`, {
    method: "POST",
    devUser,
    body: JSON.stringify(input),
  });
}

export async function receiveInventoryStock(
  devUser: string,
  input: {
    rawBarcode: string;
    quantity: number;
    source?: string;
    reference?: string;
    locationId?: string;
    unitCost?: number;
    idempotencyKey?: string;
  },
) {
  return request<{
    status: "RECEIVED" | "REPLAYED";
    parsed: ParsedBarcode;
    barcode: ProductBarcode;
    product: Product & { medication: Medication };
    traceability: {
      lot: ProductLot;
      expiration: ProductExpiration;
    };
    balance: InventoryBalance;
    transaction: InventoryTransaction;
  }>("/api/receiving/stock", {
    method: "POST",
    devUser,
    body: JSON.stringify(input),
  });
}

export async function getInventoryBalances(devUser: string) {
  const result = await request<{ balances: InventoryBalance[] }>(
    "/api/inventory/balances",
    { devUser },
  );
  return result.balances;
}

export async function adjustInventoryBalance(
  devUser: string,
  balanceId: string,
  input: { delta: number; reason: string },
) {
  return request<{
    balance: InventoryBalance;
    transaction: InventoryTransaction;
  }>(`/api/inventory/balances/${balanceId}/adjust`, {
    method: "POST",
    devUser,
    body: JSON.stringify(input),
  });
}

export async function getCycleCounts(devUser: string) {
  const result = await request<{ sessions: CycleCountSession[] }>(
    "/api/inventory/cycle-counts",
    { devUser },
  );
  return result.sessions;
}

export async function createCycleCount(
  devUser: string,
  input: { balanceIds?: string[]; note?: string },
) {
  return request<{ session: CycleCountSession }>(
    "/api/inventory/cycle-counts",
    {
      method: "POST",
      devUser,
      body: JSON.stringify(input),
    },
  );
}

export async function countCycleCountLine(
  devUser: string,
  cycleCountId: string,
  lineId: string,
  countedQuantity: number,
) {
  return request<{ session: CycleCountSession }>(
    `/api/inventory/cycle-counts/${cycleCountId}/lines/${lineId}`,
    {
      method: "PATCH",
      devUser,
      body: JSON.stringify({ countedQuantity }),
    },
  );
}

export async function submitCycleCount(
  devUser: string,
  cycleCountId: string,
) {
  return request<{ session: CycleCountSession }>(
    `/api/inventory/cycle-counts/${cycleCountId}/submit`,
    {
      method: "POST",
      devUser,
    },
  );
}

export async function reviewCycleCount(
  devUser: string,
  cycleCountId: string,
  input: { decision: "APPROVE" | "REJECT"; reviewNote: string },
) {
  return request<{ session: CycleCountSession }>(
    `/api/inventory/cycle-counts/${cycleCountId}/review`,
    {
      method: "POST",
      devUser,
      body: JSON.stringify(input),
    },
  );
}


export async function getInventoryHolds(devUser: string) {
  const result = await request<{ holds: InventoryHold[] }>(
    "/api/inventory/holds",
    { devUser },
  );
  return result.holds;
}

export async function quarantineInventoryBalance(
  devUser: string,
  balanceId: string,
  input: {
    quantity: number;
    reasonCode: InventoryHoldReason;
    note?: string;
  },
) {
  return request<{
    hold: InventoryHold;
    balance: InventoryBalance;
    transaction: InventoryTransaction;
  }>(`/api/inventory/balances/${balanceId}/quarantine`, {
    method: "POST",
    devUser,
    body: JSON.stringify(input),
  });
}

export async function releaseInventoryHold(
  devUser: string,
  holdId: string,
  resolutionNote: string,
) {
  return request<{
    hold: InventoryHold;
    balance: InventoryBalance;
    transaction: InventoryTransaction;
  }>(`/api/inventory/holds/${holdId}/release`, {
    method: "POST",
    devUser,
    body: JSON.stringify({ resolutionNote }),
  });
}

export async function disposeInventoryHold(
  devUser: string,
  holdId: string,
  input: {
    dispositionType: InventoryDispositionType;
    resolutionNote: string;
  },
) {
  return request<{
    hold: InventoryHold;
    balance: InventoryBalance;
    transaction: InventoryTransaction;
  }>(`/api/inventory/holds/${holdId}/dispose`, {
    method: "POST",
    devUser,
    body: JSON.stringify(input),
  });
}

export async function getInventorySites(devUser: string) {
  const result = await request<{ sites: PharmacySiteSummary[] }>(
    "/api/inventory/sites",
    { devUser },
  );
  return result.sites;
}

export async function getInventoryTransfers(devUser: string) {
  const result = await request<{ transfers: InventoryTransfer[] }>(
    "/api/inventory/transfers",
    { devUser },
  );
  return result.transfers;
}

export async function createInventoryTransfer(
  devUser: string,
  input: {
    destinationSiteId: string;
    sourceInventoryBalanceId: string;
    quantity: number;
    note?: string;
    carrier?: string;
    trackingNumber?: string;
    sealIdentifier?: string;
    custodyReference?: string;
    idempotencyKey?: string;
  },
) {
  return request<{ transfer: InventoryTransfer }>("/api/inventory/transfers", {
    method: "POST",
    devUser,
    body: JSON.stringify(input),
  });
}

export async function receiveInventoryTransfer(
  devUser: string,
  transferId: string,
  input?: {
    receiptNote?: string;
    carrier?: string;
    trackingNumber?: string;
    sealIdentifier?: string;
  },
) {
  return request<{ transfer: InventoryTransfer }>(
    `/api/inventory/transfers/${transferId}/receive`,
    {
      method: "POST",
      devUser,
      body: JSON.stringify(input ?? {}),
    },
  );
}

export async function cancelInventoryTransfer(
  devUser: string,
  transferId: string,
  reason: string,
) {
  return request<{ transfer: InventoryTransfer }>(
    `/api/inventory/transfers/${transferId}/cancel`,
    {
      method: "POST",
      devUser,
      body: JSON.stringify({ reason }),
    },
  );
}

export async function getRecallCases(devUser: string) {
  const result = await request<{ recalls: RecallCase[] }>(
    "/api/inventory/recalls",
    { devUser },
  );
  return result.recalls;
}

export async function createRecallCase(
  devUser: string,
  input: {
    productId: string;
    lotNumber?: string;
    reference: string;
    reason: string;
  },
) {
  return request<{
    recall: RecallCase;
    summary: {
      matchedBalanceCount: number;
      quarantinedHoldCount: number;
      reservedAffectedQuantity: string;
      affectedSoldFillCount: number;
    };
  }>("/api/inventory/recalls", {
    method: "POST",
    devUser,
    body: JSON.stringify(input),
  });
}

export async function closeRecallCase(
  devUser: string,
  recallCaseId: string,
  closureNote: string,
) {
  return request<{ recall: RecallCase }>(
    `/api/inventory/recalls/${recallCaseId}/close`,
    {
      method: "POST",
      devUser,
      body: JSON.stringify({ closureNote }),
    },
  );
}

export async function getPurchaseOrders(devUser: string) {
  const result = await request<{ purchaseOrders: PurchaseOrder[] }>(
    "/api/inventory/purchase-orders",
    { devUser },
  );
  return result.purchaseOrders;
}

export async function createPurchaseOrder(
  devUser: string,
  input: {
    orderNumber: string;
    supplierName: string;
    note?: string;
    lines: Array<{
      productId: string;
      quantityOrdered: number;
      unitCost?: number;
    }>;
  },
) {
  return request<{ purchaseOrder: PurchaseOrder }>(
    "/api/inventory/purchase-orders",
    {
      method: "POST",
      devUser,
      body: JSON.stringify(input),
    },
  );
}

export async function receivePurchaseOrderLine(
  devUser: string,
  purchaseOrderId: string,
  lineId: string,
  input: {
    quantity: number;
    lotNumber: string;
    expirationDate: string;
    invoiceReference?: string;
    locationId?: string;
    idempotencyKey?: string;
  },
) {
  return request<{
    purchaseOrder: PurchaseOrder;
    receipt: unknown;
    balance: InventoryBalance;
  }>(
    `/api/inventory/purchase-orders/${purchaseOrderId}/lines/${lineId}/receive`,
    {
      method: "POST",
      devUser,
      body: JSON.stringify(input),
    },
  );
}

export async function cancelPurchaseOrder(
  devUser: string,
  purchaseOrderId: string,
) {
  return request<{ purchaseOrder: PurchaseOrder }>(
    `/api/inventory/purchase-orders/${purchaseOrderId}/cancel`,
    {
      method: "POST",
      devUser,
    },
  );
}


export async function getInventoryLocations(devUser: string) {
  const result = await request<{ locations: InventoryLocation[] }>(
    "/api/inventory/locations",
    { devUser },
  );
  return result.locations;
}

export async function createInventoryLocation(
  devUser: string,
  input: {
    code: string;
    name: string;
    type: InventoryLocationType;
    isDefaultReceiving?: boolean;
    isDefaultDispensing?: boolean;
    isQuarantine?: boolean;
    temperatureMinC?: number;
    temperatureMaxC?: number;
  },
) {
  return request<{ location: InventoryLocation }>("/api/inventory/locations", {
    method: "POST",
    devUser,
    body: JSON.stringify(input),
  });
}

export async function moveInventoryStock(
  devUser: string,
  input: {
    inventoryBalanceId: string;
    fromLocationId: string;
    toLocationId: string;
    state: InventoryStockState;
    quantity: number;
    reason: string;
  },
) {
  return request<{ transaction: InventoryTransaction }>(
    "/api/inventory/locations/move",
    {
      method: "POST",
      devUser,
      body: JSON.stringify(input),
    },
  );
}

export async function getInventoryPolicies(devUser: string) {
  const result = await request<{ policies: InventoryPolicy[] }>(
    "/api/inventory/policies",
    { devUser },
  );
  return result.policies;
}

export async function saveInventoryPolicy(
  devUser: string,
  policyKey: string,
  input: {
    scope?: "SITE" | "PRODUCT";
    productId?: string | null;
    reorderPoint?: number | null;
    targetStockLevel?: number | null;
    minShelfLifeDays?: number;
    expirationWarningDays?: number;
    fefoEnabled?: boolean;
    staleReservationHours?: number;
    staleTransferHours?: number;
    purchaseOrderOverdueDays?: number;
    technicianAdjustmentThreshold?: number | null;
    preferredSupplierName?: string | null;
  },
) {
  return request<{ policy: InventoryPolicy }>(
    `/api/inventory/policies/${encodeURIComponent(policyKey)}`,
    {
      method: "PUT",
      devUser,
      body: JSON.stringify(input),
    },
  );
}

export async function getInventoryDemands(devUser: string) {
  const result = await request<{ demands: InventoryDemand[] }>(
    "/api/inventory/demands",
    { devUser },
  );
  return result.demands;
}

export async function getFefoRecommendation(
  devUser: string,
  productId: string,
  quantity: number,
) {
  const params = new URLSearchParams({
    productId,
    quantity: String(quantity),
  });
  return request<{
    requestedQuantity: string;
    recommendedQuantity: string;
    shortageQuantity: string;
    fefoEnabled: boolean;
    minShelfLifeDays: number;
    picks: Array<{
      balanceId: string;
      productLotId: string;
      lotNumber: string;
      expirationDate: string;
      quantity: string;
      availableQuantity: string;
      locations: Array<{
        locationId: string;
        code: string;
        name: string;
        quantity: string;
      }>;
    }>;
  }>(`/api/inventory/fefo?${params.toString()}`, { devUser });
}

export async function getInventoryProjection(
  devUser: string,
  balanceId: string,
  at?: string,
) {
  const suffix = at ? `?at=${encodeURIComponent(at)}` : "";
  return request<{
    balance: InventoryBalance;
    asOf: string;
    onHandQuantity: string;
    reservedQuantity: string;
    quarantinedQuantity: string;
    availableQuantity: string;
    recordedAcquisitionCost: string;
  }>(`/api/inventory/balances/${balanceId}/as-of${suffix}`, {
    devUser,
  });
}

export async function getInventoryExceptions(devUser: string) {
  const result = await request<{ exceptions: InventoryException[] }>(
    "/api/inventory/exceptions",
    { devUser },
  );
  return result.exceptions;
}

export async function acknowledgeInventoryException(
  devUser: string,
  exceptionId: string,
) {
  return request<{ exception: InventoryException }>(
    `/api/inventory/exceptions/${exceptionId}/acknowledge`,
    { method: "POST", devUser },
  );
}

export async function resolveInventoryException(
  devUser: string,
  exceptionId: string,
  resolutionNote: string,
) {
  return request<{ exception: InventoryException }>(
    `/api/inventory/exceptions/${exceptionId}/resolve`,
    {
      method: "POST",
      devUser,
      body: JSON.stringify({ resolutionNote }),
    },
  );
}

export async function getReceivingDiscrepancies(devUser: string) {
  const result = await request<{ discrepancies: ReceivingDiscrepancy[] }>(
    "/api/inventory/discrepancies",
    { devUser },
  );
  return result.discrepancies;
}

export async function createReceivingDiscrepancy(
  devUser: string,
  input: {
    type: ReceivingDiscrepancyType;
    purchaseOrderId?: string;
    purchaseOrderLineId?: string;
    receiptId?: string;
    expectedProductId?: string;
    observedProductId?: string;
    expectedQuantity?: number;
    observedQuantity?: number;
    note?: string;
  },
) {
  return request<{ discrepancy: ReceivingDiscrepancy }>(
    "/api/inventory/discrepancies",
    {
      method: "POST",
      devUser,
      body: JSON.stringify(input),
    },
  );
}

export async function resolveReceivingDiscrepancy(
  devUser: string,
  discrepancyId: string,
  resolutionNote: string,
) {
  return request<{ discrepancy: ReceivingDiscrepancy }>(
    `/api/inventory/discrepancies/${discrepancyId}/resolve`,
    {
      method: "POST",
      devUser,
      body: JSON.stringify({ resolutionNote }),
    },
  );
}

export async function addTransferCustodyEvent(
  devUser: string,
  transferId: string,
  input: {
    type: InventoryCustodyEvent["type"];
    carrier?: string;
    trackingNumber?: string;
    sealIdentifier?: string;
    note?: string;
  },
) {
  return request<{ event: InventoryCustodyEvent }>(
    `/api/inventory/transfers/${transferId}/custody`,
    {
      method: "POST",
      devUser,
      body: JSON.stringify(input),
    },
  );
}
