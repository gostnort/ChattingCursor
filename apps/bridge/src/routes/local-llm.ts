import type { FastifyInstance } from "fastify";
import { isLocalRequest } from "../middleware/auth.js";
import {
  addLocalLlmAuthor,
  cancelActiveInstallsForModel,
  deleteInstalledLocalLlmModel,
  findInstalledLocalLlmModel,
  getInstallJobStatus,
  listHfGgufGroups,
  listHfModelsByAuthor,
  listInstalledLocalLlmModels,
  listLocalLlmAuthors,
  parseLocalLlmRouteModelId,
  startLocalLlmInstall,
  updateLocalLlmDefaultPrompt,
} from "../services/local-llm-store.js";
import { forceStopLocalLlmSidecar } from "../services/local-llm-lifecycle.js";


function readStringField(body: unknown, key: string): string {
  if (!body || typeof body !== "object") {
    return "";
  }
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}


function readStringArrayField(body: unknown, key: string): string[] {
  if (!body || typeof body !== "object") {
    return [];
  }
  const value = (body as Record<string, unknown>)[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}


/** 注册 local-llm 管理路由（仅本机） */
export async function registerLocalLlmRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/local-llm/")) {
      return;
    }
    if (!isLocalRequest(request)) {
      return reply.status(403).send({
        error: "local_only",
        message: "local-llm API 仅允许本机访问",
      });
    }
  });


  app.get("/local-llm/authors", async (_request, reply) => {
    const authors = await listLocalLlmAuthors();
    return reply.send({ authors });
  });


  app.post("/local-llm/authors", async (request, reply) => {
    const author = readStringField(request.body, "author");
    if (!author) {
      return reply.status(400).send({ error: "invalid_request", message: "缺少 author" });
    }
    try {
      const authors = await addLocalLlmAuthor(author);
      return reply.send({ authors });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(400).send({ error: "invalid_request", message });
    }
  });


  app.get("/local-llm/hf/models", async (request, reply) => {
    const author = (request.query as { author?: string }).author?.trim() ?? "";
    if (!author) {
      return reply.status(400).send({ error: "invalid_request", message: "缺少 query 参数 author" });
    }
    try {
      const models = await listHfModelsByAuthor(author);
      return reply.send({ author, models });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(502).send({ error: "hf_error", message });
    }
  });


  app.get("/local-llm/hf/files", async (request, reply) => {
    const repoId = (request.query as { repo_id?: string }).repo_id?.trim() ?? "";
    if (!repoId) {
      return reply.status(400).send({ error: "invalid_request", message: "缺少 query 参数 repo_id" });
    }
    try {
      const groups = await listHfGgufGroups(repoId);
      return reply.send({ repoId, groups });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(502).send({ error: "hf_error", message });
    }
  });


  app.post("/local-llm/install", async (request, reply) => {
    const author = readStringField(request.body, "author");
    const repoId = readStringField(request.body, "repoId");
    if (!author || !repoId) {
      return reply.status(400).send({ error: "invalid_request", message: "缺少 author 或 repoId" });
    }
    const ggufGroupKey = readStringField(request.body, "ggufGroupKey");
    const filenames = readStringArrayField(request.body, "filenames");
    const jobId = startLocalLlmInstall({
      author,
      repoId,
      ggufGroupKey: ggufGroupKey || undefined,
      filenames: filenames.length > 0 ? filenames : undefined,
      displayName: readStringField(request.body, "displayName") || undefined,
      defaultPrompt: readStringField(request.body, "defaultPrompt") || undefined,
    });
    return reply.send({ jobId });
  });


  app.get("/local-llm/install/:jobId", async (request, reply) => {
    const rawJobId = (request.params as { jobId: string }).jobId;
    const jobId = decodeURIComponent(rawJobId).trim();
    const status = await getInstallJobStatus(jobId);
    if (!status) {
      return reply.status(404).send({ error: "not_found", message: "安装任务不存在" });
    }
    return reply.send(status);
  });


  app.get("/local-llm/installed", async (_request, reply) => {
    const models = await listInstalledLocalLlmModels();
    return reply.send({
      models: models.map((item) => ({
        id: item.id,
        author: item.author,
        modelSlug: item.modelSlug,
        label: `${item.author}/${item.modelSlug}`,
        displayName: item.displayName,
        defaultPrompt: item.defaultPrompt,
        weightsReady: item.weightsReady,
        repoId: item.repoId,
        ggufGroupKey: item.ggufGroupKey,
        filenames: item.filenames,
      })),
    });
  });


  app.delete("/local-llm/installed/*", async (request, reply) => {
    const rawId = (request.params as { "*": string })["*"] ?? "";
    const modelId = parseLocalLlmRouteModelId(rawId);
    if (!modelId) {
      return reply.status(400).send({ error: "invalid_request", message: "缺少 model id" });
    }
    try {
      const model = await findInstalledLocalLlmModel(modelId);
      let installCancelled = false;
      if (model) {
        installCancelled = await cancelActiveInstallsForModel(model.author, model.modelSlug);
      }
      const { unloaded: sidecarStopped } = await forceStopLocalLlmSidecar();
      await deleteInstalledLocalLlmModel(modelId);
      return reply.send({
        ok: true,
        unloaded: sidecarStopped || installCancelled,
        deleted: true,
        id: modelId,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("未找到已安装模型")) {
        return reply.status(404).send({ error: "not_found", message });
      }
      return reply.status(500).send({ error: "delete_failed", message });
    }
  });


  app.patch("/local-llm/installed/*", async (request, reply) => {
    const rawId = (request.params as { "*": string })["*"] ?? "";
    const modelId = parseLocalLlmRouteModelId(rawId);
    if (!modelId) {
      return reply.status(400).send({ error: "invalid_request", message: "缺少 model id" });
    }
    const defaultPrompt = readStringField(request.body, "defaultPrompt");
    if (!request.body || typeof request.body !== "object" || !("defaultPrompt" in request.body)) {
      return reply.status(400).send({ error: "invalid_request", message: "缺少 defaultPrompt" });
    }
    try {
      const model = await updateLocalLlmDefaultPrompt(modelId, defaultPrompt);
      return reply.send({ model });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(404).send({ error: "not_found", message });
    }
  });
}
