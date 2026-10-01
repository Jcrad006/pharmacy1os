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

export type FillBillingRole =
  | "PRIMARY_CLAIM"
  | "COMPLETION_OF_PRIMARY"
  | "EMERGENCY_SUPPLY";

export type FillInterruptionReason =
  | "INSUFFICIENT_PHYSICAL_STOCK"
  | "DAMAGED_PRODUCT"
  | "EXPIRED_PRODUCT"
  | "STOCK_DISCREPANCY"
  | "OTHER";

export type ProductSelectionDirective =
  | "UNSPECIFIED"
  | "SELECTION_PERMITTED"
  | "DISPENSE_AS_WRITTEN";

export type PrescriptionSourceType =
  | "MANUAL"
  | "PAPER"
  | "FAX"
  | "ELECTRONIC"
  | "VERBAL"
  | "TRANSFER";

export type DocumentSourceType = "SCAN" | "UPLOAD" | "ELECTRONIC_RENDER";
export type DocumentKind =
  | "PRESCRIPTION_SOURCE"
  | "INSURANCE_CARD"
  | "PRESCRIBER_COMMUNICATION"
  | "PRIOR_AUTHORIZATION"
  | "OTHER";
export type PrescriptionAnnotationStatus = "ACTIVE" | "SUPERSEDED";
export type PrescriptionChangeRecordStatus = "ACTIVE" | "SUPERSEDED";
export type PrescriptionChangeType =
  | "SIG"
  | "QUANTITY"
  | "REFILLS"
  | "DRUG"
  | "STRENGTH"
  | "DOSAGE_FORM"
  | "DAW"
  | "PRESCRIBER"
  | "WRITTEN_DATE"
  | "OTHER";
export type PrescriptionChangeCommunicationMethod =
  | "PHONE"
  | "FAX"
  | "ELECTRONIC"
  | "IN_PERSON"
  | "OTHER";

export type ClaimStandard = "D0" | "F6";

export type BillingNdcStrategy =
  | "MAJORITY_SOURCE"
  | "REQUIRE_MANUAL_SELECTION"
  | "SINGLE_SOURCE_ONLY"
  | "PAYER_CONFIGURED";

export type CoverageRelationship = "SELF" | "SPOUSE" | "CHILD" | "OTHER";

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
  daysSupply: number | null;
  quantity: string | number | null;
  authorizedQuantity: string | number | null;
  intendedQuantity: string | number | null;
  payerIntendedQuantity: string | number | null;
  physicalDispensedQuantity: string | number;
  remainingOwedQuantity: string | number;
  billingRole: FillBillingRole;
  billingAnchorFillId: string | null;
  interruptionReason: FillInterruptionReason | null;
  interruptionNote: string | null;
  interruptedAt: string | null;
  interruptedById: string | null;
  billingProductId: string | null;
  patientDiscardDate: string | null;
  dispensedInOriginalContainer: boolean;
  productSources: FillProductSource[];
  biologicCommunicationTask: BiologicCommunicationTask | null;
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
  willCallPackage: WillCallPackage | null;
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
  prescribedProductId: string | null;
  prescribedProduct: Product | null;
  productSelectionDirective: ProductSelectionDirective;
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
  sourceType: PrescriptionSourceType;
  electronicMessageId: string | null;
  heldFromStatus: PrescriptionStatus | null;
  doNotFillBefore: string | null;
  createdAt: string;
  updatedAt: string;
  patient: Patient;
  prescriber: Prescriber;
  fills: PrescriptionFill[];
  allowedTransitions: PrescriptionStatus[];
};

export type PrescriptionChangeRecord = {
  id: string;
  siteId: string;
  prescriptionId: string;
  annotationId: string;
  changeType: PrescriptionChangeType;
  whatChanged: string;
  reason: string;
  communicationMethod: PrescriptionChangeCommunicationMethod | null;
  contactedParty: string | null;
  authorizingPrescriber: string | null;
  note: string | null;
  status: PrescriptionChangeRecordStatus;
  changedById: string;
  changedAt: string;
  supersedesChangeRecordId: string | null;
  changedBy: {
    id: string;
    displayName: string;
    role: UserRole;
  };
};

