export type UserRole =
  | "ADMIN"
  | "PHARMACIST"
  | "TECHNICIAN"
  | "INTERN"
  | "CASHIER"
  | "AUDITOR";

export type PrescriptionStatus =
  | "RECEIVED"
  | "DATA_ENTRY"
  | "DUR_REVIEW"
  | "PRODUCT_FILL"
  | "PHARMACIST_REVIEW"
  | "READY"
  | "SOLD"
  | "ON_HOLD"
  | "CANCELLED"
  | "TRANSFERRED";

export type FillStatus =
  | "SCHEDULED"
  | "IN_PROGRESS"
  | "READY"
  | "SOLD"
  | "RETURNED_TO_STOCK"
  | "CANCELLED";

export type FillKind =
  | "STANDARD"
  | "PARTIAL"
  | "COMPLETION"
  | "EMERGENCY_SUPPLY";

export type DurSeverity = "INFO" | "WARNING" | "HIGH";
export type DurIssueStatus = "OPEN" | "RESOLVED";

export type DevUser = {
  externalAuthId: string;
  displayName: string;
  role: UserRole;
  siteId: string;
  siteName: string;
};

export type Patient = {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  phone: string | null;
  email?: string | null;
};

export type PrescriberIdentifierType = "NPI" | "DEA" | "STATE_ID";
export type PrescriberContactType = "PHONE" | "FAX";

export type PrescriberIdentifier = {
  id: string;
  type: PrescriberIdentifierType;
  number: string;
  jurisdiction: string;
  isPrimary: boolean;
};

export type PrescriberContact = {
  id: string;
  type: PrescriberContactType;
  label: string | null;
  value: string;
  extension: string | null;
  isPrimary: boolean;
};

export type PrescriberAddress = {
  id: string;
  label: string | null;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  postalCode: string;
  isPrimary: boolean;
};

export type Prescriber = {
  id: string;
  firstName: string;
  lastName: string;
  practiceLevel: string;
  dateOfBirth: string | null;
  identifiers: PrescriberIdentifier[];
  contacts: PrescriberContact[];
  addresses: PrescriberAddress[];
};

export type PrescriptionFill = {
  id: string;
  fillNumber: number;
  partNumber: number;
  kind: FillKind;
  scheduledFor: string | null;
  quantity: string | number | null;
  authorizedQuantity: string | number | null;
  consumesRefill: boolean;
  completionOfFillId: string | null;
  emergencyReason: string | null;
  emergencyAuthorizedById: string | null;
  emergencyAuthorizedAt: string | null;
  followUpDueAt: string | null;
  followUpCompletedAt: string | null;
  followUpNote: string | null;
  status: FillStatus;
  productId: string | null;
  productLotId: string | null;
  productExpirationId: string | null;
  scannedNdc: string | null;
  scannedLotNumber: string | null;
  scannedExpiration: string | null;
  productVerifiedAt: string | null;
  inventoryBalanceId: string | null;
  inventoryReservedAt: string | null;
  inventoryCommittedAt: string | null;
  inventoryReturnedAt: string | null;
  inventoryBalance: InventoryBalance | null;
  product: Product | null;
  productLot: ProductLot | null;
  productExpiration: ProductExpiration | null;
  filledAt: string | null;
  soldAt: string | null;
  createdAt: string;
};

export type PrescriptionQueueItem = {
  id: string;
  rxNumber: string | null;
  medicationId: string | null;
  medication: Medication | null;
  medicationName: string;
  strength: string | null;
  dosageForm: string | null;
  sig: string;
  quantityWritten: string | number | null;
  refillsAllowed: number;
  refillsUsed: number;
  writtenDate: string | null;
  expirationDate: string | null;
  minimumDaysBetweenFills: number | null;
  status: PrescriptionStatus;
  heldFromStatus: PrescriptionStatus | null;
  doNotFillBefore: string | null;
  createdAt: string;
  updatedAt: string;
  patient: Patient;
  prescriber: Prescriber;
  fills: PrescriptionFill[];
  allowedTransitions: PrescriptionStatus[];
};

export type AuditEvent = {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: unknown;
  occurredAt: string;
  actor: {
    displayName: string;
    role: UserRole;
  } | null;
};

