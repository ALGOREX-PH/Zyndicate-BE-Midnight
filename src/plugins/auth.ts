import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import type { Env } from "../config/env.js";
import { unauthorized } from "../lib/errors.js";

const ISSUER = "zyndicate";
export const TOKEN_TTL = "24h";

export interface AuthContext {
  publicKey: string;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
  interface FastifyInstance {
    /** preHandler that requires a valid bearer token. */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** preHandler that attaches auth when a bearer token is present and valid. */
    optionalAuthenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export async function signSessionToken(env: Env, publicKey: string): Promise<string> {
  const secret = new TextEncoder().encode(env.JWT_SECRET);
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(publicKey)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(secret);
}

async function resolveAuth(env: Env, request: FastifyRequest): Promise<AuthContext | null> {
  const header = request.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  try {
    const secret = new TextEncoder().encode(env.JWT_SECRET);
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER });
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
    return { publicKey: payload.sub.toLowerCase() };
  } catch {
    return null;
  }
}

export function registerAuth(app: FastifyInstance, env: Env): void {
  app.decorateRequest("auth", null);

  app.decorate("authenticate", async (request: FastifyRequest, _reply: FastifyReply) => {
    const auth = await resolveAuth(env, request);
    if (!auth) throw unauthorized("A valid bearer token is required");
    request.auth = auth;
  });

  app.decorate(
    "optionalAuthenticate",
    async (request: FastifyRequest, _reply: FastifyReply) => {
      request.auth = await resolveAuth(env, request);
    }
  );
}

/** Convenience for handlers behind `authenticate`. */
export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthorized();
  return request.auth;
}
