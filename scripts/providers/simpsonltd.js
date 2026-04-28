/**
 * SimpsonLtd.com scraper.
 *
 * Flow:
 *   1. Navigate to /search?query=QUERY
 *   2. Collect product listing links (a.list-item-link)
 *   3. Filter out accessories + relevance filter
 *   4. Extract prices from listing page or visit detail pages
 *   5. Return normalised result array
 *
 * Env:
 *   SL_MAX_LISTINGS=10    Max products to return (default 10)
 *   SL_DETAIL_DELAY=200   ms between detail page requests (default 200)
 */

import { setTimeout as delay } from "node:timers/promises";
import { 
  conditionFromText, 
  ensureNotBlocked, 
  parseUsdPrice, 
  toAbsoluteUrl,
  isAccessory,
  extractKeywords,
  isRelevant,
  normalizeCondition
} from "./_util.js";

export const sourceName = "simpsonltd";

const BASE_URL = "https://www.simpsonltd.com/";
const MAX_LISTINGS = Number(process.env.SL_MAX_LISTINGS) || 10;
const DETAIL_DELAY_MS = Number(process.env.SL_DETAIL_DELAY) || 200;

// ---------------------------------------------------------------------------
// Clean up raw title from listing cards
// ---------------------------------------------------------------------------
function cleanTitle(rawTitle) {
  if (!rawTitle) return "";
  let t = rawTitle;
  const dollarIdx = t.indexOf("$");
  if (dollarIdx > 0) t = t.slice(0, dollarIdx);
  t = t.replace(/^[A-Z]\d{4,7}\s+/, "");
  t = t.replace(/Cal:\s*[^\s]+/gi, "");
  t = t.replace(/Blue:\s*[^\s]+/gi, "");
  t = t.replace(/Bore:\s*[^\s]+/gi, "");
  t = t.replace(/Barrel:\s*[^\s]+/gi, "");
  t = t.replace(/\s{2,}/g, " ").trim();
  return t;
}

// ---------------------------------------------------------------------------
// Step 1: Navigate to search
// ---------------------------------------------------------------------------
async function navigateSearch(page, query) {
  const searchUrl = new URL("/search", BASE_URL);
  searchUrl.searchParams.set("query", query);
  console.log(`[${sourceName}] Searching: ${searchUrl.href}`);
  await page.goto(searchUrl.href, { waitUntil: "domcontentloaded", timeout: 10_000 });
  await ensureNotBlocked(page, `${sourceName}: after navigation`);
}

// ---------------------------------------------------------------------------
// Step 2: Collect listing URLs
// ---------------------------------------------------------------------------
async function collectListingUrls(page) {
  await page.waitForFunction(
    () => {
      const cards = document.querySelectorAll("a.list-item-link, .search-results a[href*='/products/']");
      const noResults = /no results|nothing found|0 results/i.test(
        (document.body?.innerText || "").slice(0, 3000)
      );
      return cards.length > 0 || noResults;
    },
    { timeout: 5_000, polling: 250 }
  ).catch(() => {});

  await delay(100);

  const listings = await page.evaluate((baseUrl) => {
    const seen = new Set();
    const out = [];

    let cards = Array.from(document.querySelectorAll("a.list-item-link"));
    if (cards.length === 0) {
      cards = Array.from(document.querySelectorAll("a[href*='/products/']"));
    }

    for (const a of cards) {
      let href;
      try { href = new URL(a.getAttribute("href") || a.href, baseUrl).href; }
      catch { continue; }

      if (!href.includes("/products/")) continue;
      if (seen.has(href)) continue;
      seen.add(href);

      const rawTitle = (a.textContent || "").trim().slice(0, 400);

      const priceText = (
        a.querySelector("p.search-item-price > span, span.search-item-price, .price span, .price")
          ?.textContent || ""
      ).trim();

      const specs = {};
      const specSpans = a.querySelectorAll("span");
      for (const s of specSpans) {
        const t = (s.textContent || "").trim();
        const calM = t.match(/^Cal:\s*(.+)/i);
        const blueM = t.match(/^Blue:\s*(.+)/i);
        const boreM = t.match(/^Bore:\s*(.+)/i);
        const barrelM = t.match(/^Barrel:\s*(.+)/i);
        const stockM = t.match(/^Stock:\s*(.+)/i);
        if (calM) specs.caliber = calM[1].trim();
        if (blueM) specs.blue = blueM[1].trim();
        if (boreM) specs.bore = boreM[1].trim();
        if (barrelM) specs.barrel = barrelM[1].trim();
        if (stockM) specs.stock = stockM[1].trim();
      }

      out.push({ href, rawTitle, priceText, specs });
    }

    return out;
  }, BASE_URL);

  console.log(`[${sourceName}] Found ${listings.length} listing(s) on search results page.`);
  return listings;
}

