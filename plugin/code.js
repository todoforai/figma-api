// figma-api bridge plugin — talks the cursor-talk-to-figma WebSocket protocol so
// it's a drop-in for that ecosystem (its MCP server can drive this plugin), while
// staying small. The UI (ui.html) joins a WS channel on the relay, forwards each
// {command,params} here, this runs it and returns the result.
//
// Two ways to drive it:
//   • named commands (create_frame, set_fill_color, …) — cursor-talk-to-figma compatible
//   • "eval" — run arbitrary Plugin API code (our extra; droppable, but handy)

// ── serialization ────────────────────────────────────────────────────────────
// Figma nodes → {id,type,name}; recurse plain objects/arrays; guard cycles/bigints.
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

// ── small helpers ────────────────────────────────────────────────────────────
async function byId(id) {
  if (!id) throw new Error("Missing nodeId parameter");
  const n = await figma.getNodeByIdAsync(id);
  if (!n) throw new Error(`Node not found with ID: ${id}`);
  return n;
}
async function appendTo(node, parentId) {
  if (parentId) {
    const p = await byId(parentId);
    if (!("appendChild" in p)) throw new Error(`Parent node does not support children: ${parentId}`);
    p.appendChild(node);
  } else figma.currentPage.appendChild(node);
}
const solid = (c) => ({ type: "SOLID", color: { r: +c.r || 0, g: +c.g || 0, b: +c.b || 0 }, opacity: c.a === undefined ? 1 : +c.a });
const box = (n) => ({ id: n.id, name: n.name, x: n.x, y: n.y, width: n.width, height: n.height, parentId: n.parent ? n.parent.id : undefined });
const fontStyle = (w) => ({ 100: "Thin", 200: "Extra Light", 300: "Light", 400: "Regular", 500: "Medium", 600: "Semi Bold", 700: "Bold", 800: "Extra Bold", 900: "Black" }[w] || "Regular");

function b64(bytes) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    const ng = i + 1 < bytes.length, nh = i + 2 < bytes.length;
    out += chars[a >> 2] + chars[((a & 3) << 4) | (ng ? b >> 4 : 0)] +
      (ng ? chars[((b & 15) << 2) | (nh ? c >> 6 : 0)] : "=") + (nh ? chars[c & 63] : "=");
  }
  return out;
}

