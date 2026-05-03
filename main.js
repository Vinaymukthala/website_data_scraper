import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parallelSemanticSearchService } = require("./semanticService");

/**
 * Run a parallel semantic search across the provided namespaces.
 *
 * @param {object} [input={}] - Search parameters (see semanticService for schema).
 * @returns {Promise<{ elapsedTime: number, mergedListings: any[], needToSendToLLM: object[], error?: string }>}
 */
async function parallelSemanticSearch(input) {
  return parallelSemanticSearchService(input || {});
}

export { parallelSemanticSearch };