export type DurIssue = {
  id: string;
  prescriptionId: string;
  code: string;
  title: string;
  description: string | null;
  severity: DurSeverity;
  status: DurIssueStatus;
  source: string;
  eligibleAt: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  resolvedAutomatically: boolean;
  resolvedBy: {
    displayName: string;
    role: UserRole;
  } | null;
};

export type InterventionNote = {
  id: string;
  prescriptionId: string;
  note: string;
  createdAt: string;
  author: {
    displayName: string;
    role: UserRole;
  };
};

export type ExceptionKind =
  | "CLINICAL_ISSUE"
  | "ON_HOLD"
  | "PHARMACIST_REVIEW"
  | "SCHEDULED_FILL"
  | "COMPLETION_FILL"
  | "EMERGENCY_FOLLOW_UP";

export type ExceptionItem = {
  id: string;
  kind: ExceptionKind;
  prescriptionId: string;
  rxNumber: string | null;
  patientName: string;
  medicationName: string;
  title: string;
  detail: string | null;
  severity: DurSeverity;
  dueAt: string | null;
  createdAt: string;
};

export type ExceptionSummary = {
  total: number;
  clinical: number;
  onHold: number;
  pharmacistReview: number;
  scheduled: number;
  emergencyFollowUp: number;
};



export type PharmacySiteSummary = {
  id: string;
  name: string;
  ncpdpId: string | null;
  phone: string | null;
};

export type InventoryTransferStatus =
  | "IN_TRANSIT"
  | "RECEIVED"
  | "CANCELLED";

export type RecallStatus = "ACTIVE" | "CLOSED";

export type PurchaseOrderStatus =
  | "OPEN"
  | "PARTIALLY_RECEIVED"
  | "RECEIVED"
  | "CANCELLED";

export type InventoryTransactionType =
  | "RECEIVE"
  | "RESERVE"
  | "RELEASE"
  | "DISPENSE"
  | "RETURN_TO_STOCK"
  | "ADJUSTMENT"
  | "QUARANTINE"
  | "RELEASE_QUARANTINE"
  | "DISPOSE"
  | "TRANSFER_OUT"
  | "TRANSFER_IN"
  | "TRANSFER_CANCEL_RETURN"
  | "MOVE_LOCATION";

export type InventoryTransaction = {
  id: string;
  siteId: string;
  inventoryBalanceId: string;
  fillId: string | null;
  actorId: string | null;
  type: InventoryTransactionType;
  onHandDelta: string | number;
  reservedDelta: string | number;
  quarantinedDelta: string | number;
  inventoryHoldId: string | null;
  reason: string | null;
  source: string | null;
  reference: string | null;
  idempotencyKey: string | null;
  unitCost: string | number | null;
  extendedCost: string | number | null;
  occurredAt: string;
  actor?: {
    displayName: string;
    role: UserRole;
  } | null;
};

export type CycleCountStatus =
  | "OPEN"
  | "SUBMITTED"
  | "APPROVED"
  | "REJECTED";

export type CycleCountLine = {
  id: string;
  cycleCountSessionId: string;
  inventoryBalanceId: string;
  expectedOnHand: string | null;
  expectedReserved: string | null;
  expectedQuarantined: string | null;
  countedQuantity: string | null;
  discrepancy: string | null;
  countedById: string | null;
  countedBy?: {
    id: string;
    displayName: string;
    role: UserRole;
  } | null;
  countedAt: string | null;
  reconciledTransactionId: string | null;
  reconciledTransaction?: InventoryTransaction | null;
  createdAt: string;
  updatedAt: string;
  inventoryBalance: InventoryBalance;
};

export type CycleCountSession = {
  id: string;
  siteId: string;
  status: CycleCountStatus;
  createdById: string;
  createdBy: {
    id: string;
    displayName: string;
    role: UserRole;
  };
  submittedById: string | null;
  submittedBy?: {
    id: string;
    displayName: string;
    role: UserRole;
  } | null;
  reviewedById: string | null;
  reviewedBy?: {
    id: string;
    displayName: string;
    role: UserRole;
  } | null;
  note: string | null;
  reviewNote: string | null;
  createdAt: string;
  submittedAt: string | null;
  reviewedAt: string | null;
  lines: CycleCountLine[];
};

