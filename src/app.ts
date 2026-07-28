import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider
} from "fastify-type-provider-zod";
import "./types.js";
import { loadEnv } from "./config/env.js";
import { createDb } from "./db/client.js";
import { LruTtlCache } from "./lib/cache.js";
import { buildLoggerOptions } from "./lib/logger.js";
import { Metrics, moduleFromUrl } from "./lib/metrics.js";
import { registerAuth } from "./plugins/auth.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { registerSecurity } from "./plugins/security.js";
import { registerSwagger } from "./plugins/swagger.js";
import { registerAuthRoutes } from "./modules/auth/routes.js";
import { registerBidRoutes } from "./modules/bids/routes.js";
import { registerDisputeRoutes } from "./modules/disputes/routes.js";
import { registerEvaluationRoutes } from "./modules/evaluations/routes.js";
import { registerHealthRoutes } from "./modules/health/routes.js";
import { registerMandateRoutes } from "./modules/mandates/routes.js";
import { registerPassportRoutes } from "./modules/passports/routes.js";
import { registerReceiptRoutes } from "./modules/receipts/routes.js";
import { registerVaultRoutes } from "./modules/vault/routes.js";
import { registerWorkroomRoutes } from "./modules/workrooms/routes.js";

export interface BuildAppOptions {
  /** Env overrides (tests use DATABASE_PATH=":memory:", LOG_LEVEL="silent"). */
  env?: Partial<Record<string, string>>;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = loadEnv(options.env);

  const app = Fastify({
    logger: buildLoggerOptions(env.LOG_LEVEL),
    bodyLimit: 2 * 1024 * 1024
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const { db, sqlite } = createDb(env.DATABASE_PATH);
  const metrics = new Metrics();

  app.decorate("env", env);
  app.decorate("db", db);
  app.decorate("sqlite", sqlite);
  app.decorate("metrics", metrics);
  app.decorate("discoveryCache", new LruTtlCache<unknown>(200, 5000));

  registerErrorHandler(app);
  await registerSecurity(app, env);
  await registerSwagger(app);
  registerAuth(app, env);

  app.addHook("onResponse", (request, reply, done) => {
    metrics.record(moduleFromUrl(request.url), reply.statusCode);
    done();
  });

  registerHealthRoutes(app);

  await app.register(
    async (api) => {
      registerAuthRoutes(api);
      registerPassportRoutes(api);
      registerMandateRoutes(api);
      registerBidRoutes(api);
      registerWorkroomRoutes(api);
      registerEvaluationRoutes(api);
      registerVaultRoutes(api);
      registerDisputeRoutes(api);
      registerReceiptRoutes(api);
    },
    { prefix: "/api/v1" }
  );

  app.addHook("onClose", (_instance, done) => {
    try {
      sqlite.close();
    } finally {
      done();
    }
  });

  return app;
}
