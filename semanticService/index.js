
const Fuse = require("fuse.js");
const path = require("path");
const { pathToFileURL } = require("url");

const CONFIG = {
  API_URL: "https://retailassist-poc.kore.ai/semanticSearch/v2/cx/processQuery",
  API_STAGE: "dev",
  API_TOKEN: process.env.SEMANTIC_SEARCH_BEARER_TOKEN || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJib3RJZCI6IlRlc3QxMjM0IiwicHJvamVjdEFjY2VzcyI6IlNFTUFOVElDX1NFQVJDSCIsImlhdCI6MTc2MTc0MDY0Nn0.nzoUcJb3HET84Abqp2GCqIIiGX1kRG2xSzRfTjlMM3c",

  INVENTORY_API_URL: "https://platform.kore.ai/api/1.1/public/tables/Inventory_Intake/rows/query",
  INVENTORY_API_TOKEN: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhcHBJZCI6ImNzLTRlMDgzOWU5LTcwZDEtNWE4ZC05NDMzLTg4ODQ2OGE4NmE4MCJ9.4QX0FVRrS7S33rlwej4jGX4rRIu9MZwaw7L-wSe5w0M",

  FUSE_OPTIONS: { includeScore: true, threshold: 0.5, minMatchCharLength: 2 }, // brand

  DEFAULT_TOP_K: 15,
  DEFAULT_MAX_RESULTS: 15,
  DEFAULT_TIMEOUT_MS: Number(process.env.HTTP_TIMEOUT_MS || 15000),
  DEFAULT_RETRIES: Number(process.env.HTTP_RETRIES || 1),
  DEFAULT_RETRY_DELAY_MS: Number(process.env.HTTP_RETRY_DELAY_MS || 500),

  APPLY_FILTERS_ON_DB: {
    isEnabled: false,
    targetKeys: ["category_level_2", "category_level_3", "category_level_4", "price", "size", "product_rating", "grouped_warehouse_id", "isEos", "isPm"],
  },

  META_FILTER_KEYS: ["category_level_2", "category_level_3", "category_level_4", "price", "color", "product_rating", "key_features", "size", "grouped_warehouse_id", "isEos", "isPm"],

  META_OPTIONS: [{ category: { operator: "^" }, price: { operator: "arithmetic" }, size: { operator: "arithmetic" } }],
};

/* ── Helpers ── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const safeObject = (v) => isObject(v) ? v : {};
const safeArray = (v) => Array.isArray(v) ? v : [];
const firstDefined = (...args) => args.find((v) => v !== undefined && v !== null);

/* ── Validation ── */

function validateInput(input) {
  if (!isObject(input)) throw new Error("Input must be a plain object.");
  if (!Array.isArray(input.db) || !input.db.length) throw new Error("Input must contain a non-empty 'db' array.");
  input.db.forEach((entry, i) => {
    if (!entry.indexName) throw new Error(`db[${i}] must contain 'indexName'.`);
    if (!Array.isArray(entry.namespace) || !entry.namespace.length) throw new Error(`db[${i}] must contain a non-empty 'namespace' array.`);
    if (!Array.isArray(entry.hardfilters) || !entry.hardfilters.length) throw new Error(`db[${i}] must contain a non-empty 'hardfilters' array.`);
  });
  if (!isObject(input.metaQuery) || !Object.keys(input.metaQuery).length) throw new Error("Input must contain a non-empty 'metaQuery' object.");
  if (!input.sessionId) throw new Error("Input must contain 'sessionId'.");
  if (!CONFIG.API_TOKEN) throw new Error("Missing SEMANTIC_SEARCH_BEARER_TOKEN environment variable.");
}

/* ── Inventory Enrichment ── */

// In-memory cache for inventory data to avoid re-fetching on every request.
const INVENTORY_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const _inventoryCache = { data: null, fetchedAt: 0 };

