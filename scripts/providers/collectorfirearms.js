/**
 * CollectorsFirearms.com scraper.
 *
 * WooCommerce-based site — search via /?s= query parameter.
 * Extracts listings from search results page cards.
 * Condition is inferred from the title (e.g. "NEW") and description text.
 *
 * Env:
 *   CF_MAX_LISTINGS=10   Max products to return (default 10)
 */

import { parseUsdPrice, conditionFromText } from "./_util.js";

export const sourceName = "collectorfirearms";

const BASE_URL = "https://collectorsfirearms.com/";
const MAX_LISTINGS = Number(process.env.CF_MAX_LISTINGS) || 10;

// ── Helpers ──────────────────────────────────────────────────────────────────

const ACCESSORY_RE = /MAGAZINE|HOLSTER|GRIP[S ]|SCOPE|OPTIC|SLING|CLEANING|AMMO|BAYONET|CASE |PARTS KIT|MANUAL|BOOK |CONVERSION KIT|LOADER|LASER|FLASHLIGHT|SUPPRESSOR|SILENCER|KNIFE/i;

function isAccessory(title) {
  const upper = (title || "").toUpperCase();
  if (ACCESSORY_RE.test(upper)) return true;

  // Block standalone barrels, slides, parts — but allow guns that mention barrel length
  if (/\b(BARREL|BARRELS|RECEIVER|SLIDE|UPPER|LOWER|CHOKE|CHOKES|PARTS)\b/.test(upper)) {
    if (/\b(INCH\s+BARREL|IN\s+BARREL|" BARREL|'' BARREL|EXTRA\s+BARREL)\b/.test(upper)) {
      return false;
    }
    return true;
  }
  return false;
}

const CALIBRE_NOISE = new Set([
  "MM", "LUGER", "ACP", "AUTO", "MAG", "MAGNUM", "SPECIAL", "WIN",
  "WINCHESTER", "REM", "REMINGTON", "NATO", "GAP", "SUPER", "SHORT",
  "LONG", "RIFLE", "PISTOL", "SHOTGUN", "GAUGE", "GA", "FOR", "SALE",
  "SN", "NEW", "USED",
]);

function extractKeywords(query) {
  return query.toUpperCase().split(/\s+/)
    .filter(w => w.length >= 2 && !/^\d+$/.test(w) && !CALIBRE_NOISE.has(w));
}

function matchCount(title, keywords) {
  const up = (title || "").toUpperCase();
  return keywords.reduce((n, kw) => n + (up.includes(kw) ? 1 : 0), 0);
}

/**
 * Clean up the raw title from the search card.
 * Removes leading SKU codes like "(SN: CHED655)" and trailing item IDs like "(L2026-04730)"
 */
function cleanTitle(rawTitle) {
  let t = String(rawTitle || "").trim();
  // Remove serial number prefix: "(SN: CHED655)"
  t = t.replace(/^\(SN:\s*[^)]+\)\s*/i, "");
  // Remove item ID suffix: "(L2026-04730)"
  t = t.replace(/\s*\(L\d{4}-\d{4,6}\)\s*/gi, "");
  // Trim trailing "NEW" / "USED" condition tag (we extract it separately)
  // Handles both "PISTOL 9MM NEW" and "PISTOL 9MMNEW" (no space)
  t = t.replace(/(NEW|USED)\s*$/i, "");
  return t.replace(/\s{2,}/g, " ").trim();
}

/**
 * Extract condition from the title text. 
 * CollectorsFirearms often appends "NEW" or mentions condition in the description.
 */
function extractCondition(title, description) {
  const combined = `${title} ${description}`.toUpperCase();
  if (/\bNEW\b/.test(combined) && !/\bUSED\b/.test(combined)) return "New";
  if (/\bUSED\b/.test(combined)) return "Used";
  if (/\bEXCELLENT\b/.test(combined)) return "Used";
  if (/\bVERY GOOD\b/.test(combined)) return "Used";
  if (/\bGOOD\b/.test(combined)) return "Used";
  if (/\bFAIR\b/.test(combined)) return "Used";
  return conditionFromText(combined);
}

// ── Main entry ───────────────────────────────────────────────────────────────

