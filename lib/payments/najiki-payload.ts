export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse only object-shaped webhook payloads; JSON null, arrays, and scalars are invalid. */
export function parseNajikiWebhookPayload(rawBody: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function asJsonObject(value: unknown): JsonObject | null {
  return isJsonObject(value) ? value : null;
}

/** Read a scalar without invoking attacker-controlled object coercion methods. */
export function scalarString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

export function firstScalarString(...values: unknown[]): string {
  for (const value of values) {
    const candidate = scalarString(value).trim();
    if (candidate) return candidate;
  }
  return '';
}
