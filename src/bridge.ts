// WebSocket relay + CLI peer for the Figma plugin bridge.
//
// The Figma REST API can't create canvas nodes (frames/text/shapes) — the Plugin
// API can. The plugin can't be addressed directly, so a relay sits between it and
// the CLI. We speak the cursor-talk-to-figma WebSocket protocol, so this relay is
// a drop-in for that ecosystem: its MCP server can drive our plugin, and our CLI
// can drive theirs.
//
//   figma-api create-frame … ──ws──▶  relay (channel broadcast)  ◀──ws──  plugin
//
// Protocol (channel-scoped, broadcast to the *other* peer, never echoed):
//   join:    { type:"join", channel }   → { type:"system", message:{ id, result } }
//   command: { type:"message", channel, message:{ id, command, params } }
//   result:  { type:"message", channel, message:{ id, result } | { id, error } }
//   each is delivered to the other peer wrapped as { type:"broadcast", message }.

import { resolve } from "path";
import { existsSync } from "fs";
import type { ServerWebSocket } from "bun";

export const DEFAULT_PORT = 3055;
export const DEFAULT_CHANNEL = "figma-api";

interface WsData { channel?: string }

/** Absolute path to the bundled plugin/manifest.json, or a clone hint if missing. */
function manifestPath(): string {
  const p = resolve(import.meta.dir, "..", "plugin", "manifest.json");
  return existsSync(p)
    ? p
    : `${p} (missing — clone it: git clone https://github.com/todoforai/figma-api)`;
}

export function startBridge(port: number): void {
  const channels = new Map<string, Set<ServerWebSocket<WsData>>>();

  Bun.serve<WsData, undefined>({
    port,
    fetch(req, server) {
      if (server.upgrade(req, { data: {} })) return;
      return new Response("figma-api bridge: WebSocket only", { status: 426 });
    },
    websocket: {
      // Match cursor-talk-to-figma's relay (src/socket.ts) so either side is a
      // drop-in: welcome on open, two-part join ack, peer notices, broadcasts
      // wrapped as {type:"broadcast", sender:"peer", message:<inner>}.
      open(ws) {
        ws.send(JSON.stringify({ type: "system", message: "Please join a channel to start chatting" }));
      },
      message(ws, raw) {
        let msg: any;
        try { msg = JSON.parse(String(raw)); } catch { return; }

        if (msg.type === "join") {
          const ch = typeof msg.channel === "string" && msg.channel ? msg.channel : DEFAULT_CHANNEL;
          if (ws.data.channel && ws.data.channel !== ch) channels.get(ws.data.channel)?.delete(ws);
          let peers = channels.get(ch);
          if (!peers) channels.set(ch, (peers = new Set()));
          ws.data.channel = ch;
          ws.send(JSON.stringify({ type: "system", message: `Joined channel: ${ch}`, channel: ch }));
          ws.send(JSON.stringify({ type: "system", message: { id: msg.id, result: `Connected to channel: ${ch}` }, channel: ch }));
          for (const peer of peers) if (peer !== ws) peer.send(JSON.stringify({ type: "system", message: "A new user has joined the channel", channel: ch }));
          peers.add(ws);
          console.log(`peer joined channel "${ch}" (${peers.size} in channel)`);
          return;
        }

        const ch = ws.data.channel;
        if (!ch || !channels.get(ch)?.has(ws)) { ws.send(JSON.stringify({ type: "error", message: "You must join the channel first" })); return; }

        // Forward progress updates verbatim to the other peers (upstream parity).
        if (msg.type === "progress_update") {
          for (const peer of channels.get(ch) ?? []) if (peer !== ws) peer.send(JSON.stringify(msg));
          return;
        }
        if (msg.type !== "message") return;

        // Broadcast the inner message to the OTHER peers (sender never gets its own).
        const out = JSON.stringify({ type: "broadcast", sender: "peer", channel: ch, message: msg.message });
        for (const peer of channels.get(ch) ?? []) if (peer !== ws) peer.send(out);
      },
      close(ws) {
        const ch = ws.data.channel;
        if (!ch) return;
        const peers = channels.get(ch);
        if (!peers) return;
        peers.delete(ws);
        for (const peer of peers) peer.send(JSON.stringify({ type: "system", message: "A user has left the channel", channel: ch }));
        if (peers.size === 0) channels.delete(ch);
      },
    },
  });

  console.log(`figma-api bridge (WebSocket) listening on ws://localhost:${port}`);
  console.log(`Default channel: "${DEFAULT_CHANNEL}". Open the plugin, click Connect, then run figma-api commands.`);
}

/** Setup instructions shown only when a canvas command can't reach the plugin. */
const setup = (port: number) => `
Canvas writes (create frames/text/shapes) aren't in the Figma REST API — they need
the plugin bridge, which the user must install.

AGENT: be explicit with the user about this. The bridge plugin grants write access
to their Figma documents — confirm they want it, then walk them through (the plugin
runs in THEIR Figma, you can't do step 2 for them):
  1. Start the relay (keep running):   figma-api bridge
  2. In the Figma DESKTOP app: Plugins → Development → Import plugin from manifest
     → ${manifestPath()}
     Run it, set the URL to ws://localhost:${port} and channel "${DEFAULT_CHANNEL}", click Connect.
  3. Retry. Verify the round-trip with:  figma-api ping
Cross-machine: expose the relay via 'cloudflared tunnel --url http://localhost:${port}'
and paste the wss:// URL into the plugin. Browser-only Figma can't load dev plugins.`;

/** CLI peer: connect to the relay, send one command, return the plugin's result. */
export function sendCommand(
  wsUrl: string,
  channel: string,
  command: string,
  params: Record<string, unknown>,
  timeoutMs = 30000,
): Promise<unknown> {
  const port = Number(new URL(wsUrl).port) || DEFAULT_PORT;
  return new Promise((resolveP, rejectP) => {
    const ws = new WebSocket(wsUrl);
    const id = crypto.randomUUID().slice(0, 8);
    let joined = false;

    const timer = setTimeout(() => {
      ws.close();
      rejectP(new Error(`Timed out waiting for the plugin — relay is up but no plugin is Connected.${setup(port)}`));
    }, timeoutMs);

    ws.addEventListener("open", () => ws.send(JSON.stringify({ id, type: "join", channel })));
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      rejectP(new Error(`Bridge relay not reachable at ${wsUrl}.${setup(port)}`));
    });
    ws.addEventListener("message", (ev) => {
      let data: any;
      try { data = JSON.parse(String(ev.data)); } catch { return; }
      // Wait for the structured join ack (ignore string system notices / welcome)
      // before sending the command, else the relay rejects it as "not in channel".
      if (data.type === "system") {
        const sm = data.message;
        if (!joined && sm && typeof sm === "object" && sm.result === `Connected to channel: ${channel}`) {
          joined = true;
          ws.send(JSON.stringify({ id, type: "message", channel, message: { id, command, params } }));
        }
        return;
      }
      // The plugin's result arrives as a "broadcast" event; data.message is the payload.
      const m = data.message;
      if (m && m.id === id) {
        clearTimeout(timer);
        ws.close();
        if (m.error) rejectP(new Error(m.error));
        else resolveP(m.result);
      }
    });
  });
}

/** Run a command and print its result; exit non-zero on failure. */
export async function runCommand(
  wsUrl: string,
  channel: string,
  command: string,
  params: Record<string, unknown>,
): Promise<void> {
  try {
    const result = await sendCommand(wsUrl, channel, command, params);
    console.log(JSON.stringify(result ?? null, null, 2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
