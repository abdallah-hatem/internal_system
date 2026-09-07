import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * How many connections one instance of this app may open.
 *
 * Prisma's default is `cpus * 2 + 1`, which is right for one long-lived server
 * and wrong for a serverless host, where every concurrent request can be its
 * own instance with its own pool. Neon's free plan allows a limited number of
 * connections in total; a handful of cold functions each claiming nine of them
 * exhausts it, and the next request does not fail — it *waits*.
 *
 * That is what made this hard to see. Login answered in 1.5s one moment and
 * hung past 60s the next, with nothing in the API log because the request never
 * reached a handler. From the browser it looked like the app was broken; from
 * the dashboard everything was green.
 *
 * One connection per instance, and a bounded wait rather than an unbounded one:
 * a request that cannot get a connection should be refused quickly so the
 * caller sees an error, not a spinner that never resolves.
 */
const SERVERLESS_POOL = { connection_limit: '1', pool_timeout: '20' };

/**
 * Applied only where it is needed, and only when the parameters are absent, so
 * a URL that already says something specific is left alone.
 */
export function tunedDatabaseUrl(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  // `VERCEL` is set on every Vercel runtime and nowhere else. Locally, Prisma's
  // default pool is correct and this would needlessly serialise queries.
  if (!process.env.VERCEL) return raw;

  try {
    const url = new URL(raw);
    for (const [key, value] of Object.entries(SERVERLESS_POOL)) {
      if (!url.searchParams.has(key)) url.searchParams.set(key, value);
    }
    return url.toString();
  } catch {
    // A malformed URL is a problem, but not this file's problem to report —
    // Prisma will say so far more clearly than a rethrow from here would.
    return raw;
  }
}

/**
 * How long an interactive transaction may take.
 *
 * Prisma's default is 5000 ms, which is a figure for a database on the same
 * machine. Receiving stock does roughly seven round trips per line plus an
 * audit row and a ledger entry, and `connection_limit: 1` above means they
 * serialise — so on the deployed API every one of them is a network hop taken
 * one at a time. Measured in production it came to 5095 ms, and
 * `POST /receipts/verify` failed with P2028 every single time: stock could not
 * be received at all, while the same code passed locally in well under a
 * second because Postgres was a container on the same host.
 *
 * The region fix in vercel.json is the real repair — the function and Neon are
 * now in the same one. This is the margin, so that a slow moment costs a slow
 * request rather than a 500 on the one endpoint that creates stock.
 *
 * Applied only on Vercel. Locally the default is a useful canary: a
 * transaction that cannot finish in five seconds against a local database has
 * something wrong with it, and that is worth failing over.
 */
const NETWORKED_TRANSACTION = { timeout: 15_000, maxWait: 10_000 } as const;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({
      datasources: { db: { url: tunedDatabaseUrl(process.env.DATABASE_URL) } },
      ...(process.env.VERCEL ? { transactionOptions: NETWORKED_TRANSACTION } : {}),
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
