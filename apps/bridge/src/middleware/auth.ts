import type { FastifyReply, FastifyRequest } from "fastify";
import { tokenRotationService } from "../services/token-rotation.js";


export function isLocalRequest(request: FastifyRequest): boolean {
  if (request.headers["cf-ray"] || request.headers["x-forwarded-for"]) {
    return false;
  }
  const address = request.ip;
  return address === "127.0.0.1"
    || address === "::1"
    || address === "::ffff:127.0.0.1"
    || address === "localhost";
}


function readBearerToken(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization?.trim();
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  const queryToken = (request.query as { token?: string } | undefined)?.token;
  return queryToken?.trim() || undefined;
}


export async function requireRemoteToken(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (isLocalRequest(request)) {
    return;
  }
  const token = readBearerToken(request);
  const valid = await tokenRotationService.verifyToken(token);
  if (valid) {
    return;
  }
  await reply.status(401).send({
    error: "unauthorized",
    message: "远程访问需要当天口令。",
  });
}