// ---------------------------------------------------------------------------
// Step 3: Scrape a single detail page
// ---------------------------------------------------------------------------
async function scrapeDetailPage(page, href) {
  await page.goto(href, { waitUntil: "domcontentloaded", timeout: 10_000 });
  await ensureNotBlocked(page, `${sourceName}: detail page`);
  const data = await page.evaluate((pageUrl) => {
    const h1 = document.querySelector("h1");
    const title = (h1?.innerText || h1?.textContent || document.title || "").trim();

    let sku = "";
    const h3s = document.querySelectorAll("h3");
    for (const h of h3s) {
      const t = (h.innerText || h.textContent || "").trim();
      const m = t.match(/SKU:\s*(\S+)/i);
      if (m) { sku = m[1]; break; }
    }

    const mainArea =
      document.querySelector("main, #main, .product-detail, .product-page, article") ||
      document.body;
    const bodyText = (mainArea?.innerText || document.body?.innerText || "").trim();

    let priceText = "";
    const priceEl = document.querySelector(".product-price, [class*='price'], #price, .price");
    if (priceEl) {
      const t = (priceEl.innerText || priceEl.textContent || "").trim();
      if (/\$[\d,]+/.test(t)) priceText = t;
    }

    if (!priceText) {
      const allEls = mainArea.querySelectorAll("span, div, p, td, strong, b");
      for (const el of allEls) {
        const t = (el.innerText || el.textContent || "").trim();
        if (/^\$[\d,]+\.?\d*$/.test(t)) { priceText = t; break; }
      }
    }

    if (!priceText) {
      const m = bodyText.match(/\$\s*([\d,]+\.?\d*)/);
      if (m) priceText = "$" + m[1];
    }

    // Extract ALL label:value specs from body text
    const specs = {};
    const SKIP_LABELS = /^(price|shipping|sku|call|email|contact|simpson|privacy|address|phone)/i;
    const lines = bodyText.split(/\n/);
    for (const line of lines) {
      const match = line.trim().match(/^([A-Za-z][A-Za-z\s/]{1,25}):\s*(.+)/);
      if (match) {
        const label = match[1].trim();
        const value = match[2].trim();
        if (label.length > 1 && value.length > 0 && value.length < 150 && !SKIP_LABELS.test(label)) {
          let key = label.toLowerCase().replace(/\s+(.)/g, (_, c) => c.toUpperCase());
          // Normalize aliases
          if (key === "cal") key = "caliber";
          if (!specs[key]) specs[key] = value;
        }
      }
    }

    const conditionParts = [];
    if (specs.stock) conditionParts.push(specs.stock);
    
    if (conditionParts.length === 0) {
      if (specs.blue)   conditionParts.push(`Blue: ${specs.blue}`);
      if (specs.bore)   conditionParts.push(`Bore: ${specs.bore}`);
    }
    const condition = conditionParts.join(", ") || "Unknown";

    return { title, priceText, condition, description: "", pageUrl, ...specs };
  }, href);

  return data;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
export async function scrape({ page, query, model, firearmType }) {
  const keywords = extractKeywords(query);

  await navigateSearch(page, query);

  let listings = await collectListingUrls(page);

  if (listings.length === 0) {
    console.warn(`[${sourceName}] No listings found for query: "${query}".`);
    const simpleQuery = query.split(" ")[0];
    if (simpleQuery !== query) {
      console.log(`[${sourceName}] Retrying with simpler query: "${simpleQuery}"`);
      await navigateSearch(page, simpleQuery);
      const fallbackListings = await collectListingUrls(page);
      if (fallbackListings.length === 0) {
        console.warn(`[${sourceName}] Still no results. Returning empty.`);
        return [];
      }
      listings.push(...fallbackListings);
    } else {
      return [];
    }
  }

  // ── Filter out accessories ─────────────────────────────────────────
  const relevant = listings.filter(l => {
    const title = (l.rawTitle || "").toUpperCase();
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

    return !isAccessory(l.rawTitle) && isRelevant(l.rawTitle, keywords, sourceName, model);
  });

  const PDP_LIMIT = 3;
  const pdpTargets = relevant.slice(0, PDP_LIMIT);

  if (pdpTargets.length === 0) {
    console.warn(`[${sourceName}] No firearm listings found after filtering.`);
    return [];
  }

  console.log(`[${sourceName}] Visiting ${pdpTargets.length} detail pages sequentially...`);
  const results = [];

  for (let i = 0; i < pdpTargets.length; i++) {
    const listing = pdpTargets[i];
    const pageUrl = toAbsoluteUrl(BASE_URL, listing.href);
    if (!pageUrl) continue;

      console.log(`[${sourceName}] [${i + 1}/${pdpTargets.length}] Scraping: ${pageUrl}`);

    try {
      const data = await scrapeDetailPage(page, pageUrl);

      const finalTitle = data.title || cleanTitle(listing.rawTitle) || "";
      if (isAccessory(finalTitle)) {
        console.log(`[${sourceName}]   → Accessory: "${finalTitle}" — skipping.`);
        continue;
      }

      const price = parseUsdPrice(data.priceText || listing.priceText);
      if (price == null || price <= 0) {
        console.log(`[${sourceName}]   → No valid price — skipping.`);
        continue;
      }

      // Extract description from PDP page text
      let description = data.description || "";
      if (!description) {
        // Try to extract from body text on PDP
        try {
          description = await page.evaluate(() => {
            const mainArea = document.querySelector("main, #main, .product-detail, .product-page, article") || document.body;
            const ps = Array.from(mainArea.querySelectorAll("p"))
              .map(p => (p.innerText || p.textContent || "").trim())
              .filter(t => t.length > 50 && !t.includes("Simpson Limited") && !t.includes("Privacy Policy") && !t.includes("Call us at"));
            if (ps.length > 0) return ps.sort((a, b) => b.length - a.length)[0];
            return "";
          });
        } catch { description = ""; }
      }

      results.push({
        sourceName,
        pageUrl,
        title: finalTitle || null,
        description: (description || "").toLowerCase().replace(/\s+/g, " "),
        ...data,
        ...listing.specs,
        condition: normalizeCondition(data.condition),
        model: data.model || model || "",
        price: { currency: "USD", original: price },
      });

      console.log(`[${sourceName}]   → "${data.title}" — $${price}`);
    } catch (err) {
      console.warn(`[${sourceName}]   → Error: ${err?.message}`);
    }

    if (i < pdpTargets.length - 1) await delay(DETAIL_DELAY_MS);
  }

  console.log(`[${sourceName}] Done — ${results.length} result(s).`);
  return results;
}
