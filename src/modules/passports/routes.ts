import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { requireAuth } from "../../plugins/auth.js";
import { notFound } from "../../lib/errors.js";
import { addCredentialBodySchema, passportParamsSchema } from "./schemas.js";
import { addCredential, getPublicPassport } from "./service.js";

export function registerPassportRoutes(app: FastifyInstance): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    "/passports/:publicKey",
    {
      schema: {
        tags: ["passports"],
        summary: "Public coarse passport — identity class, domains, completion band",
        params: passportParamsSchema
      }
    },
    async (request) => {
      const passport = getPublicPassport(app.db, request.params.publicKey);
      if (!passport) throw notFound("Passport not found");
      return { passport };
    }
  );

  routes.post(
    "/passports/credentials",
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ["passports"],
        summary: "Register a credential commitment on the caller's passport",
        body: addCredentialBodySchema
      }
    },
    async (request, reply) => {
      const { publicKey } = requireAuth(request);
      const credential = addCredential(app.db, publicKey, request.body);
      reply.status(201);
      return { credential };
    }
  );
}
