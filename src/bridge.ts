// Relay/bridge between the figma-api CLI and the Figma plugin.
// The plugin can't be addressed directly, but it can poll over HTTP — so the CLI
// enqueues commands here, the plugin long-polls /poll, executes them on the
// canvas, and posts the result back to /result.
//
//   figma-api draw-* ──POST /cmd──▶  relay  ◀──GET /poll──  plugin
//                                          ──POST /result─▶ (draws, returns ids)

import { resolve } from "path";
import { existsSync } from "fs";

interface Cmd { id: string; op: string; [k: string]: unknown }

/** Absolute path to the bundled plugin/manifest.json, or a clone hint if missing. */
function manifestPath(): string {
  const p = resolve(import.meta.dir, "..", "plugin", "manifest.json");
  return existsSync(p)
    ? p
    : `${p} (missing — clone it: git clone https://github.com/todoforai/figma-api)`;
}

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
    // Bun's default idleTimeout (10s) is shorter than our 25s /poll long-poll and
    // 30s /cmd result-wait, so it would sever those connections mid-wait — making
    // the plugin's fetch throw ("Relay unreachable") and commands silently time
    // out. Hold connections long enough to cover both.
    idleTimeout: 60,
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
const setup = () => `
Canvas writes (create frames/text/shapes, edit variables off-Enterprise) aren't in
the Figma REST API — they need the plugin bridge, which the user must install.

AGENT: be explicit with the user about this. Explain that the bridge plugin grants
write access to their Figma documents, confirm they want to install it, then walk
them through these steps (the plugin runs in THEIR Figma, you can't do step 2 for
them):
  1. Start the relay (keep running):   figma-api bridge
  2. In the Figma DESKTOP app: Plugins → Development → Import plugin from manifest
     → ${manifestPath()}
     Run it, paste the relay URL (default http://localhost:8917), click Connect.
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
    console.error(`Bridge relay not reachable at ${relay} (${e.message}).${setup()}`);
    process.exit(1);
  });
  const data = (await (res as Response).json()) as { result?: { timeout?: boolean; error?: string } };
  const result = data.result;
  if (result?.timeout) {
    console.error(`Timed out waiting for the plugin — the relay is up but no plugin is Connected.${setup()}`);
    process.exit(1);
  }
  console.log(JSON.stringify(result ?? data, null, 2));
  if (result?.error) process.exit(1);
}
