import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

const ENCRYPTED_MAGIC = Buffer.from("P1DV1");
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

export class DocumentVaultError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function getDocumentStorageRoot() {
  return resolve(
    process.env.DOCUMENT_STORAGE_ROOT ??
      resolve(process.cwd(), "data", "documents"),
  );
}

function encryptionKey() {
  const configured = process.env.DOCUMENT_ENCRYPTION_KEY?.trim();
  if (!configured) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(configured)) {
    throw new DocumentVaultError(
      503,
      "DOCUMENT_ENCRYPTION_KEY_INVALID",
      "DOCUMENT_ENCRYPTION_KEY must be a 64-character hexadecimal AES-256 key.",
    );
  }
  return Buffer.from(configured, "hex");
}

export function getDocumentStoragePath(storageKey: string) {
  const root = getDocumentStorageRoot();
  const candidate = resolve(root, storageKey);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new DocumentVaultError(
      500,
      "DOCUMENT_STORAGE_KEY_INVALID",
      "Stored document path is outside the configured document vault.",
    );
  }
  return candidate;
}

export function getDocumentEncryptionKeyFingerprint() {
  const key = encryptionKey();
  return key
    ? createHash("sha256").update(key).digest("hex").slice(0, 24)
    : null;
}

function encryptBytes(bytes: Buffer, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ENCRYPTED_MAGIC, iv, tag, ciphertext]);
}

function decryptBytes(bytes: Buffer, key: Buffer) {
  if (
    bytes.length < ENCRYPTED_MAGIC.length + 12 + 16 ||
    !bytes.subarray(0, ENCRYPTED_MAGIC.length).equals(ENCRYPTED_MAGIC)
  ) {
    throw new DocumentVaultError(
      500,
      "DOCUMENT_ENCRYPTED_PAYLOAD_INVALID",
      "Encrypted document payload is malformed.",
    );
  }
  const offset = ENCRYPTED_MAGIC.length;
  const iv = bytes.subarray(offset, offset + 12);
  const tag = bytes.subarray(offset + 12, offset + 28);
  const ciphertext = bytes.subarray(offset + 28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function decodeDocumentBase64(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new DocumentVaultError(
      400,
      "DOCUMENT_CONTENT_REQUIRED",
      "Document content is required.",
    );
  }

  const comma = trimmed.startsWith("data:") ? trimmed.indexOf(",") : -1;
  const encoded = comma >= 0 ? trimmed.slice(comma + 1) : trimmed;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded.replace(/\s+/g, ""))) {
    throw new DocumentVaultError(
      400,
      "DOCUMENT_BASE64_INVALID",
      "Document content must be valid base64.",
    );
  }

  const bytes = Buffer.from(encoded.replace(/\s+/g, ""), "base64");
  if (bytes.length === 0) {
    throw new DocumentVaultError(
      400,
      "DOCUMENT_CONTENT_REQUIRED",
      "Document content is required.",
    );
  }
  if (bytes.length > MAX_DOCUMENT_BYTES) {
    throw new DocumentVaultError(
      413,
      "DOCUMENT_TOO_LARGE",
      "Document exceeds the 25 MB development limit.",
      { maxBytes: MAX_DOCUMENT_BYTES },
    );
  }
  return bytes;
}

export function assertSupportedUploadedMimeType(mimeType: string) {
  const allowed = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/tiff",
    "application/pdf",
  ]);
  if (!allowed.has(mimeType.toLowerCase())) {
    throw new DocumentVaultError(
      415,
      "DOCUMENT_TYPE_UNSUPPORTED",
      "Prescription source documents must be JPEG, PNG, WebP, TIFF, or PDF.",
    );
  }
}

