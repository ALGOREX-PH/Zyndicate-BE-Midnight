import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { requireAuth, signSessionToken } from "../../plugins/auth.js";
import { notFound } from "../../lib/errors.js";
import { challengeBodySchema, updateMeBodySchema, verifyBodySchema } from "./schemas.js";
import {
  createChallenge,
  getIdentity,
  updateIdentity,
  verifyChallenge
} from "./service.js";

export function registerAuthRoutes(app: FastifyInstance): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const authRateLimit = {
    rateLimit: {
      max: app.env.RATE_LIMIT_AUTH_MAX,
      timeWindow: app.env.RATE_LIMIT_WINDOW
    }
  };

  routes.post(
    "/auth/challenge",
    {
      config: authRateLimit,
      schema: {
        tags: ["auth"],
        summary: "Request a signing challenge for an ed25519 public key",
        body: challengeBodySchema
      }
    },
    async (request) => {
      const { nonce, expiresAt } = createChallenge(app.db, request.body.publicKey);
      return { nonce, expiresAt: new Date(expiresAt).toISOString() };
    }
  );

  routes.post(
    "/auth/verify",
    {
      config: authRateLimit,
      schema: {
        tags: ["auth"],
        summary: "Verify a signed challenge and receive a session token",
        description:
          "The signature must be an ed25519 signature over the UTF-8 message `zyndicate:auth:<nonce>`.",
        body: verifyBodySchema
      }
    },
    async (request) => {
      const { publicKey, nonce, signature } = request.body;
      const identity = verifyChallenge(app.db, publicKey, nonce, signature);
      const token = await signSessionToken(app.env, publicKey);
      return { token, identity };
    }
  );

  routes.get(
    "/me",
    {
      preHandler: [app.authenticate],
      schema: { tags: ["auth"], summary: "Current identity" }
    },
    async (request) => {
      const { publicKey } = requireAuth(request);
      const identity = getIdentity(app.db, publicKey);
      if (!identity) throw notFound("Identity not found");
      return { identity };
    }
  );

  routes.put(
    "/me",
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ["auth"],
        summary: "Update display name / role hints",
        body: updateMeBodySchema
      }
    },
    async (request) => {
      const { publicKey } = requireAuth(request);
      const identity = updateIdentity(app.db, publicKey, request.body);
      if (!identity) throw notFound("Identity not found");
      return { identity };
    }
  );
}
