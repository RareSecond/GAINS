# GAINS

A phone-first strength-training remote. Agree on concrete workouts in ChatGPT, save them through authenticated MCP tools, and record actual performance in the web app. Targets and measurements live in separate PostgreSQL rows. There is no workout generator, coaching chat, program engine, equipment inventory, or debrief gate.

Implementation branch: `feature/implement-gains`. Default initial repository branch: `main`. The original handoff remains in the primary workspace's `SPEC.md`.

## Stack

Node 24+, TanStack Start/React/TypeScript, Better Auth 1.7.7 with its matching MCP/CIMD/OAuth packages, official MCP SDK 2.3.0, Prisma 6.19.3, PostgreSQL. Prisma 6 uses `url` and `directUrl` in `schema.prisma`; no Prisma 7 configuration or serverless Neon driver is mixed into this build. Nitro's Node preset emits `.output/server/index.mjs`. Build on the VPS's OS/architecture so the generated Prisma engine matches it.

Dependencies and mutable caches are installed independently inside this task worktree. Do not link another checkout's `node_modules` or package cache.

## Development setup

1. Use a development Neon branch (or a local PostgreSQL database), a Google OAuth web client, and an app origin. Production and development must have distinct credentials/database destinations.
2. Copy `.env.example` to `.env` and fill in its values. Generate a secret with `openssl rand -base64 48`. Keep secrets out of source control.
3. Configure Google authorized JavaScript origin to `APP_ORIGIN` and the exact redirect URI to `APP_ORIGIN/api/auth/callback/google`. Better Auth links the provider's stable account ID; email is display metadata.
4. Install and migrate:

```sh
npm ci --cache .cache/npm
npm run db:generate
npm run db:migrate
npm run dev
```

Dev and build commands regenerate Prisma Client automatically so schema changes are included. Restart a running dev server after changing the Prisma schema, since its client is cached in memory.

Unexpected API/MCP errors log a request ID, operation context, error diagnostic and stack locations. The same ID is returned to the caller for log lookup. Request argument dumps, connection URLs and bearer tokens are omitted.

Vite reads `.env` in development. For CLI commands Prisma reads it as well. `APP_ORIGIN` has no path or trailing slash; `BETTER_AUTH_URL` is exactly `APP_ORIGIN/api/auth`. Development loopback HTTP is supported. Google sign-in requires real Google credentials; there is no production fixture/login bypass. A missing connection gives an error, not simulated results.

`DATABASE_URL` is the runtime Neon PostgreSQL connection, typically the pooled endpoint with TLS and an explicit appropriate `connection_limit`. `DIRECT_DATABASE_URL` is the migration connection. A standard VPS PostgreSQL connection works; the direct URL is an explicit operational choice. Prisma uses one client/pool per app process. Do not assume migrations are categorically prohibited on all Neon pooled URLs.

For new development migrations only: `npm run db:dev`. Committed releases use `npm run db:migrate` (`prisma migrate deploy`), never production resets or schema pushes.

## Recording behavior

Upcoming workouts are previews. Starting creates new execution IDs, freezes the prescription in the same transaction, and leaves every set pending with null actuals. The completion button shows the reps and load it will record. Exact targets use one completion button; rep ranges show a big completion button for every count in the range. Tap +/− under adjustments for counts outside the range or corrections. Extra sets without a target require choosing a count. A user explicitly confirms each set; zero reps records a failed attempt. Loads are decimal strings, stored as `Decimal(9,3)`, with kg/lb and explicit conventions. No mixed-unit/convention totals are calculated.

Each planned set may include `restSeconds` (0–3,600): null/omitted leaves rest unspecified, zero means no pause. Rest applies after that specific side-specific set; for supersets/circuits, specify the round pause on the last exercise/side. Previews and session targets show the duration. Completing a new set starts a skippable countdown when more work remains; it uses a locally retained deadline, continues offline and across reloads, and does not restart for corrections. The rest card dismisses automatically at zero. A short rest-complete beep is enabled by the completion tap, with a speaker icon toggle at the top right of the rest card. Reloading may require tapping the speaker icon again. Skipping rest cancels the beep; corrections and returning to the page do not repeat it. Browser audio may be suspended when switching apps or locking a phone, so this is not a reliable background alarm. Rest is a suggestion and never blocks recording.

