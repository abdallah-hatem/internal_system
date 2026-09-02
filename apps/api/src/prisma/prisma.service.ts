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

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({
      datasources: { db: { url: tunedDatabaseUrl(process.env.DATABASE_URL) } },
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
