# Deploying the Zyndicate coordination service to Render

The service is a stateful Node process: it writes to a SQLite file and must
keep that file across deploys. That single fact drives most of what follows.

## Before you start

- A Render account with a payment method. **The free plan cannot mount a disk**,
  and without a disk the database is wiped on every deploy and every restart.
  The `starter` plan in `render.yaml` is the cheapest plan that supports one.
- The frontend's origin, so CORS can be set. You can deploy the API first and
  fill this in afterwards — the frontend needs the API URL anyway, so one of
  the two has to go first.

## Deploy

1. **Create the service.** In Render: **New → Blueprint**, select this
   repository. Render reads [`render.yaml`](../render.yaml) and provisions a
   web service named `zyndicate-api` with a 1 GB disk mounted at `/var/data`.

   Prefer clicking through instead? Create a **Web Service** with:

   | Setting | Value |
   | --- | --- |
   | Runtime | Node |
   | Build command | `npm ci && npm run build` |
   | Start command | `npm start` |
   | Health check path | `/healthz` |
   | Disk | mount at `/var/data`, 1 GB |

2. **Set the environment variables** Render did not fill in automatically:

   | Variable | Value | Notes |
   | --- | --- | --- |
   | `NODE_ENV` | `production` | Boot is refused if `JWT_SECRET` is still the development default |
   | `DATABASE_PATH` | `/var/data/zyndicate.db` | Must be inside the mounted disk |
   | `JWT_SECRET` | generated | Use Render's *Generate* button, or any 32+ random characters |
   | `CORS_ORIGINS` | `https://<your-app>.vercel.app,https://*.vercel.app` | Include the wildcard only if you want preview deployments to work |
   | `TRIBUNAL_KEYS` | *(optional)* | Comma-separated ed25519 hex keys allowed to rule disputes |

   `PORT` is injected by Render — do not set it. `TRUST_PROXY` defaults to true
   under `NODE_ENV=production`, which is what you want behind Render's load
   balancer; leave it unset.

3. **Wait for the health check.** Render marks the service live once `/healthz`
   returns 200. `/readyz` additionally proves the database opened.

4. **Verify:**

   ```bash
   curl https://<your-service>.onrender.com/healthz     # {"status":"ok"}
   curl https://<your-service>.onrender.com/readyz      # {"status":"ready"}
   curl https://<your-service>.onrender.com/docs        # Swagger UI
   ```

## Things that will bite you

**The disk is not optional.** Render's instance filesystem is ephemeral. Deploy
without a disk and the API works perfectly — until the first redeploy silently
resets every mandate, bid, and receipt. Confirm `DATABASE_PATH` points inside
the mount path, not at `./data`.

**Cold starts.** Instances that scale to zero take several seconds to answer the
first request. The frontend shows loading states, but the first call after an
idle period will feel slow.

**One instance only.** SQLite is a single-writer embedded database and the disk
attaches to exactly one instance. Do not scale past one; horizontal scale means
moving to Postgres (swap the Drizzle driver — the schema and queries are
already written against Drizzle, so the change is contained to
`src/db/client.ts` and the column types).

**CORS is exact by default.** A single `*` wildcard is supported in the host
segment and cannot span dots, so `https://*.vercel.app` matches
`https://zyndicate-git-main-you.vercel.app` but never
`https://a.b.vercel.app` or `https://vercel.app.attacker.com`. If the browser
reports a CORS failure, check the deployed origin is listed exactly, scheme
included.

**Rate limiting depends on proxy trust.** The limits are per client IP. If
`TRUST_PROXY` is somehow disabled in production, every caller shares the load
balancer's IP and the whole deployment throttles as one bucket.

## Backups

The database is one file. To copy it down:

```bash
# from a Render shell on the service
sqlite3 /var/data/zyndicate.db ".backup '/var/data/backup.db'"
```

Take a backup before any deploy that changes `DDL` in `src/db/client.ts`.
Migrations are idempotent `CREATE TABLE IF NOT EXISTS` statements, so they add
tables and indexes safely but will not rewrite or drop an existing column.

## What is not deployed here

The Compact contracts live in their own repository and are not part of this
service. The API stores commitment and nullifier *mirrors* — values the client
also anchors on Midnight — so it never becomes the authority on settlement.
