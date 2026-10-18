const PORT = 4999;
const received: Array<{ at: string; event: string; signature: string; body: string }> = [];

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/received") {
      return Response.json({ count: received.length, received });
    }
    if (url.pathname !== "/hook") return new Response("not found", { status: 404 });
    const body = await request.text();
    received.push({
      at: new Date().toISOString(),
      event: request.headers.get("x-gitgood-event") ?? "",
      signature: (request.headers.get("x-hub-signature-256") ?? "").slice(0, 20),
      body: body.slice(0, 160),
    });
    console.log(`received ${request.headers.get("x-gitgood-event")} delivery (${body.length} bytes)`);
    return new Response("ok", { status: 200 });
  },
});

console.log(`webhook receiver listening on http://0.0.0.0:${server.port} (hook path /hook)`);
