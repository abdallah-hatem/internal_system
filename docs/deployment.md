# Deploying to Vercel

Three Vercel projects from one repository, the same shape as the car service
system: the API and each frontend deploy separately from their own directory.

| app | directory | project | serves |
|---|---|---|---|
| API | `apps/api` | `internal-system-api` | NestJS, `/api/v1/*` |
| Office | `apps/web` | `internal-system-web` | the partners' app |
| Store | `apps/storefront` | `internal-system-store` | the shop-facing store |

All three in `fra1` — closest region to Egypt that Vercel offers.

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

> **Cron frequency depends on your plan.** Hobby allows two cron jobs, once a
> day. The sweep is set hourly, which Pro allows. On Hobby the build will reject
> it — change the schedule to `0 3 * * *` and accept that the "six hours before
> this hold lapses" warning becomes unreliable, or upgrade. Expiry itself is
> safe either way: `availableQty` already ignores a hold past its deadline, so
> stock is never wrongly withheld between sweeps.

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

Set on **both frontends**:

| variable | value |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://<api project>.vercel.app/api/v1` |

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

The build runs `prisma generate`, not `prisma migrate deploy` — generating a
client is safe to repeat, applying migrations is not something a build should do
to a live database without you asking. Run them deliberately:

```bash
DATABASE_URL="<the Neon URL>" npx prisma migrate deploy
```

Seed the reference data the same way, once:

```bash
DATABASE_URL="<the Neon URL>" npm run db:reset:minimal
```

## After the first deploy

- Sign in to both apps. The JWT secret differs from local, so nothing carries over.
- Upload one product photograph, deploy again, and confirm it is still there.
  That is the check that proves the Blob store is actually in use.
- Confirm the cron ran: Vercel dashboard → the API project → Cron Jobs.