export async function storeImmutableDocument(input: {
  siteId: string;
  documentId?: string;
  bytes: Buffer;
}) {
  if (input.bytes.length > MAX_DOCUMENT_BYTES) {
    throw new DocumentVaultError(
      413,
      "DOCUMENT_TOO_LARGE",
      "Document exceeds the 25 MB development limit.",
    );
  }

  const documentId = input.documentId ?? randomUUID();
  const storageKey = `originals/${input.siteId}/${documentId}.p1doc`;
  const path = getDocumentStoragePath(storageKey);
  await mkdir(dirname(path), { recursive: true });

  const key = encryptionKey();
  const payload = key ? encryptBytes(input.bytes, key) : input.bytes;
  await writeFile(path, payload, { flag: "wx" });

  return {
    documentId,
    storageKey,
    sha256: createHash("sha256").update(input.bytes).digest("hex"),
    byteSize: input.bytes.length,
    encrypted: Boolean(key),
  };
}

export async function readImmutableDocument(input: {
  storageKey: string;
  encrypted: boolean;
}) {
  const path = getDocumentStoragePath(input.storageKey);
  const payload = await readFile(path);
  if (!input.encrypted) return payload;

  const key = encryptionKey();
  if (!key) {
    throw new DocumentVaultError(
      503,
      "DOCUMENT_ENCRYPTION_KEY_REQUIRED",
      "This document is encrypted, but DOCUMENT_ENCRYPTION_KEY is not configured.",
    );
  }
  return decryptBytes(payload, key);
}

export function decodeStoredDocumentPayload(
  payload: Buffer,
  encrypted: boolean,
) {
  if (!encrypted) return payload;
  const key = encryptionKey();
  if (!key) {
    throw new DocumentVaultError(
      503,
      "DOCUMENT_ENCRYPTION_KEY_REQUIRED",
      "This document is encrypted, but DOCUMENT_ENCRYPTION_KEY is not configured.",
    );
  }
  return decryptBytes(payload, key);
}

export async function readStoredDocumentPayload(storageKey: string) {
  return readFile(getDocumentStoragePath(storageKey));
}

export async function removeStoredDocument(storageKey: string) {
  try {
    await unlink(getDocumentStoragePath(storageKey));
  } catch (error) {
    const code =
      typeof error === "object" && error && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    if (code !== "ENOENT") throw error;
  }
}

