/**
 * BudsGunShop.com scraper — uses ScraperAPI to bypass Cloudflare.
 *
 * Env:
 *   SCRAPER_API_KEY        (required) Your ScraperAPI key
 *   SCRAPE_TIMEOUT_MS      Used with SERP+PDP phases for default fetch deadline (default 15000)
 *   BG_FETCH_TIMEOUT_MS    Override SERP ScraperAPI timeout (ms)
 *   BG_PDP_FETCH_TIMEOUT_MS  Override PDP fetch timeout (ms)
 *   BG_PDP_LIMIT           PDP pages per run (default 2)
 *   BG_MAX_LISTINGS=10     Max products to return (default 10)
 */

import * as cheerio from "cheerio";
import {
  parseUsdPrice,
  isAccessory,
  extractKeywords,
  isRelevant,
  normalizeCondition,
  extractSpecsFromHtml,
  modelMatches,
  extractBreadcrumbTrailFrom$,
  breadcrumbTrailImpliesNonFirearm,
} from "./_util.js";

export const sourceName = "budsgunshop";

const MAX_LISTINGS = Number(process.env.BG_MAX_LISTINGS) || 10;
const PDP_LIMIT = Math.min(10, Math.max(1, Number(process.env.BG_PDP_LIMIT) || 2));

function budsFetchMs(phase) {
  const scrapeMs = Number(process.env.SCRAPE_TIMEOUT_MS) || 15000;
  const reserve = Math.max(2000, Number(process.env.SCRAPER_PDP_RESERVE_MS) || 2200);
  if (phase === "pdp") {
    return Math.max(4000, Number(process.env.BG_PDP_FETCH_TIMEOUT_MS) || 5500);
  }
  return Math.max(
    7500,
    Number(process.env.BG_FETCH_TIMEOUT_MS) || scrapeMs - 450 - reserve
  );
}

/**
 * Fetch HTML from a URL via ScraperAPI.
 */
async function fetchViaScraperAPI(targetUrl, apiKey, phase = "serp") {
  const apiUrl = `https://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(targetUrl)}&country_code=us`;
  const response = await fetch(apiUrl, { signal: AbortSignal.timeout(budsFetchMs(phase)) });
  if (!response.ok) {
    throw new Error(`ScraperAPI returned ${response.status}: ${response.statusText}`);
  }
  return await response.text();
}

/**
 * Fetch a single PDP page via ScraperAPI and extract description.
 */
async function fetchPdpData(pdpUrl, apiKey) {
  try {
    const html = await fetchViaScraperAPI(pdpUrl, apiKey, "pdp");
    const $ = cheerio.load(html);

    let description = "";
    const descEl = $(".product_description, #tab-description, .product-description, [itemprop='description']").first();
    if (descEl.length) {
      description = descEl.text().trim();
    } else {
      // Fallback: largest paragraph
      const paragraphs = [];
      $("p, .description, td").each((_, el) => {
        const t = $(el).text().trim();
        if (t.length > 80 && !t.includes("BudsGunShop") && !t.includes("Terms")) {
          paragraphs.push(t);
        }
      });
      if (paragraphs.length > 0) {
        description = paragraphs.sort((a, b) => b.length - a.length)[0];
      }
    }

    // Extract condition
    let condition = "";
    const condEl = $("[class*='condition'], td:contains('Condition')").first();
    if (condEl.length) condition = condEl.text().trim();

    description = description.replace(/\s+/g, " ").trim();

    // BudsGunShop-specific: page has multiple comparison tables.
    // Use the FIRST table (current product) and JSON-LD for brand.
    const specs = { caliber: "", model: "", brand: "", action: "", capacity: "", barrelLength: "" };

    // JSON-LD has the most reliable brand info
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).html());
        if (data.brand && !specs.brand) specs.brand = typeof data.brand === "string" ? data.brand : data.brand.name || "";
      } catch { }
    });

    // First spec table = current product's specs
    const firstTable = $("table.table-striped.table-bordered").first();
    if (firstTable.length) {
      firstTable.find("tr").each((_, row) => {
        const cells = $(row).find("th, td");
        if (cells.length >= 2) {
          const label = $(cells[0]).text().trim().toLowerCase();
          const value = $(cells[1]).text().trim();
          if (label === "caliber" && !specs.caliber) specs.caliber = value;
          if (label === "action" && !specs.action) specs.action = value;
          if (label === "capacity" && !specs.capacity) specs.capacity = value;
          if (label.includes("barrel") && !specs.barrelLength) specs.barrelLength = value;
        }
      });
    }

    const breadcrumbTrail = extractBreadcrumbTrailFrom$($);
    return { description, condition, breadcrumbTrail, ...specs };
  } catch (e) {
    console.warn(`[${sourceName}] PDP fetch failed: ${e.message}`);
    return { description: "", condition: "", breadcrumbTrail: "" };
  }
}

// ── Main entry ───────────────────────────────────────────────────────────────

