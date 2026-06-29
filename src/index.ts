#!/usr/bin/env bun
import { program } from "commander";
import { readFileSync } from "fs";
import {
  saveCredentials, loadCredentials,
  get, post, put, del, output, parseFigmaTarget, readJsonArg,
} from "./api";
import { startBridge, runCommand, DEFAULT_PORT, DEFAULT_CHANNEL } from "./bridge";

const DEFAULT_RELAY = process.env.FIGMA_RELAY || `ws://localhost:${DEFAULT_PORT}`;
const DEFAULT_CH = process.env.FIGMA_CHANNEL || DEFAULT_CHANNEL;

/** Parse "r,g,b[,a]" (0–255 or 0–1) or "#rgb[a]" / "#rrggbb[aa]" into Figma's 0–1 {r,g,b,a}. */
function parseColor(s: string): { r: number; g: number; b: number; a: number } {
  if (s.startsWith("#")) {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join(""); // #rgb → #rrggbb
    if ((h.length !== 6 && h.length !== 8) || /[^0-9a-fA-F]/.test(h)) {
      console.error(`Invalid hex color: ${s}`); process.exit(1);
    }
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
  }
  const p = s.split(",").map(Number);
  const bad = (p.length !== 3 && p.length !== 4) || p.some((v) => !Number.isFinite(v) || v < 0);
  const rgb255 = p.slice(0, 3).some((v) => v > 1);
  if (bad || p.slice(0, 3).some((v) => v > (rgb255 ? 255 : 1)) || (p[3] !== undefined && p[3] > 1)) {
    console.error(`Invalid color: ${s} (use r,g,b[,a] as 0–1 or 0–255 RGB, alpha 0–1; or #hex)`);
    process.exit(1);
  }
  const d = rgb255 ? 255 : 1;
  return { r: p[0] / d, g: p[1] / d, b: p[2] / d, a: p[3] ?? 1 };
}

/** Common flags for every canvas command + a thin sender. */
function canvas(name: string) {
  return program
    .command(name)
    .option("--relay <url>", "relay WebSocket URL", DEFAULT_RELAY)
    .option("--channel <name>", "relay channel", DEFAULT_CH);
}
const drive = (o: any, command: string, params: Record<string, unknown> = {}) =>
  runCommand(o.relay, o.channel, command, params);
/** Number(v) when the option is present (incl. "0"), else undefined. */
const num = (v: unknown) => (v === undefined ? undefined : Number(v));

program
  .name("figma-api")
  .description(
    "Figma REST API CLI — raw read+write wrapper for files, nodes, images, comments,\n" +
    "components, styles, variables, dev resources, webhooks, projects and analytics.\n" +
    "Auth: figma-api auth <personal-access-token>   (or FIGMA_TOKEN env var)\n" +
    "Token: create at https://www.figma.com/settings → Personal access tokens\n" +
    "Most commands accept a file URL or a raw file key. node-id is read from the URL too.\n\n" +
    "NOTE: Creating canvas layers (frames/shapes/text) is NOT in the REST API — those\n" +
    "go through the plugin bridge (create-frame, create-text, set-fill-color, …). It\n" +
    "speaks the cursor-talk-to-figma WebSocket protocol, so any client in that\n" +
    "ecosystem is interchangeable. REST-writable here: comments, reactions, variables,\n" +
    "dev resources and webhooks (token needs the matching write scopes)."
  )
  .version("1.0.0")
  .addHelpText("after", `
Examples:
  figma-api auth figd_xxx
  figma-api me
  figma-api file https://www.figma.com/design/AbC123/My-File
  figma-api nodes AbC123 --ids 1:2,3:4
  figma-api images AbC123 --ids 1:2 --format svg --scale 2
  figma-api comments AbC123
  figma-api comment-add AbC123 "Looks great!" --x 100 --y 200 --node 1:2
  figma-api variables-local AbC123
  figma-api webhook-create FILE_UPDATE https://my.app/hook --context file --context-id AbC123

Run 'figma-api <command> --help' for per-command details, parameters and examples.`);

// ── auth ───────────────────────────────────────────────────────────────────
program
  .command("auth [token]")
  .description("Save a personal access token, or show auth status")
  .addHelpText("after", `
Get a token:
  1. Open https://www.figma.com/settings
  2. Scroll to "Personal access tokens" → Generate new token
  3. Pick scopes: file_content:read is enough for reads. For writes also add
     file_comments:write, file_variables:write, file_dev_resources:write,
     webhooks:write (some scopes need a paid/Enterprise plan).

Examples:
  figma-api auth                 # show current status + instructions
  figma-api auth figd_abc123     # save token to ~/.config/figma-api/credentials.json

You can also skip saving and pass the token via env:
  FIGMA_TOKEN=figd_abc123 figma-api me`)
  .action((token?: string) => {
    if (token) {
      saveCredentials({ token });
      console.log("✅ Token saved to ~/.config/figma-api/credentials.json");
      return;
    }
    console.log("Figma REST API — Personal Access Token auth\n");
    console.log("How to get a token:");
    console.log("  1. https://www.figma.com/settings → Personal access tokens");
    console.log("  2. Generate, choose scopes (reads: file_content:read; writes need more)");
    console.log("  3. Save it:  figma-api auth <token>\n");
    const env = process.env.FIGMA_TOKEN || process.env.FIGMA_API_TOKEN;
    const creds = loadCredentials();
    if (env) console.log(`Current status:\n  ✅ FIGMA_TOKEN env set (${env.slice(0, 8)}...)`);
    else if (creds?.token) console.log(`Current status:\n  ✅ Saved token ${creds.token.slice(0, 8)}...`);
    else console.log("Current status:\n  ❌ No token saved and no FIGMA_TOKEN env var");
  });

