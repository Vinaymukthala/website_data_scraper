/**
 * Firearm price scraper service.
 *
 * Exports:
 *   scrapeFirearm(input) → { query, sources, offerValue, errors, _meta }
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";

import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import AnonymizeUAPlugin from "puppeteer-extra-plugin-anonymize-ua";

import {
  isAccessory,
  extractKeywords,
  isRelevant,
  parseUsdPrice,
  cleanDescription,
  breadcrumbTrailImpliesNonFirearm,
} from "./scripts/providers/_util.js";
import { normalizeInput } from "./scripts/llmNormalizer.js";

// ── Provider registry ────────────────────────────────────────────────────────

import * as truegunvalue from "./scripts/providers/truegunvalue.js";
import * as gunsinternational from "./scripts/providers/gunsinternational.js";
import * as simpsonltd from "./scripts/providers/simpsonltd.js";
import * as collectorfirearms from "./scripts/providers/collectorfirearms.js";
import * as budsgunshop from "./scripts/providers/budsgunshop.js";
import * as gunbroker from "./scripts/providers/gunbroker.js";
import * as palmettostatearmory from "./scripts/providers/palmettostatearmory.js";
import * as grabagun from "./scripts/providers/grabagun.js";

const PROVIDERS = [truegunvalue, gunsinternational, simpsonltd, collectorfirearms, gunbroker, budsgunshop, grabagun, palmettostatearmory];

/**
 * Providers that never need a Puppeteer page (no browser.newPage).
 * Simpson: direct fetch to their Firebase search API (not ScraperAPI).
 * GunBroker / Buds / PSA / GrabAGun: ScraperAPI + Cheerio (also no tab).
 */
const SKIP_BROWSER_PAGE_PROVIDERS = new Set([
  "simpsonltd",
  "gunbroker",
  "budsgunshop",
  "grabagun",
  "palmettostatearmory",
]);

const PROVIDER_DEFAULT_CONDITIONS = {
  "gunbroker": "Used",
  "gunsinternational": "Used",
  "truegunvalue": "Used",
  "grabagun": "New",
  "budsgunshop": "New",
  "palmettostatearmory": "New",
  "gunscom": "Used",
  "simpsonltd": "Used",
  "collectorfirearms": "Used",
};

// ── Puppeteer setup ──────────────────────────────────────────────────────────

puppeteerExtra.use(StealthPlugin());
puppeteerExtra.use(AnonymizeUAPlugin({ makeWindows: false }));

const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-blink-features=AutomationControlled",
  "--window-size=1366,768",
  "--no-first-run",
  "--disable-background-networking",
  "--disable-default-apps",
  "--disable-extensions",
  "--mute-audio",
  "--disable-gpu",
  "--disable-software-rasterizer",
];

// ── Helpers ──────────────────────────────────────────────────────────────────

/** True if text looks like a part/accessory, not a complete firearm (shared across providers). */
function isLikelyPartOrAccessoryListing(up) {
  const u = String(up || "")
    .toUpperCase()
    .replace(/\s+/g, " ");
  if (!u) return false;
  if (
    /\b(BARREL\s+SEAL|O[\s-]?RING|ORING|FOLLOWER|EXTRACTOR|EJECTOR|RECOIL\s+SPRING|BUFFER\s+TUBE|DETENT|MAGAZINE\s+TUBE)\b/.test(
      u
    )
  ) {
    return true;
  }
  if (/\b(10|25|50|100)[\s-]*PACK\b.*\b(SEAL|RING)\b/i.test(u)) return true;
  if (/\bSEAL\b.*\b(PACK|KIT)\b/i.test(u) && /\b(BARREL|GAS)\b/i.test(u)) return true;
  if (/\bFITS\b.*\b(REMINGTON|GLOCK|RUGER|MOSSBERG|SIG)\b/i.test(u) && /\b(SEAL|RING|FOLLOWER|SPRING|PIN|EXTRACTOR|EJECTOR)\b/i.test(u)) {
    return true;
  }
  if (/\bRS\s+BARREL\b/i.test(u)) return true;
  if (/\bBARREL\s+ONLY\b/i.test(u)) return true;
  if (/\b(REPLACEMENT|UPGRADE)\s+PART\b/i.test(u)) return true;
  return false;
}

