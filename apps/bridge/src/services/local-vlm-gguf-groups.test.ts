import assert from "node:assert/strict";
import test from "node:test";
import { groupGgufFilenames } from "./local-llm-gguf-group.js";


function attachMmproj(mainFiles: string[], mmprojFiles: string[]) {
  const groups = groupGgufFilenames(mainFiles);
  for (const group of groups) {
    const quant = group.groupKey.match(/q\d+_[a-z0-9]+/i)?.[0]?.toLowerCase();
    const match = quant
      ? mmprojFiles.find((file) => file.toLowerCase().includes(quant))
      : mmprojFiles[0];
    if (match) {
      group.filenames.push(match);
    }
  }
  return groups;
}


test("视觉分组自动附带 mmproj", () => {
  const groups = attachMmproj(
    ["qwen3-vl-embedding-2b-Q4_0.gguf"],
    ["mmproj-Q4_0.gguf", "mmproj-F16.gguf"],
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.filenames.length, 2);
  assert.ok(groups[0]?.filenames.some((file) => file.includes("mmproj")));
});