// ── user ─────────────────────────────────────────────────────────────────────
program
  .command("me")
  .description("Get the authenticated user (whoami)")
  .addHelpText("after", `\nExample:\n  figma-api me`)
  .action(async () => output(await get("/v1/me")));

// ── files ─────────────────────────────────────────────────────────────────────
program
  .command("file <key-or-url>")
  .description("Get the full document JSON for a file")
  .option("--ids <ids>", "comma-separated node IDs to limit the returned tree (e.g. 1:2,3:4)")
  .option("--depth <n>", "how deep to traverse the document tree (1 = pages only)")
  .option("--version <id>", "a specific version ID (default: current)")
  .option("--geometry <mode>", "set to 'paths' to include vector geometry")
  .option("--branch-data", "include branch metadata")
  .addHelpText("after", `
Examples:
  figma-api file https://www.figma.com/design/AbC123/My-File
  figma-api file AbC123 --depth 2
  figma-api file AbC123 --ids 1:2,3:4 --geometry paths

Tip: pipe to jq, e.g.  figma-api file AbC123 --depth 1 | jq '.document.children[].name'`)
  .action(async (input: string, o: any) => {
    const { fileKey, nodeId } = parseFigmaTarget(input);
    const ids = o.ids ?? nodeId;
    await output(await get(`/v1/files/${fileKey}`, {
      ids, depth: o.depth, version: o.version, geometry: o.geometry,
      branch_data: o.branchData ? true : undefined,
    }));
  });

program
  .command("nodes <key-or-url>")
  .description("Get document JSON for specific nodes only (lighter than 'file')")
  .option("--ids <ids>", "comma-separated node IDs (required unless node-id is in the URL)")
  .option("--depth <n>", "traversal depth within each node")
  .option("--version <id>", "a specific version ID")
  .option("--geometry <mode>", "set to 'paths' to include vector geometry")
  .addHelpText("after", `
Examples:
  figma-api nodes AbC123 --ids 1:2,3:4
  figma-api nodes "https://www.figma.com/design/AbC123/x?node-id=1-2"   # ids from URL`)
  .action(async (input: string, o: any) => {
    const { fileKey, nodeId } = parseFigmaTarget(input);
    const ids = o.ids ?? nodeId;
    if (!ids) { console.error("Provide --ids or a URL containing node-id"); process.exit(1); }
    await output(await get(`/v1/files/${fileKey}/nodes`, {
      ids, depth: o.depth, version: o.version, geometry: o.geometry,
    }));
  });

program
  .command("file-meta <key-or-url>")
  .description("Get lightweight file metadata (name, last touched, editor type, thumbnail)")
  .addHelpText("after", `\nExample:\n  figma-api file-meta AbC123`)
  .action(async (input: string) => {
    const { fileKey } = parseFigmaTarget(input);
    await output(await get(`/v1/files/${fileKey}/meta`));
  });

program
  .command("versions <key-or-url>")
  .description("List the version history of a file")
  .addHelpText("after", `\nExample:\n  figma-api versions AbC123`)
  .action(async (input: string) => {
    const { fileKey } = parseFigmaTarget(input);
    await output(await get(`/v1/files/${fileKey}/versions`));
  });

// ── images ────────────────────────────────────────────────────────────────────
program
  .command("images <key-or-url>")
  .description("Render nodes to images and return their URLs")
  .option("--ids <ids>", "comma-separated node IDs to render (or from URL node-id)")
  .option("--format <fmt>", "jpg | png | svg | pdf", "png")
  .option("--scale <n>", "scale factor 0.01–4 (raster only)")
  .option("--version <id>", "a specific version ID")
  .option("--svg-include-id", "include id attributes in SVG output")
  .option("--svg-include-node-id", "include node id attributes in SVG output")
  .option("--no-svg-outline-text", "keep SVG text as <text> instead of vector outlines")
  .option("--no-svg-simplify-stroke", "do not simplify inside/outside strokes in SVG")
  .option("--no-contents-only", "include content that overlaps the rendered node")
  .option("--use-absolute-bounds", "render full node dimensions ignoring clipping")
  .addHelpText("after", `
Returns a JSON map of node-id → rendered image URL (valid for a short time).
Examples:
  figma-api images AbC123 --ids 1:2 --format svg
  figma-api images AbC123 --ids 1:2,3:4 --format png --scale 2`)
  .action(async (input: string, o: any) => {
    const { fileKey, nodeId } = parseFigmaTarget(input);
    const ids = o.ids ?? nodeId;
    if (!ids) { console.error("Provide --ids or a URL containing node-id"); process.exit(1); }
    await output(await get(`/v1/images/${fileKey}`, {
      ids, format: o.format, scale: o.scale, version: o.version,
      svg_include_id: o.svgIncludeId ? true : undefined,
      svg_include_node_id: o.svgIncludeNodeId ? true : undefined,
      svg_outline_text: o.svgOutlineText === false ? false : undefined,
      svg_simplify_stroke: o.svgSimplifyStroke === false ? false : undefined,
      contents_only: o.contentsOnly === false ? false : undefined,
      use_absolute_bounds: o.useAbsoluteBounds ? true : undefined,
    }));
  });