export type PrescriptionAnnotation = {
  id: string;
  siteId: string;
  prescriptionId: string;
  documentId: string;
  text: string;
  x: string | number;
  y: string | number;
  width: string | number;
  height: string | number;
  backgroundOpacity: string | number;
  status: PrescriptionAnnotationStatus;
  createdById: string;
  createdAt: string;
  supersedesAnnotationId: string | null;
  createdBy: {
    id: string;
    displayName: string;
    role: UserRole;
  };
  changeRecord: PrescriptionChangeRecord | null;
};

export type PrescriptionDocument = {
  id: string;
  siteId: string;
  patientId: string | null;
  prescriptionId: string | null;
  kind: DocumentKind;
  sourceType: DocumentSourceType;
  mimeType: string;
  originalFilename: string | null;
  sha256: string;
  byteSize: number;
  encrypted: boolean;
  immutable: boolean;
  createdById: string;
  createdAt: string;
  createdBy: {
    id: string;
    displayName: string;
    role: UserRole;
  };
  annotations: PrescriptionAnnotation[];
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
  | "EMERGENCY_FOLLOW_UP"
  | "BIOLOGIC_COMMUNICATION";

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
  biologicCommunication: number;
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
  barcode: string | null;
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
  | "RELEASED"
  | "RETURNED";

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
  | "MISSING_ACQUISITION_COST"
  | "PHYSICAL_STOCK_SHORTAGE";

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
  therapeuticEquivalenceCode: string | null;
  isInterchangeableBiological: boolean;
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
  ncNarrowTherapeuticIndex: boolean;
  isBiological: boolean;
  hasFdaInterchangeableBiologicAlternative: boolean;
  active: boolean;
  products: Product[];
};

export type FillProductSource = {
  id: string;
  fillId: string;
  sequence: number;
  productId: string;
  manufacturerId: string;
  productLotId: string;
  productExpirationId: string;
  inventoryBalanceId: string;
  quantity: string | number;
  ndcSnapshot: string;
  manufacturerSnapshot: string;
  lotNumberSnapshot: string;
  expirationSnapshot: string;
  verifiedAt: string;
  committedAt: string | null;
  returnedAt: string | null;
  product: Product;
  manufacturer: Manufacturer;
  productLot: ProductLot;
  productExpiration: ProductExpiration;
  inventoryBalance: InventoryBalance;
};

