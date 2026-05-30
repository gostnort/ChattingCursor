import assert from "node:assert/strict";
import test from "node:test";
import {
  bytesFromHfTreeEntry,
  computeDownloadPercent,
  formatInstallProgressLabel,
  sumSelectedHfFileBytes,
} from "./local-llm-hf-size.js";


test("bytesFromHfTreeEntry 优先 LFS size", () => {
  assert.equal(bytesFromHfTreeEntry({ size: 120, lfs: { size: 9_000_000_000 } }), 9_000_000_000);
  assert.equal(bytesFromHfTreeEntry({ size: 500 }), 500);
  assert.equal(bytesFromHfTreeEntry({}), null);
});


test("sumSelectedHfFileBytes 聚合多文件总大小", () => {
  const tree = [
    { type: "file", path: "a.gguf", size: 100, lfs: { size: 1_000 } },
    { type: "file", path: "subdir/b.gguf", lfs: { size: 2_000 } },
    { type: "file", path: "other.gguf", size: 99 },
  ];
  assert.equal(sumSelectedHfFileBytes(tree, ["a.gguf", "subdir/b.gguf"]), 3_000);
  assert.equal(sumSelectedHfFileBytes(tree, ["missing.gguf"]), null);
});


test("computeDownloadPercent 限制 0–100", () => {
  assert.equal(computeDownloadPercent(500, 1000), 50);
  assert.equal(computeDownloadPercent(1500, 1000), 100);
  assert.equal(computeDownloadPercent(100, null), null);
});


test("formatInstallProgressLabel 未知总量显示计算中", () => {
  assert.match(formatInstallProgressLabel(1_500_000_000, null, null), /已下载.*计算中/);
  assert.match(formatInstallProgressLabel(500_000_000, 1_000_000_000, 50), /50%/);
});