program
  .command("image-fills <key-or-url>")
  .description("Get download URLs for all images placed as fills in a file")
  .addHelpText("after", `\nExample:\n  figma-api image-fills AbC123`)
  .action(async (input: string) => {
    const { fileKey } = parseFigmaTarget(input);
    await output(await get(`/v1/files/${fileKey}/images`));
  });

// ── comments (read + write) ────────────────────────────────────────────────────
program
  .command("comments <key-or-url>")
  .description("List comments in a file")
  .option("--as-md", "return comment bodies as Markdown")
  .addHelpText("after", `\nExample:\n  figma-api comments AbC123`)
  .action(async (input: string, o: any) => {
    const { fileKey } = parseFigmaTarget(input);
    await output(await get(`/v1/files/${fileKey}/comments`, { as_md: o.asMd ? true : undefined }));
  });

program
  .command("comment-add <key-or-url> <message>")
  .description("Add a comment to a file (write)")
  .option("--x <px>", "pin x coordinate on the canvas")
  .option("--y <px>", "pin y coordinate on the canvas")
  .option("--node <id>", "anchor the pin to a node id (with optional --x/--y offset)")
  .option("--reply-to <comment-id>", "reply to an existing comment instead of a new pin")
  .addHelpText("after", `
Pin placement: use --x/--y for an absolute canvas pin, optionally --node to anchor
to a node, or --reply-to to thread under an existing comment.
Examples:
  figma-api comment-add AbC123 "Tighten this spacing" --x 120 --y 240
  figma-api comment-add AbC123 "On this frame" --node 1:2
  figma-api comment-add AbC123 "Agreed" --reply-to 99887766`)
  .action(async (input: string, message: string, o: any) => {
    const { fileKey } = parseFigmaTarget(input);
    const body: Record<string, unknown> = { message };
    if (o.replyTo) body.comment_id = o.replyTo;
    else if (o.node) {
      body.client_meta = { node_id: o.node, node_offset: { x: Number(o.x ?? 0), y: Number(o.y ?? 0) } };
    } else if (o.x !== undefined || o.y !== undefined) {
      if (o.x === undefined || o.y === undefined) {
        console.error("A canvas pin needs both --x and --y (or use --node).");
        process.exit(1);
      }
      body.client_meta = { x: Number(o.x), y: Number(o.y) };
    }
    await output(await post(`/v1/files/${fileKey}/comments`, body));
  });

program
  .command("comment-delete <key-or-url> <comment-id>")
  .description("Delete a comment (write)")
  .addHelpText("after", `\nExample:\n  figma-api comment-delete AbC123 99887766`)
  .action(async (input: string, commentId: string) => {
    const { fileKey } = parseFigmaTarget(input);
    await output(await del(`/v1/files/${fileKey}/comments/${commentId}`));
  });

program
  .command("reactions <key-or-url> <comment-id>")
  .description("List reactions on a comment")
  .option("--cursor <c>", "pagination cursor")
  .addHelpText("after", `\nExample:\n  figma-api reactions AbC123 99887766`)
  .action(async (input: string, commentId: string, o: any) => {
    const { fileKey } = parseFigmaTarget(input);
    await output(await get(`/v1/files/${fileKey}/comments/${commentId}/reactions`, { cursor: o.cursor }));
  });

program
  .command("reaction-add <key-or-url> <comment-id> <emoji>")
  .description("Add an emoji reaction to a comment (write)")
  .addHelpText("after", `
Emoji must be a supported shortcode, e.g. :eyes:, :heart_eyes:, :+1:.
Example:
  figma-api reaction-add AbC123 99887766 :eyes:`)
  .action(async (input: string, commentId: string, emoji: string) => {
    const { fileKey } = parseFigmaTarget(input);
    await output(await post(`/v1/files/${fileKey}/comments/${commentId}/reactions`, { emoji }));
  });

program
  .command("reaction-delete <key-or-url> <comment-id> <emoji>")
  .description("Remove an emoji reaction from a comment (write)")
  .addHelpText("after", `\nExample:\n  figma-api reaction-delete AbC123 99887766 :eyes:`)
  .action(async (input: string, commentId: string, emoji: string) => {
    const { fileKey } = parseFigmaTarget(input);
    await output(await del(`/v1/files/${fileKey}/comments/${commentId}/reactions`, { emoji }));
  });

