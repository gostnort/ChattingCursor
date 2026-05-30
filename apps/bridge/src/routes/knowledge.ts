import type { FastifyInstance } from "fastify";
import { knowledgeCreateNodeRequestSchema, knowledgeRenameNodeRequestSchema } from "@chatting-cursor/shared";
import { requireRemoteToken } from "../middleware/auth.js";
import { isLocalRequest } from "../middleware/auth.js";
import {
  createKnowledgeChild,
  deleteKnowledgeNode,
  listKnowledgeTree,
  renameKnowledgeNode,
  uploadKnowledgeMarkdown,
} from "../services/knowledge-store.js";


/** 注册知识库 wiki 路由（本机可写，远程可读需 token + 本机 Bridge） */
export async function registerKnowledgeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/knowledge")) {
      return;
    }
    await requireRemoteToken(request, reply);
    const writeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
    if (writeMethods.has(request.method) && !isLocalRequest(request)) {
      return reply.status(403).send({
        error: "local_only",
        message: "知识库写入 API 仅允许本机访问",
      });
    }
  });


  app.get("/knowledge/tree", async (_request, reply) => {
    const tree = await listKnowledgeTree();
    return reply.send(tree);
  });


  app.post("/knowledge/nodes", async (request, reply) => {
    const parsed = knowledgeCreateNodeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }
    try {
      const node = await createKnowledgeChild(parsed.data.parentId, parsed.data.name);
      return reply.send({ node });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(400).send({ error: "create_failed", message });
    }
  });


  app.post("/knowledge/nodes/:nodeId/content", async (request, reply) => {
    const { nodeId } = request.params as { nodeId: string };
    const file = await request.file();
    if (!file) {
      return reply.status(400).send({ error: "missing_file", message: "Expected multipart field 'file' (.md)" });
    }
    const buffer = await file.toBuffer();
    const text = buffer.toString("utf8");
    try {
      const bytes = await uploadKnowledgeMarkdown(nodeId, text);
      return reply.send({ nodeId, bytes });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(400).send({ error: "upload_failed", message });
    }
  });


  app.patch("/knowledge/nodes/:nodeId", async (request, reply) => {
    const { nodeId } = request.params as { nodeId: string };
    const parsed = knowledgeRenameNodeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }
    try {
      const node = await renameKnowledgeNode(nodeId, parsed.data.name);
      return reply.send({ node });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(400).send({ error: "rename_failed", message });
    }
  });


  app.delete("/knowledge/nodes/:nodeId", async (request, reply) => {
    const { nodeId } = request.params as { nodeId: string };
    try {
      await deleteKnowledgeNode(nodeId);
      return reply.send({ ok: true, nodeId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(400).send({ error: "delete_failed", message });
    }
  });
}
