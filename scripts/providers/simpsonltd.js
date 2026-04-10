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
import { conditionFromText, ensureNotBlocked, parseUsdPrice, toAbsoluteUrl } from "./_util.js";

export const sourceName = "simpsonltd";

const BASE_URL = "https://www.simpsonltd.com/";
const MAX_LISTINGS = Number(process.env.SL_MAX_LISTINGS) || 10;
const DETAIL_DELAY_MS = Number(process.env.SL_DETAIL_DELAY) || 200;

// ---------------------------------------------------------------------------
// Relevance filtering — same approach as GI
// ---------------------------------------------------------------------------
const CALIBRE_NOISE = new Set([
  "MM", "LUGER", "ACP", "AUTO", "MAG", "MAGNUM", "SPECIAL", "WIN",
  "WINCHESTER", "REM", "REMINGTON", "NATO", "GAP", "SUPER", "SHORT",
  "LONG", "RIFLE", "PISTOL", "SHOTGUN", "GAUGE", "GA", "FOR", "SALE",
  "12GA", "20GA", "28GA", "410",
]);

function extractKeywords(query) {
  return query
    .toUpperCase()
    .split(/\s+/)
    .filter(w => w.length >= 2 && !/^\d+$/.test(w) && !CALIBRE_NOISE.has(w));
}

function isRelevant(title, keywords, minMatch) {
  if (!title || keywords.length === 0) return true;
  const upper = title.toUpperCase();
  let matched = 0;
  for (const kw of keywords) {
    if (upper.includes(kw)) matched++;
  }
  return matched >= minMatch;
}

// ---------------------------------------------------------------------------
// Accessory keywords — filter out non-guns
// ---------------------------------------------------------------------------
const ACCESSORY_KEYWORDS = [
  "MAGAZINE", "MAGAZINES", "MAG ", "MAGS ",
  "HOLSTER", "HOLSTERS",
  "GRIP", "GRIPS",
  "BARREL ONLY", "BARREL ASSEMBLY",
  "STOCK ONLY", "STOCK SET",
  "SCOPE", "OPTIC", "OPTICS",
  "SLING", "CASE ", "HARD CASE", "SOFT CASE",
  "CLEANING KIT", "TOOL", "WRENCH",
  "FOREND ONLY", "BUTTSTOCK",
  "MANUAL", "BOOK ", "BOOKS",
  "PARTS KIT", "PARTS LOT", "SPARE PARTS",
  "CONVERSION KIT",
  "LOADER", "SPEEDLOADER",
  "LIGHT", "LASER", "FLASHLIGHT",
  "SUPPRESSOR", "SILENCER",
  "BAYONET", "KNIFE",
  "AMMO", "AMMUNITION", "CARTRIDGE",
  "RELOADING",
];

function isAccessory(title) {
  const upper = (title || "").toUpperCase();
  return ACCESSORY_KEYWORDS.some(kw => upper.includes(kw));
}

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
        if (calM) specs.caliber = calM[1].trim();
        if (blueM) specs.blue = blueM[1].trim();
        if (boreM) specs.bore = boreM[1].trim();
        if (barrelM) specs.barrel = barrelM[1].trim();
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

    const specs = {};
    const specPatterns = [
      { key: "blue",    re: /\bBlue:\s*([^\n\r,]+)/i },
      { key: "bore",    re: /\bBore:\s*([^\n\r,]+)/i },
      { key: "caliber", re: /\bCal(?:iber)?:\s*([^\n\r,]+)/i },
      { key: "barrel",  re: /\bBarrel:\s*([^\n\r,]+)/i },
      { key: "action",  re: /\bAction:\s*([^\n\r,]+)/i },
    ];
    for (const { key, re } of specPatterns) {
      const m = bodyText.match(re);
      if (m) specs[key] = m[1].trim().slice(0, 50);
    }

    const conditionParts = [];
    if (specs.blue)   conditionParts.push(`Blue: ${specs.blue}`);
    if (specs.bore)   conditionParts.push(`Bore: ${specs.bore}`);
    const condition = conditionParts.join(", ") || "Unknown";

    return { title, sku, priceText, condition, specs, pageUrl };
  }, href);

  return data;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
