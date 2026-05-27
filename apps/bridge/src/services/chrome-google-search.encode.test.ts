import assert from "node:assert/strict";
import { buildGoogleSearchUrl } from "./chrome-google-search.js";


const sampleQuery = "哲学家对Kathara的评价";
const searchUrl = buildGoogleSearchUrl(sampleQuery);
const parsed = new URL(searchUrl);
assert.equal(decodeURIComponent(parsed.searchParams.get("q") ?? ""), sampleQuery);
assert.ok(searchUrl.includes("%E5%93%B2"), "Chinese must be UTF-8 percent-encoded once in q=");
assert.ok(!searchUrl.includes(sampleQuery), "raw Unicode must not appear in URL");
assert.ok(
  encodeURIComponent(searchUrl).includes("%25"),
  "encodeURIComponent on full URL double-encodes % (old openTab bug)",
);
