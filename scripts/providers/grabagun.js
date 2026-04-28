/**
 * GrabAGun.com scraper — uses ScraperAPI to bypass bot protection.
 *
 * Env:
 *   SCRAPER_API_KEY        (required) Your ScraperAPI key
 *   GRABAGUN_MAX_LISTINGS=10 Max products to return (default 10)
 */

import * as cheerio from "cheerio";
import {
  parseUsdPrice,
  isAccessory,
  extractKeywords,
  isRelevant,
  normalizeCondition,
  extractSpecsFromHtml
} from "./_util.js";

export const sourceName = "grabagun";

const MAX_LISTINGS = Number(process.env.GRABAGUN_MAX_LISTINGS) || 10;
const PDP_LIMIT = 3;

/**
 * Fetch HTML from a URL via ScraperAPI.
 */
async function fetchViaScraperAPI(targetUrl, apiKey) {
  const apiUrl = `https://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(targetUrl)}&country_code=us`;
  const response = await fetch(apiUrl, { signal: AbortSignal.timeout(30_000) });
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
    const html = await fetchViaScraperAPI(pdpUrl, apiKey);
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
    return { description, condition, ...specs };
  } catch (e) {
    console.warn(`[${sourceName}] PDP fetch failed: ${e.message}`);
    return { description: "", condition: "" };
  }
}

// ── Main entry ───────────────────────────────────────────────────────────────

export async function scrape({ page, query, model, firearmType }) {
  const apiKey = process.env.SCRAPER_API_KEY || "7260a6ebef2b9568767d0c2cb1c03515";
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

  console.log(`[${sourceName}] Raw titles:`, raw.map(r => r.title));
  if (raw.length === 0) return [];

  let relevant = raw.filter(l => {
    const title = (l.title || "").toUpperCase();
    const upBrand = (query.split(" ")[0] || "").toUpperCase();
    const upModel = (model || "").toUpperCase();

    const calibers = [".45", "9MM", ".40", ".380", ".22", ".357", ".44", "10MM", ".223", "5.56", ".308", "7.62"];
    const hasCaliber = calibers.some(c => title.includes(c));
    const hasBrand = title.includes(upBrand);
    const hasModel = upModel ? title.includes(upModel) : true;

    if (hasBrand && hasModel && hasCaliber) {
      if (/\b(MOULD|MOLD|DIE[S]?|RELOADING)\b/i.test(title)) return false;
      return true;
    }

    return !isAccessory(l.title) && isRelevant(l.title, keywords, sourceName, model);
  });

  console.log(`[${sourceName}] After site-specific filters: ${relevant.length} relevant listing(s).`);

  // Fetch PDP data in parallel (3 max)
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
