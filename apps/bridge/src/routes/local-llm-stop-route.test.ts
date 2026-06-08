import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerLocalLlmRoutes } from "./local-llm.js";


test("POST /local-llm/stop 空闲时返回 ok 且 unloaded 为 false", async () => {
  const app = Fastify({ logger: false });
  await registerLocalLlmRoutes(app);
  const response = await app.inject({
    method: "POST",
    url: "/local-llm/stop",
    remoteAddress: "127.0.0.1",
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { ok: boolean; unloaded: boolean; llmUnloaded: boolean; vlmUnloaded: boolean };
  assert.equal(body.ok, true);
  assert.equal(body.unloaded, false);
  assert.equal(body.llmUnloaded, false);
  assert.equal(body.vlmUnloaded, false);
  await app.close();
});


test("POST /local-llm/stop 响应含 unloaded 与 llm/vlm 卸载字段", async () => {
  const app = Fastify({ logger: false });
  await registerLocalLlmRoutes(app);
  const response = await app.inject({
    method: "POST",
    url: "/local-llm/stop",
    remoteAddress: "127.0.0.1",
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    ok: boolean;
    unloaded: boolean;
    llmUnloaded: boolean;
    vlmUnloaded: boolean;
  };
  assert.equal(body.ok, true);
  assert.equal(typeof body.unloaded, "boolean");
  assert.equal(body.unloaded, body.llmUnloaded || body.vlmUnloaded);
  await app.close();
});


test("POST /local-llm/stop 重复调用仍成功", async () => {
  const app = Fastify({ logger: false });
  await registerLocalLlmRoutes(app);
  const first = await app.inject({
    method: "POST",
    url: "/local-llm/stop",
    remoteAddress: "127.0.0.1",
  });
  const second = await app.inject({
    method: "POST",
    url: "/local-llm/stop",
    remoteAddress: "127.0.0.1",
  });
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  const body = second.json() as { ok: boolean; unloaded: boolean };
  assert.equal(body.ok, true);
  assert.equal(body.unloaded, false);
  await app.close();
});


test("POST /local-llm/stop 非本机请求返回 403", async () => {
  const app = Fastify({ logger: false });
  await registerLocalLlmRoutes(app);
  const response = await app.inject({
    method: "POST",
    url: "/local-llm/stop",
    remoteAddress: "203.0.113.1",
  });
  assert.equal(response.statusCode, 403);
  await app.close();
});
