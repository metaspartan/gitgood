import { expect, test } from "bun:test";
import { readBoundedResponse } from "../../src/web/bounded-response.ts";

function fixture(chunks: number[][], length?: string) {
  let pulls = 0, cancellations = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { const next = chunks[pulls++]; if (next) controller.enqueue(new Uint8Array(next)); else controller.close(); },
    cancel() { cancellations++; },
  }, { highWaterMark: 0 });
  return { response: new Response(stream, { headers: length === undefined ? {} : { "content-length": length } }), counts: () => ({ pulls, cancellations }) };
}

test("stream boundaries below, at and one byte above the cap", async () => {
  for (const size of [3, 4, 5]) {
    const f = fixture([[1, 2], Array(size - 2).fill(3)]);
    const operation = readBoundedResponse(f.response, 4, new AbortController().signal);
    if (size > 4) {
      await expect(operation).rejects.toThrow("Preview exceeds");
      expect(f.counts()).toEqual({ pulls: 2, cancellations: 1 });
    } else {
      expect(Array.from(await operation)).toEqual([1, 2, ...Array(size - 2).fill(3)]);
      expect(f.counts()).toEqual({ pulls: 3, cancellations: 0 });
    }
    expect(f.response.body!.locked).toBe(false);
  }
});

test("oversized declared content is canceled before reading", async () => {
  const f = fixture([[1, 2, 3]], "5");
  await expect(readBoundedResponse(f.response, 4, new AbortController().signal)).rejects.toThrow();
  expect(f.counts()).toEqual({ pulls: 0, cancellations: 1 });
});

test("lying and missing lengths cannot bypass stream enforcement", async () => {
  for (const length of [undefined, "1", "invalid"]) {
    const f = fixture([[1, 2, 3, 4, 5], [6]], length);
    await expect(readBoundedResponse(f.response, 4, new AbortController().signal)).rejects.toThrow();
    expect(f.counts()).toEqual({ pulls: 1, cancellations: 1 });
  }
});

test("abort cancels a pending read and releases its lock", async () => {
  let cancellations = 0;
  const controller = new AbortController();
  const response = new Response(new ReadableStream({ cancel() { cancellations++; } }));
  const result = readBoundedResponse(response, 4, controller.signal);
  controller.abort();
  await expect(result).rejects.toThrow();
  expect(cancellations).toBe(1); expect(response.body!.locked).toBe(false);
});

test("pre-abort and error responses cancel without consuming data", async () => {
  const f = fixture([[1]]); const controller = new AbortController(); controller.abort();
  await expect(readBoundedResponse(f.response, 4, controller.signal)).rejects.toThrow();
  expect(f.counts()).toEqual({ pulls: 0, cancellations: 1 });
  await expect(readBoundedResponse(new Response("error", { status: 403 }), 10, new AbortController().signal)).rejects.toThrow("HTTP 403");
});
