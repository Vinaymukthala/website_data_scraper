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
  cleanDescription
} from "./scripts/providers/_util.js";

// ── Provider registry ────────────────────────────────────────────────────────

import * as truegunvalue from "./scripts/providers/truegunvalue.js";
import * as gunsinternational from "./scripts/providers/gunsinternational.js";
import * as simpsonltd from "./scripts/providers/simpsonltd.js";
import * as collectorfirearms from "./scripts/providers/collectorfirearms.js";
import * as budsgunshop from "./scripts/providers/budsgunshop.js";
import * as gunbroker from "./scripts/providers/gunbroker.js";
import * as palmettostatearmory from "./scripts/providers/palmettostatearmory.js";
import * as grabagun from "./scripts/providers/grabagun.js";
//import * as gunscom from "./scripts/providers/gunscom.js";

const PROVIDERS = [truegunvalue, gunsinternational, simpsonltd, collectorfirearms, budsgunshop, gunbroker, palmettostatearmory, grabagun];

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

  // Post-PDP accessory check — final safety net
  if (isAccessory(title)) {
    return null;
  }

  const description = cleanDescription(row.description || "");

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
    // Seller metadata
    "company", "firstName", "lastName", "fax", "activeListings", "returnPolicy",
    "checkPayments", "layawayOption",
  ]);
  const attributes = {};
  for (const [key, val] of Object.entries(row)) {
    if (CORE_KEYS.has(key)) continue;
    const v = val != null ? String(val).trim() : "";
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
async function scrapeFirearm(input) {
  validateInput(input);

  const BRAND = String(input.brand).trim();
  const MODEL = String(input.model).trim();
  const CALIBER = String(input.caliber).trim();
  const TYPE = String(input.firearmType).trim();
  const QUERY = [BRAND, MODEL, CALIBER].join(" ");

  const headless = process.env.HEADLESS !== "false";
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim() || undefined;
  const timeoutMs = Number(process.env.SCRAPE_TIMEOUT_MS) || 45000;

  const startedAt = Date.now();

  const browser = await puppeteerExtra.launch({
    headless,
    executablePath,
    pipe: true,
    args: BROWSER_ARGS,
    defaultViewport: { width: 1366, height: 768 },
    ignoreDefaultArgs: ["--enable-automation"],
  });

  const errors = {};
  const allRows = [];
  const providerLatencies = [];

  try {
    const settled = await Promise.allSettled(
      PROVIDERS.map(async (provider) => {
        const page = await browser.newPage();
        const startTime = Date.now();

        try {
          // ScraperAPI providers: cap at 8s (they typically respond in 2-4s)
          // Puppeteer providers: cap at timeoutMs (5s from SCRAPE_TIMEOUT_MS env)
          const SCRAPERAPI_PROVIDERS = new Set(["budsgunshop", "gunbroker", "palmettostatearmory", "grabagun", "gunscom"]);
          const providerTimeout = SCRAPERAPI_PROVIDERS.has(provider.sourceName)
            ? 25000
            : timeoutMs;

          const rows = await withTimeout(
            provider.scrape({
              page,
              query: QUERY,
              model: MODEL,
              firearmType: TYPE,
            }),
            providerTimeout,
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
          await page.close().catch(() => { });
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
  } finally {
    await browser.close().catch(() => { });
  }

  const keywords = extractKeywords(QUERY);

  const sources = allRows
    .filter(row => {
      const title = row.title || row.gunName || "";
      const upTitle = title.toUpperCase();

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
        if (re.test(upTitle)) {
          isExplicitPart = true;
          break;
        }
      }

      if (!isExplicitPart) {
        const hasMagWord = /\b(MAGAZINE[S]?|MAG[S]?)\b/i.test(upTitle);
        const hasGunWord = /\b(PISTOL|RIFLE|SHOTGUN|REVOLVER|HANDGUN|BARREL|FRAME|SLIDE|RECEIVER)\b/i.test(upTitle);
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
      const hasCaliber = calibers.some(c => upTitle.includes(c));
      const hasBrand = upTitle.includes(upBrand);
      const hasModel = upModel.split(" ").every(word => upTitle.includes(word));

      // If it contains Brand, Model, and a Caliber, it's highly likely a gun (bypass aggressive accessory filter)
      let isStrictMatch = false;
      if (hasBrand && hasModel && hasCaliber && !/\b(MOULD|MOLD|DIE[S]?|RELOADING)\b/i.test(upTitle)) {
        isStrictMatch = true;
      }

      // Centralized safety net: filter out accessories and irrelevant items
      // Skip for truegunvalue — their listings are confirmed firearms
      if (row.sourceName !== "truegunvalue") {
        if (!isStrictMatch && isAccessory(title, BRAND)) {
          return false;
        }
        if (!isStrictMatch && !isRelevant(title, keywords, row.sourceName, MODEL)) {
          return false;
        }
      }

      // Special rule for PSA: Brand and Model MUST be in the title
      if (row.sourceName === "palmettostatearmory") {
        if (!upTitle.includes(upBrand) || !upTitle.includes(upModel)) {
          return false;
        }
      }

      return true;
    })
    .map((row) => normalizeRow(row, BRAND, CALIBER, MODEL))
    .filter(Boolean)
    .sort((a, b) => a.price.original - b.price.original);

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