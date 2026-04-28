/**
 * BudsGunShop.com scraper — uses ScraperAPI to bypass Cloudflare.
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
  normalizeCondition,
  extractSpecsFromHtml
} from "./_util.js";

export const sourceName = "budsgunshop";

const MAX_LISTINGS = Number(process.env.BG_MAX_LISTINGS) || 10;
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

    return { description, condition, ...specs };
  } catch (e) {
    console.warn(`[${sourceName}] PDP fetch failed: ${e.message}`);
    return { description: "", condition: "" };
  }
}

// ── Main entry ───────────────────────────────────────────────────────────────

export async function scrape({ page, query, model, firearmType }) {
  const apiKey = process.env.SCRAPER_API_KEY || "65caf441e3d532533fc4af93002263b9";
  if (!apiKey) {
    console.warn(`[${sourceName}] SCRAPER_API_KEY not set — skipping.`);
    return [];
  }

  const keywords = extractKeywords(query);

  const searchUrl = `https://www.budsgunshop.com/search?q=${encodeURIComponent(query)}`;
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

  // Fetch PDP data in parallel (3 max)
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
