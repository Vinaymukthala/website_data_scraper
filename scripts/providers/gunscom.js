/**
 * Guns.com scraper — uses ScraperAPI to bypass bot protection.
 *
 * Env:
 *   SCRAPER_API_KEY        (required) Your ScraperAPI key
 *   GUNSCOM_MAX_LISTINGS=10 Max products to return (default 10)
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

export const sourceName = "gunscom";

const MAX_LISTINGS = Number(process.env.GUNSCOM_MAX_LISTINGS) || 10;
const PDP_LIMIT = 3;

/**
 * Fetch HTML via ScraperAPI with render=true (for JS-rendered search pages).
 */
async function fetchRendered(targetUrl, apiKey) {
  const apiUrl = `https://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(targetUrl)}&country_code=us&render=true&wait_for_selector=.product-card`;
  const response = await fetch(apiUrl, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    throw new Error(`ScraperAPI returned ${response.status}: ${response.statusText}`);
  }
  return await response.text();
}

/**
 * Fetch HTML via ScraperAPI (plain, no render — for PDP pages).
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
 * Fetch a single PDP page via ScraperAPI and extract description + condition.
 */
async function fetchPdpData(pdpUrl, apiKey) {
  try {
    const html = await fetchViaScraperAPI(pdpUrl, apiKey);
    const $ = cheerio.load(html);

    let description = "";
    // Guns.com PDP selectors
    const descEl = $(".product-description, .pdp-description, [itemprop='description'], #description, .product-info-description").first();
    if (descEl.length) {
      description = descEl.text().trim();
    } else {
      // Fallback: meta description
      const metaDesc = $("meta[name='description']").attr("content") || "";
      if (metaDesc && metaDesc.length > 20) {
        description = metaDesc;
      }
    }

    // Fallback: largest paragraph
    if (!description) {
      const paragraphs = [];
      $("p, .value, .detail-text").each((_, el) => {
        const t = $(el).text().trim();
        if (t.length > 80 && !t.includes("Guns.com") && !t.includes("Copyright") && !t.includes("Terms")) {
          paragraphs.push(t);
        }
      });
      if (paragraphs.length > 0) {
        description = paragraphs.sort((a, b) => b.length - a.length)[0];
      }
    }

    // Extract condition
    let condition = "";
    const condEl = $("[class*='condition'], .product-condition, td:contains('Condition')").first();
    if (condEl.length) condition = condEl.text().replace(/\s+/g, " ").trim();

    // Guns.com labels: "New", "Certified Used"
    if (!condition) {
      const label = $(".product-label, .badge, .tag").first().text().trim();
      if (/new|used|certified/i.test(label)) condition = label;
    }

    description = description.replace(/\s+/g, " ").trim();
    const specs = extractSpecsFromHtml($);
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

  const searchUrl = `https://www.guns.com/search?keyword=${encodeURIComponent(query)}`;
  console.log(`[${sourceName}] ${searchUrl} (via ScraperAPI)`);

  let html;
  try {
    html = await fetchRendered(searchUrl, apiKey);
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

  // Guns.com product cards
  $(".product-item, .product-card, [class*='product-tile']").each((_, card) => {
    const $card = $(card);

    const titleElem = $card.find(".product-name, .title, h3, a[class*='product']").first();
    const title = (titleElem.text() || "").trim();
    if (!title || title.length < 5) return;

    let href = $card.find("a").first().attr("href") || "";
    if (href && !href.startsWith("http")) {
      href = `https://www.guns.com${href.startsWith("/") ? "" : "/"}${href}`;
    }
    if (!href) return;

    const priceText = $card.find(".price, .price-box, [class*='price']").first().text().trim();
    raw.push({ url: href, title, price: priceText });
  });

  console.log(`[${sourceName}] Extracted ${raw.length} listing(s).`);
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
      rawCond = "New"; // Guns.com sells new and used
      if (/\bUSED\b/.test(upper) || /\bCERTIFIED USED\b/.test(upper)) rawCond = "Used";
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
