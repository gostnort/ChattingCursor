import type { FastifyInstance } from "fastify";
import { isLocalRequest } from "../middleware/auth.js";
import {
  addLocalVlmAuthor,
  DEFAULT_OFFLINE_VLM_AUTHOR,
  DEFAULT_OFFLINE_VLM_REPO,
  deleteInstalledLocalVlmModel,
  findInstalledLocalVlmModel,
  getInstallJobStatus,
  listHfVlmGgufGroups,
  listHfVlmModelsByAuthor,
  listInstalledLocalVlmModels,
  listLocalVlmAuthors,
  parseLocalVlmRouteModelId,
  startLocalVlmInstall,
} from "../services/local-vlm-store.js";
import { readOfflineVisionSettings, writeOfflineVisionSettings } from "../services/offline-vision-settings.js";


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


/** 注册 local-vlm 管理路由（仅本机） */
export async function registerLocalVlmRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/local-vlm/")) {
      return;
    }
    if (!isLocalRequest(request)) {
      return reply.status(403).send({
        error: "local_only",
        message: "local-vlm API 仅允许本机访问",
      });
    }
  });


  app.get("/local-vlm/settings", async (_request, reply) => {
    const settings = await readOfflineVisionSettings();
    const installed = await listInstalledLocalVlmModels();
    return reply.send({
      ...settings,
      defaultRepoId: DEFAULT_OFFLINE_VLM_REPO,
      defaultAuthor: DEFAULT_OFFLINE_VLM_AUTHOR,
      installed: installed.map((item) => ({
        id: item.id,
        label: `${item.author}/${item.modelSlug}`,
        repoId: item.repoId,
        weightsReady: item.weightsReady,
      })),
    });
  });


  app.patch("/local-vlm/settings", async (request, reply) => {
    const body = request.body ?? {};
    const enabled = typeof (body as { enabled?: boolean }).enabled === "boolean"
      ? (body as { enabled: boolean }).enabled
      : undefined;
    const selectedModelId = readStringField(body, "selectedModelId") || undefined;
    const settings = await writeOfflineVisionSettings({ enabled, selectedModelId });
    return reply.send(settings);
  });


  app.get("/local-vlm/authors", async (_request, reply) => {
    const authors = await listLocalVlmAuthors();
    return reply.send({ authors });
  });


  app.post("/local-vlm/authors", async (request, reply) => {
    const author = readStringField(request.body, "author");
    if (!author) {
      return reply.status(400).send({ error: "invalid_request", message: "缺少 author" });
    }
    const authors = await addLocalVlmAuthor(author);
    return reply.send({ authors });
  });


  app.get("/local-vlm/hf/models", async (request, reply) => {
    const author = (request.query as { author?: string }).author?.trim() ?? "";
    if (!author) {
      return reply.status(400).send({ error: "invalid_request", message: "缺少 query 参数 author" });
    }
    const models = await listHfVlmModelsByAuthor(author);
    return reply.send({ author, models });
  });


  app.get("/local-vlm/hf/files", async (request, reply) => {
    const repoId = (request.query as { repo_id?: string }).repo_id?.trim() ?? "";
    if (!repoId) {
      return reply.status(400).send({ error: "invalid_request", message: "缺少 query 参数 repo_id" });
    }
    const groups = await listHfVlmGgufGroups(repoId);
    return reply.send({ repoId, groups });
  });


  app.post("/local-vlm/install", async (request, reply) => {
    const author = readStringField(request.body, "author");
    const repoId = readStringField(request.body, "repoId");
    if (!author || !repoId) {
      return reply.status(400).send({ error: "invalid_request", message: "缺少 author 或 repoId" });
    }
    const jobId = startLocalVlmInstall({
      author,
      repoId,
      ggufGroupKey: readStringField(request.body, "ggufGroupKey"),
      filenames: readStringArrayField(request.body, "filenames"),
      displayName: readStringField(request.body, "displayName"),
    });
    return reply.send({ jobId });
  });


  app.get("/local-vlm/install/:jobId", async (request, reply) => {
    const jobId = (request.params as { jobId: string }).jobId;
    const status = await getInstallJobStatus(jobId);
    if (!status) {
      return reply.status(404).send({ error: "not_found", message: "安装任务不存在" });
    }
    return reply.send(status);
  });


  app.get("/local-vlm/installed", async (_request, reply) => {
    const models = await listInstalledLocalVlmModels();
    return reply.send({
      models: models.map((item) => ({
        id: item.id,
        author: item.author,
        modelSlug: item.modelSlug,
        repoId: item.repoId,
        displayName: item.displayName,
        label: `${item.author}/${item.modelSlug}`,
        weightsReady: item.weightsReady,
        defaultPrompt: item.defaultPrompt,
        installedAt: item.installedAt,
      })),
    });
  });


  app.delete("/local-vlm/installed/*", async (request, reply) => {
    const raw = (request.params as { "*": string })["*"] ?? "";
    const modelId = parseLocalVlmRouteModelId(raw);
    if (!modelId) {
      return reply.status(400).send({ error: "invalid_request", message: "无效的 model id" });
    }
    await deleteInstalledLocalVlmModel(modelId);
    return reply.send({ ok: true, deleted: true });
  });


  app.get("/local-vlm/installed/*", async (request, reply) => {
    const raw = (request.params as { "*": string })["*"] ?? "";
    const modelId = parseLocalVlmRouteModelId(raw);
    const model = await findInstalledLocalVlmModel(modelId);
    if (!model) {
      return reply.status(404).send({ error: "not_found", message: "未找到视觉模型" });
    }
    return reply.send({ model });
  });
}
