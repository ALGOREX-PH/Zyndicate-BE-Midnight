import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { requireAuth } from "../../plugins/auth.js";
import { notFound } from "../../lib/errors.js";
import { mandateIdParamsSchema } from "../mandates/schemas.js";
import { getMandateAccess } from "../mandates/service.js";
import {
  disputeParamsSchema,
  listDisputesQuerySchema,
  openDisputeBodySchema,
  rulingBodySchema
} from "./schemas.js";
import { listDisputesFor, openDispute, ruleDispute } from "./service.js";

export function registerDisputeRoutes(app: FastifyInstance): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.post(
    "/mandates/:id/disputes",
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ["disputes"],
        summary: "Open a dispute (party only); settlement freezes",
        params: mandateIdParamsSchema,
        body: openDisputeBodySchema
      }
    },
    async (request, reply) => {
      const { publicKey } = requireAuth(request);
      const access = getMandateAccess(app.db, request.params.id, publicKey);
      if (!access) throw notFound("Mandate not found");
      if (access.role === null && access.mandate.state === "draft") {
        throw notFound("Mandate not found");
      }
      const { dispute, mandate } = openDispute(app.db, access, publicKey, request.body);
      app.discoveryCache.clear();
      reply.status(201);
      return { dispute, state: mandate.state };
    }
  );

  routes.post(
    "/disputes/:id/ruling",
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ["disputes"],
        summary: "Tribunal ruling: release | refund (state -> resolved)",
        params: disputeParamsSchema,
        body: rulingBodySchema
      }
    },
    async (request) => {
      const { publicKey } = requireAuth(request);
      const { dispute, mandate } = ruleDispute(
        app.db,
        app.env.tribunalKeys,
        request.params.id,
        publicKey,
        request.body
      );
      app.discoveryCache.clear();
      return { dispute, state: mandate.state };
    }
  );

  routes.get(
    "/disputes",
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ["disputes"],
        summary: "Disputes the caller participates in",
        querystring: listDisputesQuerySchema
      }
    },
    async (request) => {
      const { publicKey } = requireAuth(request);
      // Listing is always scoped to the caller: dispute records are
      // confidential to the mandate parties and tribunal.
      return { items: listDisputesFor(app.db, publicKey) };
    }
  );
}
