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

import { 
  parseUsdPrice, 
  conditionFromText, 
  isAccessory, 
  extractKeywords, 
  isRelevant,
  normalizeCondition
} from "./_util.js";

export const sourceName = "collectorfirearms";

const BASE_URL = "https://collectorsfirearms.com/";
const MAX_LISTINGS = Number(process.env.CF_MAX_LISTINGS) || 10;

/**
 * Clean up the raw title from the search card.
 * Removes leading SKU codes like "(SN: CHED655)" and trailing item IDs like "(L2026-04730)"
 */
function cleanTitle(rawTitle) {
  let t = String(rawTitle || "").replace(/\s+/g, " ").trim();
  // Remove serial number prefix: "(SN: CHED655)"
  t = t.replace(/^\(SN:\s*[^)]+\)\s*/i, "");
  // Remove item ID suffix: "(L2026-04730)"
  t = t.replace(/\s*\(L\d{4}-\d{4,6}\)\s*/gi, "");
  // Trim trailing "NEW" / "USED" condition tag (we extract it separately)
  // Handles both "PISTOL 9MM NEW" and "PISTOL 9MMNEW" (no space)
  t = t.replace(/(NEW|USED)\s*$/i, "");
  return t.trim();
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

export async function scrape({ page, query, model, firearmType }) {
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
      const description = descEl ? (descEl.textContent || "").trim() : "";

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
        const description = parent ? (parent.textContent || "").trim() : "";

        out.push({ url: href, title, price: priceText, description });
      }
    }

    return out;
  }, BASE_URL);

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

  // ── Scrape detail pages in parallel for descriptions ────────────────
  const PDP_LIMIT = 3;
  const pdpTargets = relevant.slice(0, PDP_LIMIT);

  console.log(`[${sourceName}] Fetching ${pdpTargets.length} PDP(s) in parallel...`);

  const browser = page.browser();
  const pdpDataMap = {};

  await Promise.all(pdpTargets.map(async (listing) => {
    const pdpUrl = listing.url;
    let pdpPage;
    try {
      pdpPage = await browser.newPage();
      try {
        await pdpPage.goto(pdpUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
      } catch {
        // partial load
      }

      await pdpPage.waitForFunction(
        () => (document.body.innerText || "").length > 100,
        { timeout: 3000 }
      ).catch(() => {});

      const data = await pdpPage.evaluate(() => {
        let description = "";
        const descEl = document.querySelector("#tab-description, .woocommerce-Tabs-panel--description, .product-description, .woocommerce-product-details__short-description");
        if (descEl) {
          description = (descEl.innerText || descEl.textContent || "").trim();
        } else {
           const summary = document.querySelector(".summary, .entry-summary");
           if (summary) description = (summary.innerText || summary.textContent || "").trim();
        }
        
        // Remove pricing, SKU, and condition lines
        description = description
           .replace(/\b(SKU|Condition|Price):\s*[^\n\r]+/gi, "")
           .replace(/\$[\d,]+\.?\d*/g, "")
           .replace(/\s+/g, " ")
           .trim();

        // Extract specs from WooCommerce attributes table
        const specs = {};
        document.querySelectorAll(".woocommerce-product-attributes tr, #tab-additional_information tr").forEach(row => {
          const label = (row.querySelector("th")?.textContent || "").trim();
          const value = (row.querySelector("td")?.textContent || "").trim();
          if (label && value && label.length < 40) {
            const key = label.toLowerCase().replace(/\s+(.)/g, (_, c) => c.toUpperCase());
            specs[key] = value;
          }
        });

        // Extract from product meta
        const skuEl = document.querySelector(".sku");
        if (skuEl) specs.sku = skuEl.textContent.trim();
        
        // Extract specs from JSON-LD if present
        document.querySelectorAll('script[type="application/ld+json"]').forEach(el => {
          try {
            const data = JSON.parse(el.textContent);
            if (data["@type"] === "Product") {
              if (data.brand?.name && !specs.brand) specs.brand = data.brand.name;
              if (data.model && !specs.model) specs.model = data.model;
            }
          } catch {}
        });

        // Parse structured label:value lines from description text
        const SKIP_LABELS = /^(price|shipping|payment|item\s*location|location|tax|description|sku|condition|ffl|please|note|we\s)/i;
        const lines = description.split(/\n|\r/);
        for (const line of lines) {
          const match = line.trim().match(/^([A-Za-z][A-Za-z\s/]{1,30}):\s*(.+)/);
          if (match) {
            const label = match[1].trim();
            const value = match[2].trim();
            if (label.length > 1 && value.length > 0 && value.length < 150 && !SKIP_LABELS.test(label)) {
              const key = label.toLowerCase().replace(/\s+(.)/g, (_, c) => c.toUpperCase());
              if (key === "manufacturer") { if (!specs.brand) specs.brand = value; }
              else if (!specs[key]) specs[key] = value;
            }
          }
        }

        return { description, ...specs };
      });

      pdpDataMap[pdpUrl] = data;
    } catch (e) {
      console.warn(`[${sourceName}] PDP failed for ${pdpUrl.substring(pdpUrl.lastIndexOf('/')+1, pdpUrl.lastIndexOf('/')+30)}: ${e.message || e}`);
    } finally {
      if (pdpPage) await pdpPage.close().catch(() => {});
    }
  }));

  // Build results
  const results = [];
  for (const l of pdpTargets) {
    const p = parseUsdPrice(l.price);
    if (p == null || p <= 0) continue;

    const pdp = pdpDataMap[l.url] || {};
    const title = cleanTitle(l.title);
    
    let rawCondition = pdp.condition || extractCondition(l.title, l.description) || "Unknown";
    const condition = normalizeCondition(rawCondition);

    results.push({
      sourceName,
      pageUrl: l.url,
      title: title || null,
      description: (pdp.description || l.description || "").toLowerCase(),
      ...pdp,
      condition,
      model: pdp.model || model || "",
      price: { currency: "USD", original: p },
    });
  }

  console.log(`[${sourceName}] Done — ${results.length} result(s).`);
  return results;
}
