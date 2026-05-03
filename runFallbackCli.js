/**
 * Test realtime fallback only (no semantic search / Kore APIs).
 *
 * Usage:
 *   node runFallbackCli.js [path/to.json]
 *   node runFallbackCli.js --json '{"brand":"Glock","model":"19","caliber":"9mm","firearmtype":"HANDGUN"}'
 *
 * JSON file: use { "input": { "metaQuery": { ... } } } or { "metaQuery": { ... } } or top-level metaQuery fields.
 */
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { runFallbackScrapeOnly } = require("./semanticService");

function parseMetaQueryFromArgv() {
  const j = process.argv.indexOf("--json");
  if (j !== -1 && process.argv[j + 1]) {
    return JSON.parse(process.argv[j + 1]);
  }
  const path = process.argv[2] || "./parallel_semantic_payload.json";
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  return raw.input?.metaQuery ?? raw.metaQuery ?? raw;
}

const metaQuery = parseMetaQueryFromArgv();
const result = await runFallbackScrapeOnly(metaQuery);
console.log(JSON.stringify(result, null, 2));
