/**
 * Palmetto State Armory (PSA) scraper — uses ScraperAPI to bypass Cloudflare.
 *
 * PSA is a Magento store. We scrape their catalog search page.
 *
 * Env:
 *   SCRAPER_API_KEY        (required) Your ScraperAPI key
 *   SCRAPE_TIMEOUT_MS      ScraperAPI fetch timeout per request (default 15000)
 *   PSA_MAX_LISTINGS=10    Max products to return (default 10)
 */

import * as cheerio from "cheerio";
import {
  parseUsdPrice,
  isAccessory,
  extractKeywords,
  isRelevant,
  normalizeCondition,
  extractSpecsFromHtml,
  modelMatches,
  CALIBER_MAP,
  extractBreadcrumbTrailFrom$,
  breadcrumbTrailImpliesNonFirearm,
} from "./_util.js";

export const sourceName = "palmettostatearmory";

const MAX_LISTINGS = Number(process.env.PSA_MAX_LISTINGS) || 10;
const PDP_LIMIT = 3;

/**
 * Fetch via ScraperAPI.
 */
async function fetchViaScraperAPI(targetUrl, apiKey) {
  const apiUrl = `https://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(targetUrl)}`;
  const ms = Number(process.env.SCRAPE_TIMEOUT_MS) || 15000;
  const response = await fetch(apiUrl, { signal: AbortSignal.timeout(ms) });
  if (!response.ok) {
    throw new Error(`ScraperAPI returned ${response.status}: ${response.statusText}`);
  }
  return await response.text();
}

/**
 * Fetch a single PDP page via ScraperAPI and extract description + specs.
 */