// ── projects ────────────────────────────────────────────────────────────────
program
  .command("projects <team-id>")
  .description("List projects in a team")
  .addHelpText("after", `
team-id is in the team URL: figma.com/files/team/<TEAM_ID>/...
Example:
  figma-api projects 1101234567890`)
  .action(async (teamId: string) => output(await get(`/v1/teams/${teamId}/projects`)));

program
  .command("project-files <project-id>")
  .description("List files in a project")
  .option("--branch-data", "include branch metadata for each file")
  .addHelpText("after", `\nExample:\n  figma-api project-files 55512345`)
  .action(async (projectId: string, o: any) =>
    output(await get(`/v1/projects/${projectId}/files`, { branch_data: o.branchData ? true : undefined })));

// ── components & styles ───────────────────────────────────────────────────────
program
  .command("components <key-or-url>")
  .description("List published components in a file")
  .addHelpText("after", `\nExample:\n  figma-api components AbC123`)
  .action(async (input: string) => {
    const { fileKey } = parseFigmaTarget(input);
    await output(await get(`/v1/files/${fileKey}/components`));
  });

program
  .command("team-components <team-id>")
  .description("List published components in a team library (paginated)")
  .option("--page-size <n>", "results per page")
  .option("--after <cursor>", "pagination cursor")
  .addHelpText("after", `\nExample:\n  figma-api team-components 1101234567890 --page-size 50`)
  .action(async (teamId: string, o: any) =>
    output(await get(`/v1/teams/${teamId}/components`, { page_size: o.pageSize, after: o.after })));

program
  .command("component <key>")
  .description("Get a single published component by its key")
  .addHelpText("after", `\nExample:\n  figma-api component 8f2c...`)
  .action(async (key: string) => output(await get(`/v1/components/${key}`)));

program
  .command("component-sets <key-or-url>")
  .description("List published component sets (variants) in a file")
  .addHelpText("after", `\nExample:\n  figma-api component-sets AbC123`)
  .action(async (input: string) => {
    const { fileKey } = parseFigmaTarget(input);
    await output(await get(`/v1/files/${fileKey}/component_sets`));
  });

program
  .command("team-component-sets <team-id>")
  .description("List published component sets in a team library (paginated)")
  .option("--page-size <n>", "results per page")
  .option("--after <cursor>", "pagination cursor")
  .addHelpText("after", `\nExample:\n  figma-api team-component-sets 1101234567890`)
  .action(async (teamId: string, o: any) =>
    output(await get(`/v1/teams/${teamId}/component_sets`, { page_size: o.pageSize, after: o.after })));

program
  .command("styles <key-or-url>")
  .description("List published styles in a file")
  .addHelpText("after", `\nExample:\n  figma-api styles AbC123`)
  .action(async (input: string) => {
    const { fileKey } = parseFigmaTarget(input);
    await output(await get(`/v1/files/${fileKey}/styles`));
  });

program
  .command("team-styles <team-id>")
  .description("List published styles in a team library (paginated)")
  .option("--page-size <n>", "results per page")
  .option("--after <cursor>", "pagination cursor")
  .addHelpText("after", `\nExample:\n  figma-api team-styles 1101234567890`)
  .action(async (teamId: string, o: any) =>
    output(await get(`/v1/teams/${teamId}/styles`, { page_size: o.pageSize, after: o.after })));

program
  .command("style <key>")
  .description("Get a single published style by its key")
  .addHelpText("after", `\nExample:\n  figma-api style 1a2b...`)
  .action(async (key: string) => output(await get(`/v1/styles/${key}`)));

// ── variables (read + write, Enterprise) ──────────────────────────────────────
program
  .command("variables-local <key-or-url>")
  .description("Get local variables and collections in a file (Enterprise)")
  .addHelpText("after", `
Requires file_variables:read scope and an Enterprise plan.
Example:
  figma-api variables-local AbC123`)
  .action(async (input: string) => {
    const { fileKey } = parseFigmaTarget(input);
    await output(await get(`/v1/files/${fileKey}/variables/local`));
  });

program
  .command("variables-published <key-or-url>")
  .description("Get published variables from a library file (Enterprise)")
  .addHelpText("after", `\nExample:\n  figma-api variables-published AbC123`)
  .action(async (input: string) => {
    const { fileKey } = parseFigmaTarget(input);
    await output(await get(`/v1/files/${fileKey}/variables/published`));
  });

program
  .command("variables-modify <key-or-url> <json>")
  .description("Create / update / delete variables and collections in bulk (write, Enterprise)")
  .addHelpText("after", `
Requires file_variables:write scope + Enterprise. <json> is a payload object (or
@file.json) with any of: variableCollections, variableModes, variables,
variableModeValues. Each entry has an "action" of CREATE | UPDATE | DELETE.

Example (inline):
  figma-api variables-modify AbC123 '{"variableCollections":[{"action":"CREATE","name":"Tokens"}]}'
Example (from file):
  figma-api variables-modify AbC123 @payload.json

Docs: https://www.figma.com/developers/api#post-variables-endpoint`)
  .action(async (input: string, json: string) => {
    const { fileKey } = parseFigmaTarget(input);
    await output(await post(`/v1/files/${fileKey}/variables`, readJsonArg(json)));
  });

