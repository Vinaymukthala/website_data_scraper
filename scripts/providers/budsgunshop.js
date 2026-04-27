/**
 * BudsGunShop.com scraper — uses ScraperAPI to bypass Cloudflare.
 *
 * This provider does NOT use Puppeteer. Instead, it calls ScraperAPI's
 * proxy endpoint via fetch() and parses the returned HTML with cheerio.
 *
 * Env:
 *   SCRAPER_API_KEY        (required) Your ScraperAPI key
 *   BG_MAX_LISTINGS=10     Max products to return (default 10)
 */

import * as cheerio from "cheerio";
import {
  parseUsdPrice,
  isAccessory,
  extractKeywords,
  isRelevant,
  extractBrandAndCaliber
} from "./_util.js";

export const sourceName = "budsgunshop";

const MAX_LISTINGS = Number(process.env.BG_MAX_LISTINGS) || 10;

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

  // BudsGunShop search URL
  const searchUrl = `https://www.budsgunshop.com/search?q=${encodeURIComponent(query)}`;
  console.log(`[${sourceName}] ${searchUrl} (via ScraperAPI)`);

  let html;
  try {
    html = await fetchViaScraperAPI(searchUrl, apiKey);
  } catch (err) {
    console.error(`[${sourceName}] ScraperAPI error: ${err.message}`);
    throw err;
  }

  // Check for Cloudflare block
  if (html.includes("security verification") || html.includes("Just a moment")) {
    console.warn(`[${sourceName}] Cloudflare blocked even via ScraperAPI.`);
    return [];
  }

  // Parse HTML with cheerio
  const $ = cheerio.load(html);
  const raw = [];

  // BudsGunShop structure:
  //   .product_box_container
  //     a.product-box-link[href="product_info.php/products_id/XXX/slug"]
  //       span[itemprop="name"] → title
  //     span.search_price → price digits (e.g. "783.49")
  $(".product_box_container").each((_, card) => {
    const $card = $(card);

    // Title from itemprop="name"
    const title = ($card.find("span[itemprop='name']").text() || "").trim();
    if (!title || title.length < 5) return;

    // Link
    let href = $card.find("a.product-box-link, a.list-products-name").first().attr("href") || "";
    if (href && !href.startsWith("http")) {
      href = `https://www.budsgunshop.com/${href.replace(/^\//, "")}`;
    }
    if (!href) return;

    // Price from span.search_price
    const priceText = $card.find("span.search_price").first().text().trim();

    raw.push({ url: href, title, price: `$${priceText}` });
  });

  console.log(`[${sourceName}] Extracted ${raw.length} listing(s).`);
  if (raw.length === 0) return [];

  // Filter: accessories
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

    // Infer condition from title
    const upper = l.title.toUpperCase();
    let condition = "New"; // BudsGunShop items are mostly new
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
