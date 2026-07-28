import type { Env } from "./config/env.js";
import type { Db } from "./db/client.js";
import type Database from "better-sqlite3";
import type { Metrics } from "./lib/metrics.js";
import type { LruTtlCache } from "./lib/cache.js";

declare module "fastify" {
  interface FastifyInstance {
    env: Env;
    db: Db;
    sqlite: Database.Database;
    metrics: Metrics;
    /** Small TTL cache for public discovery queries. */
    discoveryCache: LruTtlCache<unknown>;
  }
}