/**
 * Fetches all rows from the Inventory_Intake table (cached for TTL duration).
 * Each row may have comma-separated 'brand' and 'model' strings.
 * Returns two deduplicated arrays: { brands, models }.
 */
async function fetchInventoryData() {
  const now = Date.now();
  if (_inventoryCache.data && now - _inventoryCache.fetchedAt < INVENTORY_CACHE_TTL_MS) {
    console.log("[fetchInventoryData] Returning cached inventory.");
    return _inventoryCache.data;
  }

  console.log("[fetchInventoryData] Fetching fresh inventory from API...");
  const t0 = Date.now();
  const response = await fetch(CONFIG.INVENTORY_API_URL, {
    method: "POST",
    headers: { auth: CONFIG.INVENTORY_API_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query: {} }),
  });

  if (!response.ok) throw new Error(`Inventory API error: HTTP ${response.status}`);

  const data = await response.json();
  const rows = safeArray(data.records || data.rows || data.data || data);

  const brands = new Set();
  const models = new Set();
  const calibers = new Set();

  rows.forEach((row) => {
    safeArray(typeof row.brand === "string" ? row.brand.split(",") : row.brand)
      .forEach((b) => { const v = b.trim(); if (v) brands.add(v); });

    safeArray(typeof row.model === "string" ? row.model.split(",") : row.model)
      .forEach((m) => { const v = m.trim(); if (v) models.add(v); });

    safeArray(typeof row.caliber === "string" ? row.caliber.split(",") : row.caliber)
      .forEach((c) => { const v = c.trim(); if (v) calibers.add(v); });
  });

  const result = { brands: [...brands], models: [...models], calibers: [...calibers] };
  _inventoryCache.data = result;
  _inventoryCache.fetchedAt = Date.now();
  console.log(`[fetchInventoryData] Done in ${Date.now() - t0} ms — brands: ${result.brands.length}, models: ${result.models.length}, calibers: ${result.calibers.length}`);
  return result;
}

/**
 * Fuzzy-matches a single string against a list of candidates using Fuse.js.
 *
 * Priority:
 *  1. Exact case-insensitive match — always wins ("Glock" → only "GLOCK"/"Glock", never "Galco").
 *  2. Fuzzy match — returns candidates based on returnAll flag:
 *       returnAll=false (brand): only same-normalized-form as top hit (prevents cross-brand ties)
 *       returnAll=true  (model): ALL results within threshold (captures all matching model names)
 */
function fuzzyMatchOne(value, candidates, fuseOptions = CONFIG.FUSE_OPTIONS, returnAll = false) {
  if (!value || !candidates.length) return { matched: false };
  const lv = String(value).toLowerCase();

  // ── Step 1: exact case-insensitive match ────────────────────────
  const exactMatches = candidates.filter((c) => c.toLowerCase() === lv);
  if (exactMatches.length) return { matched: true, values: exactMatches };

  // ── Step 2: fuzzy fallback ───────────────────────────────────────
  const fuse = new Fuse(candidates, fuseOptions);
  const results = fuse.search(String(value));
  if (!results.length) return { matched: false };

  const values = returnAll
    ? results.map((r) => r.item)                                         // model: all within threshold
    : results.filter((r) => r.item.toLowerCase() === results[0].item.toLowerCase()).map((r) => r.item); // brand: top-normalized only

  return { matched: true, values };
}

/**
 * Fuzzy-matches a value (string or array of strings) against candidates.
 * Collects ALL matches within threshold across all input values.
 * Returns { matched: true, value: { $in: [...allMatches] } } if any matched,
 *         { matched: false, value: original }                 if none matched.
 */
function fuzzyMatch(value, candidates, fuseOptions = CONFIG.FUSE_OPTIONS, returnAll = false) {
  const values = Array.isArray(value) ? value : [value];
  const matched = [...new Set(
    values.flatMap((v) => {
      const result = fuzzyMatchOne(v, candidates, fuseOptions, returnAll);
      return result.matched ? result.values : [];
    })
  )];

  if (!matched.length) return { matched: false, value };
  return { matched: true, value: { $in: matched } };
}

