# Deploying to Vercel

Three Vercel projects from one repository, the same shape as the car service
system: the API and each frontend deploy separately from their own directory.

| app | directory | project | serves |
|---|---|---|---|
| API | `apps/api` | `internal-system-api` | NestJS, `/api/v1/*` |
| Office | `apps/web` | `internal-system-web` | the partners' app |
| Store | `apps/storefront` | `internal-system-store` | the shop-facing store |

The two frontends run in `fra1`, the closest region to Egypt that Vercel offers. The API runs in `iad1`, beside
the Neon database in us-east-1 (moved 2026-09-07: from `fra1` every query crossed the Atlantic, and receiving
stock took five seconds). The office app is served at `internal-system-web-three.vercel.app` — the plain `-web`
name belongs to someone else's project; see `docs/where-things-stand.md`.

---

## What had to change first

Three things worked locally and could not have worked on Vercel. None of them
fail loudly, which is why they are worth naming.

### Files were written to a disk that does not survive a deploy

`LocalDiskStorage` writes under `apps/api/uploads/`. Vercel rebuilds the
filesystem on every deployment, so every product photograph and every picture a
shop attached to an import request would disappear at the next push — and
nothing would look wrong until someone opened a product and found a broken
image.

`VercelBlobStorage` is the second implementation the `StorageAdapter` interface
was written for. Object keys are unchanged, so a database written by one adapter
is readable by the other.

Which one runs is decided by `BLOB_READ_WRITE_TOKEN` rather than by `NODE_ENV`:
the app follows what it has actually been given. **If you deploy without
attaching a Blob store, uploads silently go to a disk that is about to vanish.**

### Scheduled jobs never ran

`@Cron(EVERY_30_MINUTES)` needs a process that stays alive between ticks. A
serverless function exists for one request and is then gone, so the decorator
registers a job that never fires — holds stop expiring and the office stops
being warned before stock goes back on the shelf. Nothing logs an error.

The schedule now lives in `apps/api/vercel.json` and calls
`GET /api/v1/jobs/sweep-holds`. The `@Cron` decorator is still there and still
works on a host with a real process; running both is harmless because the sweep
is idempotent.

> **This account is on Hobby, so the sweep runs once a day**, at 03:00. An
> hourly schedule was rejected at build time with "Hobby accounts are limited to
> daily cron jobs".
>
> What that costs, stated plainly: **the "six hours before this hold lapses"
> warning is effectively dead.** It fires only if the single daily run happens
> to land inside a request's six-hour window, which for a 48-hour hold is a
> roughly 12% chance. Do not rely on it.
>
> What it does not cost: expiry itself. `availableQty` ignores any hold past its
> deadline, so stock is never wrongly withheld between sweeps — the sweep is
> housekeeping for the reservations table, not the rule. A hold is dead when its
> deadline passes, whether or not anything has swept it.
>
> Pro restores the hourly schedule; change `schedule` back to `0 * * * *`.

### CORS named only localhost

Two hardcoded origins. A deployed frontend would have been refused with a
browser-side network error and nothing in the API log — which reads as the API
being down. `WEB_ORIGIN` and `STORE_ORIGIN` now name the deployed origins,
localhost stays allowed, and `*.vercel.app` previews are matched by pattern so a
preview deployment is not locked out of its own API.

---

## Environment variables

Set on the **API** project:

| variable | where it comes from | if it is missing |
|---|---|---|
| `DATABASE_URL` | the Neon integration sets this | nothing starts |
| `JWT_SECRET` | generate one, below | **the app refuses to boot** — deliberately |
| `WEB_ORIGIN` | the office app's URL | the office app cannot call the API |
| `STORE_ORIGIN` | the store's URL | the store cannot call the API |
| `CRON_SECRET` | generate one, below | the sweep endpoint refuses every request |
| `BLOB_READ_WRITE_TOKEN` | the Blob store sets this | uploads go to a disk that is wiped |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | generate a pair (`npx web-push generate-vapid-keys`); set in production 2026-10-16 | no phone alerts at all — push is off with a warning in the log; the bell still works |
| `VAPID_SUBJECT` | a `mailto:` for the push services | a placeholder mailto is used |
| `AI_API_KEY` (+ `AI_PROVIDER`, `AI_MODEL`, `AI_BASE_URL`, `AI_DAILY_LIMIT`) | the office chat's model — a key from the provider (Gemini by default; any OpenAI-compatible one; `apps/api/.env.example`); set in production 2026-10-26 by the owner, provider Groq | the chat says it is not set up; nothing else changes |
| `PUBLIC_BASE_URL` | the API's public address; `scripts/ship-prod.sh env` sets it if absent | the assistant's OAuth and MCP addresses are read from forwarded headers, which a caller can choose |