export async function scrape({ page, query }) {
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
  const beforeFilter = listings.length;
  listings = listings.filter(l => {
    const title = cleanTitle(l.rawTitle);
    if (isAccessory(title)) {
      console.log(`[${sourceName}] Skipping accessory: "${title}"`);
      return false;
    }
    return true;
  });
  console.log(`[${sourceName}] Filtered: ${beforeFilter} → ${listings.length} (removed ${beforeFilter - listings.length} accessories)`);

  // ── Relevance filtering — match user query keywords ────────────────
  const keywords = extractKeywords(query);
  const minMatch = Math.min(2, keywords.length);

  let relevant = listings.filter(l => isRelevant(cleanTitle(l.rawTitle), keywords, minMatch));
  console.log(`[${sourceName}] Relevance: ${listings.length} → ${relevant.length} strict match (keywords: [${keywords.join(", ")}])`);

  // Fallback: relax to 1 keyword (brand only)
  if (relevant.length === 0 && keywords.length > 1) {
    relevant = listings.filter(l => isRelevant(cleanTitle(l.rawTitle), keywords, 1));
    console.log(`[${sourceName}] Relaxed to 1-keyword match: ${relevant.length} result(s)`);
  }

  // Final fallback: all non-accessory listings
  if (relevant.length === 0) {
    relevant = listings;
    console.log(`[${sourceName}] Using all ${relevant.length} non-accessory listings as fallback.`);
  }

  listings = relevant.slice(0, MAX_LISTINGS);

  if (listings.length === 0) {
    console.warn(`[${sourceName}] No firearm listings found after filtering.`);
    return [];
  }

  // ── Try quick results from listing page ────────────────────────────
  const quickResults = listings
    .map((p) => {
      const pageUrl = toAbsoluteUrl(BASE_URL, p.href);
      const price = parseUsdPrice(p.priceText);
      if (!pageUrl || price == null || price <= 0) return null;

      const title = cleanTitle(p.rawTitle);
      return {
        sourceName,
        condition: conditionFromText(title),
        pageUrl,
        gunName: title || null,
        specs: p.specs || {},
        price: { currency: "USD", original: price },
      };
    })
    .filter(Boolean);

  if (quickResults.length > 0) {
    console.log(`[${sourceName}] Got ${quickResults.length} result(s) from listing page.`);
    return quickResults;
  }

  // ── Visit detail pages for missing prices ──────────────────────────
  console.log(`[${sourceName}] Visiting detail pages for prices…`);
  const results = [];

  for (let i = 0; i < listings.length; i++) {
    const listing = listings[i];
    const pageUrl = toAbsoluteUrl(BASE_URL, listing.href);
    if (!pageUrl) continue;

    console.log(`[${sourceName}] [${i + 1}/${listings.length}] Scraping: ${pageUrl}`);

    try {
      const data = await scrapeDetailPage(page, pageUrl);

      if (isAccessory(data.title)) {
        console.log(`[${sourceName}]   → Accessory: "${data.title}" — skipping.`);
        continue;
      }

      const price = parseUsdPrice(data.priceText);
      if (price == null || price <= 0) {
        console.log(`[${sourceName}]   → No valid price — skipping.`);
        continue;
      }

      results.push({
        sourceName,
        condition: data.condition || conditionFromText(data.title) || "Unknown",
        pageUrl,
        gunName: data.title || cleanTitle(listing.rawTitle) || null,
        sku: data.sku || null,
        specs: data.specs || {},
        price: { currency: "USD", original: price },
      });

      console.log(`[${sourceName}]   → "${data.title}" — $${price}`);
    } catch (err) {
      console.warn(`[${sourceName}]   → Error: ${err?.message}`);
    }

    if (i < listings.length - 1) await delay(DETAIL_DELAY_MS);
  }

  console.log(`[${sourceName}] Done — ${results.length} result(s).`);
  return results;
}