// ── dev resources (read + write) ──────────────────────────────────────────────
program
  .command("dev-resources <key-or-url>")
  .description("List dev resources (links) attached to nodes in a file")
  .option("--node-ids <ids>", "comma-separated node IDs to filter by")
  .addHelpText("after", `\nExample:\n  figma-api dev-resources AbC123 --node-ids 1:2,3:4`)
  .action(async (input: string, o: any) => {
    const { fileKey } = parseFigmaTarget(input);
    await output(await get(`/v1/files/${fileKey}/dev_resources`, { node_ids: o.nodeIds }));
  });

program
  .command("dev-resource-add <key-or-url> <name> <url>")
  .description("Attach a dev resource link to a node (write)")
  .requiredOption("--node <id>", "node id to attach the link to")
  .addHelpText("after", `
Example:
  figma-api dev-resource-add AbC123 "PR #42" https://github.com/org/repo/pull/42 --node 1:2

Bulk: use 'dev-resources-bulk-add' with a JSON array for multiple at once.`)
  .action(async (input: string, name: string, url: string, o: any) => {
    const { fileKey } = parseFigmaTarget(input);
    const body = { dev_resources: [{ name, url, file_key: fileKey, node_id: o.node }] };
    await output(await post(`/v1/dev_resources`, body));
  });

program
  .command("dev-resources-bulk-add <json>")
  .description("Create multiple dev resources from a JSON array (write)")
  .addHelpText("after", `
<json> (or @file.json) is an array of { name, url, file_key, node_id }.
Example:
  figma-api dev-resources-bulk-add '[{"name":"Docs","url":"https://x","file_key":"AbC123","node_id":"1:2"}]'`)
  .action(async (json: string) => {
    const arr = readJsonArg(json);
    await output(await post(`/v1/dev_resources`, { dev_resources: arr }));
  });

program
  .command("dev-resources-update <json>")
  .description("Update existing dev resources by id from a JSON array (write)")
  .addHelpText("after", `
<json> (or @file.json) is an array of { id, name?, url? }.
Example:
  figma-api dev-resources-update '[{"id":"abc","name":"Renamed"}]'`)
  .action(async (json: string) => {
    const arr = readJsonArg(json);
    await output(await put(`/v1/dev_resources`, { dev_resources: arr }));
  });

program
  .command("dev-resource-delete <key-or-url> <dev-resource-id>")
  .description("Delete a dev resource from a file (write)")
  .addHelpText("after", `\nExample:\n  figma-api dev-resource-delete AbC123 abc-id`)
  .action(async (input: string, id: string) => {
    const { fileKey } = parseFigmaTarget(input);
    await output(await del(`/v1/files/${fileKey}/dev_resources/${id}`));
  });

// ── webhooks v2 (read + write) ─────────────────────────────────────────────────
program
  .command("webhooks")
  .description("List webhooks (by context or for the whole plan)")
  .option("--context <type>", "team | project | file")
  .option("--context-id <id>", "id matching the context type")
  .option("--plan-api-id <id>", "list all webhooks for a plan")
  .option("--cursor <c>", "pagination cursor")
  .addHelpText("after", `
Examples:
  figma-api webhooks --context file --context-id AbC123
  figma-api webhooks --context team --context-id 1101234567890`)
  .action(async (o: any) =>
    output(await get(`/v2/webhooks`, { context: o.context, context_id: o.contextId, plan_api_id: o.planApiId, cursor: o.cursor })));

program
  .command("webhook <webhook-id>")
  .description("Get a single webhook by id")
  .addHelpText("after", `\nExample:\n  figma-api webhook 1234567`)
  .action(async (id: string) => output(await get(`/v2/webhooks/${id}`)));

program
  .command("webhook-create <event> <endpoint>")
  .description("Create a webhook (write)")
  .requiredOption("--context <type>", "team | project | file")
  .requiredOption("--context-id <id>", "id matching the context type")
  .requiredOption("--passcode <code>", "passcode echoed back in each request for verification")
  .option("--status <status>", "ACTIVE | PAUSED", "ACTIVE")
  .option("--description <text>", "human description of the webhook")
  .addHelpText("after", `
event: PING | FILE_UPDATE | FILE_VERSION_UPDATE | FILE_DELETE | LIBRARY_PUBLISH
       | FILE_COMMENT | DEV_MODE_STATUS_UPDATE
Requires webhooks:write scope. Figma sends a PING to the endpoint on creation.
Example:
  figma-api webhook-create FILE_UPDATE https://my.app/hook --context file --context-id AbC123 --passcode s3cret`)
  .action(async (event: string, endpoint: string, o: any) => {
    const body: Record<string, unknown> = {
      event_type: event, endpoint, context: o.context, context_id: o.contextId,
      passcode: o.passcode, status: o.status,
    };
    if (o.description) body.description = o.description;
    await output(await post(`/v2/webhooks`, body));
  });