/** SERP/card title plus PDP fields — relevance when marketplace titles omit model/caliber. */
function compositeMatchText(row) {
  const t = row.title || row.gunName || "";
  const bits = [row.brand, row.model, row.caliber, row.description, row.breadcrumbTrail]
    .filter((v) => v != null && String(v).trim())
    .map((v) => String(v).trim());
  if (row.llmGunAttributes && typeof row.llmGunAttributes === "object") {
    for (const v of Object.values(row.llmGunAttributes)) {
      if (v != null && String(v).trim()) bits.push(String(v).trim());
    }
  }
  return [t, ...bits].join(" ").replace(/\s+/g, " ").trim();
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`Timeout ${ms}ms (${label})`);
      error.name = "TimeoutError";
      reject(error);
    }, ms);

    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function normalizeRow(row, brand, caliber, model) {
  const price = row?.price?.original;
  if (typeof price !== "number" || !Number.isFinite(price)) {
    return null;
  }

  const pageUrl = row?.pageUrl ? String(row.pageUrl) : null;
  if (!pageUrl) {
    return null;
  }

  const rawTitle = row.title || row.gunName;
  const title = rawTitle ? String(rawTitle).replace(/\s+/g, " ").trim() : null;
  if (!title || title.length < 3) {
    return null; // Mandatory title
  }

  // Post-PDP accessory check — use title + specs when card title is vague
  if (isAccessory(compositeMatchText(row))) {
    return null;
  }

  const description = row.descriptionFromLlm
    ? String(row.description || "").replace(/\s+/g, " ").trim()
    : cleanDescription(row.description || "");

  let condition = String(row.condition || "Unknown");
  const sourceName = String(row.sourceName || "unknown");

  // Inject default condition if unknown
  if (condition === "Unknown" && PROVIDER_DEFAULT_CONDITIONS[sourceName]) {
    condition = PROVIDER_DEFAULT_CONDITIONS[sourceName];
  }

  const finalBrand = row.brand ? String(row.brand).trim() : brand;
  const finalCaliber = row.caliber ? String(row.caliber).trim() : caliber;
  const finalModel = row.model ? String(row.model).trim() : model;

  // Collect all extra PDP attributes dynamically — only include non-empty values
  // CORE_KEYS: fields already at top level or noise fields to exclude
  const CORE_KEYS = new Set([
    "sourceName", "condition", "conditionType", "pageUrl", "title",
    "description", "brand", "model", "caliber", "price",
    // Internal fields leaked from providers
    "priceText", "rawTitle", "href", "pageUrl",
    // Noise: not useful gun attributes
    "serial", "upc", "gtin", "sku", "mpn", "mfgModelNo", "shipping",
    "itemCondition", "gunName", "type", "itemGroup", "family", "category",
    "descriptionFromLlm",
    "breadcrumbTrail",
    // Seller metadata
    "company", "firstName", "lastName", "fax", "activeListings", "returnPolicy",
    "checkPayments", "layawayOption",
  ]);
  const attributes = {};
  for (const [key, val] of Object.entries(row)) {
    if (CORE_KEYS.has(key)) continue;
    if (val == null) continue;
    // If the value is a plain object (e.g. provider-level attributes), flatten it
    if (typeof val === "object" && !Array.isArray(val)) {
      for (const [subKey, subVal] of Object.entries(val)) {
        const sv = subVal != null ? String(subVal).trim() : "";
        if (sv && !CORE_KEYS.has(subKey)) attributes[subKey] = sv;
      }
      continue;
    }
    const v = String(val).trim();
    if (v) attributes[key] = v;
  }

  const result = {
    sourceId: "000",
    sourceName,
    condition,
    pageUrl,
    title,
    brand: finalBrand,
    model: finalModel,
    caliber: finalCaliber,
    price: {
      currency: "USD",
      original: price,
    },
  };

  // Only add description if it has values
  if (description) {
    result.description = description;
  }

  const crumb = row.breadcrumbTrail && String(row.breadcrumbTrail).trim();
  if (crumb) {
    result.breadcrumbTrail = crumb.replace(/\s+/g, " ").slice(0, 600);
  }

  // Only add attributes object if it has values
  if (Object.keys(attributes).length > 0) {
    result.attributes = attributes;
  }

  return result;
}

function computeOfferValue(sources) {
  const prices = sources.map((source) => source.price.original);

  return {
    min: prices.length ? Math.min(...prices) : null,
    max: prices.length ? Math.max(...prices) : null,
    currency: "USD",
  };
}

/** One row per (sourceName, pageUrl) — e.g. TrueGunValue returns many historical comps on the same PDP. Keeps lowest price. */
function dedupeSourcesByPageUrl(rows) {
  const best = new Map();
  for (const row of rows) {
    const url = String(row.pageUrl || "").trim();
    const sn = String(row.sourceName || "");
    if (!url) continue;
    const key = `${sn}|${url}`;
    const p = row.price?.original;
    const prev = best.get(key);
    if (
      !prev ||
      (typeof p === "number" &&
        Number.isFinite(p) &&
        p < (prev.price?.original ?? Infinity))
    ) {
      best.set(key, row);
    }
  }
  const winners = new Set(best.values());
  return rows.filter((row) => {
    const url = String(row.pageUrl || "").trim();
    if (!url) return true;
    return winners.has(row);
  });
}

