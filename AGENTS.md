# AGENTS.md — figma-api setup for AI agents

Read this before using `figma-api`. It tells you exactly what to set up.

## TL;DR decision

- Need to **read** designs, or **write** comments / dev-resources / webhooks?
  → REST is enough. Just set a token (step 1). Works headless / in CI.
- Need to **create canvas nodes** (frames, text, shapes) or **edit variables**
  off-Enterprise? → REST can't. Use the **plugin bridge** (step 2). Requires the
  Figma desktop app open.

## 1. Auth (always required)

```bash
figma-api auth <token>          # saved to ~/.config/figma-api/credentials.json
# or, no save:
FIGMA_TOKEN=<token> figma-api me
```

- Token = Figma Personal Access Token (`figd_…`), from https://www.figma.com/settings → Personal access tokens.
- Scopes: reads need `file_content:read`. Writes need the matching scope
  (`file_comments:write`, `file_dev_resources:write`, `webhooks:write`).
  `file_variables:*` is **Enterprise-only** → REST `variables-modify` returns 403
  on non-Enterprise; use the bridge instead.
- Verify: `figma-api me` should print your user JSON. If you have a stored token
  in a secret vault, fetch it from there rather than asking the user.
- File commands accept a raw file key **or** a Figma URL; `node-id` is parsed from
  the URL automatically.

## 2. Plugin bridge (only for canvas writes / variables off-Enterprise)

The Figma REST API has **no endpoint** to create canvas nodes. The Figma Plugin
API does. The bridge lets the CLI drive a companion plugin:

```
figma-api run '<code>'  ──POST──▶  relay  ◀──poll──  Figma plugin  → runs on canvas
```

Setup (do all three, in order):

1. **Start the relay** (keep it running, background it):
   ```bash
   figma-api bridge          # listens on http://localhost:8917
   ```
2. **Load the plugin** — this is a human step, you cannot automate it:
   In the **Figma desktop app** (browser can't import dev plugins):
   Plugins → Development → Import plugin from manifest → pick this package's
   `plugin/manifest.json`. Run it, paste the relay URL, click **Connect**.
3. **Drive it**:
   ```bash
   figma-api ping            # round-trip check; prints page + selection
   figma-api run 'const t=figma.createText(); await figma.loadFontAsync({family:"Inter",style:"Regular"}); t.characters="Hi"; figma.currentPage.appendChild(t); return t'
   figma-api run @script.js  # or load code from a file
   ```

`run` executes arbitrary Plugin API code (`figma` in scope, `await` + `return`
supported; returned nodes come back as `{id,type,name}`). It subsumes any
draw/create helper — prefer it over inventing new commands.

Cross-machine (CLI and Figma on different hosts): expose the relay publicly with
`cloudflared tunnel --url http://localhost:8917` and paste that https URL into
the plugin instead of localhost.

## Gotchas an agent will hit

- **REST `variables-modify` → 403** on non-Enterprise tokens. Don't retry; switch
  to `figma-api run` with `figma.variables.*`.
- **"create a frame/text/shape via REST"** is impossible — there is no endpoint.
  Use the bridge.
- **Browser-only Figma can't load the dev plugin.** Needs the desktop app, or a
  published plugin. If the user is browser-only and refuses desktop, canvas
  writes are not available — say so plainly.
- **`figma-api run` / the relay have no auth** and execute arbitrary code in the
  user's document. Only run on a trusted machine; don't expose the tunnel URL
  publicly; don't run untrusted code.
- The bridge handles **one command at a time, one connected plugin**. Don't fan
  out parallel `run` calls.
- The CLI exits non-zero on plugin error/timeout — check exit codes.

## Quick reference

`figma-api --help` lists every command; `figma-api <cmd> --help` has params,
scopes and examples. Read = me/file/nodes/images/comments/components/styles/
variables-*/dev-resources/webhooks/… Write (REST) = comment-add/reaction-add/
variables-modify/dev-resource-*/webhook-*. Canvas write = bridge + run.