export async function scrape({ page, query, firearmType }) {
  const keywords = extractKeywords(query);
  const minMatch = Math.min(2, keywords.length);

  // Build search URL
  const url = new URL("/", BASE_URL);
  url.searchParams.set("s", query);

  console.log(`[${sourceName}] ${url.href}`);

  // ── Block heavy assets to speed up page load ──────────────────────
  await page.setRequestInterception(true);
  const BLOCKED_TYPES = new Set(["image", "stylesheet", "font", "media", "texttrack", "eventsource"]);
  const BLOCKED_DOMAINS = /google-analytics|googletagmanager|facebook|doubleclick|hotjar|pinterest|tiktok|bing\.com\/bat|clarity\.ms/i;

  page.on("request", (req) => {
    if (BLOCKED_TYPES.has(req.resourceType()) || BLOCKED_DOMAINS.test(req.url())) {
      req.abort();
    } else {
      req.continue();
    }
  });

  // Navigate — WooCommerce search is server-rendered HTML
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 10_000 });

  // Quick wait — product cards are in the initial HTML, no need to wait long
  await page.waitForFunction(
    () => document.querySelectorAll("article, .product, .post, a[href*='/product/']").length > 0
      || /no results|nothing found|no products/i.test(
        (document.body?.innerText || "").slice(0, 3000)),
    { timeout: 4000, polling: 150 }
  ).catch(() => {});

  // Extract listings from the search results page
  const raw = await page.evaluate((base) => {
    const out = [];
    const seen = new Set();

    // WooCommerce search results — articles or product divs
    const cards = document.querySelectorAll(
      "article.product, li.product, div.product, article.post, .post-item"
    );

    for (const card of cards) {
      // Find the title link
      const titleLink = card.querySelector(
        ".woocommerce-loop-product__title a, .product-title a, h2 a, h3 a, .entry-title a, a[href*='/product/']"
      );
      if (!titleLink) continue;

      let href;
      try { href = new URL(titleLink.getAttribute("href") || titleLink.href, base).href; }
      catch { continue; }
      if (seen.has(href)) continue;
      seen.add(href);

      const title = (titleLink.textContent || "").trim();
      if (title.length < 5) continue;

      // Find price
      let priceText = "";
      const priceEl = card.querySelector(".price, .amount, [class*='price']");
      if (priceEl) {
        priceText = (priceEl.textContent || "").trim();
        // WooCommerce sometimes shows sale prices as "$800 $700" — take the last one
        const prices = priceText.match(/\$[\d,]+\.?\d*/g);
        if (prices && prices.length > 1) priceText = prices[prices.length - 1];
      }

      // Find description
      const descEl = card.querySelector(
        ".woocommerce-product-details__short-description, .product-short-description, .entry-summary, .entry-content, p"
      );
      const description = descEl ? (descEl.textContent || "").trim().slice(0, 300) : "";

      out.push({ url: href, title, price: priceText, description });
    }

    // Fallback: if WooCommerce product cards aren't found, try generic links
    if (out.length === 0) {
      for (const a of document.querySelectorAll("a[href*='/product/']")) {
        let href;
        try { href = new URL(a.getAttribute("href") || a.href, base).href; }
        catch { continue; }
        if (seen.has(href)) continue;
        seen.add(href);

        const title = (a.textContent || "").trim();
        if (title.length < 5 || title.length > 300) continue;

        const parent = a.closest("article, div, li, tr");
        let priceText = "";
        if (parent) {
          const m = (parent.textContent || "").match(/\$[\d,]+\.?\d*/);
          if (m) priceText = m[0];
        }
        const description = parent ? (parent.textContent || "").trim().slice(0, 300) : "";

        out.push({ url: href, title, price: priceText, description });
      }
    }

    return out;
  }, BASE_URL);

  console.log(`[${sourceName}] Extracted ${raw.length} listing(s).`);
  if (raw.length === 0) return [];

  // Filter: accessories
  let listings = raw.filter(l => !isAccessory(l.title));

  // Relevance filter (progressive)
  let relevant = listings.filter(l => matchCount(l.title, keywords) >= minMatch);
  if (relevant.length === 0 && keywords.length > 1)
    relevant = listings.filter(l => matchCount(l.title, keywords) >= 1);
  if (relevant.length === 0) relevant = listings;

  // Build results
  const results = [];
  for (const l of relevant.slice(0, MAX_LISTINGS)) {
    const p = parseUsdPrice(l.price);
    if (p == null || p <= 0) continue;

    const title = cleanTitle(l.title);
    const condition = extractCondition(l.title, l.description);

    results.push({
      sourceName,
      condition,
      pageUrl: l.url,
      gunName: title || null,
      price: { currency: "USD", original: p },
    });
  }

  console.log(`[${sourceName}] Done — ${results.length} result(s).`);
  return results;
}