Each planned set may include `platesPerSide`: up to 20 positive decimal strings in the set's load unit, heaviest first (e.g. `["20", "5", "1.25"]`). Plate loading is fully chat-driven: GAINS keeps no plate or bar inventory and does no arithmetic. ChatGPT chooses plates from what it knows the user owns, and the remote shows them beside the target load in previews and on the current set. An empty list means plates do not apply (fixed dumbbells, stack machines, bodyweight). Plates require a numeric load; the database enforces the bounds.

Groups suggest round-robin order but allow arbitrary navigation. Left/right results are independent; copying confirmed measurements is deliberate. Substitution moves pending work into a new execution exercise; performed sets keep their identity. Extra work can be added, and only extra uncompleted work can be removed. Completed sets can be corrected while active. Finish preserves pending versus skipped versus completed, permits early completion, and makes history read-only.

The database enforces one active session per account and one session per concrete workout. Repeat a workout by creating another concrete prescription in chat. Existing active sessions must be resumed or finished first.

## Offline and conflicts

Open/start a workout online first. An opened session, draft inputs, and an ordered mutation outbox are retained in user-scoped IndexedDB. Results are shown as retained only after the local write succeeds. Confirmed operations have stable UUIDs; newly added rows have stable UUIDs. Each acknowledgement advances the next expected revision. Receipt lookup precedes stale-revision rejection, including lost-response retries.

The service worker precaches only the empty `/offline` shell and built public assets. It does not cache auth, API, or MCP responses. Reloading an opened recording page offline works after the service worker installs. Offline finish stays pending until all preceding changes and Finish are acknowledged. Reconnect/focus triggers uploads; uploads are not promised while the app is closed.