Set on **both frontends**:

| variable | value |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://<api project>.vercel.app/api/v1` |
| `NEXT_PUBLIC_FEATURE_REQUESTS` (office only, optional) | `on` shows the Requests page in production; unset hides it there (BUSINESS_LOGIC "Requests in the office") |

Generate the two secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

`JWT_SECRET` is checked at boot — unset, under 32 characters, or a placeholder
like `CHANGE_ME_IN_PRODUCTION` and the server will not start. That is on
purpose: with no secret, `@nestjs/jwt` signs and verifies with `undefined`,
every login succeeds, and every token is forgeable.

---

## First deploy

Attach the two storage services from the Vercel dashboard rather than pasting
credentials anywhere — both set their own environment variables:

1. **Storage → Neon** on the API project. Sets `DATABASE_URL`.
2. **Storage → Blob** on the API project. Sets `BLOB_READ_WRITE_TOKEN`.

Then, per project:

```bash
cd apps/api && vercel link && vercel deploy --prod
cd apps/web && vercel link && vercel deploy --prod
cd apps/storefront && vercel link && vercel deploy --prod
```

## Migrations

> Superseded for releases by "Shipping a release" below: use `scripts/ship-prod.sh migrate`, which pulls the
> production URL itself (the unpooled one — Neon's pooler drops the lock `migrate deploy` takes). The text
> below is the first deploy's, kept as written.

The build runs `prisma generate`, not `prisma migrate deploy` — generating a
client is safe to repeat, applying migrations is not something a build should do
to a live database without you asking. Run them deliberately:

```bash
DATABASE_URL="<the Neon URL>" npx prisma migrate deploy
```

Seed the reference data the same way, once (first deploy only — `db:reset:*` rebuilds the local Docker database
and does not read `DATABASE_URL`; production is emptied and given new partner logins with
`scripts/prod-reset-partners.sh`, which the owner runs himself):

```bash
DATABASE_URL="<the Neon URL>" npm run db:reset:minimal
```

## After the first deploy

- Sign in to both apps. The JWT secret differs from local, so nothing carries over.
- Upload one product photograph, deploy again, and confirm it is still there.
  That is the check that proves the Blob store is actually in use.
- Confirm the cron ran: Vercel dashboard → the API project → Cron Jobs.

---

## Shipping a release

Pushing `master` deploys all three apps (Vercel builds production only — each `vercel.json`'s `ignoreCommand`
skips previews and other branches). The schema goes first, because the new code reads it:

```bash
scripts/ship-prod.sh status      # which migrations production has not had
scripts/ship-prod.sh migrate     # apply them — run on its own, never in a pipe or chained to the push
scripts/ship-prod.sh status      # must print "Database schema is up to date!"
git push origin master           # only now: the deploy
scripts/ship-prod.sh smoke       # read-only checks against the live API and office app
```

- **Never chain them** (`ship-prod.sh migrate | tail -1 && git push`): a pipe's exit code is the last command's,
  so a failed migration (Neon once dropped the connection, P1001) still let the push deploy code ahead of its
  schema. Migrate alone, read `status`, then push (LEARNINGS, 2026-10-14).
- **A migration that rewrites data** gets a `scripts/ship-prod.sh backup` first (pg_dump into `.backups/`, needs
  Docker) — only when the owner asks for one; he decides when production is backed up.
- After the deploy, check each of the three projects reaches READY on the new commit, and run
  `scripts/check-data.sh` against production when the release changed how records are written.
- **In a worktree** `ship-prod.sh` exits 1 with no output: `.vercel/` is untracked, so `vercel env pull` has no
  project link and `set -e` stops it before it can say so. Copy `apps/api/.vercel/project.json` from the main
  checkout into the worktree's `apps/api/.vercel/` (it stays ignored), then run `status`.
- **Phone alerts** need `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` on the API project (present in production since
  2026-10-16). Without them the API boots, logs a warning, and only the bell works.
- Auto mode blocks production steps: switch the session to manual, let the owner approve each step, switch back.
- **Last release** (2026-10-27, `d87b68b`): customer branches, migration `20261025120000_customer_branches` applied
  first. Production's migrations end there; nothing is merged and waiting. `20261026100000_sale_order_edits` lives
  only on `feature/edit-order` (Edit order, not shipped) — never apply it to production until that branch ships.
  See `docs/BUILD_LOG.md`.