program
  .command("webhook-update <webhook-id>")
  .description("Update a webhook's event, endpoint, status, passcode or description (write)")
  .option("--event <event>", "new event type")
  .option("--endpoint <url>", "new endpoint URL")
  .option("--passcode <code>", "new passcode")
  .option("--status <status>", "ACTIVE | PAUSED")
  .option("--description <text>", "new description")
  .addHelpText("after", `\nExample:\n  figma-api webhook-update 1234567 --status PAUSED`)
  .action(async (id: string, o: any) => {
    const body: Record<string, unknown> = {};
    if (o.event) body.event_type = o.event;
    if (o.endpoint) body.endpoint = o.endpoint;
    if (o.passcode) body.passcode = o.passcode;
    if (o.status) body.status = o.status;
    if (o.description) body.description = o.description;
    await output(await put(`/v2/webhooks/${id}`, body));
  });

program
  .command("webhook-delete <webhook-id>")
  .description("Delete a webhook (write)")
  .addHelpText("after", `\nExample:\n  figma-api webhook-delete 1234567`)
  .action(async (id: string) => output(await del(`/v2/webhooks/${id}`)));

program
  .command("webhook-requests <webhook-id>")
  .description("Get recent delivery attempts (requests + responses) for a webhook")
  .addHelpText("after", `\nExample:\n  figma-api webhook-requests 1234567`)
  .action(async (id: string) => output(await get(`/v2/webhooks/${id}/requests`)));

// ── library analytics (Enterprise) ─────────────────────────────────────────────
program
  .command("analytics <key-or-url> <asset> <kind>")
  .description("Library analytics: asset=component|style|variable, kind=actions|usages (Enterprise)")
  .requiredOption("--group-by <field>", "actions: component|style|variable | team ; usages: component|style|variable | file")
  .option("--start-date <YYYY-MM-DD>", "range start (actions only)")
  .option("--end-date <YYYY-MM-DD>", "range end (actions only)")
  .option("--order <dir>", "asc | desc")
  .option("--cursor <c>", "pagination cursor")
  .addHelpText("after", `
Requires library_analytics:read + Enterprise.
Examples:
  figma-api analytics AbC123 component usages --group-by file
  figma-api analytics AbC123 style actions --group-by team --start-date 2024-01-01 --end-date 2024-02-01`)
  .action(async (input: string, asset: string, kind: string, o: any) => {
    const { fileKey } = parseFigmaTarget(input);
    if (!["component", "style", "variable"].includes(asset)) { console.error("asset must be component|style|variable"); process.exit(1); }
    if (!["actions", "usages"].includes(kind)) { console.error("kind must be actions|usages"); process.exit(1); }
    await output(await get(`/v1/analytics/libraries/${fileKey}/${asset}/${kind}`, {
      group_by: o.groupBy, start_date: o.startDate, end_date: o.endDate, order: o.order, cursor: o.cursor,
    }));
  });

// ── activity / payments / oembed ────────────────────────────────────────────────
program
  .command("activity-logs")
  .description("Get activity logs for an organization (Enterprise, org token)")
  .option("--events <list>", "comma-separated event types to filter")
  .option("--start-time <unix>", "range start (epoch seconds)")
  .option("--end-time <unix>", "range end (epoch seconds)")
  .option("--limit <n>", "max events")
  .option("--order <dir>", "asc | desc")
  .addHelpText("after", `\nExample:\n  figma-api activity-logs --limit 100 --order desc`)
  .action(async (o: any) => output(await get(`/v1/activity_logs`, {
    events: o.events, start_time: o.startTime, end_time: o.endTime, limit: o.limit, order: o.order,
  })));

program
  .command("payments")
  .description("Get payment information for a plugin/widget/community-file user")
  .option("--token <plugin_payment_token>", "plugin payment token (from plugin runtime; alternative to --user-id)")
  .option("--user-id <id>", "the Figma user id (use with one of --plugin-id/--widget-id/--community-file-id)")
  .option("--plugin-id <id>", "plugin resource id")
  .option("--widget-id <id>", "widget resource id")
  .option("--community-file-id <id>", "community file resource id")
  .addHelpText("after", `
Provide either --token, or --user-id together with one of --plugin-id / --widget-id
/ --community-file-id.
Examples:
  figma-api payments --token <plugin_payment_token>
  figma-api payments --user-id 12345 --plugin-id 67890`)
  .action(async (o: any) => output(await get(`/v1/payments`, {
    plugin_payment_token: o.token, user_id: o.userId,
    plugin_id: o.pluginId, widget_id: o.widgetId, community_file_id: o.communityFileId,
  })));

program
  .command("oembed <url>")
  .description("Get oEmbed metadata for a public Figma file/prototype URL")
  .addHelpText("after", `\nExample:\n  figma-api oembed https://www.figma.com/design/AbC123/My-File`)
  .action(async (url: string) => output(await get(`/v1/oembed`, { url })));

