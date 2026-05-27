import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenRotationService } from "../apps/bridge/src/services/token-rotation.ts";

function parseTokenFile(content) {
  const fields = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const sep = trimmed.indexOf(":");
    if (sep < 0) {
      continue;
    }
    const key = trimmed.slice(0, sep).trim().toLowerCase();
    fields[key] = trimmed.slice(sep + 1).trim();
  }
  return fields;
}

const dir = await mkdtemp(join(tmpdir(), "cc-token-test-"));
const service = new TokenRotationService({
  directory: dir,
  publicBridgeUrl: "https://first.trycloudflare.com",
});

try {
  await service.updatePublicBridgeUrl("https://first.trycloudflare.com");
  const firstPath = service.getFilePath();
  const firstRaw = await readFile(firstPath, "utf8");
  const first = parseTokenFile(firstRaw);
  if (first.generatedat) {
    throw new Error("token file must not contain generatedAt");
  }
  if (!first.datetime || !first.token) {
    throw new Error("first rotation missing datetime or token");
  }

  await new Promise((resolve) => setTimeout(resolve, 5));
  await service.updatePublicBridgeUrl("https://second.trycloudflare.com");
  const secondRaw = await readFile(firstPath, "utf8");
  const second = parseTokenFile(secondRaw);
  if (second.generatedat) {
    throw new Error("token file must not contain generatedAt after second rotation");
  }
  if (second.token === first.token) {
    throw new Error(`token unchanged after reconnect simulation: ${second.token}`);
  }
  if (second.previousdatetime !== first.datetime) {
    throw new Error(
      `previousDatetime mismatch: expected ${first.datetime}, got ${second.previousdatetime ?? "(missing)"}`,
    );
  }
  if (second.publicbridgeurl !== "https://second.trycloudflare.com") {
    throw new Error(`publicBridgeUrl not updated: ${second.publicbridgeurl}`);
  }

  console.log("OK token rotation test");
  console.log(`  token1=${first.token}`);
  console.log(`  token2=${second.token}`);
  console.log(`  previousDatetime=${second.previousdatetime}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