async function fetchPdpData(pdpUrl, apiKey) {
  try {
    const html = await fetchViaScraperAPI(pdpUrl, apiKey);
    const $ = cheerio.load(html);

    // ── PSA Page Structure ──────────────────────────────────────────────
    // Section "Details"  → .product.attribute.overview .value
    //   Contains specs as text: "Brand: Ruger  Model: 10/22  Caliber: 22 LR ..."
    // Section "Features" → .product.attribute.description .value
    //   Contains the actual product description (wrapped in PageBuilder divs)
    // Spec table (.additional-attributes) only has SKU, Brand, MPN, UPC
    // ─────────────────────────────────────────────────────────────────────

    // 1. Description from "Features" section
    let description = "";
    const descEl = $(".product.attribute.description .value").first();
    if (descEl.length) {
      const clone = descEl.clone();
      clone.find("style, script, table").remove();
      // Extract text from content elements (p, li) to skip PageBuilder wrappers
      const parts = [];
      clone.find("p, li").each((_, el) => {
        const t = $(el).text().trim();
        if (t.length > 0) parts.push(t);
      });
      description = parts.length > 0 ? parts.join(" ") : clone.text().trim();
    }

    // Clean up PSA's PageBuilder inline CSS noise
    description = description
      .replace(/#html-body\s*\[data-pb-style=[^\]]*\]\{[^}]*\}/g, "")
      .replace(/\s+/g, " ")
      .trim();

    // 2. Specs from "Details" section (.product.attribute.overview .value)
    //    PSA collapses label:value pairs: "Brand: RugerModel: 10/22Caliber: 22 LR..."
    //    Extract ALL attributes dynamically.
    const specs = {};
    const overviewEl = $(".product.attribute.overview .value").first();
    if (overviewEl.length) {
      const overviewText = overviewEl.text().replace(/\s+/g, " ").trim();
      // Split on known PSA labels — captures "Label: Value" pairs
      const PSA_LABELS = [
        "Brand", "Model", "Model/Series", "Caliber", "Caliber/Gauge", "Gauge", "Chamber",
        "Capacity", "Barrel Length", "Action", "Operating System",
        "OAL", "Overall Length", "Sights", "Sight",
        "Barrel Finish", "Barrel Material", "Barrel Description",
        "Twist", "Trigger Pull Weight", "Trigger", "Grooves",
        "Receiver Finish", "Receiver Material", "Receiver Description",
        "Weight", "Color", "Stock", "Stock Material", "Stock Description",
        "Stock Finish Group", "Stock Config",
        "Safety", "Length of Pull", "Drop at Heel", "Drop at Comb",
        "Magazine", "Magazine Type", "Scope", "Finish", "Frame", "Grip",
        "MPN", "UPC", "Thread Pattern", "Optic Description",
        "Chokes", "Chambered for", "Orientation", "Hand",
      ];
      // Build one regex: (Label1|Label2|...): value
      const labelPattern = PSA_LABELS.map(l => l.replace(/[/]/g, "\\/").replace(/\s+/g, "\\s*")).join("|");
      const BOUNDARY = `(?=(?:${labelPattern}):|$)`;

      for (const label of PSA_LABELS) {
        const escapedLabel = label.replace(/[/]/g, "\\/").replace(/\s+/g, "\\s*");
        const re = new RegExp(`${escapedLabel}:\\s*(.+?)${BOUNDARY}`, "i");
        const m = overviewText.match(re);
        if (m) {
          // Convert label to camelCase key with alias normalization
          let key = label.toLowerCase().replace(/[/]/g, " ").replace(/\s+(.)/g, (_, c) => c.toUpperCase());
          // Normalize aliases
          if (key === "caliberGauge") key = "caliber";
          if (key === "modelSeries") key = "model";
          specs[key] = m[1].trim();
        }
      }
    }

    // 3. Condition — PSA sells new firearms by default
    let condition = "";
    const condEl = $("[class*='condition']").first();
    if (condEl.length) condition = condEl.text().trim();

    const breadcrumbTrail = extractBreadcrumbTrailFrom$($);
    return { description, condition, breadcrumbTrail, ...specs };
  } catch (e) {
    console.warn(`[${sourceName}] PDP fetch failed: ${e.message}`);
    return { description: "", condition: "", breadcrumbTrail: "" };
  }
}

// ── Main entry ───────────────────────────────────────────────────────────────

export async function scrape({ page, query, model, firearmType }) {
  const apiKey = process.env.SCRAPER_API_KEY;
  if (!apiKey) {
    console.warn(`[${sourceName}] SCRAPER_API_KEY not set — skipping.`);
    return [];
  }

  const keywords = extractKeywords(query);

  const searchUrl = `https://palmettostatearmory.com/catalogsearch/result/?q=${encodeURIComponent(query)}`;
  console.log(`[${sourceName}] ${searchUrl} (via ScraperAPI)`);

  let html;
  try {
    html = await fetchViaScraperAPI(searchUrl, apiKey);
  } catch (err) {
    console.error(`[${sourceName}] ScraperAPI error: ${err.message}`);
    throw err;
  }

  if (html.includes("security verification") || html.includes("Just a moment")) {
    console.warn(`[${sourceName}] Blocked by Cloudflare.`);
    return [];
  }

  const $ = cheerio.load(html);
  const raw = [];

  $(".item.product.product-item").each((_, card) => {
    const $card = $(card);
    const title = ($card.find(".product-item-name").text() || "").trim();
    if (!title || title.length < 5) return;

    let href = $card.find("a.product-item-link, a.product-item-photo, a").first().attr("href") || "";
    if (!href) return;

    let priceText = $card.find("span.price-wrapper.final-price span.price").first().text().trim();
    if (!priceText) {
      priceText = $card.find("span.price-wrapper span.price").first().text().trim();
    }
    if (!priceText) {
      const m = $card.text().match(/\$[\d,]+\.?\d{0,2}/);
      if (m) priceText = m[0];
    }

    raw.push({ title, price: priceText, url: href });
  });

  console.log(`[${sourceName}] Extracted ${raw.length} listing(s).`);
  if (raw.length === 0) return [];

  // Always SERP-filter (no "blind mode" for ≤3 hits — that let magazines, mounts, etc. through).
  const relevant = raw.filter((l) => {
    const title = (l.title || "").toUpperCase();
    const upBrand = (query.split(" ")[0] || "").toUpperCase();
    const upModel = (model || "").toUpperCase();

    const hasCaliber = CALIBER_MAP.some((entry) => entry.patterns.some((p) => p.test(title)));
    const hasBrand = title.includes(upBrand);
    const hasModel = modelMatches(title, upModel);

    if (hasBrand && hasModel && hasCaliber) {
      if (/\b(MOULD|MOLD|DIE[S]?|RELOADING)\b/i.test(title)) return false;
      if (
        /\b(BARREL\s+SEAL|O[\s-]?RING|FOLLOWER|RECOIL\s+SPRING)\b/i.test(title) ||
        /\b(10|25|50)[\s-]*PACK\b.*\bSEAL\b/i.test(title) ||
        (/\bFITS\b/i.test(title) && /\b(SEAL|RING|FOLLOWER)\b/i.test(title))
      ) {
        return false;
      }
      return true;
    }

    return !isAccessory(l.title) && isRelevant(l.title, keywords, sourceName, model, query);
  });

  console.log(`[${sourceName}] After site-specific filters: ${relevant.length} relevant listing(s).`);

  // Fetch PDP data in parallel (up to PDP_LIMIT)
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

    if (breadcrumbTrailImpliesNonFirearm(pdp.breadcrumbTrail)) {
      console.log(`[${sourceName}] Post-PDP rejected (breadcrumb): ${String(pdp.breadcrumbTrail).slice(0, 140)}`);
      continue;
    }

    const blob = [
      l.title,
      pdp.description || "",
      pdp.brand || "",
      pdp.model || "",
      pdp.caliber || "",
    ]
      .filter(Boolean)
      .join(" ");
    if (isAccessory(blob)) {
      console.log(`[${sourceName}] Post-PDP rejected (accessory): ${l.title}`);
      continue;
    }

    const upper = l.title.toUpperCase();
    let rawCond = pdp.condition || "";
    if (!rawCond) {
      rawCond = "New"; // PSA sells new firearms
      if (/\bUSED\b/.test(upper)) rawCond = "Used";
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
