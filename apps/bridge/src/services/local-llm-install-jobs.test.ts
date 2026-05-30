import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getLocalLlmInstallJobsDir } from "../paths.js";
import {
  cacheInstallJob,
  getInstallJobStatus,
  recoverStaleInstallJobs,
  resetInstallJobsForTest,
  saveInstallJob,
} from "./local-llm-install-jobs.js";
import { encodeHfRepoId, resolveInstallGgufFilenames } from "./local-llm-store.js";


test("encodeHfRepoId 支持 Qwen3.5 仓库名中的点号", () => {
  assert.equal(encodeHfRepoId("unsloth/Qwen3.5-9B-GGUF"), "unsloth/Qwen3.5-9B-GGUF");
});


test("resolveInstallGgufFilenames 未指定 filenames 时拒绝安装", async () => {
  await assert.rejects(
    () => resolveInstallGgufFilenames("unsloth/Qwen3.5-9B-GGUF", []),
    /请先在界面选择/,
  );
});


test("resolveInstallGgufFilenames 使用指定 filenames", async () => {
  const files = await resolveInstallGgufFilenames("unsloth/Qwen3.5-9B-GGUF", [
    "Qwen3.5-9B-Q4_K_M.gguf",
    "subdir/Qwen3.5-9B-Q8_0.gguf",
  ]);
  assert.deepEqual(files, ["Qwen3.5-9B-Q4_K_M.gguf", "subdir/Qwen3.5-9B-Q8_0.gguf"]);
});


test("cacheInstallJob 在 saveInstallJob 落盘前可被轮询命中", async () => {
  resetInstallJobsForTest();
  const jobId = "install-immediate-789";
  cacheInstallJob({ jobId, state: "running", progress: "排队中…" });
  const status = await getInstallJobStatus(jobId);
  assert.equal(status?.state, "running");
});


test("install job 持久化后可跨内存重启查询", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cc-install-job-"));
  const previousRepo = process.env.CHATTINGCURSOR_REPO_ROOT;
  const previousJobs = process.env.CHATTINGCURSOR_LOCAL_LLM_INSTALL_JOBS_DIR;
  t.after(async () => {
    process.env.CHATTINGCURSOR_REPO_ROOT = previousRepo ?? "";
    process.env.CHATTINGCURSOR_LOCAL_LLM_INSTALL_JOBS_DIR = previousJobs ?? "";
    resetInstallJobsForTest();
    await rm(tempRoot, { recursive: true, force: true });
  });
  process.env.CHATTINGCURSOR_REPO_ROOT = tempRoot;
  process.env.CHATTINGCURSOR_LOCAL_LLM_INSTALL_JOBS_DIR = path.join(tempRoot, "install-jobs");
  resetInstallJobsForTest();
  const jobId = "install-test-123";
  await saveInstallJob({ jobId, state: "done", progress: "完成" });
  assert.equal(
    await import("node:fs/promises").then((fs) =>
      fs.access(path.join(getLocalLlmInstallJobsDir(), "install-test-123.json")).then(() => true).catch(() => false),
    ),
    true,
  );
  resetInstallJobsForTest();
  const status = await getInstallJobStatus(jobId);
  assert.equal(status?.state, "done");
  assert.equal(status?.progress, "完成");
});


test("recoverStaleInstallJobs 将 running 任务标记为中断", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cc-install-stale-"));
  const previousRepo = process.env.CHATTINGCURSOR_REPO_ROOT;
  const previousJobs = process.env.CHATTINGCURSOR_LOCAL_LLM_INSTALL_JOBS_DIR;
  t.after(async () => {
    process.env.CHATTINGCURSOR_REPO_ROOT = previousRepo ?? "";
    process.env.CHATTINGCURSOR_LOCAL_LLM_INSTALL_JOBS_DIR = previousJobs ?? "";
    resetInstallJobsForTest();
    await rm(tempRoot, { recursive: true, force: true });
  });
  process.env.CHATTINGCURSOR_REPO_ROOT = tempRoot;
  process.env.CHATTINGCURSOR_LOCAL_LLM_INSTALL_JOBS_DIR = path.join(tempRoot, "install-jobs");
  resetInstallJobsForTest();
  const jobId = "install-stale-456";
  await saveInstallJob({ jobId, state: "running", progress: "下载中" });
  resetInstallJobsForTest();
  await recoverStaleInstallJobs();
  const status = await getInstallJobStatus(jobId);
  assert.equal(status?.state, "error");
  assert.match(status?.error ?? "", /Bridge 已重启/);
});


test("migrateLegacyInstallJobsDir 迁移 local_llm/.install-jobs", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cc-install-migrate-"));
  const previousRepo = process.env.CHATTINGCURSOR_REPO_ROOT;
  const previousLocal = process.env.CHATTINGCURSOR_LOCAL_LLM_DIR;
  const previousJobs = process.env.CHATTINGCURSOR_LOCAL_LLM_INSTALL_JOBS_DIR;
  t.after(async () => {
    process.env.CHATTINGCURSOR_REPO_ROOT = previousRepo ?? "";
    process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = previousLocal ?? "";
    process.env.CHATTINGCURSOR_LOCAL_LLM_INSTALL_JOBS_DIR = previousJobs ?? "";
    resetInstallJobsForTest();
    await rm(tempRoot, { recursive: true, force: true });
  });
  process.env.CHATTINGCURSOR_REPO_ROOT = tempRoot;
  process.env.CHATTINGCURSOR_LOCAL_LLM_DIR = path.join(tempRoot, "local_llm");
  process.env.CHATTINGCURSOR_LOCAL_LLM_INSTALL_JOBS_DIR = path.join(tempRoot, ".chattingcursor", "local-llm-install-jobs");
  resetInstallJobsForTest();
  const legacyDir = path.join(tempRoot, "local_llm", ".install-jobs");
  const jobId = "install-legacy-migrate";
  await import("node:fs/promises").then(async (fs) => {
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(
      path.join(legacyDir, `${jobId}.json`),
      `${JSON.stringify({ jobId, state: "done", progress: "完成" }, null, 2)}\n`,
      "utf8",
    );
  });
  const status = await getInstallJobStatus(jobId);
  assert.equal(status?.state, "done");
  assert.equal(
    await import("node:fs/promises").then((fs) =>
      fs.access(path.join(getLocalLlmInstallJobsDir(), `${jobId}.json`)).then(() => true).catch(() => false),
    ),
    true,
  );
  assert.equal(
    await import("node:fs/promises").then((fs) =>
      fs.access(legacyDir).then(() => true).catch(() => false),
    ),
    false,
  );
});
