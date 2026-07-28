import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { desc, eq } from "drizzle-orm";
import { receipts } from "../../db/schema.js";
import { requireAuth } from "../../plugins/auth.js";

export function registerReceiptRoutes(app: FastifyInstance): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    "/me/receipts",
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ["receipts"],
        summary: "Proof receipts held by the caller"
      }
    },
    async (request) => {
      const { publicKey } = requireAuth(request);
      const items = app.db
        .select()
        .from(receipts)
        .where(eq(receipts.holderKey, publicKey))
        .orderBy(desc(receipts.issuedAt))
        .all();
      return { items };
    }
  );
}