function validateInput(input) {
  const { firearmType, brand, model, caliber } = input || {};

  if (!firearmType || !brand || !model || !caliber) {
    throw new Error("Input must include firearmType, brand, model, and caliber");
  }
}

// ── Core API ─────────────────────────────────────────────────────────────────

/**
 * @param {{ firearmType: string, brand: string, model: string, caliber: string }} input
 * @returns {Promise<{
 *   query: object,
 *   sources: object[],
 *   offerValue: { min: number|null, max: number|null, currency: string },
 *   errors: Record<string, string>,
 *   _meta: { durationMs: number, providers: number, results: number }
 * }>}
 */
async function scrapeFirearm(rawInput) {
  const startedAt = Date.now();
  const headless = process.env.HEADLESS !== "false";
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim() || undefined;
  /** Default 15s per provider (SCRAPE_TIMEOUT_MS); raise if slow networks time out often. */
  const timeoutMs = Number(process.env.SCRAPE_TIMEOUT_MS) || 15000;

  let browser;
  const errors = {};
  const allRows = [];
  const providerLatencies = [];

  try {
    const [input, launched] = await Promise.all([
      normalizeInput(rawInput),
      puppeteerExtra.launch({
        headless,
        executablePath,
        pipe: true,
        args: BROWSER_ARGS,
        defaultViewport: { width: 1366, height: 768 },
        ignoreDefaultArgs: ["--enable-automation"],
      }),
    ]);
    browser = launched;

    validateInput(input);

    const BRAND = String(input.brand).trim();
    const MODEL = String(input.model).trim();
    const CALIBER = String(input.caliber || "").trim();
    const TYPE = String(input.firearmType || "").trim();
    const QUERY = [BRAND, MODEL, CALIBER].filter(Boolean).join(" ");

    /** PDP text often says "FN" while the user typed "FNH"; append query tokens for relevance / strict-match checks. */
    const matchTextForFilter = (row) => {
      const base = compositeMatchText(row);
      const desc = row.description ? String(row.description) : "";
      const extra = [BRAND, MODEL, CALIBER, desc].filter((v) => v && String(v).trim()).join(" ");
      return extra ? `${base} ${extra}`.replace(/\s+/g, " ").trim() : base;
    };

    const settled = await Promise.allSettled(
      PROVIDERS.map(async (provider) => {
        const startTime = Date.now();
        let page = null;
        try {
          if (!SKIP_BROWSER_PAGE_PROVIDERS.has(provider.sourceName)) {
            page = await browser.newPage();
          }
          const rows = await withTimeout(
            provider.scrape({
              page,
              query: QUERY,
              brand: BRAND,
              model: MODEL,
              caliber: CALIBER,
              firearmType: TYPE,
            }),
            timeoutMs,
            provider.sourceName
          );

          return {
            name: provider.sourceName,
            rows: Array.isArray(rows) ? rows : [],
            latencyMs: Date.now() - startTime
          };
        } catch (error) {
          return {
            name: provider.sourceName,
            rows: [],
            error,
            latencyMs: Date.now() - startTime
          };
        } finally {
          if (page) await page.close().catch(() => { });
        }
      })
    );

    for (const result of settled) {
      const value =
        result.status === "fulfilled"
          ? result.value
          : { name: "unknown", rows: [], error: result.reason };

      if (value.error) {
        errors[value.name] = value.error?.message || String(value.error);
      }

      if (!value.rows?.length && !value.error) {
        errors[value.name] = "No results";
      }

      providerLatencies.push({ name: value.name, ms: value.latencyMs });

      for (const row of value.rows || []) {
        allRows.push(row);
      }
    }

    // Always log per-provider timing
    if (providerLatencies.length > 0) {
      console.log(`\n--- Per-Provider Timing ---`);
      providerLatencies
        .sort((a, b) => a.ms - b.ms)
        .forEach(p => {
          const status = errors[p.name] ? 'FAIL' : ' OK ';
          console.log(`  [${status}] ${p.name.padEnd(22)} ${String(p.ms).padStart(6)}ms`);
        });
      console.log(`---------------------------`);
    }

    const keywords = extractKeywords(QUERY);

    const rawSources = allRows
      .filter(row => {
      const cardTitle = row.title || row.gunName || "";
      const upCard = cardTitle.toUpperCase();
      const matchText = matchTextForFilter(row);
      const upMatch = matchText.toUpperCase();

      if (row.sourceName !== "truegunvalue" && isLikelyPartOrAccessoryListing(upMatch)) {
        return false;
      }

      if (row.sourceName !== "truegunvalue" && breadcrumbTrailImpliesNonFirearm(row.breadcrumbTrail)) {
        return false;
      }

      // UNIVERSAL EXPLICIT PART FILTER: Reject immediately if it matches explicit accessory patterns
      let isExplicitPart = false;
      const EXPLICIT_PART_REGEXES = [
        /\b(FOR|FITS)\b.*\b(MOSSBERG|GLOCK|TAURUS|SIG|RUGER|SMITH|MAVERICK|MODEL|GEN|G\d+|P\d+)\b/i,
        /\b(MINICLIP|CHOKE|HEAT SHIELD|MOUNT|RAIL)\b/i,
        /\b(GRIP|STOCK|HANDGUARD|FOREND)\s+KIT\b/i,
        /^\s*(PRO\s*MAG|MAGPUL|ETS|MEC-GAR|OPSOL)\b/i,
        /\bBARREL\b$/i
      ];

      for (const re of EXPLICIT_PART_REGEXES) {
        if (re.test(upCard)) {
          isExplicitPart = true;
          break;
        }
      }

      if (!isExplicitPart) {
        const hasMagWord = /\b(MAGAZINE[S]?|MAG[S]?)\b/i.test(upCard);
        const hasGunWord = /\b(PISTOL|RIFLE|SHOTGUN|REVOLVER|HANDGUN|BARREL|FRAME|SLIDE|RECEIVER)\b/i.test(upCard);
        if (hasMagWord && !hasGunWord) {
          isExplicitPart = true;
        }
      }

      if (isExplicitPart && row.sourceName !== "truegunvalue") {
        return false;
      }

      const upBrand = BRAND.toUpperCase();
      const upModel = MODEL.toUpperCase();

      const calibers = [CALIBER.toUpperCase(), CALIBER.toUpperCase().replace(" GA", "GA")];
      const hasCaliber = calibers.some(c => upMatch.includes(c));
      const hasBrand = upMatch.includes(upBrand);
      const hasModel = upModel.split(" ").every(word => upMatch.includes(word));

      // If it contains Brand, Model, and a Caliber, it's highly likely a gun (bypass aggressive accessory filter)
      let isStrictMatch = false;
      if (hasBrand && hasModel && hasCaliber && !/\b(MOULD|MOLD|DIE[S]?|RELOADING)\b/i.test(upMatch)) {
        isStrictMatch = true;
      }

      // Centralized safety net: filter out accessories and irrelevant items
      // Skip for truegunvalue — their listings are confirmed firearms
      if (row.sourceName !== "truegunvalue") {
        if (!isStrictMatch && isAccessory(matchText, BRAND)) {
          return false;
        }
        if (!isStrictMatch && !isRelevant(matchText, keywords, row.sourceName, MODEL, QUERY, CALIBER)) {
          return false;
        }
      }

      // PSA: brand + model must appear (card title or PDP specs). Allow FNH ↔ FN catalog naming.
      if (row.sourceName === "palmettostatearmory") {
        const alnum = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        const nm = alnum(matchText);
        const b = alnum(BRAND);
        const m = alnum(MODEL);
        const brandOk =
          nm.includes(b) ||
          (b === "FNH" && (nm.includes("FNH") || nm.includes("FNHERSTAL") || /\bFN\b/i.test(matchText)));
        const modelOk = m.length < 2 || nm.includes(m) || upModel.split(/\s+/).filter((w) => w.length > 1).every((w) => nm.includes(alnum(w)));
        if (!brandOk || !modelOk) return false;
      }

      return true;
      })
      .map((row) => normalizeRow(row, BRAND, CALIBER, MODEL))
      .filter(Boolean)
      .sort((a, b) => a.price.original - b.price.original);

    const sources = dedupeSourcesByPageUrl(rawSources);

    sources.forEach((source, index) => {
      source.sourceId = String(index + 1).padStart(3, "0");
    });

    return {
      query: {
        firearmType: TYPE,
        brand: BRAND,
        model: MODEL,
        caliber: CALIBER,
        searchQuery: QUERY,
      },
      sources,
      offerValue: computeOfferValue(sources),
      errors,
      _meta: {
        durationMs: Date.now() - startedAt,
        providers: PROVIDERS.length,
        results: sources.length,
      },
    };
  } finally {
    if (browser) await browser.close().catch(() => { });
  }
}

export { scrapeFirearm };

// ── CLI ──────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isCLI =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isCLI) {
  (async () => {
    let input;
    const jsonIndex = process.argv.indexOf("--json");

    if (jsonIndex !== -1 && process.argv[jsonIndex + 1]) {
      input = JSON.parse(process.argv[jsonIndex + 1]);
    } else {
      const payloadPath = path.join(__dirname, "input_payload.json");
      const raw = JSON.parse(await fs.readFile(payloadPath, "utf8"));
      input = raw.quickQuoteRequest?.firearm;
    }

    if (!input) {
      console.error("No input found.");
      process.exit(1);
    }

    const result = await scrapeFirearm(input);
    console.log(JSON.stringify(result, null, 2));
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}