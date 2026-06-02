import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LEGACY_TOKEN_FILE_NAME,
  getDefaultTokenFileName,
  getShortHostname,
  sanitizeHostnameForFilename,
} from "./paths.js";


describe("sanitizeHostnameForFilename", () => {
  it("replaces Windows-invalid characters", () => {
    assert.equal(sanitizeHostnameForFilename('PC<>:"/\\|?*'), "PC_________");
  });


  it("returns unknown for empty input", () => {
    assert.equal(sanitizeHostnameForFilename("   "), "unknown");
  });
});


describe("getDefaultTokenFileName", () => {
  it("uses legacy name when env override matches old default", () => {
    const prev = process.env.CHATTINGCURSOR_TOKEN_FILE_NAME;
    process.env.CHATTINGCURSOR_TOKEN_FILE_NAME = LEGACY_TOKEN_FILE_NAME;
    try {
      assert.equal(getDefaultTokenFileName(), LEGACY_TOKEN_FILE_NAME);
    } finally {
      if (prev === undefined) {
        delete process.env.CHATTINGCURSOR_TOKEN_FILE_NAME;
      } else {
        process.env.CHATTINGCURSOR_TOKEN_FILE_NAME = prev;
      }
    }
  });


  it("embeds short hostname in default pattern", () => {
    const prev = process.env.CHATTINGCURSOR_TOKEN_FILE_NAME;
    delete process.env.CHATTINGCURSOR_TOKEN_FILE_NAME;
    try {
      const name = getDefaultTokenFileName();
      const host = getShortHostname();
      assert.equal(name, `chattingcursor-${host}-token.txt`);
    } finally {
      if (prev === undefined) {
        delete process.env.CHATTINGCURSOR_TOKEN_FILE_NAME;
      } else {
        process.env.CHATTINGCURSOR_TOKEN_FILE_NAME = prev;
      }
    }
  });
});
