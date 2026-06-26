// figma-api bridge plugin. The UI (ui.html) long-polls the relay, forwards each
// command here, this runs it and returns the result. The REST API can't create
// canvas nodes or edit variables off-Enterprise — the Plugin API can, and the
// figma-api CLI drives it through `figma-api run`.

// Serialize a value for JSON transport: Figma nodes → {id,type,name}, recurse
// plain objects/arrays, guard against cycles and unstringifiable values.
function serialize(v, seen) {
  if (v == null || typeof v === "boolean" || typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "function" || typeof v === "symbol" || typeof v === "undefined") return undefined;
  if (typeof v.id === "string" && typeof v.type === "string") return { id: v.id, type: v.type, name: v.name };
  seen = seen || new Set();
  if (seen.has(v)) return "[circular]";
  seen.add(v);
  if (Array.isArray(v)) return v.map((x) => serialize(x, seen));
  const o = {};
  for (const k of Object.keys(v)) { try { o[k] = serialize(v[k], seen); } catch (_) {} }
  return o;
}

async function exec(cmd) {
  if (cmd.op === "ping") {
    return { pong: true, page: figma.currentPage.name, selection: figma.currentPage.selection.map((n) => n.id) };
  }
  if (cmd.op === "eval") {
    // Run arbitrary Plugin API code. `figma` is in scope; code may use await
    // and `return` a value. WARNING: this executes whatever the relay delivers.
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const out = await new AsyncFunction("figma", cmd.code || "")(figma);
    return { value: serialize(out) };
  }
  return { error: "unknown op: " + cmd.op };
}

figma.showUI(__html__, { width: 340, height: 320 });

figma.ui.onmessage = async (msg) => {
  if (msg.type === "exec") {
    let result;
    try { result = await exec(msg.cmd); }
    catch (e) { result = { error: String((e && e.message) || e) }; }
    figma.ui.postMessage({ type: "result", id: msg.cmd.id, result });
    figma.notify(result.error ? "⚠️ " + result.error : "✅ " + msg.cmd.op);
  } else if (msg.type === "close") {
    figma.closePlugin();
  }
};
