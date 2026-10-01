export type ParsedBarcodeType =
  | "GTIN_14"
  | "UPC_A"
  | "EAN_13"
  | "OTHER";

export type ParsedBarcode = {
  raw: string;
  type: ParsedBarcodeType;
  identifier: string;
  identifierSearch: string;
  gtin: string | null;
  lotNumber: string | null;
  expirationDate: Date | null;
  format: "GS1" | "PLAIN";
};

const GS = "\x1D";

function normalizeIdentifier(value: string) {
  return value.trim().replace(/\s+/g, "");
}

function parseGs1Date(value: string) {
  if (!/^\d{6}$/.test(value)) return null;
  const year = 2000 + Number(value.slice(0, 2));
  const month = Number(value.slice(2, 4));
  let day = Number(value.slice(4, 6));

  if (month < 1 || month > 12) return null;

  if (day === 0) {
    day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  const result = new Date(Date.UTC(year, month - 1, day));
  if (
    result.getUTCFullYear() !== year ||
    result.getUTCMonth() !== month - 1 ||
    result.getUTCDate() !== day
  ) {
    return null;
  }

  return result;
}

function parsed(
  raw: string,
  type: ParsedBarcodeType,
  identifier: string,
  options?: {
    gtin?: string | null;
    lotNumber?: string | null;
    expirationDate?: Date | null;
    format?: "GS1" | "PLAIN";
  },
): ParsedBarcode {
  const clean = normalizeIdentifier(identifier);
  return {
    raw,
    type,
    identifier: clean,
    identifierSearch: clean.replace(/[^A-Za-z0-9]/g, "").toUpperCase(),
    gtin: options?.gtin ?? (type === "GTIN_14" ? clean : null),
    lotNumber: options?.lotNumber?.trim() || null,
    expirationDate: options?.expirationDate ?? null,
    format: options?.format ?? "PLAIN",
  };
}

function parseParenthesizedGs1(raw: string, value: string) {
  const fields = new Map<string, string>();
  const matches = [...value.matchAll(/\((\d{2,4})\)/g)];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (!match) continue;

    const ai = match[1];
    if (!ai) continue;

    const start = (match.index ?? 0) + match[0].length;
    const nextMatch = matches[index + 1];
    const end = nextMatch?.index ?? value.length;

    fields.set(ai, value.slice(start, end).replaceAll(GS, "").trim());
  }

  const gtin = fields.get("01");
  if (!gtin || !/^\d{14}$/.test(gtin)) return null;

  return parsed(raw, "GTIN_14", gtin, {
    gtin,
    lotNumber: fields.get("10") ?? null,
    expirationDate: fields.get("17")
      ? parseGs1Date(fields.get("17")!)
      : null,
    format: "GS1",
  });
}

function parseElementString(raw: string, value: string) {
  let cursor = 0;
  let gtin: string | null = null;
  let lotNumber: string | null = null;
  let expirationDate: Date | null = null;

  while (cursor < value.length) {
    if (value[cursor] === GS) {
      cursor += 1;
      continue;
    }

    const ai = value.slice(cursor, cursor + 2);
    if (ai === "01" && /^\d{14}$/.test(value.slice(cursor + 2, cursor + 16))) {
      gtin = value.slice(cursor + 2, cursor + 16);
      cursor += 16;
      continue;
    }

    if (ai === "17" && /^\d{6}$/.test(value.slice(cursor + 2, cursor + 8))) {
      expirationDate = parseGs1Date(value.slice(cursor + 2, cursor + 8));
      cursor += 8;
      continue;
    }

    if (ai === "10") {
      const start = cursor + 2;
      const separator = value.indexOf(GS, start);
      const end = separator === -1 ? value.length : separator;
      lotNumber = value.slice(start, end).trim() || null;
      cursor = end;
      continue;
    }

    return null;
  }

  if (!gtin) return null;

  return parsed(raw, "GTIN_14", gtin, {
    gtin,
    lotNumber,
    expirationDate,
    format: "GS1",
  });
}

export function parseBarcode(rawInput: string): ParsedBarcode | null {
  const raw = rawInput.trim();
  if (!raw) return null;

  const stripped = raw
    .replace(/^\](?:d2|C1)/i, "")
    .replace(/[\r\n]+$/g, "");

  if (stripped.includes("(01)")) {
    const gs1 = parseParenthesizedGs1(raw, stripped);
    if (gs1) return gs1;
  }

  if (stripped.startsWith("01")) {
    const gs1 = parseElementString(raw, stripped);
    if (gs1) return gs1;
  }

  if (/^\d{14}$/.test(stripped)) {
    return parsed(raw, "GTIN_14", stripped);
  }

  if (/^\d{13}$/.test(stripped)) {
    return parsed(raw, "EAN_13", stripped);
  }

  if (/^\d{12}$/.test(stripped)) {
    return parsed(raw, "UPC_A", stripped);
  }

  return parsed(raw, "OTHER", stripped);
}
