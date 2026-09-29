export const MAX_DEVICE_BODY_BYTES = 512 * 1024;
export const MAX_DEVICE_EVENTS = 500;
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

export function exceedsContentLength(request: Request, maxBytes: number): boolean {
  const contentLength = request.headers.get('content-length');
  if (!contentLength) return false;

  const parsedLength = Number(contentLength);
  return Number.isFinite(parsedLength) && parsedLength > maxBytes;
}

export function exceedsBodyLimit(body: string, maxBytes: number): boolean {
  return new TextEncoder().encode(body).byteLength > maxBytes;
}
