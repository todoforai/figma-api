// Relay/bridge between the figma-api CLI and the Figma plugin.
// The plugin can't be addressed directly, but it can poll over HTTP — so the CLI
// enqueues commands here, the plugin long-polls /poll, executes them on the
// canvas, and posts the result back to /result.
//
//   figma-api draw-* ──POST /cmd──▶  relay  ◀──GET /poll──  plugin
//                                          ──POST /result─▶ (draws, returns ids)

interface Cmd { id: string; op: string; [k: string]: unknown }

const queue: Cmd[] = [];
const resultWaiters = new Map<string, (v: unknown) => void>();
const pollWaiters: ((c: Cmd | null) => void)[] = [];
let lastSeen = 0;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "*" },
  });
}

export function startBridge(port: number): void {
  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS") return json({}, 204);

      // Health / status
      if (url.pathname === "/health") {
        return json({ ok: true, queued: queue.length, pluginSeenMsAgo: lastSeen ? Date.now() - lastSeen : null });
      }

      // CLI → enqueue a command and wait for the plugin's result
      if (url.pathname === "/cmd" && req.method === "POST") {
        const body = (await req.json()) as Record<string, unknown>;
        const id = crypto.randomUUID().slice(0, 8);
        const cmd: Cmd = { id, op: String(body.op), ...body };
        const waiter = pollWaiters.shift();
        if (waiter) waiter(cmd);
        else queue.push(cmd);
        const result = await new Promise((resolve) => {
          resultWaiters.set(id, resolve);
          setTimeout(() => { if (resultWaiters.delete(id)) resolve({ timeout: true }); }, 30000);
        });
        return json({ id, result });
      }

      // Plugin → long-poll for the next command
      if (url.pathname === "/poll") {
        lastSeen = Date.now();
        const next = queue.shift();
        if (next) return json(next);
        const cmd = await new Promise<Cmd | null>((resolve) => {
          pollWaiters.push(resolve);
          setTimeout(() => {
            const i = pollWaiters.indexOf(resolve);
            if (i >= 0) { pollWaiters.splice(i, 1); resolve(null); }
          }, 25000);
        });
        return json(cmd ?? {});
      }

      // Plugin → post a command result
      if (url.pathname === "/result" && req.method === "POST") {
        const body = (await req.json()) as { id: string; result: unknown };
        const w = resultWaiters.get(body.id);
        if (w) { resultWaiters.delete(body.id); w(body.result); }
        return json({ ok: true });
      }

      return json({ error: "not found" }, 404);
    },
  });
  console.log(`figma-api bridge listening on http://localhost:${port}`);
  console.log("Endpoints: POST /cmd  GET /poll  POST /result  GET /health");
  console.log("Point the plugin at this URL (or a cloudflared tunnel of it), then run draw-* commands.");
}

/** Setup instructions shown only when a canvas-write command can't reach the plugin. */
const SETUP = `
To run canvas commands (create frames/text/shapes, edit variables off-Enterprise),
the plugin bridge must be set up — the Figma REST API can't do these:
  1. Start the relay (keep running):   figma-api bridge
  2. In the Figma DESKTOP app: Plugins → Development → Import plugin from manifest
     → the plugin/manifest.json shipped with this package. Run it, paste the relay
     URL (default http://localhost:8917), click Connect.
  3. Retry. Verify the round-trip with:  figma-api ping
Cross-machine: expose the relay via 'cloudflared tunnel --url http://localhost:8917'
and paste that https URL into the plugin. Browser-only Figma can't load dev plugins.`;

/** CLI helper: push a command to a running bridge and return the plugin's result. */
export async function sendCommand(relay: string, op: string, params: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${relay.replace(/\/$/, "")}/cmd`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, ...params }),
  }).catch((e) => {
    console.error(`Bridge relay not reachable at ${relay} (${e.message}).${SETUP}`);
    process.exit(1);
  });
  const data = (await (res as Response).json()) as { result?: { timeout?: boolean; error?: string } };
  const result = data.result;
  if (result?.timeout) {
    console.error(`Timed out waiting for the plugin — the relay is up but no plugin is Connected.${SETUP}`);
    process.exit(1);
  }
  console.log(JSON.stringify(result ?? data, null, 2));
  if (result?.error) process.exit(1);
}