// ── plugin bridge (canvas writes the REST API can't do) ───────────────────────
// The relay + plugin speak the cursor-talk-to-figma WebSocket protocol, so these
// commands are interchangeable with that ecosystem's MCP server / plugin.
program
  .command("bridge")
  .description("Start the WebSocket relay that lets the CLI drive the Figma plugin (canvas writes)")
  .option("--port <n>", "port to listen on", String(DEFAULT_PORT))
  .addHelpText("after", `
The Figma REST API cannot create canvas nodes (frames/text/shapes). This relay
bridges the CLI and the companion Figma plugin (see plugin/ folder), which can.
It speaks the cursor-talk-to-figma WebSocket protocol — compatible with that
ecosystem's MCP server / plugin.

Flow:
  1. figma-api bridge                       # start this relay (keep running)
  2. In Figma desktop: Plugins → Development → Import plugin from manifest →
     plugin/manifest.json, run it, set URL ws://localhost:${DEFAULT_PORT} + channel
     "${DEFAULT_CHANNEL}", click Connect.
  3. figma-api ping                         # verify; then create-frame / create-text / …

Cross-machine: expose the relay with 'cloudflared tunnel --url http://localhost:${DEFAULT_PORT}'
and paste the wss:// URL into the plugin.

⚠️  Security: the relay has no auth and 'run' executes arbitrary code in your
Figma document. Only run it on a trusted machine/network.`)
  .action((o: any) => startBridge(Number(o.port)));

canvas("ping")
  .description("Ping the connected plugin to verify the bridge round-trip")
  .addHelpText("after", `\nReturns the plugin's current page name and selection.\nExample:\n  figma-api ping`)
  .action((o: any) => drive(o, "ping"));

// ── canvas reads ──────────────────────────────────────────────────────────────
canvas("get-document-info")
  .description("Get the current page and its top-level children (via plugin)")
  .action((o: any) => drive(o, "get_document_info"));

canvas("get-selection")
  .description("Get the current selection on the canvas (via plugin)")
  .action((o: any) => drive(o, "get_selection"));

canvas("get-node-info <node-id>")
  .description("Get full info for one node (via plugin)")
  .action((id: string, o: any) => drive(o, "get_node_info", { nodeId: id }));

canvas("get-nodes-info <ids>")
  .description("Get full info for several nodes (comma-separated ids, via plugin)")
  .action((ids: string, o: any) => drive(o, "get_nodes_info", { nodeIds: ids.split(",") }));

canvas("get-styles")
  .description("List local paint/text/effect/grid styles (via plugin)")
  .action((o: any) => drive(o, "get_styles"));

canvas("get-components")
  .description("List local components in the document (via plugin)")
  .action((o: any) => drive(o, "get_local_components"));

canvas("export-image <node-id>")
  .description("Export a node as a base64 PNG (via plugin)")
  .option("--scale <n>", "scale factor", "1")
  .action((id: string, o: any) => drive(o, "export_node_as_image", { nodeId: id, scale: Number(o.scale) }));

// ── canvas creation ───────────────────────────────────────────────────────────
canvas("create-frame")
  .description("Create a frame on the canvas (via plugin)")
  .option("--x <n>", "x", "0").option("--y <n>", "y", "0")
  .option("--width <n>", "width", "100").option("--height <n>", "height", "100")
  .option("--name <name>", "layer name")
  .option("--parent <id>", "parent node id (defaults to current page)")
  .option("--fill <color>", "fill color: r,g,b[,a] or #hex")
  .option("--stroke <color>", "stroke color: r,g,b[,a] or #hex")
  .option("--stroke-weight <n>", "stroke weight")
  .option("--layout <mode>", "auto layout: NONE | HORIZONTAL | VERTICAL")
  .option("--item-spacing <n>", "item spacing (auto layout)")
  .addHelpText("after", `\nExample:\n  figma-api create-frame --width 320 --height 200 --fill "#1F6FEB" --name Card`)
  .action((o: any) => drive(o, "create_frame", {
    x: Number(o.x), y: Number(o.y), width: Number(o.width), height: Number(o.height),
    name: o.name, parentId: o.parent,
    fillColor: o.fill ? parseColor(o.fill) : undefined,
    strokeColor: o.stroke ? parseColor(o.stroke) : undefined,
    strokeWeight: num(o.strokeWeight),
    layoutMode: o.layout, itemSpacing: num(o.itemSpacing),
  }));

canvas("create-rectangle")
  .description("Create a rectangle on the canvas (via plugin)")
  .option("--x <n>", "x", "0").option("--y <n>", "y", "0")
  .option("--width <n>", "width", "100").option("--height <n>", "height", "100")
  .option("--name <name>", "layer name").option("--parent <id>", "parent node id")
  .addHelpText("after", `\nExample:\n  figma-api create-rectangle --width 80 --height 80 --name Box`)
  .action((o: any) => drive(o, "create_rectangle", {
    x: Number(o.x), y: Number(o.y), width: Number(o.width), height: Number(o.height), name: o.name, parentId: o.parent,
  }));

canvas("create-text <text>")
  .description("Create a text node on the canvas (via plugin)")
  .option("--x <n>", "x", "0").option("--y <n>", "y", "0")
  .option("--size <n>", "font size", "14").option("--weight <n>", "font weight (100–900)", "400")
  .option("--color <color>", "font color: r,g,b[,a] or #hex")
  .option("--name <name>", "layer name").option("--parent <id>", "parent node id")
  .addHelpText("after", `\nExample:\n  figma-api create-text "Hello" --size 24 --weight 700 --color "#111"`)
  .action((text: string, o: any) => drive(o, "create_text", {
    text, x: Number(o.x), y: Number(o.y), fontSize: Number(o.size), fontWeight: Number(o.weight),
    fontColor: o.color ? parseColor(o.color) : undefined, name: o.name, parentId: o.parent,
  }));