export type InventoryHoldStatus = "ACTIVE" | "RELEASED" | "DISPOSED";

export type InventoryHoldReason =
  | "DAMAGED"
  | "EXPIRED"
  | "RECALL"
  | "SUSPECT_PRODUCT"
  | "TEMPERATURE_EXCURSION"
  | "OTHER";

export type InventoryDispositionType =
  | "DESTROY"
  | "RETURN_TO_VENDOR"
  | "REVERSE_DISTRIBUTOR"
  | "OTHER";

export type InventoryHold = {
  id: string;
  siteId: string;
  inventoryBalanceId: string;
  quantity: string | number;
  reasonCode: InventoryHoldReason;
  note: string | null;
  status: InventoryHoldStatus;
  createdById: string;
  createdBy: {
    id: string;
    displayName: string;
    role: UserRole;
  };
  resolvedById: string | null;
  resolvedBy?: {
    id: string;
    displayName: string;
    role: UserRole;
  } | null;
  resolutionNote: string | null;
  dispositionType: InventoryDispositionType | null;
  createdAt: string;
  resolvedAt: string | null;
  updatedAt: string;
  inventoryBalance: InventoryBalance;
  transactions: InventoryTransaction[];
  carrier: string | null;
  trackingNumber: string | null;
  sealIdentifier: string | null;
  custodyReference: string | null;
  custodyEvents?: InventoryCustodyEvent[];
};

export type InventoryLocationType =
  | "SHELF"
  | "BIN"
  | "REFRIGERATOR"
  | "FREEZER"
  | "SAFE"
  | "RECEIVING"
  | "QUARANTINE"
  | "RETURN_TO_VENDOR"
  | "WILL_CALL"
  | "OTHER";

export type InventoryStockState = "AVAILABLE" | "QUARANTINED";

export type InventoryLocation = {
  id: string;
  siteId: string;
  code: string;
  name: string;
  type: InventoryLocationType;
  active: boolean;
  isDefaultReceiving: boolean;
  isDefaultDispensing: boolean;
  isQuarantine: boolean;
  temperatureMinC: string | number | null;
  temperatureMaxC: string | number | null;
  createdAt: string;
  updatedAt: string;
  stockPositions?: InventoryStockPosition[];
};

export type InventoryStockPosition = {
  id: string;
  inventoryBalanceId: string;
  locationId: string;
  location: InventoryLocation;
  state: InventoryStockState;
  quantity: string | number;
  createdAt: string;
  updatedAt: string;
  inventoryBalance?: InventoryBalance;
};

export type InventoryAllocationStatus =
  | "ACTIVE"
  | "COMMITTED"
  | "RELEASED";

export type InventoryAllocation = {
  id: string;
  siteId: string;
  fillId: string;
  inventoryBalanceId: string;
  actorId: string | null;
  quantity: string | number;
  status: InventoryAllocationStatus;
  createdAt: string;
  resolvedAt: string | null;
  fill?: PrescriptionFill & {
    prescription?: {
      id: string;
      rxNumber: string | null;
      medicationName: string;
    };
  };
};

export type InventoryDemandStatus =
  | "OPEN"
  | "READY"
  | "FULFILLED"
  | "CANCELLED";

export type InventoryDemandSource =
  | "FILL"
  | "COMPLETION"
  | "REORDER"
  | "MANUAL";

export type InventoryDemand = {
  id: string;
  siteId: string;
  medicationId: string;
  productId: string | null;
  fillId: string | null;
  source: InventoryDemandSource;
  requiredQuantity: string | number;
  availableQuantity: string | number;
  status: InventoryDemandStatus;
  neededBy: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  fulfilledAt: string | null;
  medication: Medication;
  product?: Product | null;
  fill?: PrescriptionFill & {
    prescription?: {
      id: string;
      rxNumber: string | null;
      patient?: Patient;
    };
  };
};

export type InventoryPolicy = {
  id: string;
  siteId: string;
  scope: "SITE" | "PRODUCT";
  policyKey: string;
  productId: string | null;
  reorderPoint: string | number | null;
  targetStockLevel: string | number | null;
  minShelfLifeDays: number;
  expirationWarningDays: number;
  fefoEnabled: boolean;
  staleReservationHours: number;
  staleTransferHours: number;
  purchaseOrderOverdueDays: number;
  technicianAdjustmentThreshold: string | number | null;
  preferredSupplierName: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  product?: (Product & { medication?: Medication }) | null;
};

