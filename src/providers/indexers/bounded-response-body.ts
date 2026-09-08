export async function readBoundedResponseBody(
  response: Response,
  maximumBytes: number,
  label: string,
  invalid: (message: string) => Error,
  requireNonEmpty = false,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > maximumBytes
  ) {
    throw invalid(`${label} is too large`);
  }
  if (response.body === null) {
    if (requireNonEmpty) throw invalid(`${label} has an invalid size`);
    return new Uint8Array();
  }

  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw invalid(`${label} is too large`);
    }
    chunks.push(value);
  }
  if (requireNonEmpty && totalBytes === 0) {
    throw invalid(`${label} has an invalid size`);
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