// Fuse score thresholds for model matching (0 = perfect, 1 = no match)
const MAX_MODEL_RESULTS = 20;
const MODEL_EXACT_THRESHOLD = 0.2; // ≤ this → near-exact / typo-tolerant → return only these
const MODEL_BROAD_THRESHOLD = 0.4; // ≤ this → partial match → return all within threshold

/**
 * Resolves a model input to a list of inventory model names using Fuse.js only.
 *
 * Two outcomes:
 *   Near-exact (score ≤ MODEL_EXACT_THRESHOLD) → return only those close entries.
 *     Handles typos: "G4O" → "G40", "B-14 Rideg" → "B-14 Ridge"
 *   No close match (score > MODEL_EXACT_THRESHOLD) → return all matches within
 *     MODEL_BROAD_THRESHOLD so the API gets broader coverage.
 *
 * Searches brand-filtered list first; falls back to full model list if empty.
 * Raw input always appended as final fallback for the API's itemToSearch.
 */
function resolveModelMatches(rawValue, allModels, matchedBrandNames = []) {
  const raw = String(rawValue).trim();
  const rawLower = raw.toLowerCase();

  const exactInAll = allModels.filter((m) => m.toLowerCase() === rawLower);
  if (exactInAll.length > 0) {
    return [...new Set([...exactInAll, raw])];
  }

  // Brand-filtered list for fuzzy matching (keeps search focused and fast).
  const brandFiltered = matchedBrandNames.length > 0
    ? allModels.filter((m) => matchedBrandNames.some((b) => m.toLowerCase().includes(b.toLowerCase())))
    : [];

  function fuseSearch(list) {
    const fuse = new Fuse(list, { includeScore: true, threshold: MODEL_BROAD_THRESHOLD, minMatchCharLength: 2 });
    return fuse.search(raw);
  }

  let results = fuseSearch(brandFiltered.length > 0 ? brandFiltered : allModels);

  // If brand-filtered search found nothing, try the full list
  if (!results.length && brandFiltered.length > 0) {
    results = fuseSearch(allModels);
  }

  // Nothing found at all → raw fallback only
  if (!results.length) return [raw];

  const bestScore = results[0].score;

  // Near-exact match (typo-tolerant) → return only the close entries
  if (bestScore <= MODEL_EXACT_THRESHOLD) {
    const close = results.filter((r) => r.score <= MODEL_EXACT_THRESHOLD).slice(0, MAX_MODEL_RESULTS);
    return [...new Set([...close.map((r) => r.item), raw])];
  }

  // Partial / no close match → return all fuzzy results for broader API coverage
  return [...new Set([...results.slice(0, MAX_MODEL_RESULTS).map((r) => r.item), raw])];
}

/**
 * Fuzzy-matches brand and model from metaQuery against the inventory catalog.
 * - Searches for brand/model keys case-insensitively, preserves original key casing.
 * - Returns enriched map: only successfully matched keys with { $in: [...] } values.
 * - Keys that fail fuzzy match are excluded entirely.
 */