export type BiologicCommunicationTask = {
  id: string;
  siteId: string;
  fillId: string;
  status: "OPEN" | "COMPLETED" | "EXEMPT";
  productName: string;
  manufacturerName: string;
  dueAt: string;
  completedById: string | null;
  completedAt: string | null;
  note: string | null;
  exemptReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PayerBillingProfile = {
  id: string;
  siteId: string;
  payerId: string;
  billingNdcStrategy: BillingNdcStrategy;
  autoReversePaidClaimOnSourceCorrection: boolean;
  customRules: Record<string, unknown> | unknown;
  notes: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type Payer = {
  id: string;
  siteId: string;
  name: string;
  bin: string | null;
  pcn: string | null;
  defaultGroupId: string | null;
  claimStandard: ClaimStandard;
  billingNdcStrategy: BillingNdcStrategy;
  billingProfile?: PayerBillingProfile | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PatientCoverage = {
  id: string;
  siteId: string;
  patientId: string;
  payerId: string;
  position: number;
  memberId: string;
  personCode: string | null;
  groupId: string | null;
  relationship: CoverageRelationship;
  cardholderName: string | null;
  cardholderDateOfBirth: string | null;
  effectiveDate: string | null;
  terminationDate: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  payer: Payer;
};

export type ClaimOperation = "SUBMIT" | "REVERSAL";
export type ClaimOutcome = "PAID" | "REJECTED" | "ERROR" | "REVERSED";
export type PrescriptionLabelStatus = "ACTIVE" | "VOID";
export type LabelPrintStatus =
  | "QUEUED"
  | "PRINTED"
  | "FAILED"
  | "CANCELLED";

export type ClaimTransaction = {
  id: string;
  siteId: string;
  fillId: string;
  payerId: string;
  coverageIdSnapshot: string;
  coveragePosition: number;
  operation: ClaimOperation;
  outcome: ClaimOutcome;
  idempotencyKey: string;
  originalTransactionId: string | null;
  claimStandard: ClaimStandard;
  adapterName: string;
  adapterVersion: string;
  billedProductId: string;
  billedNdc: string;
  memberIdSnapshot: string;
  personCodeSnapshot: string | null;
  groupIdSnapshot: string | null;
  payerIntendedQuantity: string | number;
  physicalPartQuantity: string | number;
  daysSupply: number;
  billingProfileVersion: number | null;
  billingProfileSnapshot: unknown;
  requestSnapshot: unknown;
  responseSnapshot: unknown;
  transactionReference: string | null;
  authorizationNumber: string | null;
  amountPaid: string | number | null;
  patientResponsibility: string | number | null;
  rejectCodes: string[];
  messages: string[];
  createdById: string;
  adjudicatedAt: string;
  createdAt: string;
  payer?: Payer;
  createdBy?: {
    id: string;
    displayName: string;
    role: UserRole;
  };
  fill?: PrescriptionFill & {
    prescription?: PrescriptionQueueItem;
  };
};

export type LabelPrintJob = {
  id: string;
  siteId: string;
  labelId: string;
  status: LabelPrintStatus;
  copies: number;
  printerName: string | null;
  actorId: string | null;
  queuedAt: string;
  printedAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
  label?: PrescriptionLabel;
};

export type PrescriptionLabel = {
  id: string;
  siteId: string;
  fillId: string;
  version: number;
  status: PrescriptionLabelStatus;
  claimTransactionId: string | null;
  rxNumberSnapshot: string | null;
  patientNameSnapshot: string;
  prescriberNameSnapshot: string;
  medicationSnapshot: string;
  sigSnapshot: string;
  physicalQuantity: string | number;
  containerQuantity: string | number;
  bottleNumber: number;
  bottleCount: number;
  physicalProductIdSnapshot: string | null;
  physicalNdcSnapshot: string | null;
  manufacturerSnapshot: string | null;
  productDescriptionSnapshot: string | null;
  payerIntendedQuantity: string | number | null;
  daysSupply: number | null;
  billedNdcSnapshot: string | null;
  sourceSummarySnapshot: unknown;
  generatedAt: string;
  voidedAt: string | null;
  voidReason: string | null;
  printJobs?: LabelPrintJob[];
  fill?: PrescriptionFill & {
    prescription?: PrescriptionQueueItem;
  };
};

export type ClaimAdjudicationState =
  | "PAID_LABEL_READY"
  | "CASH_LABEL_READY"
  | "COMPLETION_LABEL_READY"
  | "REJECTED"
  | "ERROR"
  | "BLOCKED";

export type ClaimAdjudicationResult = {
  state: ClaimAdjudicationState;
  code?: string;
  error?: string;
  details?: Record<string, unknown>;
  transactions: ClaimTransaction[];
  label: PrescriptionLabel | null;
  printJob: LabelPrintJob | null;
  labels: PrescriptionLabel[];
  printJobs: LabelPrintJob[];
};


export type PosTransactionStatus = "COMPLETED" | "VOIDED";
export type PosPriceBasis =
  | "THIRD_PARTY"
  | "CASH"
  | "COMPLETION_ALREADY_BILLED";
export type PaymentMethod = "CASH" | "CARD" | "CHECK" | "OTHER";
export type PickupFulfillmentMode = "WILL_CALL" | "IMMEDIATE";
export type PickupIdentityMethod =
  | "DATE_OF_BIRTH"
  | "ADDRESS"
  | "GOVERNMENT_ID"
  | "KNOWN_PATIENT"
  | "OTHER";
export type PickupSignatureMethod =
  | "ELECTRONIC_TYPED"
  | "EXTERNAL_DEVICE"
  | "PAPER";
export type WillCallPackageStatus =
  | "STAGED"
  | "PICKED_UP"
  | "RETURNED_TO_STOCK";
export type WillCallEventType =
  | "STAGED"
  | "RELOCATED"
  | "REBAGGED"
  | "PICKED_UP"
  | "RETURNED_TO_STOCK";

export type WillCallPackage = {
  id: string;
  siteId: string;
  fillId: string;
  bagBarcode: string;
  locationId: string;
  status: WillCallPackageStatus;
  stagedById: string;
  stagedAt: string;
  pickedUpAt: string | null;
  returnedAt: string | null;
  updatedAt: string;
  location: InventoryLocation;
};

export type WillCallEvent = {
  id: string;
  siteId: string;
  packageId: string;
  eventType: WillCallEventType;
  actorId: string;
  oldBagBarcode: string | null;
  newBagBarcode: string | null;
  fromLocationId: string | null;
  toLocationId: string | null;
  occurredAt: string;
  actor?: {
    id: string;
    displayName: string;
    role: UserRole;
  };
  fromLocation?: Pick<InventoryLocation, "id" | "code" | "name" | "barcode"> | null;
  toLocation?: Pick<InventoryLocation, "id" | "code" | "name" | "barcode"> | null;
};

export type WillCallScanResult = {
  scanType: "BAG" | "LOCATION";
  packages: WillCallPackage[];
};

export type PosQuoteLine = {
  fillId: string;
  prescriptionId: string;
  patientId: string;
  rxNumber: string | null;
  medicationName: string;
  fillNumber: number;
  partNumber: number;
  quantity: string | number;
  priceBasis: PosPriceBasis;
  claimTransactionId: string | null;
  patientResponsibilitySnapshot: string | number | null;
  cashUnitPriceSnapshot: string | number | null;
  cashPricingSnapshot: unknown;
  amountDue: string | number;
  pickupFulfillmentMode: PickupFulfillmentMode;
  willCallPackageId: string | null;
  bagBarcode: string | null;
  willCallLocationId: string | null;
  willCallLocationCode: string | null;
  willCallLocationName: string | null;
  willCallLocationBarcode: string | null;
};

export type PosQuote = {
  patientId: string;
  pickupFulfillmentMode: PickupFulfillmentMode;
  lines: PosQuoteLine[];
  totalDue: string | number;
};

export type PaymentTender = {
  id: string;
  transactionId: string;
  method: PaymentMethod;
  amount: string | number;
  reference: string | null;
  actorId: string;
  createdAt: string;
};

export type PointOfSaleLine = {
  id: string;
  transactionId: string;
  fillId: string;
  claimTransactionId: string | null;
  quantity: string | number;
  priceBasis: PosPriceBasis;
  cashUnitPriceSnapshot: string | number | null;
  cashPricingSnapshot: unknown;
  patientResponsibilitySnapshot: string | number | null;
  amountDue: string | number;
  createdAt: string;
};

export type PointOfSaleTransaction = {
  id: string;
  siteId: string;
  patientId: string;
  receiptNumber: string;
  status: PosTransactionStatus;
  totalDue: string | number;
  totalTendered: string | number;
  changeDue: string | number;
  idempotencyKey: string;
  pickupFulfillmentMode: PickupFulfillmentMode;
  pickupRecipientName: string;
  pickupRelationship: string | null;
  pickupIdentityMethod: PickupIdentityMethod;
  pickupVerifiedAt: string;
  pickupSignatureMethod: PickupSignatureMethod;
  pickupSignatureName: string | null;
  pickupSignatureReference: string | null;
  createdById: string;
  voidedById: string | null;
  completedAt: string;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  lines: PointOfSaleLine[];
  tenders: PaymentTender[];
  patient?: Patient;
  createdBy?: {
    id: string;
    displayName: string;
    role: UserRole;
  };
};
