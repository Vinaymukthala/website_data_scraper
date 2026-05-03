/**
 * CollectorsFirearms.com scraper.
 *
 * Simple approach:
 *   1. Search via /?s= query
 *   2. Match listing titles against LLM-normalized brand + model
 *   3. Return max 3 matching results
 *   4. Condition: "NEW" in title → New, else scan description for grade
 */

import { parseUsdPrice, isRelevant, extractKeywords } from "./_util.js";

export const sourceName = "collectorfirearms";

const BASE_URL = "https://collectorsfirearms.com/";
const MAX_RESULTS = 3;

/**
 * Condition logic:
 * - "NEW" in title → "New"
 * - Otherwise scan description for: Excellent, Very Good, Good, Fair
 * - Default: "Used"
 */
function extractCondition(title, description) {
  const upTitle = (title || "").toUpperCase();
  if (/\bNEW\b/.test(upTitle)) return "New";

  const upDesc = (description || "").toUpperCase();
  if (/\bEXCELLENT\b/.test(upDesc)) return "Excellent";
  if (/\bVERY\s+GOOD\b/.test(upDesc)) return "Very Good";
  if (/\bGOOD\b/.test(upDesc) && !/\bVERY\s+GOOD\b/.test(upDesc)) return "Good";
  if (/\bFAIR\b/.test(upDesc)) return "Fair";
  return "Used";
}

/**
 * Clean up raw title — remove serial numbers and item IDs.
 */
function cleanTitle(rawTitle) {
  let t = String(rawTitle || "").replace(/\s+/g, " ").trim();
  t = t.replace(/^\(SN:\s*[^)]+\)\s*/i, "");
  t = t.replace(/\s*\(L\d{4}-\d{4,6}\)\s*/gi, "");
  return t.trim();
}

// ── Main entry ───────────────────────────────────────────────────────────────

export async function scrape({ page, query, brand, model, caliber, firearmType }) {
  const url = new URL("/", BASE_URL);
  url.searchParams.set("s", query);

  console.log(`[${sourceName}] ${url.href}`);

  // Block heavy assets
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (["image", "stylesheet", "font", "media"].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 10_000 });

  await page.waitForFunction(
    () => document.querySelectorAll("article, .product, a[href*='/product/']").length > 0
      || /no results|nothing found|no products/i.test(
        (document.body?.innerText || "").slice(0, 3000)),
    { timeout: 4000, polling: 150 }
  ).catch(() => {});

  // Extract all listings from search page
  const raw = await page.evaluate((base) => {
    const out = [];
    const seen = new Set();

    const cards = document.querySelectorAll(
      "article.product, li.product, div.product, article.post, .post-item"
    );

    for (const card of cards) {
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

      let priceText = "";
      const priceEl = card.querySelector(".price, .amount, [class*='price']");
      if (priceEl) {
        priceText = (priceEl.textContent || "").trim();
        const prices = priceText.match(/\$[\d,]+\.?\d*/g);
        if (prices && prices.length > 1) priceText = prices[prices.length - 1];
      }

      const descEl = card.querySelector(
        ".woocommerce-product-details__short-description, .product-short-description, .entry-summary, .entry-content, p"
      );
      const description = descEl ? (descEl.textContent || "").trim() : "";

      out.push({ url: href, title, price: priceText, description });
    }

    // Fallback: generic product links
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
        const description = parent ? (parent.textContent || "").trim() : "";

        out.push({ url: href, title, price: priceText, description });
      }
    }

    return out;
  }, BASE_URL);

  console.log(`[${sourceName}] Extracted ${raw.length} listing(s).`);
  if (raw.length === 0) return [];

  const upBrand = (brand || "").toUpperCase();
  const upModel = (model || "").toUpperCase();
  const keywords = extractKeywords(query);

  const matched = raw.filter(l => {
    const upTitle = (l.title || "").toUpperCase();
    if (upBrand && !upTitle.includes(upBrand)) return false;
    if (upModel && !upModel.split(" ").every(w => upTitle.includes(w))) return false;
    
    // Reuse universal relevance filter for caliber/gauge logic
    if (!isRelevant(l.title, keywords, sourceName, model, query)) {
      return false;
    }
    
    return true;
  });

  console.log(`[${sourceName}] Matched ${matched.length} listing(s) for "${brand} ${model}".`);

  // Build results — max 3
  const matchedTargets = matched.slice(0, MAX_RESULTS);
  const browser = page.browser();
  const pdpDataMap = {};

  if (matchedTargets.length > 0) {
    console.log(`[${sourceName}] Fetching ${matchedTargets.length} PDP(s) for full descriptions...`);
    await Promise.all(matchedTargets.map(async (l) => {
      let pdpPage;
      try {
        pdpPage = await browser.newPage();
        // disable assets for speed
        await pdpPage.setRequestInterception(true);
        pdpPage.on("request", (req) => {
          if (["image", "stylesheet", "font", "media"].includes(req.resourceType())) req.abort();
          else req.continue();
        });

        await pdpPage.goto(l.url, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
        
        const fullDesc = await pdpPage.evaluate(() => {
          const el = document.querySelector(".single-product-description, #tab-description, .woocommerce-Tabs-panel--description, .product-description");
          if (el) return el.textContent;
          const backup = document.querySelector(".summary, .entry-summary");
          return backup ? backup.textContent : "";
        });

        if (fullDesc) {
          pdpDataMap[l.url] = fullDesc.replace(/\b(SKU|Condition|Price):\s*[^\n\r]+/gi, "").replace(/\s+/g, " ").trim();
        }
      } catch (e) {
        // ignore errors
      } finally {
        if (pdpPage) await pdpPage.close().catch(() => {});
      }
    }));
  }

  const results = [];
  for (const l of matchedTargets) {
    const p = parseUsdPrice(l.price);
    if (p == null || p <= 0) continue;

    const title = cleanTitle(l.title);
    const fullDescription = pdpDataMap[l.url] || l.description || "";
    const condition = extractCondition(l.title, fullDescription);

    results.push({
      sourceName,
      pageUrl: l.url,
      title: title || null,
      description: fullDescription.toLowerCase(),
      condition,
      brand: brand || "",
      model: model || "",
      caliber: caliber || "",
      price: { currency: "USD", original: p },
    });
  }

  console.log(`[${sourceName}] Done — ${results.length} result(s).`);
  return results;
}