GAINS is an installable PWA: `public/manifest.webmanifest` opens `/` standalone, with icons generated from the GAINS logo (separate maskable variants keep the artwork inside Android's safe zone). Launching the installed app offline opens the cached shell rather than a browser error. The dashboard still needs the network for its workout list, so open an active session online first.

Conflicts retain the local version, show the server comparison, and require either explicitly discarding local changes or reapplying compatible edits. A finished server session cannot be reopened. Retained changes can be exported before discarding. Browser storage failures are visible and block further recording instead of claiming offline safety.

Sign-out hides cached data and stops uploads. If drafts or queued edits exist, the user must deliberately choose to sign out while retaining them. The same authenticated account must return before uploading. Each sync verifies the server identity; another account cannot acquire or upload the old queue. Local data remains on that browser profile until site storage is cleared.

## ChatGPT MCP

Connect the HTTPS `APP_ORIGIN/mcp` URL using [OpenAI's custom MCP setup guide](https://developers.openai.com/api/docs/guides/custom-mcp-server). Sign in using the same Google account as the web remote and approve the verified requesting client and permissions. Supported custom MCP access depends on the user's ChatGPT account/workspace.

The endpoint uses SDK v2 Streamable HTTP, pinned to the stateless MCP `2026-07-28` profile. Better Auth/CIMD handles client metadata retrieval, exact registered redirects, signed OAuth context, authorization-code PKCE, refresh, and persistent signing keys. It uses the Node metadata transport's SSRF protections. No Google API token is used as an MCP bearer token.

For OpenAI tunnels, set `MCP_RESOURCE_URL` to the exact OAuth resource URL requested by your ChatGPT connection, then restart the app from this checkout. Keep `APP_ORIGIN` and `BETTER_AUTH_URL` on the app/auth origin. Access tokens last five minutes; the OAuth challenge requests `offline_access` so the provider issues a refresh token. Existing connections created without that scope need a new authorization grant. Test tunnel audiences with `MCP_RESOURCE_URL=https://tunnel.example/v1/mcp/test npm test` against the disposable test database.

Discovery URLs:

- `/.well-known/oauth-protected-resource` (also available with the configured resource pathname appended)
- `/.well-known/oauth-authorization-server/api/auth`
- `/api/auth/.well-known/oauth-authorization-server`
- `/api/auth/.well-known/openid-configuration`
- `/api/auth/jwks`

Scopes: `profile:read`, `workouts:read`, `workouts:write`, plus standard identity/refresh scopes. Every tool declares scopes and read/write annotations. `get_profile` returns one stable internal ID and the standard OpenAI profile schema/marker. No tool accepts an account selector. Session mutations are browser-only.

Tools: `get_profile`, `get_training_context`, `get_workout`, `list_exercises`, `ensure_exercise`, `get_exercise_history`, `get_session`, `create_workout`, `update_workout`, `delete_workout`.

Load values are nonnegative decimal strings, up to 6 integer/3 fractional digits; omitted load is unspecified. Side-specific target rows have positive consecutive set numbers. Bilateral rows use BOTH; every per-side set has LEFT and RIGHT. Straight/superset/circuit groups need 1/2/2+ exercises respectively. Runtime schemas enforce ownership-related membership before writes and reject unknown fields. Text limits: names/titles 120, notes/instructions 2,000. Limits: 30 groups, 10 exercises/group, 100 target rows/exercise, 300 targets/workout, 100 execution exercises, 600 execution rows/session. Requests max 256 KiB. Context/history pages max 50; exercise search pages 50. Upcoming context is bounded to 30 summaries.

Writes use stable operation UUIDs; reusing a key with another payload fails. Upcoming replacements need an expected revision; frozen prescriptions reject changes. MCP errors use stable categories and expose validation fields without secrets. Read responses include server timestamps; offline data is unavailable to ChatGPT until saved.

Resource requests validate signature, issuer, audience, expiration, scopes, and the live consent/account authorization epoch. Disconnect increments the epoch and deletes the account's consents and access/refresh records atomically. Thus an already issued JWT fails immediately, despite Better Auth JWTs not being individually revocable. Browser session identity and OAuth subject share the same user table.

Auth/OAuth rate limits use Better Auth's database storage. App/MCP per-account limits use a bounded memory map in the intended single-process VPS deployment (120 browser writes / 240 MCP requests per minute). Before multiple processes, move those limits to shared storage. Only the trusted reverse proxy supplies `X-Real-IP`; Node must not be publicly reachable.

The auth schema was generated by `auth@1.7.7`; its optional PostgreSQL arrays require the committed defaults migration. `npm run db:auth-schema` regenerates the library-owned tables; review its diff carefully and preserve domain relations, account uniqueness, array defaults, and custom constraint migrations. Do not use the auth CLI's migrate command with Prisma.

## Tests

Use one runner: Node's built-in `node:test`, also for the Playwright smoke test. No fixture data is seeded into production.

```sh
cp .env.test.example .env.test
# Fill in a dedicated, disposable DB whose name ends in _test.
node --env-file=.env.test node_modules/prisma/build/index.js migrate deploy
npm run build
npm run typecheck
npm test
PLAYWRIGHT_BROWSERS_PATH=.cache/browsers npx playwright install chromium
npm run test:browser
```

Integration tests refuse non-test database names. They create unique test-owned accounts and clean those records afterward. Test sessions are created only inside test code; this validates the real app's session handling but does not prove a live Google login. Without `.env.test`/DATABASE_URL, database/OAuth checks are skipped; domain tests still run. Integration tests boot the built app on the configured loopback origin (default port 3000), so keep that port free.

The representative fixture covers optional jumps, exact-rep/no-load squat/RPE range, loaded bench, pull-up rep range, single-leg RDL/row superset, and side-specific core/back-extension work. A second fixture checks three-exercise circuit traversal with exhausted slots and assistance/per-dumbbell/added loads. Tests include overrides, substitutions after completed work, extra sets/exercises, explicit skips, side mismatches, and early completion. The browser test saves `test-results/mobile-recording.png` and exercises offline reload, reconnect, conflict/reapply, account switching, and offline finish. The local auth test uses real provider PKCE issuance and real SDK calls; it is not a ChatGPT live connection.

## Standalone host reference

```sh
npm ci --cache .cache/npm
npm run db:generate
npm run build
npm run typecheck
npm run db:migrate
npm start
```

`npm start` loads `.env` when present and runs the long-lived Node output; `PORT` selects the port. Set `HOST=127.0.0.1` behind the proxy and `NODE_ENV=production`. Production requires HTTPS and real configured Google/Better Auth secrets. Keep the environment file outside web-served directories. Build output excludes test code. For the codictive VPS, use the Docker/Phase deployment below instead of these standalone templates.

Reuse the VPS's existing supervisor and HTTPS reverse proxy. `deploy/gains.service` and `deploy/nginx.conf` are templates to adapt to those conventions. The proxy overwrites trusted headers, disables response buffering/caching for streaming, forwards all discovery/auth/MCP paths, and restricts body size. Google callbacks and ChatGPT discovery must resolve at the same public origin. Preserve Prisma's platform-specific generated engine and deploy `.output`, `prisma`, package/lock files and the matching independent installation.

For each release: take/verify a backup, build/test in a new release directory, apply committed migrations once using the migration URL, verify `/health` readiness and discovery, then switch the existing release symlink/restart the app. Migration failure blocks the release switch. Keep the previous application release for rollback, but do not pretend application rollback automatically reverses a database migration. The codictive workflow below automates migrations and application activation after its infrastructure has been provisioned.

## Backup and live acceptance

Record the actual development/production Neon branch names, plan, point-in-time recovery availability and retention period in the operator runbook. These values are not known here and no paid retention setting is assumed. Before release, verify them in the project's Neon console. Use the configured direct connection for an encrypted `pg_dump --format=custom` backup. Retain it in the owner's approved backup location; do not write secrets or backups to this repository.

Practice restore into a separate empty branch/database with `pg_restore --no-owner --no-acl`, run migrations/readiness checks, and verify workout/session counts and a sample comparison before any traffic switch. Use the actual plan's point-in-time restore workflow when available. Do not restore over production without explicit operator authorization.

Live inputs still needed: Google OAuth clients/callbacks, Neon connections and retention settings, and ChatGPT custom MCP access. With those supplied, run the manual loop in the original spec: Google sign-in and return, same-account ChatGPT linking, workout create/open/record, network disconnect/reload/reconnect, early finish, ChatGPT comparison/history, second-account isolation, then disconnect and confirm existing token rejection. Local tests do not verify Google, ChatGPT account linking, Neon hosting, public HTTPS, or VPS deployment.

Official implementation references: [TanStack Start hosting](https://tanstack.com/start/latest/docs/framework/react/guide/hosting), [Better Auth MCP](https://better-auth.com/docs/plugins/mcp), [OAuth provider](https://better-auth.com/docs/plugins/oauth-provider), [OpenAI authentication/profile contract](https://developers.openai.com/plugins/build/auth), [Prisma transactions](https://www.prisma.io/docs/orm/prisma-client/queries/transactions), [Neon Prisma guide](https://neon.com/docs/guides/prisma).

## Deploying to codictive with Phase

Production is `https://gains.codictive.be`; the existing wildcard DNS points at
codictive's VPS. No new DNS record is needed. The codictive repository owns the
Caddy route, private `codictive_edge` network and `/srv/apps/gains/compose.yml`.
The old systemd/nginx files above are reference templates for a standalone host;
the codictive deployment uses Docker and Caddy.

### Phase configuration

Create a Phase app named `gains` with separate development and production
environments. Populate `DATABASE_URL`, `DIRECT_DATABASE_URL`,
`BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_ORIGIN`
and `BETTER_AUTH_URL` from `.env.example`, using different database destinations
and auth secrets for the two environments. Generate each auth secret with
`openssl rand -base64 48`. Keep Google and database credentials directly in Phase.

Production values include:

```text
APP_ORIGIN=https://gains.codictive.be
BETTER_AUTH_URL=https://gains.codictive.be/api/auth
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
```

Do not set `MCP_RESOURCE_URL` for the normal public deployment; its default is
`APP_ORIGIN/mcp`. It is only needed when a tunnel requires a different audience.
Configure Google's authorized JavaScript origin as `https://gains.codictive.be`
and its exact redirect as `https://gains.codictive.be/api/auth/callback/google`.
Development uses `http://localhost:3000` and the matching development callback.

Authenticate locally with `phase auth`, then use:

```sh
npm ci --cache .cache/npm
npm run db:migrate:phase
npm run dev:phase
# For a built local server:
npm run build
npm run start:phase
```

These scripts default to `gains/development`. `PHASE_APP` and `PHASE_ENV` can
override the context. Runtime credentials are injected with `phase run`; no
`.env` file is required. The container uses the same wrapper with
`PHASE_ENV=production` and a mounted service token. Self-hosted Phase can use
`PHASE_HOST` both locally and in the codictive/GitHub configuration.

Reuse the existing service token and grant its service account read access to
both `codictive/production` and `gains/production`. Codictive's Ansible role uses
the infrastructure runner's `PHASE_SERVICE_TOKEN` directly and writes it to a
UID 1000-owned, mode 0400 file without logging its contents. No duplicate token
secret in Phase is needed. The VPS needs this token so containers can fetch
secrets on every start or restart, independently of GitHub Actions.
After rotating the token, update the GitHub `PHASE_SERVICE_TOKEN` secrets,
rerun codictive provisioning, then rerun the application deploy workflow.
For first setup or token rotation locally, export `PHASE_SERVICE_TOKEN` before
`make gains`. Changes to app secrets only require rerunning the application
workflow to fetch fresh values.

### First deployment

1. Publish this GAINS repository to GitHub if it has no remote yet. The default
   branch must be `main` for `.github/workflows/deploy.yml` to deploy.
2. In GAINS's GitHub repository, create a `production` environment and add
   `PHASE_SERVICE_TOKEN`: the existing token with read-only access to both
   **codictive/production** and **gains/production**. Optional variables:
   `INFRA_PHASE_APP` and `PHASE_HOST`.
3. Grant the service account access to GAINS before merging the codictive
   changes. Its infrastructure workflow provisions GAINS and its Caddy route. Alternatively,
   from the codictive checkout, use `make gains && make proxy` after the VPS's
   base Docker/Caddy setup has converged.
4. Verify the production database's backup/restore setup before the first
   migration. Push/merge GAINS's code to `main`, or manually run its deploy
   workflow on `main` after the infrastructure is ready.
5. Verify `https://gains.codictive.be/health`, Google sign-in, recording, and the
   ChatGPT connection to `https://gains.codictive.be/mcp`.

The workflow builds Linux amd64 Node 24 images and checks TypeScript. Builds
receive no app secrets. It packs app and migration images into a one-day GitHub
artifact, then uploads it over host-key-verified SSH using temporary credentials.
PRs build only; production deploys are serialized. No tests are added or run by
this workflow, and no image-registry credentials are needed.

The VPS helper loads the images, runs `prisma migrate deploy`, recreates the app,
and waits up to 180 seconds for its database-backed `/health` readiness check.
A migration failure leaves the running app alone. Failed app readiness restores
the previous application image when available. Neither case reverses migrations.
The job also checks public HTTPS readiness after activation.

As root on the VPS, inspect or roll back with:

```sh
/usr/local/sbin/gains-release rollback
```

Compose operations require `GAINS_RELEASE` to be set to the SHA in
`/srv/apps/gains/current`; the release helper sets it automatically. For logs:

```sh
GAINS_RELEASE="$(cat /srv/apps/gains/current)" docker compose -f /srv/apps/gains/compose.yml logs --tail 100 app
```

Retain the current and previous `gains`/`gains-migrate` images when cleaning up
Docker storage. Only remove obsolete images after successful activation; do not
run a blanket prune that removes rollback images. Application rollback requires
that the previous version is compatible with the migrated database.
