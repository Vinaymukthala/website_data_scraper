/**
 * GunBroker.com scraper — uses ScraperAPI to bypass Cloudflare.
 *
 * GunBroker is an auction/marketplace site. We scrape the "Buy Now"
 * search results which include fixed prices, not auction bids.
 *
 * Env:
 *   SCRAPER_API_KEY        (required) Your ScraperAPI key
 *   GB_MAX_LISTINGS=10     Max products to return (default 10)
 */

import * as cheerio from "cheerio";
import {
  parseUsdPrice,
  isAccessory,
  extractKeywords,
  isRelevant,
  extractBrandAndCaliber
} from "./_util.js";

export const sourceName = "gunbroker";

const MAX_LISTINGS = Number(process.env.GB_MAX_LISTINGS) || 10;

/**
 * Fetch HTML from a URL via ScraperAPI (plain — no render=true needed for GunBroker).
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

  // Sort=13 = Buy Now items,
  const searchUrl = `https://www.gunbroker.com/all/search?keywords=${encodeURIComponent(query)}&Sort=13`;
  console.log(`[${sourceName}] ${searchUrl} (via ScraperAPI)`);

  let html;
  try {
    html = await fetchViaScraperAPI(searchUrl, apiKey);
  } catch (err) {
    console.error(`[${sourceName}] ScraperAPI error: ${err.message}`);
    throw err;
  }

  // Cloudflare check
  if (html.includes("security verification") || html.includes("Just a moment")) {
    console.warn(`[${sourceName}] Blocked by Cloudflare.`);
    return [];
  }

  // Parse HTML with cheerio
  // GunBroker structure:
  //   div.listing[id="item-XXXXXXXXXX"]
  //     div.listing-text  → title (repeated twice, take first unique)
  //     div.listing-meta  → "Qty: X Item #:XXXXXXXXXX"
  //   Price is in the card text as "Price $XXX.XX"
  const $ = cheerio.load(html);
  const raw = [];

  $("div.listing[id^='item-']").each((_, card) => {
    const $card = $(card);
    const id = ($card.attr("id") || "").replace("item-", "").trim();
    if (!id) return;

    // Title comes from listing-text, which repeats — take the trimmed first line
    const titleEl = $card.find(".listing-text").first();
    const titleRaw = (titleEl.text() || "").trim().replace(/\s+/g, " ");
    // listing-text repeats the title twice (e.g. "GLOCK 19 GLOCK 19"), deduplicate
    const half = Math.ceil(titleRaw.length / 2);
    const half1 = titleRaw.slice(0, half).trim();
    const half2 = titleRaw.slice(half).trim();
    const title = (half1 === half2 || half2.startsWith(half1)) ? half1 : titleRaw;
    const cleanTitle = title.replace(/\s+/g, " ").trim();

    if (!cleanTitle || cleanTitle.length < 3) return;

    // Price: find "Price $XXX.XX" pattern in the full card text
    const cardText = $card.text();
    const priceMatch = cardText.match(/Price\s+(\$[\d,]+\.?\d{0,2})/);
    const priceText = priceMatch ? priceMatch[1] : "";

    const pageUrl = `https://www.gunbroker.com/item/${id}`;
    raw.push({ title: cleanTitle, price: priceText, url: pageUrl });
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
    let condition = "Used"; // GunBroker is mostly used/private-seller
    if (/\bNEW\b/.test(upper) && !/\bUSED\b/.test(upper)) condition = "New";
    if (/\bNIB\b/.test(upper) || /\bNEW IN BOX\b/.test(upper)) condition = "New";

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