async function enrichMetaQuery(metaQuery) {
  try {
    const { brands, models, calibers } = await fetchInventoryData();
    const enriched = {};

    const brandKey = Object.keys(metaQuery).find((k) => k.toLowerCase() === "brand");
    const modelKey = Object.keys(metaQuery).find((k) => k.toLowerCase() === "model");
    const caliberKey = Object.keys(metaQuery).find((k) => k.toLowerCase() === "caliber" || k.toLowerCase() === "caliberinfo");

    // ── Brand matching ───────────────────────────────────────────
    let matchedBrandNames = [];
    if (brandKey !== undefined) {
      const result = fuzzyMatch(metaQuery[brandKey], brands);
      if (result.matched) {
        enriched[brandKey] = result.value;
        matchedBrandNames = result.value.$in.map((b) => b.toLowerCase());
        console.log(`[enrichMetaQuery] brand "${metaQuery[brandKey]}" → fuzzy matched: ${JSON.stringify(result.value)}`);
      } else {
        enriched[brandKey] = metaQuery[brandKey];
        console.log(`[enrichMetaQuery] brand "${metaQuery[brandKey]}" → no match, passing raw value`);
      }
    }

    // ── Model matching ──────────────────────────────────────────────
    if (modelKey !== undefined) {
      const matched = resolveModelMatches(metaQuery[modelKey], models, matchedBrandNames);
      enriched[modelKey] = { $in: matched };
      console.log(`[enrichMetaQuery] model "${metaQuery[modelKey]}" → { $in: [${matched.join(", ")}] }`);
    }

    // ── Caliber matching — Fuse.js only, no hardcoded rules ──────────────────
    // Two-tier threshold (same pattern as model matching):
    //   Near-exact (score ≤ CALIBER_EXACT_THRESHOLD) → return only those.
    //     ".380 ACP" → ".380 ACP", ".380 Auto", ".380 ACP+P"  (NOT ".45 ACP")
    //   No near-exact found → broaden to CALIBER_BROAD_THRESHOLD.
    //     "Win" → ".243 Win", ".308 Win", "Winchester" etc.
    //   Nothing at all → raw fallback so query still proceeds.
    if (caliberKey !== undefined) {
      const CALIBER_EXACT_THRESHOLD = 0.15; // near-exact / typo-tolerant
      const CALIBER_BROAD_THRESHOLD = 0.35; // broader — for abbreviations like "Win"

      const rawCaliber = String(metaQuery[caliberKey]).trim();
      const fuseCaliber = new Fuse(calibers, { includeScore: true, threshold: CALIBER_BROAD_THRESHOLD, minMatchCharLength: 2 });
      const caliberResults = fuseCaliber.search(rawCaliber);

      let matchedCalibers;
      if (!caliberResults.length) {
        matchedCalibers = [rawCaliber]; // raw fallback
      } else if (caliberResults[0].score <= CALIBER_EXACT_THRESHOLD) {
        // Near-exact match exists → return only the close ones (prevents .45 ACP leaking in)
        matchedCalibers = caliberResults
          .filter((r) => r.score <= CALIBER_EXACT_THRESHOLD)
          .map((r) => r.item);
      } else {
        // No near-exact → return all within broad threshold (covers abbreviations)
        matchedCalibers = caliberResults.map((r) => r.item);
      }

      enriched["$or_caliber"] = matchedCalibers;
      console.log(`[enrichMetaQuery] caliber "${rawCaliber}" → matched ${matchedCalibers.length} variant(s)`);
    }

    return enriched;
  } catch (error) {
    console.warn(`[enrichMetaQuery] Inventory fetch failed, falling back to raw values. Reason: ${error.message}`);
    const fallback = {};
    const brandKey = Object.keys(metaQuery).find((k) => k.toLowerCase() === "brand");
    const modelKey = Object.keys(metaQuery).find((k) => k.toLowerCase() === "model");
    const caliberKey = Object.keys(metaQuery).find((k) => k.toLowerCase() === "caliber" || k.toLowerCase() === "caliberinfo");
    if (brandKey) fallback[brandKey] = metaQuery[brandKey];
    if (modelKey) fallback[modelKey] = metaQuery[modelKey];
    if (caliberKey) fallback["$or_caliber"] = [String(metaQuery[caliberKey]).trim()];
    return fallback;
  }
}

/* ── HTTP ── */

function buildHeaders() {
  return { Authorization: `Bearer ${CONFIG.API_TOKEN}`, stage: CONFIG.API_STAGE, "Content-Type": "application/json" };
}

