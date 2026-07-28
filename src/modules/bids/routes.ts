import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { requireAuth } from "../../plugins/auth.js";
import { notFound } from "../../lib/errors.js";
import { mandateIdParamsSchema } from "../mandates/schemas.js";
import { getMandateAccess } from "../mandates/service.js";
import { bidParamsSchema, placeBidBodySchema } from "./schemas.js";
import { listBidsFor, placeBid, toBidView, withdrawBid } from "./service.js";

export function registerBidRoutes(app: FastifyInstance): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.post(
    "/mandates/:id/bids",
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ["bids"],
        summary: "Submit a sealed bid (commitment + nullifier + ciphertext)",
        params: mandateIdParamsSchema,
        body: placeBidBodySchema
      }
    },
    async (request, reply) => {
      const { publicKey } = requireAuth(request);
      const access = getMandateAccess(app.db, request.params.id, publicKey);
      if (!access) throw notFound("Mandate not found");
      if (access.role === null && access.mandate.state === "draft") {
        throw notFound("Mandate not found");
      }
      const bid = placeBid(app.db, access.mandate, publicKey, request.body);
      reply.status(201);
      return { bid: toBidView(bid, true) };
    }
  );

  routes.get(
    "/mandates/:id/bids",
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ["bids"],
        summary: "List bids: principal sees all, an operator sees only their own",
        params: mandateIdParamsSchema
      }
    },
    async (request) => {
      const { publicKey } = requireAuth(request);
      const access = getMandateAccess(app.db, request.params.id, publicKey);
      if (!access) throw notFound("Mandate not found");
      if (access.role === null && access.mandate.state === "draft") {
        throw notFound("Mandate not found");
      }
      return { items: listBidsFor(app.db, access, publicKey) };
    }
  );

  routes.delete(
    "/mandates/:id/bids/:bidId",
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ["bids"],
        summary: "Withdraw an own pending bid",
        params: bidParamsSchema
      }
    },
    async (request) => {
      const { publicKey } = requireAuth(request);
      const access = getMandateAccess(app.db, request.params.id, publicKey);
      if (!access) throw notFound("Mandate not found");
      const bid = withdrawBid(app.db, access.mandate.id, request.params.bidId, publicKey);
      return { bid: toBidView(bid, true) };
    }
  );
}
