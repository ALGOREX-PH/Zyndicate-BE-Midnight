import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { requireAuth } from "../../plugins/auth.js";
import { forbidden, notFound } from "../../lib/errors.js";
import { mandateIdParamsSchema } from "../mandates/schemas.js";
import { getMandateAccess } from "../mandates/service.js";
import { workroomParamsSchema } from "../workrooms/schemas.js";
import { settleBodySchema } from "./schemas.js";
import { settleMandate, vaultStatus } from "./service.js";

export function registerVaultRoutes(app: FastifyInstance): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.post(
    "/mandates/:id/settle",
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ["vault"],
        summary:
          "Principal releases settlement exactly once (consumes the settlement nullifier)",
        params: mandateIdParamsSchema,
        body: settleBodySchema
      }
    },
    async (request, reply) => {
      const { publicKey } = requireAuth(request);
      const access = getMandateAccess(app.db, request.params.id, publicKey);
      if (!access) throw notFound("Mandate not found");
      if (access.role === null && access.mandate.state === "draft") {
        throw notFound("Mandate not found");
      }
      if (access.role !== "principal") {
        throw forbidden("Only the principal may release settlement");
      }
      const { settlement, mandate, issued } = settleMandate(app.db, access, request.body);
      app.discoveryCache.clear();
      reply.status(201);
      return { settlement, state: mandate.state, receipts: issued };
    }
  );

  routes.get(
    "/vault/:mandateId",
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ["vault"],
        summary: "Settlement status (mandate parties only)",
        params: workroomParamsSchema
      }
    },
    async (request) => {
      const { publicKey } = requireAuth(request);
      const access = getMandateAccess(app.db, request.params.mandateId, publicKey);
      // 404 discipline: non-parties never learn whether a vault exists.
      if (!access || access.role === null) throw notFound("Vault not found");
      return { vault: vaultStatus(app.db, access) };
    }
  );
}
