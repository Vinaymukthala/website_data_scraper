/**
 * GrabAGun.com scraper — uses ScraperAPI to bypass bot protection.
 *
 * Env:
 *   SCRAPER_API_KEY        (required) Your ScraperAPI key
 *   SCRAPE_TIMEOUT_MS      Used with SERP+PDP phases for default fetch deadline (default 15000)
 *   GRABAGUN_FETCH_TIMEOUT_MS  Override SERP ScraperAPI timeout (ms)
 *   GRABAGUN_PDP_FETCH_TIMEOUT_MS  Override PDP fetch timeout (ms)
 *   GRABAGUN_PDP_LIMIT     PDP pages per run (default 2 — fits 15s with SERP)
 *   GRABAGUN_MAX_LISTINGS=10 Max products to return (default 10)
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

export const sourceName = "grabagun";

const MAX_LISTINGS = Number(process.env.GRABAGUN_MAX_LISTINGS) || 10;
/** Default 2 PDPs so SERP + PDP fits SCRAPE_TIMEOUT_MS=15s with ScraperAPI */
const PDP_LIMIT = Math.min(10, Math.max(1, Number(process.env.GRABAGUN_PDP_LIMIT) || 2));

function gaFetchMs(phase) {
  const scrapeMs = Number(process.env.SCRAPE_TIMEOUT_MS) || 15000;
  const reserve = Math.max(2000, Number(process.env.SCRAPER_PDP_RESERVE_MS) || 2200);
  if (phase === "pdp") {
    return Math.max(4000, Number(process.env.GRABAGUN_PDP_FETCH_TIMEOUT_MS) || 5500);
  }
  return Math.max(
    7500,
    Number(process.env.GRABAGUN_FETCH_TIMEOUT_MS) || scrapeMs - 450 - reserve
  );
}

/**
 * Fetch HTML from a URL via ScraperAPI.
 */
async function fetchViaScraperAPI(targetUrl, apiKey, phase = "serp") {
  const apiUrl = `https://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(targetUrl)}&country_code=us`;
  const response = await fetch(apiUrl, { signal: AbortSignal.timeout(gaFetchMs(phase)) });
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
    // Magento product description selectors
    const descEl = $("#description, .product.description, .product-info-description, [itemprop='description'], .product.attribute.description").first();
    if (descEl.length) {
      description = descEl.text().trim();
    } else {
      const paragraphs = [];
      $("p, .value").each((_, el) => {
        const t = $(el).text().trim();
        if (t.length > 80 && !t.includes("GrabAGun") && !t.includes("Copyright")) {
          paragraphs.push(t);
        }
      });
      if (paragraphs.length > 0) {
        description = paragraphs.sort((a, b) => b.length - a.length)[0];
      }
    }

    let condition = "";
    const condEl = $("[class*='condition'], td:contains('Condition')").first();
    if (condEl.length) condition = condEl.text().trim();

    description = description.replace(/\s+/g, " ").trim();

    // Strip embedded "specifications" block from description and parse it
    // GrabAGun descriptions often end with: "...specifications manufacturer: benelli model: m4..."
    const descSpecs = {};
    const specBlockMatch = description.match(/specifications?\s*:?\s*((?:manufacturer|model|gauge|caliber|action|barrel)[:\s][\s\S]+)$/i);
    if (specBlockMatch) {
      // Remove the spec block from description
      description = description.slice(0, specBlockMatch.index).trim();
      // Parse label:value pairs from the spec block
      const specText = specBlockMatch[1];
      const GRAB_LABELS = [
        "manufacturer", "model", "gauge", "caliber", "action", "barrel length",
        "chamber", "capacity", "receiver finish", "barrel finish", "stock finish",
        "sights", "rail", "overall length", "length of pull", "drop at heel",
        "drop at comb", "weight", "hand", "safety", "trigger",
      ];
      const labelPattern = GRAB_LABELS.join("|");
      const BOUNDARY = `(?=(?:${labelPattern})\\s*:|$)`;
      for (const label of GRAB_LABELS) {
        const re = new RegExp(`${label.replace(/\s+/g, "\\s*")}:\\s*(.+?)${BOUNDARY}`, "is");
        const m = specText.match(re);
        if (m && m[1].trim()) {
          let key = label.replace(/\s+(.)/g, (_, c) => c.toUpperCase());
          if (key === "manufacturer") key = "brand";
          descSpecs[key] = m[1].trim();
        }
      }
    }

    const specs = extractSpecsFromHtml($);
    // Merge: table specs take priority, then description-embedded specs
    for (const [k, v] of Object.entries(descSpecs)) {
      if (v && !specs[k]) specs[k] = v;
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
  const apiKey = process.env.SCRAPER_API_KEY || "9c2b60714d381b52838ca7bb29ea0c58";
  if (!apiKey) {
    console.warn(`[${sourceName}] SCRAPER_API_KEY not set — skipping.`);
    return [];
  }

  const keywords = extractKeywords(query);

  const searchUrl = `https://grabagun.com/bsearch/result/?q=${encodeURIComponent(query)}`;
  console.log(`[${sourceName}] ${searchUrl} (via ScraperAPI)`);

  let html;
  try {
    html = await fetchViaScraperAPI(searchUrl, apiKey);
  } catch (err) {
    console.error(`[${sourceName}] ScraperAPI error: ${err.message}`);
    throw err;
  }

  if (html.includes("security verification") || html.includes("Just a moment") || html.includes("Cloudflare")) {
    console.warn(`[${sourceName}] Cloudflare blocked even via ScraperAPI.`);
    return [];
  }

  const $ = cheerio.load(html);
  const raw = [];

  $(".product-item, .item.product").each((_, card) => {
    const $card = $(card);
    const titleElem = $card.find(".product-item-link, .product-name a");
    const title = (titleElem.text() || "").trim();
    if (!title || title.length < 5) return;

    let href = titleElem.attr("href") || "";
    if (href && !href.startsWith("http")) {
      href = `https://grabagun.com/${href.replace(/^\//, "")}`;
    }
    if (!href) return;

    const priceText = $card.find(".price-box .price").first().text().trim();
    raw.push({ url: href, title, price: priceText });
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
    relevant = raw.filter(l => {
      const title = (l.title || "").toUpperCase();
      const upBrand = String(brand || query.split(/\s+/)[0] || "").toUpperCase();

      const hasBrand = upBrand && title.includes(upBrand);
      const hasModel = modelMatches(l.title, model);

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
      rawCond = "New"; // Usually new items on GrabAGun
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
