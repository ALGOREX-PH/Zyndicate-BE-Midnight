import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { requireAuth } from "../../plugins/auth.js";
import { forbidden, notFound, unauthorized } from "../../lib/errors.js";
import { offsetOf, paginate } from "../../lib/pagination.js";
import {
  awardBodySchema,
  createMandateBodySchema,
  listMandatesQuerySchema,
  mandateIdParamsSchema,
  stateActionBodySchema
} from "./schemas.js";
import {
  acceptAward,
  applyTransition,
  awardBid,
  createMandate,
  getMandateAccess,
  listMandates,
  toDetail,
  toPublicSummary
} from "./service.js";
import type { MandateAction } from "./service.js";
import type { Paginated } from "../../lib/pagination.js";
import type { MandateSummary } from "./service.js";

const STATE_ACTIONS: Record<string, MandateAction> = {
  open_bidding: "open_bidding",
  close_bidding: "close_bidding",
  cancel: "cancel"
};

export function registerMandateRoutes(app: FastifyInstance): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    "/mandates",
    {
      preHandler: [app.optionalAuthenticate],
      schema: {
        tags: ["mandates"],
        summary: "Discover mandates (public Class A summaries only)",
        querystring: listMandatesQuerySchema
      }
    },
    async (request) => {
      const { domain, state, mine = false, page, pageSize } = request.query;
      const viewerKey = request.auth?.publicKey ?? null;
      if (mine && !viewerKey) throw unauthorized("mine=true requires authentication");

      const pagination = { page, pageSize };
      const isPublicQuery = !mine;
      const cacheKey = JSON.stringify({ domain, state, page, pageSize });
      if (isPublicQuery) {
        const cached = app.discoveryCache.get(cacheKey);
        if (cached) return cached as Paginated<MandateSummary>;
      }

      const { rows, total } = listMandates(
        app.db,
        { domain, state, mine, viewerKey },
        offsetOf(pagination),
        pageSize
      );
      const result = paginate(rows.map(toPublicSummary), total, pagination);
      if (isPublicQuery) app.discoveryCache.set(cacheKey, result);
      return result;
    }
  );

  routes.post(
    "/mandates",
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ["mandates"],
        summary: "Create a mandate (public summary + commitments + encrypted package)",
        body: createMandateBodySchema
      }
    },
    async (request, reply) => {
      const { publicKey } = requireAuth(request);
      const mandate = createMandate(app.db, publicKey, request.body);
      app.discoveryCache.clear();
      const access = getMandateAccess(app.db, mandate.id, publicKey);
      reply.status(201);
      return { mandate: toDetail(access!) };
    }
  );

  routes.get(
    "/mandates/:id",
    {
      preHandler: [app.optionalAuthenticate],
      schema: {
        tags: ["mandates"],
        summary: "Role-aware mandate detail",
        params: mandateIdParamsSchema
      }
    },
    async (request) => {
      const viewerKey = request.auth?.publicKey ?? null;
      const access = getMandateAccess(app.db, request.params.id, viewerKey);
      if (!access) throw notFound("Mandate not found");
      // Drafts and invitation-only mandates are invisible to outsiders.
      if (
        access.role === null &&
        (access.mandate.state === "draft" || access.mandate.discoveryMode === "invitation")
      ) {
        throw notFound("Mandate not found");
      }
      return { mandate: toDetail(access) };
    }
  );

  routes.post(
    "/mandates/:id/state",
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ["mandates"],
        summary: "Principal state transitions: open_bidding | close_bidding | cancel",
        params: mandateIdParamsSchema,
        body: stateActionBodySchema
      }
    },
    async (request) => {
      const { publicKey } = requireAuth(request);
      const access = getMandateAccess(app.db, request.params.id, publicKey);
      if (!access) throw notFound("Mandate not found");
      if (access.role !== "principal") {
        // Drafts stay invisible to non-principals.
        if (access.mandate.state === "draft") throw notFound("Mandate not found");
        throw forbidden("Only the principal may change mandate state");
      }
      const action = STATE_ACTIONS[request.body.action]!;
      const mandate = applyTransition(app.db, access.mandate, action);
      app.discoveryCache.clear();
      return { mandate: toDetail({ ...access, mandate }) };
    }
  );

  routes.post(
    "/mandates/:id/award",
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ["mandates"],
        summary: "Principal selects the winning sealed bid",
        params: mandateIdParamsSchema,
        body: awardBodySchema
      }
    },
    async (request) => {
      const { publicKey } = requireAuth(request);
      const access = getMandateAccess(app.db, request.params.id, publicKey);
      if (!access) throw notFound("Mandate not found");
      if (access.role !== "principal") {
        if (access.mandate.state === "draft") throw notFound("Mandate not found");
        throw forbidden("Only the principal may award a bid");
      }
      const { mandate } = awardBid(app.db, access.mandate, request.body.bidId);
      app.discoveryCache.clear();
      const refreshed = getMandateAccess(app.db, mandate.id, publicKey)!;
      return { mandate: toDetail(refreshed) };
    }
  );

  routes.post(
    "/mandates/:id/accept",
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ["mandates"],
        summary: "Awarded operator accepts; execution begins",
        params: mandateIdParamsSchema
      }
    },
    async (request) => {
      const { publicKey } = requireAuth(request);
      const access = getMandateAccess(app.db, request.params.id, publicKey);
      if (!access) throw notFound("Mandate not found");
      if (access.role !== "operator") {
        if (access.mandate.state === "draft") throw notFound("Mandate not found");
        throw forbidden("Only the awarded operator may accept the award");
      }
      const mandate = acceptAward(app.db, access);
      app.discoveryCache.clear();
      return { mandate: toDetail({ ...access, mandate }) };
    }
  );
}
