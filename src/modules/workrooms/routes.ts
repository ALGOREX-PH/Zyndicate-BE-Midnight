import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { requireAuth } from "../../plugins/auth.js";
import { forbidden, notFound } from "../../lib/errors.js";
import { offsetOf, paginate } from "../../lib/pagination.js";
import { mandateIdParamsSchema } from "../mandates/schemas.js";
import { getMandateAccess } from "../mandates/service.js";
import {
  listMessagesQuerySchema,
  postArtifactBodySchema,
  postMessageBodySchema,
  submissionBodySchema,
  workroomParamsSchema
} from "./schemas.js";
import {
  addArtifact,
  createSubmission,
  listArtifacts,
  listMessages,
  postMessage,
  requireWorkroom,
  workroomMeta
} from "./service.js";

export function registerWorkroomRoutes(app: FastifyInstance): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    "/workrooms/:mandateId",
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ["workrooms"],
        summary: "Workroom metadata and members (participants only)",
        params: workroomParamsSchema
      }
    },
    async (request) => {
      const { publicKey } = requireAuth(request);
      const access = requireWorkroom(
        getMandateAccess(app.db, request.params.mandateId, publicKey)
      );
      return { workroom: workroomMeta(access) };
    }
  );

  routes.get(
    "/workrooms/:mandateId/messages",
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ["workrooms"],
        summary: "Paginated encrypted messages (participants only)",
        params: workroomParamsSchema,
        querystring: listMessagesQuerySchema
      }
    },
    async (request) => {
      const { publicKey } = requireAuth(request);
      const access = requireWorkroom(
        getMandateAccess(app.db, request.params.mandateId, publicKey)
      );
      const pagination = request.query;
      const { rows, total } = listMessages(
        app.db,
        access.mandate.id,
        offsetOf(pagination),
        pagination.pageSize
      );
      return paginate(rows, total, pagination);
    }
  );

  routes.post(
    "/workrooms/:mandateId/messages",
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ["workrooms"],
        summary: "Post an encrypted message (participants only)",
        params: workroomParamsSchema,
        body: postMessageBodySchema
      }
    },
    async (request, reply) => {
      const { publicKey } = requireAuth(request);
      const access = requireWorkroom(
        getMandateAccess(app.db, request.params.mandateId, publicKey)
      );
      const message = postMessage(
        app.db,
        access.mandate.id,
        publicKey,
        request.body.ciphertext,
        request.body.nonce
      );
      reply.status(201);
      return { message };
    }
  );

  routes.get(
    "/workrooms/:mandateId/artifacts",
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ["workrooms"],
        summary: "Paginated encrypted artifacts (participants only)",
        params: workroomParamsSchema,
        querystring: listMessagesQuerySchema
      }
    },
    async (request) => {
      const { publicKey } = requireAuth(request);
      const access = requireWorkroom(
        getMandateAccess(app.db, request.params.mandateId, publicKey)
      );
      const pagination = request.query;
      const { rows, total } = listArtifacts(
        app.db,
        access.mandate.id,
        offsetOf(pagination),
        pagination.pageSize
      );
      return paginate(rows, total, pagination);
    }
  );

  routes.post(
    "/workrooms/:mandateId/artifacts",
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ["workrooms"],
        summary: "Upload an encrypted artifact with digest and version",
        params: workroomParamsSchema,
        body: postArtifactBodySchema
      }
    },
    async (request, reply) => {
      const { publicKey } = requireAuth(request);
      const access = requireWorkroom(
        getMandateAccess(app.db, request.params.mandateId, publicKey)
      );
      const artifact = addArtifact(app.db, access.mandate.id, publicKey, request.body);
      reply.status(201);
      return { artifact };
    }
  );

  routes.post(
    "/mandates/:id/submissions",
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ["workrooms"],
        summary: "Awarded operator commits a submission (state -> submitted)",
        params: mandateIdParamsSchema,
        body: submissionBodySchema
      }
    },
    async (request, reply) => {
      const { publicKey } = requireAuth(request);
      const access = getMandateAccess(app.db, request.params.id, publicKey);
      if (!access) throw notFound("Mandate not found");
      if (access.role === null && access.mandate.state === "draft") {
        throw notFound("Mandate not found");
      }
      if (access.role !== "operator") {
        throw forbidden("Only the awarded operator may commit a submission");
      }
      const { submission, mandate } = createSubmission(app.db, access.mandate, request.body);
      app.discoveryCache.clear();
      reply.status(201);
      return { submission, state: mandate.state };
    }
  );
}
