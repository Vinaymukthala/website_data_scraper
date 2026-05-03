/**
 * CLI: load a JSON payload and run parallelSemanticSearch.
 * Usage: node runSemanticCli.js [path/to/payload.json]
 * Default: ./parallel_semantic_payload.json
 * Shape: { "input": { ... } } or top-level same as `input`.
 */
import fs from "node:fs";
import { parallelSemanticSearch } from "./main.js";

const payloadPath = process.argv[2] || "./parallel_semantic_payload.json";
const raw = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
const input = raw.input ?? raw;
const result = await parallelSemanticSearch(input);
console.log(JSON.stringify(result, null, 2));
