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
import { parseUsdPrice } from "./_util.js";

export const sourceName = "gunsinternational";

const BASE_URL = "https://www.gunsinternational.com/";
const MAX_LISTINGS = Number(process.env.GI_MAX_LISTINGS) || 10;

const SEARCH_CATEGORY = { HANDGUN: "Pistols", RIFLE: "Rifles", SHOTGUN: "Shotguns" };

// ── Helpers ──────────────────────────────────────────────────────────────────

const ACCESSORY_RE = /MAGAZINE|HOLSTER|GRIP[S ]|SCOPE|OPTIC|SLING|CLEANING|AMMO|BAYONET|CASE |PARTS KIT|MANUAL|BOOK |CONVERSION KIT|LOADER|LASER|FLASHLIGHT|SUPPRESSOR|SILENCER|KNIFE/i;

function isAccessory(title) {
  const upper = (title || "").toUpperCase();
  if (ACCESSORY_RE.test(upper)) return true;

  // Custom standalone match for "BARREL" and parts without blocking valid guns like "4 INCH BARREL"
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
]);

function extractKeywords(query) {
  return query.toUpperCase().split(/\s+/)
    .filter(w => w.length >= 2 && !/^\d+$/.test(w) && !CALIBRE_NOISE.has(w));
}

function matchCount(title, keywords) {
  const up = (title || "").toUpperCase();
  return keywords.reduce((n, kw) => n + (up.includes(kw) ? 1 : 0), 0);
}

// ── Main entry ───────────────────────────────────────────────────────────────

export async function scrape({ page, query, firearmType }) {
  const type = String(firearmType || "").trim().toUpperCase();
  const cat = SEARCH_CATEGORY[type] || "";
  const keywords = extractKeywords(query);
  const minMatch = Math.min(2, keywords.length);

  // Build search URL
  const url = new URL("/search-results.cfm", BASE_URL);
  url.searchParams.set("Quick_Search_Keyword", query);
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

  // Navigate — domcontentloaded fires fast; listing data is server-rendered HTML
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 12_000 });

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

      out.push({ url: href, title: title.slice(0, 200), price, condition: cond });
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

        out.push({ url: href, title: title.slice(0, 200), price, condition: cond });
      }
    }
    return out;
  }, BASE_URL);

  console.log(`[${sourceName}] Extracted ${raw.length} listing(s).`);
  if (raw.length === 0) return [];

  // Filter: accessories, relevance, nav links
  const NAV_RE = /new-guns-for-sale-today|recently-sold|gun-of-the-month|featured-guns|gun-shows|gun-dealers|\.catt\.cfm|search\.cfm$|search-results\.cfm$/i;

  let listings = raw
    .filter(l => !NAV_RE.test(l.url))
    .filter(l => !isAccessory(l.title));

  // Relevance filter (progressive)
  let relevant = listings.filter(l => matchCount(l.title, keywords) >= minMatch);
  if (relevant.length === 0 && keywords.length > 1)
    relevant = listings.filter(l => matchCount(l.title, keywords) >= 1);
  if (relevant.length === 0) relevant = listings;

  // Build results — only keep listings that already have a price
  const results = [];
  for (const l of relevant.slice(0, MAX_LISTINGS)) {
    const p = parseUsdPrice(l.price);
    if (p == null || p <= 0) continue;
    results.push({
      sourceName,
      condition: l.condition || "Unknown",
      pageUrl: l.url,
      gunName: l.title || null,
      price: { currency: "USD", original: p },
    });
  }

  console.log(`[${sourceName}] Done — ${results.length} result(s).`);
  return results;
}