# ZHG Hub Worker

Cloudflare Worker behind https://zhg-hub-worker.zerohourgroup.workers.dev

The Zero Hour Group's internal media hub: asset storage (R2 + D1 + Vectorize) and the
notes posting pipeline (drafting queue, review/posting UI, X API posting, Substack
browser bookmarklet).

## Pages

- `/` - Data Hub upload UI
- `/review.html` - ZHG Notes: draft queue, editing, AI rewrite, posting

## Deploys

Every push to `main` deploys automatically via GitHub Actions
(`.github/workflows/deploy.yml`). Requires the `CLOUDFLARE_API_TOKEN` repository
secret (Cloudflare token with the Edit Cloudflare Workers template).

Manual deploy: `npx wrangler deploy` or double-click `deploy.cmd`.

## Notes pipeline

Tools exposed over `/mcp` (MCP protocol + legacy `{tool, params}` shape):
queue_note, get_queue, update_note, post_note, rewrite_note, mark_posted,
delete_note, set_queue_paused, plus the original asset tools.

Posting to X uses the official API (OAuth 1.0a, pay-per-use). Substack blocks
server-originated requests, so Substack halves post through a logged-in browser
via the bookmarklet at the bottom of the Notes page.

<!-- pipeline: 2026-07-14T18:44:03Z -->