function buildPayload(input, indexName, namespace, enrichedMetaQuery, itemToSearch) {
  const hasMetaQuery = isObject(enrichedMetaQuery) && Object.keys(enrichedMetaQuery).length > 0;
  const payload = {
    sessionId: input.sessionId,
    indexName,
    namespace,
    enableMetaQueryWithSearchCriteria: input.enableMetaQueryWithSearchCriteria === true,
    topK: input.topK || CONFIG.DEFAULT_TOP_K,
    maxResults: input.maxResults || CONFIG.DEFAULT_MAX_RESULTS,
  };
  if (hasMetaQuery) payload.metaQuery = enrichedMetaQuery;
  if (itemToSearch && itemToSearch.length > 0) payload.itemToSearch = itemToSearch;
  return payload;
}

async function postJsonWithRetry({ url, headers, body, timeoutMs, retries, retryDelayMs }) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(retryDelayMs * 2 ** (attempt - 1));

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
      const contentType = response.headers.get("content-type") || "";
      const responseBody = contentType.includes("application/json") ? await response.json() : await response.text();

      if (!response.ok) {
        const isRetryable = response.status === 408 || response.status === 429 || response.status >= 500;
        if (isRetryable && attempt < retries) continue;
        throw new Error(`HTTP ${response.status}: ${JSON.stringify(responseBody)}`);
      }

      return { statusCode: response.status, data: responseBody };

    } catch (error) {
      const isTimeout = error?.name === "AbortError";
      const isNetwork = error instanceof TypeError;
      if ((isTimeout || isNetwork) && attempt < retries) continue;
      if (isTimeout) throw new Error(`Request timed out after ${timeoutMs} ms`);
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  throw new Error("Request failed after all retries.");
}

/* ── Async Pool ── */