export async function scrape({ page, query, model, firearmType, caliber = "", brand = "" }) {
  const apiKey = process.env.SCRAPER_API_KEY;
  if (!apiKey) {
    console.warn(`[${sourceName}] SCRAPER_API_KEY not set — skipping.`);
    return [];
  }

  const keywords = extractKeywords(query);

  const searchUrl = `https://www.budsgunshop.com/search.php/type/firearms/q/${encodeURIComponent(query)}/`;
  console.log(`[${sourceName}] ${searchUrl} (via ScraperAPI)`);

  let html;
  try {
    html = await fetchViaScraperAPI(searchUrl, apiKey);
  } catch (err) {
    console.error(`[${sourceName}] ScraperAPI error: ${err.message}`);
    throw err;
  }

  if (html.includes("security verification") || html.includes("Just a moment")) {
    console.warn(`[${sourceName}] Cloudflare blocked even via ScraperAPI.`);
    return [];
  }

  const $ = cheerio.load(html);
  const raw = [];

  $(".product_box_container").each((_, card) => {
    const $card = $(card);
    const title = ($card.find("span[itemprop='name']").text() || "").trim();
    if (!title || title.length < 5) return;

    let href = $card.find("a.product-box-link, a.list-products-name").first().attr("href") || "";
    if (href && !href.startsWith("http")) {
      href = `https://www.budsgunshop.com/${href.replace(/^\//, "")}`;
    }
    if (!href) return;

    const priceText = $card.find("span.search_price").first().text().trim();
    raw.push({ url: href, title, price: `$${priceText}` });
  });

  console.log(`[${sourceName}] Extracted ${raw.length} listing(s).`);
  if (raw.length === 0) return [];

  // If 3 or fewer listings, skip filtering — blindly open all PDPs
  const blindMode = raw.length <= PDP_LIMIT;
  let relevant;

  if (blindMode) {
    console.log(`[${sourceName}] ≤${PDP_LIMIT} listings found — skipping filters, fetching all PDPs blindly.`);
    relevant = raw;
  } else {
    // Filter accessories
    relevant = raw.filter(l => {
      const title = (l.title || "").toUpperCase();
      const upBrand = String(brand || query.split(/\s+/)[0] || "").toUpperCase();

      const hasBrand = upBrand && title.includes(upBrand);
      const hasModel = modelMatches(l.title, model);

      // SERP cards often omit gauge — rely on isRelevant(caliber) instead of requiring gauge on card
      if (hasBrand && hasModel) {
        if (/\b(MOULD|MOLD|DIE[S]?|RELOADING)\b/i.test(title)) return false;
        return isRelevant(l.title, keywords, sourceName, model, query, caliber);
      }

      return !isAccessory(l.title) && isRelevant(l.title, keywords, sourceName, model, query, caliber);
    });

    console.log(`[${sourceName}] After site-specific filters: ${relevant.length} relevant listing(s).`);
  }

  if (relevant.length === 0 && raw.length > 0) {
    const upBrand = String(brand || query.split(/\s+/)[0] || "").toUpperCase();
    relevant = raw.filter((l) => {
      const t = (l.title || "").toUpperCase();
      return (
        !isAccessory(l.title) &&
        upBrand &&
        t.includes(upBrand) &&
        modelMatches(l.title, model)
      );
    });
    console.log(`[${sourceName}] Fallback SERP filter (brand+model): ${relevant.length} listing(s).`);
  }

  // Fetch PDP data in parallel (up to PDP_LIMIT)
  const pdpTargets = relevant.slice(0, PDP_LIMIT);
  console.log(`[${sourceName}] Fetching ${pdpTargets.length} PDP(s) in parallel...`);

  const pdpResults = await Promise.all(
    pdpTargets.map(l => fetchPdpData(l.url, apiKey))
  );

  // Build results
  const results = [];
  for (let i = 0; i < pdpTargets.length; i++) {
    const l = pdpTargets[i];
    const pdp = pdpResults[i] || {};
    const p = parseUsdPrice(l.price);
    if (p == null || p <= 0) continue;

    // Post-PDP accessory check: if we were in blind mode, validate now
    if (blindMode && isAccessory(l.title)) {
      console.log(`[${sourceName}] Post-PDP rejected (accessory): ${l.title}`);
      continue;
    }

    if (breadcrumbTrailImpliesNonFirearm(pdp.breadcrumbTrail)) {
      console.log(`[${sourceName}] Post-PDP rejected (breadcrumb): ${String(pdp.breadcrumbTrail).slice(0, 140)}`);
      continue;
    }

    const upper = l.title.toUpperCase();
    let rawCond = pdp.condition || "";
    if (!rawCond) {
      rawCond = "New"; // BudsGunShop items are mostly new
      if (/\bUSED\b/.test(upper)) rawCond = "Used";
      if (/\bREFURB/.test(upper)) rawCond = "Used";
    }

    results.push({
      sourceName,
      pageUrl: l.url,
      title: l.title.slice(0, 200) || null,
      description: (pdp.description || "").toLowerCase(),
      ...pdp,
      condition: normalizeCondition(rawCond),
      model: pdp.model || model || "",
      caliber: pdp.caliber || "",
      brand: pdp.brand || "",
      price: { currency: "USD", original: p },
    });
  }

  console.log(`[${sourceName}] Done — ${results.length} result(s).`);
  return results;
}