function escapeXml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrapText(value: string, maxChars = 72) {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (!line) {
      line = word;
    } else if (`${line} ${word}`.length <= maxChars) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

export function renderElectronicPrescriptionSvg(rx: {
  rxNumber: string | null;
  medicationName: string;
  strength: string | null;
  dosageForm: string | null;
  sig: string;
  quantityWritten: unknown;
  refillsAllowed: number;
  writtenDate: Date | null;
  productSelectionDirective: string;
  electronicMessageId: string | null;
  patient: {
    firstName: string;
    lastName: string;
    dateOfBirth: Date | null;
  };
  prescriber: {
    firstName: string;
    lastName: string;
    practiceLevel: string;
    identifiers?: Array<{ type: string; number: string; isPrimary: boolean }>;
    addresses?: Array<{
      addressLine1: string;
      addressLine2: string | null;
      city: string;
      state: string;
      postalCode: string;
      isPrimary: boolean;
    }>;
  };
}) {
  const sigLines = wrapText(rx.sig);
  const npi =
    rx.prescriber.identifiers?.find(
      (item) => item.type === "NPI" && item.isPrimary,
    )?.number ??
    rx.prescriber.identifiers?.find((item) => item.type === "NPI")?.number ??
    "—";
  const address =
    rx.prescriber.addresses?.find((item) => item.isPrimary) ??
    rx.prescriber.addresses?.[0];
  const dob = rx.patient.dateOfBirth
    ? rx.patient.dateOfBirth.toISOString().slice(0, 10)
    : "—";
  const written = rx.writtenDate
    ? rx.writtenDate.toISOString().slice(0, 10)
    : "—";
  const medication = [rx.medicationName, rx.strength, rx.dosageForm]
    .filter(Boolean)
    .join(" ");

  let sigSvg = "";
  let y = 610;
  for (const line of sigLines.slice(0, 5)) {
    sigSvg += `<text x="90" y="${y}" class="sig">${escapeXml(line)}</text>`;
    y += 34;
  }

  const addressLine = address
    ? [
        address.addressLine1,
        address.addressLine2,
        `${address.city}, ${address.state} ${address.postalCode}`,
      ]
        .filter(Boolean)
        .join(" · ")
    : "—";

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1180" viewBox="0 0 900 1180">
      <rect width="900" height="1180" fill="#ffffff"/>
      <style>
        .title{font:700 30px Arial,sans-serif;fill:#173c2f}
        .subtitle{font:700 13px Arial,sans-serif;fill:#587066;letter-spacing:1.4px}
        .label{font:700 12px Arial,sans-serif;fill:#68776f;letter-spacing:1px}
        .body{font:500 22px Arial,sans-serif;fill:#17241f}
        .small{font:500 15px Arial,sans-serif;fill:#4e5d56}
        .drug{font:700 29px Arial,sans-serif;fill:#132c22}
        .sig{font:600 25px Arial,sans-serif;fill:#17241f}
      </style>
      <rect x="45" y="45" width="810" height="1090" rx="12" fill="none" stroke="#bfcfc7" stroke-width="2"/>
      <text x="80" y="105" class="title">ELECTRONIC PRESCRIPTION</text>
      <text x="80" y="135" class="subtitle">HUMAN-READABLE RENDERING OF STRUCTURED PRESCRIPTION DATA</text>
      <line x1="80" y1="165" x2="820" y2="165" stroke="#dbe5e0"/>

      <text x="80" y="210" class="label">PATIENT</text>
      <text x="80" y="245" class="body">${escapeXml(rx.patient.firstName)} ${escapeXml(rx.patient.lastName)}</text>
      <text x="575" y="210" class="label">DATE OF BIRTH</text>
      <text x="575" y="245" class="body">${escapeXml(dob)}</text>

      <text x="80" y="315" class="label">PRESCRIBER</text>
      <text x="80" y="350" class="body">${escapeXml(rx.prescriber.firstName)} ${escapeXml(rx.prescriber.lastName)}, ${escapeXml(rx.prescriber.practiceLevel)}</text>
      <text x="80" y="382" class="small">NPI: ${escapeXml(npi)}</text>
      <text x="80" y="410" class="small">${escapeXml(addressLine)}</text>

      <line x1="80" y1="455" x2="820" y2="455" stroke="#dbe5e0"/>
      <text x="80" y="500" class="label">MEDICATION</text>
      <text x="80" y="545" class="drug">${escapeXml(medication)}</text>

      <text x="80" y="590" class="label">DIRECTIONS / SIG</text>
      ${sigSvg}

      <text x="80" y="810" class="label">QUANTITY</text>
      <text x="80" y="845" class="body">${escapeXml(rx.quantityWritten ?? "—")}</text>
      <text x="320" y="810" class="label">REFILLS</text>
      <text x="320" y="845" class="body">${escapeXml(rx.refillsAllowed)}</text>
      <text x="540" y="810" class="label">PRODUCT SELECTION</text>
      <text x="540" y="845" class="body">${escapeXml(rx.productSelectionDirective)}</text>

      <text x="80" y="920" class="label">WRITTEN</text>
      <text x="80" y="955" class="body">${escapeXml(written)}</text>
      <text x="320" y="920" class="label">RX NUMBER</text>
      <text x="320" y="955" class="body">${escapeXml(rx.rxNumber ?? "—")}</text>
      <text x="540" y="920" class="label">MESSAGE ID</text>
      <text x="540" y="955" class="small">${escapeXml(rx.electronicMessageId ?? "—")}</text>

      <line x1="80" y1="1010" x2="820" y2="1010" stroke="#dbe5e0"/>
      <text x="80" y="1050" class="small">Rendered by Pharmacy1OS. The structured/raw electronic message remains the source record.</text>
      <text x="80" y="1080" class="small">Visual annotations do not modify the immutable electronic source.</text>
    </svg>`,
    "utf8",
  );
}