canvas("create-instance <component-key>")
  .description("Create an instance of a published component (via plugin)")
  .option("--x <n>", "x", "0").option("--y <n>", "y", "0").option("--parent <id>", "parent node id")
  .action((key: string, o: any) => drive(o, "create_component_instance", { componentKey: key, x: Number(o.x), y: Number(o.y), parentId: o.parent }));

// ── canvas edits ──────────────────────────────────────────────────────────────
canvas("set-fill-color <node-id> <color>")
  .description("Set a node's solid fill (color: r,g,b[,a] or #hex, via plugin)")
  .action((id: string, color: string, o: any) => drive(o, "set_fill_color", { nodeId: id, color: parseColor(color) }));

canvas("set-stroke-color <node-id> <color>")
  .description("Set a node's solid stroke (via plugin)")
  .option("--weight <n>", "stroke weight", "1")
  .action((id: string, color: string, o: any) => drive(o, "set_stroke_color", { nodeId: id, color: parseColor(color), weight: Number(o.weight) }));

canvas("set-corner-radius <node-id> <radius>")
  .description("Set a node's corner radius (via plugin)")
  .action((id: string, radius: string, o: any) => drive(o, "set_corner_radius", { nodeId: id, radius: Number(radius) }));

canvas("set-text <node-id> <text>")
  .description("Replace a text node's content (via plugin)")
  .action((id: string, text: string, o: any) => drive(o, "set_text_content", { nodeId: id, text }));

canvas("move-node <node-id> <x> <y>")
  .description("Move a node to (x, y) (via plugin)")
  .action((id: string, x: string, y: string, o: any) => drive(o, "move_node", { nodeId: id, x: Number(x), y: Number(y) }));

canvas("resize-node <node-id> <width> <height>")
  .description("Resize a node (via plugin)")
  .action((id: string, w: string, h: string, o: any) => drive(o, "resize_node", { nodeId: id, width: Number(w), height: Number(h) }));

canvas("clone-node <node-id>")
  .description("Clone a node (via plugin)")
  .option("--x <n>", "x of the clone").option("--y <n>", "y of the clone").option("--parent <id>", "parent node id")
  .action((id: string, o: any) => drive(o, "clone_node", { nodeId: id, x: num(o.x), y: num(o.y), parentId: o.parent }));

canvas("delete-node <node-id>")
  .description("Delete a node (via plugin)")
  .action((id: string, o: any) => drive(o, "delete_node", { nodeId: id }));

canvas("delete-nodes <ids>")
  .description("Delete several nodes (comma-separated ids, via plugin)")
  .action((ids: string, o: any) => drive(o, "delete_multiple_nodes", { nodeIds: ids.split(",") }));

canvas("set-layout <node-id> <mode>")
  .description("Set auto layout mode: NONE | HORIZONTAL | VERTICAL (via plugin)")
  .action((id: string, mode: string, o: any) => drive(o, "set_layout_mode", { nodeId: id, layoutMode: mode }));

canvas("set-padding <node-id>")
  .description("Set auto-layout padding (via plugin)")
  .option("--top <n>").option("--right <n>").option("--bottom <n>").option("--left <n>")
  .action((id: string, o: any) => drive(o, "set_padding", {
    nodeId: id, paddingTop: num(o.top), paddingRight: num(o.right),
    paddingBottom: num(o.bottom), paddingLeft: num(o.left),
  }));

canvas("set-item-spacing <node-id> <spacing>")
  .description("Set auto-layout item spacing (via plugin)")
  .action((id: string, s: string, o: any) => drive(o, "set_item_spacing", { nodeId: id, itemSpacing: Number(s) }));

canvas("focus <node-id>")
  .description("Select a node and zoom the viewport to it (via plugin)")
  .action((id: string, o: any) => drive(o, "set_focus", { nodeId: id }));

canvas("select <ids>")
  .description("Set the selection (comma-separated ids) and zoom to it (via plugin)")
  .action((ids: string, o: any) => drive(o, "set_selections", { nodeIds: ids.split(",") }));

// ── escape hatch: arbitrary Plugin API code ──────────────────────────────────
canvas("run <code-or-@file>")
  .description("Run arbitrary Figma Plugin API code in the connected plugin (escape hatch)")
  .addHelpText("after", `
Whatever the Figma Plugin API can do, this can do. \`figma\` is in scope; you may
use await and \`return\` a value (nodes come back as {id,type,name}). Prefer the
named create-*/set-* commands; reach for 'run' only for things they don't cover.
Pass code inline or as @file.js.

⚠️  Executes arbitrary code in your Figma document — only run code you trust.

Examples:
  figma-api run 'return figma.currentPage.selection.map(n => n.name)'
  figma-api run @make-card.js`)
  .action((codeArg: string, o: any) => {
    const code = codeArg.startsWith("@") ? readFileSync(codeArg.slice(1), "utf-8") : codeArg;
    return drive(o, "eval", { code });
  });

program.parse();