// ── command handlers (cursor-talk-to-figma compatible) ───────────────────────
const handlers = {
  async ping() {
    return { pong: true, page: figma.currentPage.name, selection: figma.currentPage.selection.map((n) => n.id) };
  },

  // arbitrary Plugin API code — `figma` in scope, may await and return a value.
  // WARNING: executes whatever the relay delivers. Run only on trusted machines.
  async eval(p) {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    return { value: serialize(await new AsyncFunction("figma", p.code || "")(figma)) };
  },

  async get_document_info() {
    await figma.currentPage.loadAsync();
    const pg = figma.currentPage;
    return { id: pg.id, name: pg.name, type: pg.type, childCount: pg.children.length,
      children: pg.children.map((n) => ({ id: n.id, name: n.name, type: n.type })) };
  },
  async get_selection() {
    return { selectionCount: figma.currentPage.selection.length,
      selection: figma.currentPage.selection.map((n) => ({ id: n.id, name: n.name, type: n.type, visible: n.visible })) };
  },
  async get_node_info(p) {
    const n = await byId(p.nodeId);
    return serialize((await n.exportAsync({ format: "JSON_REST_V1" })).document);
  },
  async get_nodes_info(p) {
    const nodes = await Promise.all((p.nodeIds || []).map((id) => byId(id)));
    return Promise.all(nodes.map(async (n) => ({ nodeId: n.id, document: serialize((await n.exportAsync({ format: "JSON_REST_V1" })).document) })));
  },
  read_my_design() { return handlers.get_selection(); },

  async create_rectangle(p = {}) {
    const r = figma.createRectangle();
    r.x = p.x ?? 0; r.y = p.y ?? 0; r.resize(p.width ?? 100, p.height ?? 100); r.name = p.name || "Rectangle";
    await appendTo(r, p.parentId);
    return box(r);
  },
  async create_frame(p = {}) {
    const f = figma.createFrame();
    f.x = p.x ?? 0; f.y = p.y ?? 0; f.resize(p.width ?? 100, p.height ?? 100); f.name = p.name || "Frame";
    if (p.layoutMode && p.layoutMode !== "NONE") {
      f.layoutMode = p.layoutMode; f.layoutWrap = p.layoutWrap || "NO_WRAP";
      f.paddingTop = p.paddingTop ?? 10; f.paddingRight = p.paddingRight ?? 10;
      f.paddingBottom = p.paddingBottom ?? 10; f.paddingLeft = p.paddingLeft ?? 10;
      f.primaryAxisAlignItems = p.primaryAxisAlignItems || "MIN";
      f.counterAxisAlignItems = p.counterAxisAlignItems || "MIN";
      f.layoutSizingHorizontal = p.layoutSizingHorizontal || "FIXED";
      f.layoutSizingVertical = p.layoutSizingVertical || "FIXED";
      f.itemSpacing = p.itemSpacing ?? 0;
    }
    if (p.fillColor) f.fills = [solid(p.fillColor)];
    if (p.strokeColor) f.strokes = [solid(p.strokeColor)];
    if (p.strokeWeight !== undefined) f.strokeWeight = p.strokeWeight;
    await appendTo(f, p.parentId);
    return Object.assign(box(f), { fills: f.fills, strokes: f.strokes, layoutMode: f.layoutMode });
  },
  async create_text(p = {}) {
    const t = figma.createText();
    t.x = p.x ?? 0; t.y = p.y ?? 0;
    const text = p.text ?? "Text"; t.name = p.name || text;
    const style = fontStyle(p.fontWeight ?? 400);
    await figma.loadFontAsync({ family: "Inter", style });
    t.fontName = { family: "Inter", style };
    t.fontSize = parseInt(p.fontSize ?? 14);
    t.characters = text;
    t.fills = [solid(p.fontColor || { r: 0, g: 0, b: 0, a: 1 })];
    await appendTo(t, p.parentId);
    return Object.assign(box(t), { characters: t.characters, fontSize: t.fontSize, fontName: t.fontName });
  },

  async set_fill_color(p = {}) {
    const n = await byId(p.nodeId);
    if (!("fills" in n)) throw new Error(`Node does not support fills: ${p.nodeId}`);
    n.fills = [solid(p.color || {})];
    return { id: n.id, name: n.name, fills: n.fills };
  },
  async set_stroke_color(p = {}) {
    const n = await byId(p.nodeId);
    if (!("strokes" in n)) throw new Error(`Node does not support strokes: ${p.nodeId}`);
    n.strokes = [solid(p.color || {})];
    if ("strokeWeight" in n) n.strokeWeight = p.weight ?? 1;
    return { id: n.id, name: n.name, strokes: n.strokes, strokeWeight: "strokeWeight" in n ? n.strokeWeight : undefined };
  },
  async set_corner_radius(p = {}) {
    const n = await byId(p.nodeId);
    if (p.radius === undefined) throw new Error("Missing radius parameter");
    if (!("cornerRadius" in n)) throw new Error(`Node does not support corner radius: ${p.nodeId}`);
    const c = p.corners;
    if (Array.isArray(c) && c.length === 4 && "topLeftRadius" in n) {
      if (c[0]) n.topLeftRadius = p.radius; if (c[1]) n.topRightRadius = p.radius;
      if (c[2]) n.bottomRightRadius = p.radius; if (c[3]) n.bottomLeftRadius = p.radius;
    } else n.cornerRadius = p.radius;
    return { id: n.id, name: n.name, cornerRadius: n.cornerRadius };
  },
  async set_text_content(p = {}) {
    const n = await byId(p.nodeId);
    if (p.text === undefined) throw new Error("Missing text parameter");
    if (n.type !== "TEXT") throw new Error(`Node is not a text node: ${p.nodeId}`);
    await figma.loadFontAsync(n.fontName);
    n.characters = p.text;
    return { id: n.id, name: n.name, characters: n.characters, fontName: n.fontName };
  },

  async move_node(p = {}) {
    const n = await byId(p.nodeId);
    if (p.x === undefined || p.y === undefined) throw new Error("Missing x or y parameters");
    if (!("x" in n)) throw new Error(`Node does not support position: ${p.nodeId}`);
    n.x = p.x; n.y = p.y;
    return { id: n.id, name: n.name, x: n.x, y: n.y };
  },
  async resize_node(p = {}) {
    const n = await byId(p.nodeId);
    if (p.width === undefined || p.height === undefined) throw new Error("Missing width or height parameters");
    if (!("resize" in n)) throw new Error(`Node does not support resizing: ${p.nodeId}`);
    n.resize(p.width, p.height);
    return { id: n.id, name: n.name, width: n.width, height: n.height };
  },
  async clone_node(p = {}) {
    const n = await byId(p.nodeId);
    const c = n.clone();
    if (p.x !== undefined) c.x = p.x; if (p.y !== undefined) c.y = p.y;
    await appendTo(c, p.parentId);
    return box(c);
  },
  async delete_node(p = {}) {
    const n = await byId(p.nodeId);
    const info = { id: n.id, name: n.name, type: n.type };
    n.remove();
    return info;
  },
  async delete_multiple_nodes(p = {}) {
    const deleted = [];
    for (const id of p.nodeIds || []) {
      try { const n = await byId(id); deleted.push({ id: n.id, name: n.name, type: n.type }); n.remove(); }
      catch (e) { deleted.push({ id, error: String(e.message || e) }); }
    }
    return { deleted };
  },

  async set_focus(p = {}) {
    const n = await byId(p.nodeId);
    figma.currentPage.selection = [n];
    figma.viewport.scrollAndZoomIntoView([n]);
    return { id: n.id, name: n.name };
  },
  async set_selections(p = {}) {
    const nodes = await Promise.all((p.nodeIds || []).map((id) => byId(id)));
    figma.currentPage.selection = nodes;
    figma.viewport.scrollAndZoomIntoView(nodes);
    return { selection: nodes.map((n) => ({ id: n.id, name: n.name })) };
  },

  async get_styles() {
    const [colors, texts, effects, grids] = await Promise.all([
      figma.getLocalPaintStylesAsync(), figma.getLocalTextStylesAsync(),
      figma.getLocalEffectStylesAsync(), figma.getLocalGridStylesAsync()]);
    return {
      colors: colors.map((s) => ({ id: s.id, name: s.name, key: s.key, paint: s.paints[0] })),
      texts: texts.map((s) => ({ id: s.id, name: s.name, key: s.key })),
      effects: effects.map((s) => ({ id: s.id, name: s.name, key: s.key })),
      grids: grids.map((s) => ({ id: s.id, name: s.name, key: s.key })),
    };
  },
  async get_local_components() {
    await figma.loadAllPagesAsync();
    const comps = figma.root.findAllWithCriteria({ types: ["COMPONENT"] });
    return { count: comps.length, components: comps.map((c) => ({ id: c.id, name: c.name, key: c.key })) };
  },
  async create_component_instance(p = {}) {
    if (!p.componentKey) throw new Error("Missing componentKey parameter");
    const comp = await figma.importComponentByKeyAsync(p.componentKey);
    const inst = comp.createInstance();
    inst.x = p.x ?? 0; inst.y = p.y ?? 0;
    await appendTo(inst, p.parentId);
    return box(inst);
  },
  async export_node_as_image(p = {}) {
    const n = await byId(p.nodeId);
    if (!("exportAsync" in n)) throw new Error(`Node does not support exporting: ${p.nodeId}`);
    const scale = p.scale ?? 1;
    const bytes = await n.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale } });
    return { nodeId: p.nodeId, format: "PNG", scale, mimeType: "image/png", imageData: b64(bytes) };
  },

  async set_layout_mode(p = {}) {
    const n = await byId(p.nodeId);
    if (!("layoutMode" in n)) throw new Error(`Node does not support auto layout: ${p.nodeId}`);
    n.layoutMode = p.layoutMode || "NONE";
    if (p.layoutWrap !== undefined) n.layoutWrap = p.layoutWrap;
    return { id: n.id, name: n.name, layoutMode: n.layoutMode };
  },
  async set_padding(p = {}) {
    const n = await byId(p.nodeId);
    if (!("paddingTop" in n)) throw new Error(`Node does not support padding: ${p.nodeId}`);
    if (p.paddingTop !== undefined) n.paddingTop = p.paddingTop;
    if (p.paddingRight !== undefined) n.paddingRight = p.paddingRight;
    if (p.paddingBottom !== undefined) n.paddingBottom = p.paddingBottom;
    if (p.paddingLeft !== undefined) n.paddingLeft = p.paddingLeft;
    return { id: n.id, name: n.name };
  },
  async set_item_spacing(p = {}) {
    const n = await byId(p.nodeId);
    if (!("itemSpacing" in n)) throw new Error(`Node does not support item spacing: ${p.nodeId}`);
    n.itemSpacing = p.itemSpacing ?? 0;
    return { id: n.id, name: n.name, itemSpacing: n.itemSpacing };
  },
  async set_axis_align(p = {}) {
    const n = await byId(p.nodeId);
    if (p.primaryAxisAlignItems !== undefined) n.primaryAxisAlignItems = p.primaryAxisAlignItems;
    if (p.counterAxisAlignItems !== undefined) n.counterAxisAlignItems = p.counterAxisAlignItems;
    return { id: n.id, name: n.name };
  },
  async set_layout_sizing(p = {}) {
    const n = await byId(p.nodeId);
    if (p.layoutSizingHorizontal !== undefined) n.layoutSizingHorizontal = p.layoutSizingHorizontal;
    if (p.layoutSizingVertical !== undefined) n.layoutSizingVertical = p.layoutSizingVertical;
    return { id: n.id, name: n.name };
  },
};

async function exec(command, params) {
  const h = handlers[command];
  if (!h) throw new Error(`Unknown command: ${command}`);
  return h(params || {});
}

// ── plugin ↔ UI wiring ───────────────────────────────────────────────────────
figma.showUI(__html__, { width: 340, height: 360 });

figma.ui.onmessage = async (msg) => {
  if (msg.type === "execute-command") {
    try {
      const result = await exec(msg.command, msg.params);
      figma.ui.postMessage({ type: "command-result", id: msg.id, result });
      figma.notify("✅ " + msg.command);
    } catch (e) {
      const error = String((e && e.message) || e);
      figma.ui.postMessage({ type: "command-error", id: msg.id, error });
      figma.notify("⚠️ " + error);
    }
  } else if (msg.type === "close") {
    figma.closePlugin();
  }
};
