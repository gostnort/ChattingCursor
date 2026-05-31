import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ensureTokenSyncDirectoryReady,
  normalizeTokenSyncDirectory,
  validateTokenSyncDirectory,
} from "./user-config.js";


describe("user-config token sync directory", () => {
  it("默认目录缺失时可自动创建", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cc-default-sync-"));
    const nested = join(dir, ".chattingcursor");
    await ensureTokenSyncDirectoryReady(nested, { userSpecified: false });
    await validateTokenSyncDirectory(nested);
    await rm(dir, { recursive: true, force: true });
  });


  it("用户指定目录不存在时校验失败", async () => {
    const missing = join(tmpdir(), `cc-missing-${Date.now()}`);
    await assert.rejects(
      () => validateTokenSyncDirectory(missing),
      /不存在/,
    );
  });


  it("用户指定目录不可写时校验失败", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cc-readonly-sync-"));
    const nested = join(dir, "cloud");
    await import("node:fs/promises").then((fs) => fs.mkdir(nested, { recursive: true }));
    if (process.platform !== "win32") {
      await import("node:fs/promises").then((fs) => fs.chmod(nested, 0o555));
      await assert.rejects(
        () => validateTokenSyncDirectory(nested),
        /不可写/,
      );
      await import("node:fs/promises").then((fs) => fs.chmod(nested, 0o755));
    }
    await rm(dir, { recursive: true, force: true });
  });


  it("用户指定目录存在且可写时通过校验", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cc-writable-sync-"));
    await validateTokenSyncDirectory(dir);
    await rm(dir, { recursive: true, force: true });
  });


  it("onedrive: 无法解析时抛出明确错误", () => {
    assert.throws(
      () => normalizeTokenSyncDirectory("onedrive:nonexistent-subdir-xyz"),
      /无法将 onedrive:/,
    );
  });


  it("用户指定目录不会自动 mkdir", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cc-parent-"));
    const cloud = join(parent, "OneDrive-subfolder");
    await assert.rejects(
      () => ensureTokenSyncDirectoryReady(cloud, { userSpecified: true }),
      /不存在/,
    );
    await rm(parent, { recursive: true, force: true });
  });
});