export type ReceivingDiscrepancyType =
  | "SHORT_SHIPMENT"
  | "OVERAGE"
  | "WRONG_PRODUCT"
  | "DAMAGED_PRODUCT"
  | "LOT_EXPIRATION_MISMATCH"
  | "INVOICE_MISMATCH"
  | "DUPLICATE_SHIPMENT"
  | "UNEXPECTED_PRODUCT"
  | "OTHER";

export type ReceivingDiscrepancy = {
  id: string;
  siteId: string;
  purchaseOrderId: string | null;
  purchaseOrderLineId: string | null;
  receiptId: string | null;
  expectedProductId: string | null;
  observedProductId: string | null;
  type: ReceivingDiscrepancyType;
  expectedQuantity: string | number | null;
  observedQuantity: string | number | null;
  note: string | null;
  status: "OPEN" | "RESOLVED";
  createdById: string;
  resolvedById: string | null;
  resolutionNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
  createdBy?: { displayName: string; role: UserRole };
  resolvedBy?: { displayName: string; role: UserRole } | null;
  expectedProduct?: (Product & { medication?: Medication }) | null;
  observedProduct?: (Product & { medication?: Medication }) | null;
};

export type InventoryExceptionType =
  | "BELOW_REORDER_POINT"
  | "EXPIRING_SOON"
  | "STALE_RESERVATION"
  | "TRANSFER_STUCK"
  | "PURCHASE_ORDER_OVERDUE"
  | "UNALLOCATED_DEMAND"
  | "POSITION_IMBALANCE"
  | "MISSING_ACQUISITION_COST";

export type InventoryException = {
  id: string;
  siteId: string;
  fingerprint: string;
  type: InventoryExceptionType;
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
  severity: DurSeverity;
  entityType: string;
  entityId: string | null;
  title: string;
  detail: string;
  firstDetectedAt: string;
  lastDetectedAt: string;
  acknowledgedById: string | null;
  acknowledgedAt: string | null;
  resolvedById: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
};

export type InventoryCustodyEvent = {
  id: string;
  transferId: string;
  siteId: string;
  actorId: string;
  type: "PACKED" | "VERIFIED" | "HANDED_OFF" | "RECEIVED" | "EXCEPTION";
  carrier: string | null;
  trackingNumber: string | null;
  sealIdentifier: string | null;
  note: string | null;
  occurredAt: string;
  actor?: { id: string; displayName: string; role: UserRole };
  site?: { id: string; name: string };
};

export type InventoryBalance = {
  id: string;
  siteId: string;
  productId: string;
  productLotId: string;
  productExpirationId: string;
  onHandQuantity: string | number;
  reservedQuantity: string | number;
  quarantinedQuantity: string | number;
  availableQuantity: string | number;
  createdAt: string;
  updatedAt: string;
  product?: Product & {
    medication: Medication;
  };
  productLot?: ProductLot;
  productExpiration?: ProductExpiration;
  transactions?: InventoryTransaction[];
  stockPositions?: InventoryStockPosition[];
  allocations?: InventoryAllocation[];
};

export type InventoryTransfer = {
  id: string;
  sourceSiteId: string;
  sourceSite: PharmacySiteSummary;
  destinationSiteId: string;
  destinationSite: PharmacySiteSummary;
  sourceInventoryBalanceId: string;
  sourceInventoryBalance: InventoryBalance;
  destinationInventoryBalanceId: string | null;
  destinationInventoryBalance: InventoryBalance | null;
  productId: string;
  lotNumber: string;
  expirationDate: string;
  quantity: string | number;
  status: InventoryTransferStatus;
  note: string | null;
  initiatedById: string;
  initiatedBy: {
    id: string;
    displayName: string;
    role: UserRole;
  };
  receivedById: string | null;
  receivedBy?: {
    id: string;
    displayName: string;
    role: UserRole;
  } | null;
  cancelledById: string | null;
  cancelledBy?: {
    id: string;
    displayName: string;
    role: UserRole;
  } | null;
  shippedAt: string;
  receivedAt: string | null;
  cancelledAt: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  sealIdentifier: string | null;
  custodyReference: string | null;
  transactions: InventoryTransaction[];
  custodyEvents?: InventoryCustodyEvent[];
};