async function asyncPool(items, concurrency, taskFn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        results[index] = await taskFn(items[index], index);
      } catch (error) {
        results[index] = { success: false, namespace: items[index], error: error?.message ?? "Unknown error" };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/* ── Merge & Deduplicate ── */

function extractBuckets(responseData) {
  // API may return an array wrapper — unwrap the first element if so
  const root = Array.isArray(responseData) ? safeObject(responseData[0]) : safeObject(responseData);
  const body = safeObject(root.body);
  return {
    relevant: safeArray(firstDefined(root.relevant, body.relevant, root.relavant, body.relavant, [])),
    lessRelevant: safeArray(firstDefined(root.lessRelevant, body.lessRelevant, root.lessRelavant, body.lessRelavant, [])),
  };
}

function selectListings(responseData) {
  const { relevant, lessRelevant } = extractBuckets(responseData);
  return relevant.length > 0 ? relevant : lessRelevant;
}

function deduplicateListings(listings) {
  const seen = new Set();
  return listings.filter((listing) => {
    const m = safeObject(listing?.metadata);
    const cal = m.caliberInfo ?? m.caliber ?? "";
    const url = m.productUrl ?? m.pageUrl ?? m.page_url ?? "";
    const lid = listing?.id ?? listing?.metadata?.id ?? "";
    const priceVal = m.price ?? m.offerPrice ?? m.offer_price ?? "";
    const key = [lid, url, m.brand ?? "", m.model ?? "", cal, priceVal].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeResults(namespaceResults) {
  return deduplicateListings(
    namespaceResults.filter((r) => r?.success).flatMap((r) => selectListings(r.data))
  );
}

/* ── LLM Payload ── */

function buildLLMPayload(listings) {
  return listings.map((listing) => {
    const m = safeObject(listing?.metadata);
    const item = {};
    if (listing?.id ?? m.id) item.id = listing?.id ?? m.id;
    const ft = m.firearmType || m.firearm_type;
    if (ft) item.firearmType = ft;
    if (m.caliber || m.caliberInfo) item.caliber = m.caliber || m.caliberInfo;
    if (m.model) item.model = m.model;
    if (m.brand) item.brand = m.brand;
    return item;
  });
}

/** Map semantic metaQuery → scrapeFirearm input (brand, model, caliber, firearmType). */
function metaQueryToScrapeInput(metaQuery) {
  if (!metaQuery || typeof metaQuery !== "object") {
    throw new Error("metaQuery is required for realtime scrape fallback");
  }
  const get = (...names) => {
    const want = names.map((n) => n.toLowerCase());
    for (const [k, v] of Object.entries(metaQuery)) {
      if (v == null) continue;
      if (want.includes(String(k).toLowerCase())) return v;
    }
    return undefined;
  };
  const firearmRaw = get("firearmType", "firearmtype");
  const firearmType =
    firearmRaw != null && String(firearmRaw).trim()
      ? String(firearmRaw).trim()
      : "UNKNOWN";
  return {
    firearmType,
    brand: String(get("brand") ?? "").trim(),
    model: String(get("model") ?? "").trim(),
    caliber: String(get("caliber", "caliberinfo", "caliberInfo") ?? "").trim(),
  };
}

/** Provider attribute keys (camelCase) → flat snake_case metadata keys. */
function camelToSnakeKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .replace(/__+/g, "_")
    .toLowerCase();
}

/**
 * Fallback listing: top-level `id` only; `metadata` has no `id` key (snake_case fields + flattened attrs).
 */
function scraperSourceToListing(row, index, scrapeInput) {
  const pageUrl = row?.pageUrl ? String(row.pageUrl).trim() : "";
  const sid = row?.sourceId != null ? String(row.sourceId) : String(index + 1).padStart(3, "0");
  const id = `rt-${sid}`;
  const p = row?.price?.original;
  const priceNum = typeof p === "number" && Number.isFinite(p) ? p : null;
  const ft = String(scrapeInput?.firearmType || "UNKNOWN").trim() || "UNKNOWN";

  const metadata = {
    brand: row.brand != null ? String(row.brand).trim() : "",
    model: row.model != null ? String(row.model).trim() : "",
    caliber: row.caliber != null ? String(row.caliber).trim() : "",
    firearm_type: ft,
    page_url: pageUrl,
    price: priceNum,
    currency: row?.price?.currency ? String(row.price.currency) : "USD",
    title: row.title != null ? String(row.title).trim() : "",
    source_name: row.sourceName != null ? String(row.sourceName) : "",
    condition: row.condition != null ? String(row.condition) : "",
  };

  if (row.description) metadata.description = String(row.description).trim();
  if (row.breadcrumbTrail) {
    metadata.store_category_trail = String(row.breadcrumbTrail).trim().slice(0, 600);
  }

  const attrs = row.attributes && typeof row.attributes === "object" ? row.attributes : {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || String(k).toLowerCase() === "id") continue;
    const sv = typeof v === "object" ? JSON.stringify(v) : String(v).trim();
    if (!sv) continue;
    let sk = camelToSnakeKey(k);
    if (sk === "id") continue;
    if (Object.prototype.hasOwnProperty.call(metadata, sk)) sk = `${sk}_detail`;
    metadata[sk] = sv;
  }

  return { id, metadata };
}

/** Strip deprecated `realtime` from API-shaped results (always omit in new responses). */
function withoutRealtime(result) {
  if (!result || typeof result !== "object") return result;
  const { realtime: _r, ...rest } = result;
  return rest;
}

/** When mergedListings is empty, load ESM scraperService.js and run scrapeFirearm. */
async function attachRealtimeFallback(input, semanticResult) {
  const merged = semanticResult.mergedListings;
  const hasListings = Array.isArray(merged) && merged.length > 0;
  if (hasListings) {
    return withoutRealtime({ ...semanticResult, isFallback: false });
  }
  try {
    const scrapeInput = metaQueryToScrapeInput(input.metaQuery);
    console.log("[fallback] mergedListings empty — running scrapeFirearm", scrapeInput);
    if (!process.env.SCRAPER_API_KEY) {
      console.warn(
        "[fallback] SCRAPER_API_KEY is not set — PSA, GunBroker, Buds, GrabAGun, etc. will return no rows (see provider warnings in scraper output)."
      );
    }

    const scraperPath = path.join(__dirname, "..", "scraperService.js");
    const { scrapeFirearm } = await import(pathToFileURL(scraperPath).href);
    const scrapeResult = await scrapeFirearm(scrapeInput);
    const sources = Array.isArray(scrapeResult?.sources) ? scrapeResult.sources : [];
    console.log(
      "[fallback] scrapeFirearm done —",
      sources.length,
      "source row(s); provider errors:",
      scrapeResult?.errors && typeof scrapeResult.errors === "object" ? Object.keys(scrapeResult.errors).length : 0
    );

    if (sources.length > 0) {
      const fromScrape = deduplicateListings(
        sources.map((row, i) => scraperSourceToListing(row, i, scrapeInput))
      );
      return withoutRealtime({
        ...semanticResult,
        mergedListings: fromScrape,
        isFallback: true,
      });
    }

    const errs = scrapeResult?.errors && typeof scrapeResult.errors === "object" ? scrapeResult.errors : {};
    const errKeys = Object.keys(errs);
    const extra = errKeys.length > 0 ? { scrape_errors: errs } : {};
    return withoutRealtime({
      ...semanticResult,
      ...extra,
      isFallback: true,
    });
  } catch (err) {
    return withoutRealtime({
      ...semanticResult,
      isFallback: true,
      error: semanticResult.error || err?.message || String(err),
    });
  }
}

/**
 * Run only the realtime scrape path (same as when mergedListings is empty after semantic search).
 * Skips semantic / inventory APIs — for local testing of scrapeFirearm + mergedListings mapping.
 *
 * @param {object} metaQuery - Same shape as parallelSemanticSearch input.metaQuery
 * @returns {Promise<object>} Shape like attachRealtimeFallback output (mergedListings, isFallback; no realtime key)
 */
async function runFallbackScrapeOnly(metaQuery) {
  const input = { metaQuery: metaQuery && typeof metaQuery === "object" ? metaQuery : {} };
  const emptySemantic = { elapsedTime: 0, mergedListings: [], sentPayloads: [] };
  return attachRealtimeFallback(input, emptySemantic);
}

/* ── Main ── */

async function parallelSemanticSearchService(input) {
  const startTime = Date.now();

  try {
    validateInput(input);

    // Fuzzy-match brand/model — returns only successfully matched keys with original casing
    const enriched = await enrichMetaQuery(input.metaQuery);

    // Flatten db[] into individual (indexName, namespace, hardfilters) pairs — one API call each
    const pairs = input.db.flatMap(({ indexName, namespace, hardfilters }) =>
      namespace.map((ns) => ({ indexName, namespace: ns, hardfilters: hardfilters.map((k) => k.toLowerCase()) }))
    );

    const headers = buildHeaders();

    // Concurrency is dynamic — one worker per (indexName + namespace) pair
    const namespaceResults = await asyncPool(pairs, pairs.length, async ({ indexName, namespace, hardfilters }) => {
      try {
        // Keys that need fuzzy matching (brand / model) — filtered by this namespace's hardfilters
        const apiMetaQuery = Object.fromEntries(
          Object.entries(enriched).filter(([k]) => hardfilters.includes(k.toLowerCase()))
        );

        // Keys in hardfilters that are NOT fuzzy-matchable (i.e. not brand/model/caliber) are
        // passed through directly from the original metaQuery with their original values.
        // Caliber is handled separately via enriched["$or_caliber"] below.
        const FUZZY_KEYS = new Set(["brand", "model", "caliber", "caliberinfo"]);

        Object.entries(input.metaQuery).forEach(([k, v]) => {
          const lk = k.toLowerCase();
          if (hardfilters.includes(lk) && !FUZZY_KEYS.has(lk)) {
            apiMetaQuery[k] = v;
          }
        });

        // ── Caliber: resolve fuzzy-matched values into $or ──────────────────
        const caliberHardfiltered = hardfilters.some((hf) => hf === "caliber" || hf === "caliberinfo");
        if (caliberHardfiltered && enriched["$or_caliber"]) {
          const vals = enriched["$or_caliber"];
          // Use $in to cover all matched variants in just 2 $or entries instead of 2×N
          apiMetaQuery["$or"] = [
            { caliber: { $in: vals } },
            { caliberinfo: { $in: vals } },
          ];
        }

        // Keys that made it into apiMetaQuery (lowercased for comparison)
        const matchedKeys = new Set(Object.keys(apiMetaQuery).map((k) => k.toLowerCase()));

        // Build itemToSearch from whatever didn't make it into metaQuery:
        //   - keys not in hardfilters for this namespace
        //   - keys in hardfilters but fuzzy match failed (not present in enriched)
        // If metaQuery is entirely empty, fall back to the whole original metaQuery.
        let itemToSearch;
        if (matchedKeys.size === 0) {
          // Nothing fuzzy-matched — send entire original metaQuery as itemToSearch
          itemToSearch = [JSON.stringify(input.metaQuery)];
        } else {
          const remainingObj = Object.fromEntries(
            Object.entries(input.metaQuery).filter(([k]) => !matchedKeys.has(k.toLowerCase()))
          );
          itemToSearch = Object.keys(remainingObj).length > 0 ? [JSON.stringify(remainingObj)] : [];
        }

        const payload = buildPayload(input, indexName, namespace, apiMetaQuery, itemToSearch);
        console.log(`[processQuery] ${indexName}/${namespace} →`, JSON.stringify(payload, null, 2));
        const apiResponse = await postJsonWithRetry({
          url: CONFIG.API_URL,
          headers,
          body: payload,
          timeoutMs: CONFIG.DEFAULT_TIMEOUT_MS,
          retries: CONFIG.DEFAULT_RETRIES,
          retryDelayMs: CONFIG.DEFAULT_RETRY_DELAY_MS,
        });
        return { success: true, indexName, namespace, statusCode: apiResponse.statusCode, data: apiResponse.data, sentMetaQuery: apiMetaQuery, sentItemToSearch: itemToSearch };
      } catch (error) {
        return { success: false, indexName, namespace, error: error?.message ?? "Unknown error" };
      }
    });

    const mergedListings = mergeResults(namespaceResults);

    // Log product count per indexName (summed across its namespaces)
    const countByIndex = {};
    namespaceResults.forEach((r) => {
      if (!r?.success) return;
      const { relevant, lessRelevant } = extractBuckets(r.data);
      const count = (relevant.length > 0 ? relevant : lessRelevant).length;
      countByIndex[r.indexName] = (countByIndex[r.indexName] || 0) + count;
    });
    console.log("[Results] Products per indexName:");
    Object.entries(countByIndex).forEach(([indexName, count]) =>
      console.log(`  ${indexName}: ${count} products`)
    );
    console.log(`  Total (after dedup): ${mergedListings.length} products`);

    const sentPayloads = namespaceResults
      .filter((r) => r?.success)
      .map(({ indexName, namespace, sentMetaQuery, sentItemToSearch }) => ({
        indexName,
        namespace,
        metaQuery: sentMetaQuery,
        itemToSearch: sentItemToSearch,
      }));

    const base = { elapsedTime: Date.now() - startTime, sentPayloads, mergedListings };
    return await attachRealtimeFallback(input, base);

  } catch (error) {
    const base = { elapsedTime: 0, mergedListings: [], error: error?.message ?? "Unknown error" };
    return await attachRealtimeFallback(input, base);
  }
}

module.exports = {
  parallelSemanticSearchService,
  metaQueryToScrapeInput,
  runFallbackScrapeOnly,
};