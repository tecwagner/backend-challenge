export interface LedgerCursorPayload {
  id: string;
  createdAt: string;
}

/**
 * Encodes { id, createdAt } into an opaque, URL-safe base64 string.
 */
export function encodeLedgerCursor(payload: LedgerCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decodes a base64url string into { id, createdAt }.
 * Returns null if the cursor is malformed or invalid.
 */
export function decodeLedgerCursor(cursor: string): LedgerCursorPayload | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.id === 'string' &&
      parsed.id.length > 0 &&
      typeof parsed.createdAt === 'string' &&
      !Number.isNaN(Date.parse(parsed.createdAt))
    ) {
      return {
        id: parsed.id,
        createdAt: parsed.createdAt,
      };
    }
    return null;
  } catch {
    return null;
  }
}
