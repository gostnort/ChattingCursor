#!/usr/bin/env node
/** 监听代码变更与 CLI 结束，自动 typecheck/lint */
import process from "node:process";
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_BRIDGE_URL = "http://127.0.0.1:4321";
const DEFAULT_DEBOUNCE_MS = 3000;
const DEFAULT_CLI_POLL_MS = 2000;
const WATCH_DIRS = ["apps", "packages", "scripts", "configs"];
const IGNORE_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  ".git",
  ".venv",
  "coverage",
  ".turbo",
]);
const WATCH_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".yaml",
  ".yml",
  ".py",
  ".ps1",
]);
const QUALITY_COMMANDS = [
  ["pnpm", "typecheck"],
  ["pnpm", "lint"],
];
const bridgeUrl = (process.env.BRIDGE_URL ?? DEFAULT_BRIDGE_URL).replace(/\/$/, "");
const debounceMs = Number.parseInt(process.env.QUALITY_WATCH_DEBOUNCE_MS ?? "", 10) || DEFAULT_DEBOUNCE_MS;
const cliPollMs = Number.parseInt(process.env.QUALITY_WATCH_CLI_POLL_MS ?? "", 10) || DEFAULT_CLI_POLL_MS;
let debounceTimer = null;
let running = false;
let pending = false;
let lastSeenRunKey = "";


function printUsage() {
  console.log("Usage: pnpm quality:watch");
  console.log("");
  console.log("Watches repo source changes and CLI run completion, then runs typecheck/lint.");
  console.log("");
  console.log(`Repo root: ${REPO_ROOT}`);
  console.log(`Bridge URL: ${bridgeUrl}`);
  console.log(`Debounce: ${debounceMs}ms`);
  console.log("");
  console.log("Environment: BRIDGE_URL, QUALITY_WATCH_DEBOUNCE_MS, QUALITY_WATCH_CLI_POLL_MS");
}


function shouldWatchPath(filePath) {
  const relative = path.relative(REPO_ROOT, filePath);
  if (!relative || relative.startsWith("..")) {
    return false;
  }
  const parts = relative.split(path.sep);
  for (const part of parts) {
    if (IGNORE_DIR_NAMES.has(part)) {
      return false;
    }
  }
  return WATCH_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}


function runCommand(command, commandArgs, label) {
  return new Promise((resolve) => {
    console.log(`\n[quality-watch] Running ${label}: ${command} ${commandArgs.join(" ")}`);
    const child = spawn(command, commandArgs, {
      cwd: REPO_ROOT,
      env: process.env,
      shell: process.platform === "win32",
      windowsHide: true,
    });
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });
    child.on("close", (code) => {
      resolve(code ?? 1);
    });
    child.on("error", (error) => {
      console.error(`[quality-watch] Failed to start ${label}: ${error.message}`);
      resolve(1);
    });
  });
}


async function runQualityCycle(reason) {
  if (running) {
    pending = true;
    console.log(`[quality-watch] Quality cycle already running; queued (${reason}).`);
    return;
  }
  running = true;
  pending = false;
  console.log(`\n[quality-watch] === Quality cycle started (${reason}) ===`);
  let passed = true;
  for (const entry of QUALITY_COMMANDS) {
    const [command, ...commandArgs] = entry;
    const exitCode = await runCommand(command, commandArgs, commandArgs.join(" "));
    if (exitCode !== 0) {
      passed = false;
      console.error(`[quality-watch] ${command} ${commandArgs.join(" ")} failed with exit code ${exitCode}.`);
      break;
    }
  }
  if (passed) {
    console.log("[quality-watch] Quality checks passed.");
  } else {
    console.log("[quality-watch] Quality checks failed.");
  }
  console.log(`[quality-watch] === Quality cycle finished (${reason}) ===\n`);
  running = false;
  if (pending) {
    scheduleQualityCycle("queued changes");
  }
}


function scheduleQualityCycle(reason) {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runQualityCycle(reason);
  }, debounceMs);
}


function attachWatchers() {
  for (const dirName of WATCH_DIRS) {
    const dirPath = path.join(REPO_ROOT, dirName);
    try {
      watch(dirPath, { recursive: true }, (_eventType, fileName) => {
        if (!fileName) {
          return;
        }
        const fullPath = path.join(dirPath, fileName);
        if (!shouldWatchPath(fullPath)) {
          return;
        }
        scheduleQualityCycle(`file change: ${path.relative(REPO_ROOT, fullPath)}`);
      });
      console.log(`[quality-watch] Watching ${path.relative(REPO_ROOT, dirPath)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[quality-watch] Could not watch ${dirPath}: ${message}`);
    }
  }
}


async function pollLatestCliRun() {
  try {
    const response = await fetch(`${bridgeUrl}/chat/latest-run`);
    if (response.status === 404) {
      return;
    }
    if (!response.ok) {
      return;
    }
    const payload = await response.json();
    const runKey = `${payload.runId ?? ""}:${payload.status ?? ""}:${payload.updatedAt ?? ""}`;
    if (!payload.runId || payload.status !== "finished") {
      return;
    }
    if (runKey === lastSeenRunKey) {
      return;
    }
    lastSeenRunKey = runKey;
    scheduleQualityCycle(`CLI run finished: ${payload.runId}`);
  } catch {
    // Bridge 可能尚未启动，忽略轮询错误
  }
}


function startCliPolling() {
  setInterval(() => {
    void pollLatestCliRun();
  }, cliPollMs);
}


console.log("[quality-watch] Daemon started.");
printUsage();
attachWatchers();
startCliPolling();
scheduleQualityCycle("startup");
