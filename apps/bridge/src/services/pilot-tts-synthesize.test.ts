import assert from "node:assert/strict";
import test from "node:test";
import {
  isValidPromptAudioPath,
  mergeSynthesizePayload,
  requiresInstructSynthesis,
} from "./pilot-tts-synthesize.js";


const emptyTtsDefaults = {
  pilotTtsPromptWavPath: "",
  pilotTtsDefaultEmotion: "",
  pilotTtsDefaultLanguage: "",
};


test("mergeSynthesizePayload 仅 text 时省略可选字段", () => {
  const merged = mergeSynthesizePayload({ text: "hello" }, emptyTtsDefaults);
  assert.deepEqual(merged, { text: "hello" });
});


test("mergeSynthesizePayload 合并持久化默认", () => {
  const merged = mergeSynthesizePayload(
    { text: "hello" },
    {
      pilotTtsPromptWavPath: "C:\\voice\\default.wav",
      pilotTtsDefaultEmotion: "happy",
      pilotTtsDefaultLanguage: "zh-henan",
    },
  );
  assert.deepEqual(merged, {
    text: "hello",
    promptWav: "C:\\voice\\default.wav",
    emotion: "happy",
    language: "zh-henan",
  });
});


test("mergeSynthesizePayload 请求字段覆盖默认且空字符串回退默认", () => {
  const merged = mergeSynthesizePayload(
    {
      text: "hello",
      promptWav: "",
      emotion: "neutral",
      language: "",
    },
    {
      pilotTtsPromptWavPath: "C:\\voice\\default.wav",
      pilotTtsDefaultEmotion: "happy",
      pilotTtsDefaultLanguage: "zh-henan",
    },
  );
  assert.deepEqual(merged, {
    text: "hello",
    emotion: "neutral",
  });
});


test("mergeSynthesizePayload per-request 覆盖默认", () => {
  const merged = mergeSynthesizePayload(
    {
      text: "hello",
      promptWav: "D:\\voice\\override.mp3",
      emotion: "sad",
      language: "zh-shanghai",
    },
    {
      pilotTtsPromptWavPath: "C:\\voice\\default.wav",
      pilotTtsDefaultEmotion: "happy",
      pilotTtsDefaultLanguage: "zh-henan",
    },
  );
  assert.deepEqual(merged, {
    text: "hello",
    promptWav: "D:\\voice\\override.mp3",
    emotion: "sad",
    language: "zh-shanghai",
  });
});


test("isValidPromptAudioPath 接受 wav 与 mp3", () => {
  assert.equal(isValidPromptAudioPath("C:\\a\\voice.wav"), true);
  assert.equal(isValidPromptAudioPath("C:\\a\\voice.WAV"), true);
  assert.equal(isValidPromptAudioPath("/tmp/ref.mp3"), true);
  assert.equal(isValidPromptAudioPath("/tmp/ref.MP3"), true);
  assert.equal(isValidPromptAudioPath("/tmp/ref.txt"), false);
});


test("requiresInstructSynthesis 在 emotion 或 language 存在时为 true", () => {
  assert.equal(requiresInstructSynthesis({ text: "x", emotion: "happy" }), true);
  assert.equal(requiresInstructSynthesis({ text: "x", language: "zh-henan" }), true);
  assert.equal(requiresInstructSynthesis({ text: "x", promptWav: "a.wav" }), false);
  assert.equal(requiresInstructSynthesis({ text: "x" }), false);
});
