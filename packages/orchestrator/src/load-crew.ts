import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crewSpecSchema, type CrewSpec } from "@chatting-cursor/shared";
import yaml from "yaml";


const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(MODULE_DIR, "../../..");
export const CREWS_DIR = path.join(REPO_ROOT, "configs", "crews");
export const RUN_CREW_SCRIPT = path.join(REPO_ROOT, "scripts", "run-crew.py");


/** 解析 crew YAML 并用 shared schema 校验 */
export async function loadCrewSpec(crewName: string): Promise<{ path: string; spec: CrewSpec }> {
  const configPath = resolveCrewConfigPath(crewName);
  const raw = await readFile(configPath, "utf8");
  const parsed = yaml.parse(raw) as unknown;
  const spec = crewSpecSchema.parse(parsed);
  return { path: configPath, spec };
}


/** 解析 configs/crews 下的配置路径 */
export function resolveCrewConfigPath(crewName: string): string {
  return path.join(CREWS_DIR, `${crewName}.yaml`);
}
