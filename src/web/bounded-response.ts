export async function readBoundedResponse(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid byte limit");
  const tooLarge = () => new Error(`Preview exceeds the ${Math.round(limit / 1048576)} MiB limit. Download the file instead.`);
  if (signal.aborted) { await response.body?.cancel(); signal.throwIfAborted(); }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Could not load preview (HTTP ${response.status})`); }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) { await response.body?.cancel(); throw tooLarge(); }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (value.byteLength > limit - total) throw tooLarge();
      total += value.byteLength;
      chunks.push(value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