export type RecallAffectedFill = {
  id: string;
  recallCaseId: string;
  fillId: string;
  discoveredAt: string;
  fill: PrescriptionFill & {
    productLot: ProductLot | null;
    prescription: {
      id: string;
      rxNumber: string | null;
      medicationName: string;
      patient: Patient;
    };
  };
};

export type RecallCase = {
  id: string;
  siteId: string;
  productId: string;
  product: Product & { medication: Medication };
  lotNumber: string | null;
  lotNumberSearch: string | null;
  reference: string;
  reason: string;
  status: RecallStatus;
  createdById: string;
  createdBy: {
    id: string;
    displayName: string;
    role: UserRole;
  };
  closedById: string | null;
  closedBy?: {
    id: string;
    displayName: string;
    role: UserRole;
  } | null;
  createdAt: string;
  closedAt: string | null;
  closureNote: string | null;
  holds: InventoryHold[];
  affectedFills: RecallAffectedFill[];
};

export type PurchaseOrderReceipt = {
  id: string;
  purchaseOrderLineId: string;
  actorId: string;
  actor: {
    id: string;
    displayName: string;
    role: UserRole;
  };
  inventoryBalanceId: string;
  inventoryBalance: InventoryBalance;
  inventoryTransactionId: string;
  quantity: string | number;
  lotNumber: string;
  expirationDate: string;
  invoiceReference: string | null;
  unitCost: string | number | null;
  extendedCost: string | number | null;
  idempotencyKey: string | null;
  receivedAt: string;
};

export type PurchaseOrderLine = {
  id: string;
  purchaseOrderId: string;
  productId: string;
  product: Product & { medication: Medication };
  quantityOrdered: string | number;
  quantityReceived: string | number;
  unitCost: string | number | null;
  createdAt: string;
  updatedAt: string;
  receipts: PurchaseOrderReceipt[];
};

export type PurchaseOrder = {
  id: string;
  siteId: string;
  orderNumber: string;
  supplierName: string;
  status: PurchaseOrderStatus;
  note: string | null;
  createdById: string;
  createdBy: {
    id: string;
    displayName: string;
    role: UserRole;
  };
  cancelledById: string | null;
  cancelledBy?: {
    id: string;
    displayName: string;
    role: UserRole;
  } | null;
  createdAt: string;
  cancelledAt: string | null;
  lines: PurchaseOrderLine[];
};

export type ProductLot = {
  id: string;
  siteId: string;
  productId: string;
  lotNumber: string;
  active: boolean;
  receivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProductExpiration = {
  id: string;
  siteId: string;
  productId: string;
  expirationDate: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Manufacturer = {
  id: string;
  name: string;
  labelerCode: string | null;
  active: boolean;
};

export type ProductUnit = "EACH" | "GRAM" | "MILLILITER";
export type ProductBarcodeType = "GTIN_14" | "UPC_A" | "EAN_13" | "OTHER";

export type ProductBarcode = {
  id: string;
  productId: string;
  type: ProductBarcodeType;
  identifier: string;
  identifierSearch: string;
  isPrimary: boolean;
  note: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ParsedBarcode = {
  raw: string;
  type: ProductBarcodeType;
  identifier: string;
  identifierSearch: string;
  gtin: string | null;
  lotNumber: string | null;
  expirationDate: string | null;
  format: "GS1" | "PLAIN";
};

export type Product = {
  id: string;
  medicationId: string;
  manufacturerId: string;
  ndc: string;
  descriptor: string;
  packageDescription: string | null;
  packageType: string | null;
  unitsPerPackage: string | number | null;
  dispensingUnit: ProductUnit | null;
  unitPrice: string | number | null;
  packagePrice: string | number | null;
  active: boolean;
  manufacturer: Manufacturer;
  lots: ProductLot[];
  expirations: ProductExpiration[];
  barcodes: ProductBarcode[];
};

export type Medication = {
  id: string;
  genericName: string;
  brandName: string | null;
  strength: string;
  dosageForm: string;
  route: string | null;
  active: boolean;
  products: Product[];
};
