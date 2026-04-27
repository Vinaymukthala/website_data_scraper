/**
 * Palmetto State Armory (PSA) scraper — uses ScraperAPI to bypass Cloudflare.
 *
 * PSA is a Magento store. We scrape their catalog search page, which is
 * server-rendered and accessible via plain ScraperAPI (no render=true needed).
 *
 * Env:
 *   SCRAPER_API_KEY        (required) Your ScraperAPI key
 *   PSA_MAX_LISTINGS=10    Max products to return (default 10)
 */

import * as cheerio from "cheerio";
import {
  parseUsdPrice,
  isAccessory,
  extractKeywords,
  isRelevant,
  extractBrandAndCaliber
} from "./_util.js";

export const sourceName = "palmettostatearmory";

const MAX_LISTINGS = Number(process.env.PSA_MAX_LISTINGS) || 10;

/**
 * Fetch via ScraperAPI — plain mode, no render needed for Magento stores.
 */
async function fetchViaScraperAPI(targetUrl, apiKey) {
  const apiUrl = `https://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(targetUrl)}`;
  const response = await fetch(apiUrl, { signal: AbortSignal.timeout(30_000) });
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

  // PSA uses Magento's catalogsearch
  const searchUrl = `https://palmettostatearmory.com/catalogsearch/result/?q=${encodeURIComponent(query)}`;
  console.log(`[${sourceName}] ${searchUrl} (via ScraperAPI)`);

  let html;
  try {
    html = await fetchViaScraperAPI(searchUrl, apiKey);
  } catch (err) {
    console.error(`[${sourceName}] ScraperAPI error: ${err.message}`);
    throw err;
  }

  // Cloudflare / block check
  if (html.includes("security verification") || html.includes("Just a moment")) {
    console.warn(`[${sourceName}] Blocked by Cloudflare.`);
    return [];
  }

  // Parse HTML with cheerio
  // Magento product card structure:
  //   li.item.product.product-item
  //     a.product-item-photo[href] → product URL
  //     .product-item-name → title text
  //     .price-box
  //       span.price-wrapper.final-price span.price → sale/final price
  //       span.price-wrapper (first one if no sale) span.price → regular price
  const $ = cheerio.load(html);
  const raw = [];

  $(".item.product.product-item").each((_, card) => {
    const $card = $(card);

    // Title
    const title = ($card.find(".product-item-name").text() || "").trim();
    if (!title || title.length < 5) return;

    // URL
    let href = $card.find("a.product-item-link, a.product-item-photo, a").first().attr("href") || "";
    if (!href) return;

    // Price — prefer final-price (sale), fall back to first price-wrapper
    let priceText = $card.find("span.price-wrapper.final-price span.price").first().text().trim();
    if (!priceText) {
      priceText = $card.find("span.price-wrapper span.price").first().text().trim();
    }
    if (!priceText) {
      // Last fallback: any $XX.XX pattern in the card
      const m = $card.text().match(/\$[\d,]+\.?\d{0,2}/);
      if (m) priceText = m[0];
    }

    raw.push({ title, price: priceText, url: href });
  });

  console.log(`[${sourceName}] Extracted ${raw.length} listing(s).`);
  if (raw.length === 0) return [];

  // Filter accessories
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

  // Build results
  const results = [];
  for (const l of relevant.slice(0, MAX_LISTINGS)) {
    const p = parseUsdPrice(l.price);
    if (p == null || p <= 0) continue;

    const upper = l.title.toUpperCase();
    let condition = "New"; // PSA sells new firearms
    if (/\bUSED\b/.test(upper)) condition = "Used";

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
