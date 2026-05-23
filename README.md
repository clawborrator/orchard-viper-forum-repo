# orchard-viper-forum

Playbook + Playwright wrapper for the `@MRIIOT/orchard-viper-forum`
specialist agent. The agent runs inside
`ladder99/clawborrator-worker-playwright` and answers Viper questions
by searching the Viper Club of America forum
(https://www.viperclub.org/vca/) and citing the threads it reads.

Companion: the `orchard-viper-forum-worker` repo, which holds the
`docker-compose.yml` that pulls this repo at container start.

## What it does

- One Claude Code session, long-lived, no cron.
- Receives inbound dispatches via `route_to_peer` from
  `@MRIIOT/orchard-conductor` or direct asks from the live-view page.
- Searches the forum, reads threads, composes answers with citations.
- READ-ONLY. Never posts, replies, votes, or PMs.

See [CLAUDE.md](./CLAUDE.md) for the full agent playbook.

## Capturing the forum cookies

1. Log into https://www.viperclub.org/vca/ with the dedicated
   VCA account (not your personal account).
2. Install the [Cookie-Editor](https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm)
   browser extension.
3. With the forum tab focused, open Cookie-Editor and click
   **Export → Export as JSON**. The clipboard will hold an array of
   cookie objects in Playwright's `addCookies()` shape.
4. Save to `secrets/viperclub.cookies.json` in the worker repo (NOT
   in this repo).

The cookies file is mounted read-only into the container. The wrapper
reads it on every invocation; there is no in-process refresh, so when
the session cookie expires (XenForo's default is ~365 days for
"remember me" cookies but session cookies are shorter — assume you'll
need to re-export every few months), capture and remount.

## Local development

```sh
npm install
# Place cookies at /tmp/viperclub.cookies.json (or anywhere) and point
# the wrapper at it.
export VIPER_COOKIES_PATH=/tmp/viperclub.cookies.json
node specialists/viperclub.js auth-check
node specialists/viperclub.js search "harmonic balancer ZB1"
node specialists/viperclub.js read-thread "https://www.viperclub.org/vca/showthread.php?t=12345"
```

Environment variables:

| Var                  | Default                                                              |
|----------------------|----------------------------------------------------------------------|
| `VIPER_COOKIES_PATH` | `/secrets/viperclub.cookies.json`                                    |
| `VIPER_BASE_URL`     | `https://www.viperclub.org/vca`                                      |
| `VIPER_DELAY_MS`     | `1500`                                                               |
| `VIPER_USER_AGENT`   | `clawborrator-orchard-viper-forum/0.1 (+https://next.clawborrator.com)` |

## Selector verification

The selectors in `specialists/viperclub.js` are XenForo defaults
verified against viperclub.org/vca on 2026-05-23 with a logged-in
session. The `SELECTORS LAST VERIFIED` line at the top of `SELECTORS`
tracks the date. If a XenForo skin update breaks one of them, the
wrapper exits non-zero with the missing-selector hint in stderr; patch
the selector, push, and the next container restart picks up the fix
(the agent clones this repo at boot).

## Repository pairing

This repo holds the AGENT CODE (CLAUDE.md + specialists/). The
deployment shape (docker-compose, secrets handling, cookies mount)
lives in the sibling repo `orchard-viper-forum-worker`. The split
mirrors `worker_v1-example-reddit-engager-repo` and
`worker_v1-example-reddit-engager-worker`.

## Why no MCP server

The forum-interaction code lives inside the agent's repo because:

- The agent's terminal SHOWS the work happening (live-view appeal —
  visitors watch it search, parse JSON, pick threads, cite).
- The agent can adapt to forum quirks at conversation time (e.g.
  notice a thread is locked, jump to a quoted reply).
- One repo, no extra package to maintain.
- Trade-off: each query is slower and burns more tokens than an
  abstracted MCP tool. Acceptable for a deep-research specialist.

## License

MIT.
