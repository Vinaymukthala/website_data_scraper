/**
 * GunsInternational.com scraper — fast edition.
 *
 * Uses search-results.cfm directly (the only URL that reliably returns listings).
 * Sets age-gate cookie before navigation to bypass the overlay.
 * Extracts listing data from .listing_guts containers.
 *
 * Env:
 *   GI_MAX_LISTINGS=10   Max products to return (default 10)
 */

import { setTimeout as delay } from "node:timers/promises";
import { 
  parseUsdPrice, 
  isAccessory, 
  extractKeywords, 
  isRelevant,
  normalizeCondition 
} from "./_util.js";

export const sourceName = "gunsinternational";

const BASE_URL = "https://www.gunsinternational.com/";
const MAX_LISTINGS = Number(process.env.GI_MAX_LISTINGS) || 10;
const SEARCH_CATEGORY = { HANDGUN: "Pistols", RIFLE: "Rifles", SHOTGUN: "Shotguns" };

// ── Main entry ───────────────────────────────────────────────────────────────

export async function scrape({ page, query, model, firearmType }) {
  const type = String(firearmType || "").trim().toUpperCase();
  const cat = SEARCH_CATEGORY[type] || "";
  const keywords = extractKeywords(query);
  const minMatch = Math.min(2, keywords.length);

  // Build search URL — use advanced search with exclude terms to get guns only
  const url = new URL("/adv-results.cfm", BASE_URL);
  url.searchParams.set("keyword", query);
  url.searchParams.set("exclude_term", "accessories, gun parts, NFA, Services, Articles");
  url.searchParams.set("the_order", "6");
  url.searchParams.set("start_row", "1");
  if (cat) url.searchParams.set("qs_cat", cat);

  console.log(`[${sourceName}] ${url.href}`);

  // Set age-gate cookie before navigation
  await page.setCookie({
    name: "alertID_age2", value: "age2",
    domain: "www.gunsinternational.com", path: "/",
    expires: Math.floor(Date.now() / 1000) + 365 * 86400,
  });

  // Block heavy assets — significantly reduces page load time
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (["image", "stylesheet", "font", "media", "other"].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  try {
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 15_000 });
  } catch {
    // Proceed if partial load
  }

  // Quick Cloudflare check
  const blocked = await page.evaluate(() =>
    /just a moment|attention required|cloudflare/i.test(document.title)
  ).catch(() => false);

  if (blocked) {
    console.warn(`[${sourceName}] Cloudflare blocked — skipping.`);
    return [];
  }

  // Dismiss age gate if cookie didn't work
  await page.evaluate(() => {
    if (typeof window.close_alert_js === "function") { window.close_alert_js(); return; }
    const dim = document.getElementById("dimScreen");
    if (dim) dim.style.display = "none";
    const f = document.getElementById("footer_alert_olay");
    if (f) f.style.display = "none";
    const d = new Date(); d.setTime(d.getTime() + 365 * 86400000);
    document.cookie = "alertID_age2=age2;expires=" + d.toUTCString() + ";path=/";
  }).catch(() => {});

  // Wait for listing elements
  await page.waitForFunction(
    () => document.querySelectorAll(".listing_guts, a[href*='gun_id=']").length > 0
      || /no (guns|results|listings) found|0 guns found/i.test(
        (document.body?.innerText || "").slice(0, 3000)),
    { timeout: 4000, polling: 150 }
  ).catch(() => {});

  // Extract listings from the page
  const raw = await page.evaluate((base) => {
    const seen = new Set(), out = [];

    // Strategy 1: .listing_guts containers
    for (const box of document.querySelectorAll(".listing_guts, .box")) {
      const a = box.querySelector(".title_link a, .title_grid a, .title_list a")
        || box.querySelector("a[href*='gun_id=']");
      if (!a) continue;
      let href;
      try { href = new URL(a.getAttribute("href") || a.href, base).href; } catch { continue; }
      if (seen.has(href)) continue;
      seen.add(href);

      let title = (a.textContent || "").trim().replace(/\s+for\s+sale\s*$/i, "").replace(/\s{2,}/g, " ");
      if (title.length < 3) continue;

      let price = "";
      for (const pe of box.querySelectorAll("strong, b, span, [class*='price'], font[color]")) {
        const t = (pe.textContent || "").trim();
        if (/^\$[\d,]+\.?\d*$/.test(t)) { price = t; break; }
      }
      if (!price) { const m = (box.textContent || "").match(/\$[\d,]+\.?\d*/); if (m) price = m[0]; }

      let cond = "Unknown";
      const ct = (box.textContent || "");
      const cm = ct.match(/\b(New|Used|Excellent|Very Good|Good|Fair|Poor|Like New|NIB)\b/i);
      if (cm) cond = cm[1];

      const descEl = box.querySelector(".description, .desc, p");
      const description = descEl ? (descEl.textContent || "").trim() : "";

      out.push({ url: href, title: title.slice(0, 200), price, condition: cond, description });
    }

    // Strategy 2: gun_id= links (fallback)
    if (out.length === 0) {
      for (const a of document.querySelectorAll("a[href*='gun_id=']")) {
        let href;
        try { href = new URL(a.getAttribute("href") || a.href, base).href; } catch { continue; }
        if (seen.has(href)) continue;
        seen.add(href);
        let title = (a.textContent || "").trim();
        if (title.length < 5) {
          const p = a.closest(".listing_guts, .box, tr, div");
          if (p) for (const s of p.querySelectorAll("a")) {
            const st = (s.textContent || "").trim();
            if (st.length >= 5 && st.length < 300 && (s.getAttribute("href") || "").includes("gun_id=")) {
              title = st; break;
            }
          }
        }
        if (title.length < 5) continue;
        title = title.replace(/\s+for\s+sale\s*$/i, "").replace(/\s{2,}/g, " ");

        let price = "";
        const el = a.closest("tr, .box, div");
        if (el) { const m = (el.textContent || "").match(/\$[\d,]+\.?\d*/); if (m) price = m[0]; }

        let cond = "Unknown";
        if (el) { const cm = (el.textContent || "").match(/\b(New|Used|Excellent|Very Good|Good|Fair|Poor|Like New|NIB)\b/i); if (cm) cond = cm[1]; }

        out.push({ url: href, title: title.slice(0, 200), price, condition: cond, description: "" });
      }
    }
    return out;
  }, BASE_URL);

  console.log(`[${sourceName}] Extracted ${raw.length} listing(s).`);
  if (raw.length === 0) return [];

  // Filter: accessories, relevance, nav links
  const NAV_RE = /new-guns-for-sale-today|recently-sold|gun-of-the-month|featured-guns|gun-shows|gun-dealers|\.catt\.cfm|search\.cfm$|search-results\.cfm$/i;

  const relevant = raw
    .filter(l => !NAV_RE.test(l.url))
    .filter(l => {
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

  // ── Scrape detail pages sequentially for descriptions ────────────────
  const pdpDataMap = {};
  const PDP_LIMIT = 3;
  const pdpTargets = relevant.slice(0, PDP_LIMIT);

  console.log(`[${sourceName}] Fetching ${pdpTargets.length} PDP(s) in parallel...`);

  const browser = page.browser();

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
        const specs = {};

        let contentText = "";
        document.querySelectorAll("div.row, div.col-xs-12").forEach(el => {
          const text = el.innerText || "";
          if (/Rifle Caliber:|Pistol Caliber:|Shotgun Gauge:|Manufacturer:/i.test(text)) {
            if (!contentText || text.length < contentText.length) {
              contentText = text;
            }
          }
        });
        if (!contentText) contentText = document.body.innerText || "";

        let description = "";
        const descMatch = contentText.match(/Description:\s*([\s\S]*?)(?=(?:Rifle Caliber|Pistol Caliber|Shotgun Gauge|Manufacturer|Model|Barrel Length|Condition|Action|Stock|Chambers|Bore)\s*:|Price:|$)/i);
        if (descMatch) {
          description = descMatch[1].trim();
        }

        const SKIP_LABELS = /^(price|buy\s*now|see\s*all|email|send|contact|seller|phone|state|zip|country|member|categories|ffl|shipping|payment|your|message|back|privacy|user|faq|career|gun[s]?\s*international|browse|advanced|new\s*today|go|check\s*payment|layaway|return|active\s*listing|company|first\s*name|last\s*name|fax|website|address|city)/i;

        const LABEL_ALIASES = {
          "rifle caliber": "caliber",
          "pistol caliber": "caliber",
          "shotgun gauge": "caliber",
          "gauge": "caliber",
          "manufacturer": "brand",
          "barrels": "barrelLength",
          "barrel length": "barrelLength",
          "manufacture date": "yearManufactured",
          "lop": "lengthOfPull",
          "stock comb": "stockComb",
          "bore condition": "boreCondition",
          "metal condition": "metalCondition",
          "wood condition": "woodCondition",
          "fore end": "foreEnd",
        };

        const lines = contentText.split(/\n/);
        for (const line of lines) {
          const match = line.trim().match(/^([A-Za-z][A-Za-z\s/]{1,30}):\s*(.+)/);
          if (match) {
            const label = match[1].trim();
            const value = match[2].trim();
            if (label.length > 1 && value.length > 0 && value.length < 150 && !SKIP_LABELS.test(label)) {
              const key = LABEL_ALIASES[label.toLowerCase()]
                || label.toLowerCase().replace(/\s+(.)/g, (_, c) => c.toUpperCase());
              if (!specs[key]) specs[key] = value;
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

  // Build results — only keep listings that already have a price
  const results = [];
  for (const l of pdpTargets) {
    const p = parseUsdPrice(l.price);
    if (p == null || p <= 0) continue;

    const pdp = pdpDataMap[l.url] || {};
    const rawCond = pdp.condition || l.condition || "Unknown";

    results.push({
      sourceName,
      pageUrl: l.url,
      title: l.title || null,
      description: (pdp.description || l.description || "").toLowerCase(),
      ...pdp,
      condition: normalizeCondition(rawCond),
      model: pdp.model || model || "",
      price: { currency: "USD", original: p },
    });
  }

  console.log(`[${sourceName}] Done — ${results.length} result(s).`);
  return results;
}