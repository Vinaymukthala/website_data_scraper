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
  extractBrandAndCaliber
} from "./_util.js";

export const sourceName = "grabagun";

const MAX_LISTINGS = Number(process.env.GRABAGUN_MAX_LISTINGS) || 10;

/**
 * Fetch HTML from a URL via ScraperAPI.
 */
async function fetchViaScraperAPI(targetUrl, apiKey) {
  const apiUrl = `https://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(targetUrl)}&country_code=us`;

  const response = await fetch(apiUrl, {
    signal: AbortSignal.timeout(30_000)
  });

  if (!response.ok) {
    throw new Error(`ScraperAPI returned ${response.status}: ${response.statusText}`);
  }

  return await response.text();
}

// ── Main entry ───────────────────────────────────────────────────────────────

export async function scrape({ page, query, model, firearmType }) {
  const apiKey = process.env.SCRAPER_API_KEY || "a96f83295b5cb373ae7d5f5446cc96aa";
  if (!apiKey) {
    console.warn(`[${sourceName}] SCRAPER_API_KEY not set — skipping.`);
    return [];
  }

  const keywords = extractKeywords(query);
  const minMatch = Math.min(2, keywords.length);

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

  // Identify product items on GrabAGun (usually .product-item or .item.product)
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

    // GrabAGun uses standard Magento price boxes: .price-box .price
    const priceText = $card.find(".price-box .price").first().text().trim();

    raw.push({ url: href, title, price: priceText });
  });

  console.log(`[${sourceName}] Raw titles:`, raw.map(r => r.title));
  if (raw.length === 0) return [];

  let relevant = raw.filter(l => {
    const title = (l.title || "").toUpperCase();
    const upBrand = (query.split(" ")[0] || "").toUpperCase(); // Simple brand extraction
    const upModel = (model || "").toUpperCase();
    
    // Check for caliber in title
    const calibers = [".45", "9MM", ".40", ".380", ".22", ".357", ".44", "10MM", ".223", "5.56", ".308", "7.62"];
    const hasCaliber = calibers.some(c => title.includes(c));
    const hasBrand = title.includes(upBrand);
    const hasModel = upModel ? title.includes(upModel) : true;

    // If it contains Brand, Model, and some Caliber, it's highly relevant
    if (hasBrand && hasModel && hasCaliber) {
       // Still block obvious non-firearms like Moulds or Dies if they sneak in
       if (/\b(MOULD|MOLD|DIE[S]?|RELOADING)\b/i.test(title)) return false;
       return true;
    }

    // Fallback to general filters if not a "perfect" match
    return !isAccessory(l.title) && isRelevant(l.title, keywords, sourceName, model);
  });

  console.log(`[${sourceName}] After site-specific filters: ${relevant.length} relevant listing(s).`);

  const results = [];
  for (const l of relevant.slice(0, MAX_LISTINGS)) {
    const p = parseUsdPrice(l.price);
    if (p == null || p <= 0) continue;

    const upper = l.title.toUpperCase();
    let condition = "New"; // Usually new items on GrabAGun
    if (/\bUSED\b/.test(upper)) condition = "Used";
    if (/\bREFURB/.test(upper)) condition = "Used";

    const { brand, caliber } = extractBrandAndCaliber(l.title, keywords);

    results.push({
      sourceName,
      condition,
      pageUrl: l.url,
      title: l.title.slice(0, 200) || null,
      description: l.description || "",
      model: model || "",
      brand,
      caliber,
      price: { currency: "USD", original: p },
    });
  }

  console.log(`[${sourceName}] Done — ${results.length} result(s).`);
  return results;
}
