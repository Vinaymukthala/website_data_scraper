/**
 * SimpsonLtd.com scraper — API-based.
 *
 * SimpsonLtd migrated to a React SPA (Firebase + Typesense).
 * Their search results are powered by a public Cloud Function:
 *   https://us-central1-simpsonltd-bfd2b.cloudfunctions.net/searchInventoryTypesense_v2
 *
 * This provider calls that API directly (no Puppeteer needed),
 * which is faster and more reliable than scraping the DOM.
 *
 * Flow:
 *   1. Call Typesense search API with the query
 *   2. Filter by License (FFL/C&R = firearm, NLR = accessory)
 *   3. Apply caliber/model relevance checks
 *   4. Return normalised result array
 *
 * Env:
 *   SL_MAX_LISTINGS=10    Max products to return (default 10)
 */

import {
  parseUsdPrice,
  isRelevant,
  extractKeywords,
  normalizeCondition,
} from "./_util.js";

export const sourceName = "simpsonltd";

const SEARCH_API =
  "https://us-central1-simpsonltd-bfd2b.cloudfunctions.net/searchInventoryTypesense_v2";
const BASE_URL = "https://www.simpsonltd.com";
const MAX_LISTINGS = Number(process.env.SL_MAX_LISTINGS) || 10;

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
export async function scrape({ page, query, model, firearmType }) {
  const keywords = extractKeywords(query);

  // Build the API URL
  const apiUrl = new URL(SEARCH_API);
  apiUrl.searchParams.set("query", query);
  apiUrl.searchParams.set("itemsPerPage", String(MAX_LISTINGS));
  apiUrl.searchParams.set("currentPage", "1");
  apiUrl.searchParams.set("sold", "false");

  console.log(`[${sourceName}] Searching: ${apiUrl.href}`);

  let data;
  try {
    const res = await fetch(apiUrl.href, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.warn(`[${sourceName}] API request failed: ${err.message}`);
    return [];
  }

  const hits = data?.hits || [];
  console.log(`[${sourceName}] API returned ${hits.length} hit(s) (total: ${data?.nbHits || 0}).`);

  if (hits.length === 0) return [];

  const results = [];

  for (const hit of hits) {
    // 1. License-based firearm validation
    const license = (hit.License || "").toUpperCase().trim();
    if (!license || license === "NLR") {
      console.log(`[${sourceName}]   → Skipped "${hit.Title}" — License: ${license || "none"} (not a firearm).`);
      continue;
    }

    // 2. Relevance check (caliber conflict, model match, accessory filter)
    const title = hit.Title || "";
    if (!isRelevant(title, keywords, sourceName, model, query)) {
      console.log(`[${sourceName}]   → Skipped "${title}" — not relevant.`);
      continue;
    }

    // 3. Price
    const price = hit.PriceReduced && hit.ReducedPrice > 0
      ? hit.ReducedPrice
      : hit.OriginalPrice || hit.Wants || 0;
    if (price <= 0) continue;

    // 4. Condition from Blue/Bore/Stock fields
    const condParts = [];
    if (hit.Stock) condParts.push(`Stock: ${hit.Stock}`);
    if (hit.Blue) condParts.push(`Blue: ${hit.Blue}`);
    if (hit.Bore) condParts.push(`Bore: ${hit.Bore}`);
    const condition = normalizeCondition(condParts.join(", ") || "Unknown");

    // 5. Product URL — Simpson uses SKU-based URLs (e.g. /products/C42077)
    const sku = hit.SKU || hit.objectID || "";
    const pageUrl = `${BASE_URL}/products/${sku}`;

    // 6. Description
    const description = (hit.Description || "").trim().toLowerCase().replace(/\s+/g, " ");

    // 7. Attributes
    const attributes = {};
    if (hit.Caliber) attributes.caliber = hit.Caliber;
    if (hit.Barrel) attributes.barrelLength = hit.Barrel;
    if (hit.Blue) attributes.blue = hit.Blue;
    if (hit.Bore) attributes.bore = hit.Bore;
    if (hit.Stock) attributes.stock = hit.Stock;
    if (hit.Action) attributes.action = hit.Action;
    if (hit.Category) attributes.category = hit.Category;
    if (hit.Subcategory) attributes.subcategory = hit.Subcategory;
    if (license) attributes.license = license;

    console.log(`[${sourceName}]   → "${title}" — $${price}`);

    results.push({
      sourceName,
      pageUrl,
      title,
      brand: hit.SubcategoryType || "",
      model: model || "",
      caliber: hit.Caliber || "",
      condition,
      description,
      price: { currency: "USD", original: price },
      attributes,
    });
  }

  console.log(`[${sourceName}] Done — ${results.length} result(s).`);
  return results;
}
