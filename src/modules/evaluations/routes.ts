import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { requireAuth } from "../../plugins/auth.js";
import { notFound } from "../../lib/errors.js";
import { mandateIdParamsSchema } from "../mandates/schemas.js";
import { getMandateAccess } from "../mandates/service.js";
import { evaluationBodySchema } from "./schemas.js";
import { assertEvaluatorAuthority, recordEvaluation } from "./service.js";

export function registerEvaluationRoutes(app: FastifyInstance): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.post(
    "/mandates/:id/evaluations",
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ["evaluations"],
        summary:
          "Record an evaluation attestation: accept -> accepted, revise -> in_execution",
        params: mandateIdParamsSchema,
        body: evaluationBodySchema
      }
    },
    async (request, reply) => {
      const { publicKey } = requireAuth(request);
      const access = getMandateAccess(app.db, request.params.id, publicKey);
      if (!access) throw notFound("Mandate not found");
      if (access.role === null && access.mandate.state === "draft") {
        throw notFound("Mandate not found");
      }
      assertEvaluatorAuthority(access, publicKey);
      const { evaluation, mandate } = recordEvaluation(
        app.db,
        access.mandate,
        publicKey,
        request.body
      );
      app.discoveryCache.clear();
      reply.status(201);
      return { evaluation, state: mandate.state };
    }
  );
}
