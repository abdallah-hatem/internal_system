/**
 * Where this run's API, office app, storefront and database are.
 *
 * The one place in the e2e suite that names an address. Every spec, the
 * Playwright config and globalSetup/teardown read from here, so pointing a run
 * somewhere else is a matter of environment variables, never of editing specs.
 *
 * With nothing set, a run behaves exactly as it always has: API on 3001, office
 * on 3000, storefront on 3002, database `motorcycle_parts` in the
 * `motorcycle_parts_db` container. `scripts/agent-env.sh <name>` prints the
 * exports that give one agent its own database and port block instead, so
 * several agents can run e2e side by side without queueing for one database.
 *
 *   API_BASE      the API, including `/api/v1`
 *   WEB_URL       the office app
 *   STORE_URL     the storefront (`STOREFRONT_BASE` is the older spelling)
 *   DATABASE_URL  the database globalSetup snapshots, reseeds and restores
 */

/** The developer's own database, and the one a run with nothing set uses. */
export const DEFAULT_DB_NAME = 'motorcycle_parts';
const DEFAULT_DATABASE_URL = `postgresql://postgres:postgres@localhost:5432/${DEFAULT_DB_NAME}?schema=public`;

export const API = process.env.API_BASE ?? 'http://localhost:3001/api/v1';
export const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
export const STORE = process.env.STORE_URL ?? process.env.STOREFRONT_BASE ?? 'http://localhost:3002';

export const DATABASE_URL = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;

const dbUrl = new URL(DATABASE_URL);

/** The database the run owns, e.g. `motorcycle_parts` or `motorcycle_parts_alice`. */
export const DB_NAME = decodeURIComponent(dbUrl.pathname.replace(/^\//, ''));

/** The Postgres container. Every database a local run touches lives in it. */
export const DB_CONTAINER = process.env.DB_CONTAINER ?? 'motorcycle_parts_db';

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/** True when the API is this machine's, not a deployed one. */
export const API_IS_LOCAL = LOCAL.test(new URL(API).hostname);

/** True when the database is the local container's, not Neon or anything else. */
export const DB_IS_LOCAL = LOCAL.test(dbUrl.hostname);
