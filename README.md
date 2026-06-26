# figma-api

Figma CLI — a subcommand-per-endpoint wrapper of the official **Figma REST API**,
plus a **plugin bridge** for the canvas writes the REST API can't do.

```bash
figma-api auth figd_xxx                 # personal access token (or FIGMA_TOKEN env)
figma-api me
figma-api file https://figma.com/design/AbC123/My-File
figma-api comment-add AbC123 "looks great" --node 1:2
```

Inspired by the Figma MCP servers (read design context) but extended to the full
REST surface **and** to live canvas manipulation through a companion plugin.

## Install

```bash
npm i -g @todoforai/figma-api    # or: bun add -g @todoforai/figma-api
figma-api --help
```

## Auth

Personal Access Token, stored in `~/.config/figma-api/credentials.json`, or passed
via `FIGMA_TOKEN` (`FIGMA_API_TOKEN`) env. OAuth bearer tokens also work.

```bash
# https://www.figma.com/settings → Personal access tokens → Generate
figma-api auth figd_xxx
```

Scopes: reads need `file_content:read`; writes need the matching scope
(`file_comments:write`, `file_dev_resources:write`, `webhooks:write`,
`file_variables:*` is Enterprise-only).

## REST commands

Every file command takes a raw file key **or** a Figma URL (`node-id` is parsed
from the URL).

Read: `me`, `file`, `nodes`, `file-meta`, `versions`, `images`, `image-fills`,
`comments`, `reactions`, `projects`, `project-files`, `components`/`team-components`/
`component`, `component-sets`/`team-component-sets`, `styles`/`team-styles`/`style`,
`variables-local`/`variables-published`, `dev-resources`, `webhooks`/`webhook`/
`webhook-requests`, `analytics`, `activity-logs`, `payments`, `oembed`.

Write: `comment-add`/`comment-delete`, `reaction-add`/`reaction-delete`,
`variables-modify`, `dev-resource-add`/`dev-resources-bulk-add`/`dev-resources-update`/
`dev-resource-delete`, `webhook-create`/`webhook-update`/`webhook-delete`.

Run `figma-api <command> --help` for parameters, scopes and examples.

## Plugin bridge — canvas writes

The REST API **cannot create canvas nodes** (frames/text/shapes) or edit variables
off-Enterprise. The Figma **Plugin API** can. The bridge lets the CLI drive a small
companion plugin:

```
figma-api run '...'  ──POST──▶  relay (figma-api bridge)  ◀──poll──  Figma plugin
                                                          ──result─▶  (runs on canvas)
```

Setup:

1. `figma-api bridge` — start the relay (keep it running).
2. Figma **desktop** → Plugins → Development → **Import plugin from manifest** →
   `plugin/manifest.json`. Run it, paste the relay URL, click **Connect**.
3. Drive it from the CLI:

```bash
figma-api ping
figma-api run 'const t = figma.createText(); await figma.loadFontAsync({family:"Inter",style:"Regular"}); t.characters="Hi from the CLI"; figma.currentPage.appendChild(t); return t'
figma-api run @make-card.js
```

`run` executes arbitrary Figma Plugin API code (`figma` in scope, `await` and
`return` supported), so it subsumes any draw/create helper.

Cross-machine: `cloudflared tunnel --url http://localhost:8917` and paste that
https URL into the plugin.

> ⚠️ **Security:** the relay has no auth and `run` executes arbitrary code in your
> Figma document. Only use it on a trusted machine/network; don't expose the tunnel
> URL publicly or run code you don't trust.

> Note: development (unpublished) plugins can only be imported in the **Figma
> desktop app**, not the browser. Once published, the browser works too.

## Why both REST and a plugin?

| | REST API | Plugin bridge |
|---|----------|---------------|
| Files / nodes / images (read) | ✅ | ✅ |
| Comments, dev resources, webhooks | ✅ | — |
| Create frames / text / shapes | ❌ (no endpoint) | ✅ |
| Edit variables off-Enterprise | ❌ (403) | ✅ |
| Works headless / CI | ✅ | needs Figma open |

## Reference

- [figma/rest-api-spec](https://github.com/figma/rest-api-spec) — authoritative endpoint list.
- [GLips/Figma-Context-MCP](https://github.com/GLips/Figma-Context-MCP) — read design-context MCP.
- [Official Figma MCP](https://help.figma.com/hc/en-us/articles/32132100833559) — `mcp.figma.com`.
- The bridge mirrors the architecture of community plugin bridges (e.g.
  southleft/figma-console-mcp) but driven by a plain CLI instead of MCP.

## Dev

```bash
bun install
bun src/index.ts --help
```

## License

MIT
