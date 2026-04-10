/**
 * Firearm price scraper — single entry point.
 *
 * Exports:
 *   scrapeFirearm(input) → { query, sources, offerValue, errors, _meta }
 *
 * Usage as module:
 *   import { scrapeFirearm } from "./index.js";
 *   const result = await scrapeFirearm({
 *     firearmType: "SHOTGUN", brand: "BERETTA",
 *     model: "DT10 TRIDENT SPORTING", caliber: "12GA",
 *   });
 *
 * Usage as CLI:
 *   node index.js                        # reads input_payload.json
 *   node index.js --json '{ ... }'       # inline JSON input
 *
 * Env:
 *   HEADLESS=false                        Show browser window
 *   PUPPETEER_EXECUTABLE_PATH=...         Chrome path
 *   SCRAPE_TIMEOUT_MS=10000               Per-provider timeout (default 10s)
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";

import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import AnonymizeUAPlugin from "puppeteer-extra-plugin-anonymize-ua";

// ── Provider registry ────────────────────────────────────────────────────────

import * as truegunvalue from "./scripts/providers/truegunvalue.js";
import * as gunsinternational from "./scripts/providers/gunsinternational.js";
import * as simpsonltd from "./scripts/providers/simpsonltd.js";

const PROVIDERS = [truegunvalue, gunsinternational, simpsonltd];

// ── Puppeteer setup (one-time) ───────────────────────────────────────────────

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

/** Race a promise against a timeout. */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const e = new Error(`Timeout ${ms}ms (${label})`);
      e.name = "TimeoutError";
      reject(e);
    }, ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** Normalize a single provider row into the output schema. */
function normalizeRow(row, brand, caliber) {
  const price = row?.price?.original;
  if (typeof price !== "number" || !Number.isFinite(price)) return null;
  const pageUrl = row?.pageUrl ? String(row.pageUrl) : null;
  if (!pageUrl) return null;

  return {
    sourceId: "000",
    sourceName: String(row.sourceName || "unknown"),
    condition: String(row.condition || "Unknown"),
    pageUrl,
    gunName: row.gunName ? String(row.gunName) : null,
    brand,
    caliber,
    price: { currency: "USD", original: price },
  };
}

/** Compute min/max offer range from normalized sources. */
function computeOfferValue(sources) {
  const prices = sources.map(s => s.price.original);
  return {
    min: prices.length ? Math.min(...prices) : null,
    max: prices.length ? Math.max(...prices) : null,
    currency: "USD",
  };
}

// ── Core API ─────────────────────────────────────────────────────────────────

/**
 * Scrape firearm prices from all registered providers.
 * Pure function — no file I/O. Takes input, returns output.
 *
 * @param {{ firearmType: string, brand: string, model: string, caliber: string }} input
 * @returns {Promise<{
 *   query: object,
 *   sources: object[],
 *   offerValue: { min: number|null, max: number|null, currency: string },
 *   errors: Record<string, string>,
 *   _meta: { durationMs: number, providers: number, results: number }
 * }>}
 */
export async function scrapeFirearm(input) {
  const { firearmType, brand, model, caliber } = input;
  if (!firearmType || !brand || !model || !caliber) {
    throw new Error("Input must include firearmType, brand, model, and caliber");
  }

  const BRAND = String(brand).trim();
  const MODEL = String(model).trim();
  const CALIBER = String(caliber).trim();
  const TYPE = String(firearmType).trim();
  const QUERY = [BRAND, MODEL, CALIBER].join(" ");

  const headless = process.env.HEADLESS !== "false";
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim() || undefined;
  const timeoutMs = Number(process.env.SCRAPE_TIMEOUT_MS) || 10_000;

  const t0 = Date.now();

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

  try {
    const settled = await Promise.allSettled(
      PROVIDERS.map(async (provider) => {
        const page = await browser.newPage();
        try {
          const rows = await withTimeout(
            provider.scrape({ page, query: QUERY, firearmType: TYPE }),
            timeoutMs,
            provider.sourceName,
          );
          return { name: provider.sourceName, rows: Array.isArray(rows) ? rows : [] };
        } catch (err) {
          return { name: provider.sourceName, rows: [], error: err };
        } finally {
          await page.close().catch(() => { });
        }
      }),
    );

    for (const result of settled) {
      const val = result.status === "fulfilled"
        ? result.value
        : { name: "unknown", rows: [], error: result.reason };

      if (val.error) errors[val.name] = val.error?.message || String(val.error);
      if (!val.rows?.length && !val.error) errors[val.name] = "No results";
      for (const row of val.rows || []) allRows.push(row);
    }
  } finally {
    await browser.close().catch(() => { });
  }

  // Normalize, sort by price, assign sequential IDs
  const sources = allRows
    .map(row => normalizeRow(row, BRAND, CALIBER))
    .filter(Boolean)
    .sort((a, b) => a.price.original - b.price.original);

  sources.forEach((s, i) => { s.sourceId = String(i + 1).padStart(3, "0"); });

  return {
    query: { firearmType: TYPE, brand: BRAND, model: MODEL, caliber: CALIBER, searchQuery: QUERY },
    sources,
    offerValue: computeOfferValue(sources),
    errors,
    _meta: { durationMs: Date.now() - t0, providers: PROVIDERS.length, results: sources.length },
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isCLI = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isCLI) {
  (async () => {
    let input;
    const jsonIdx = process.argv.indexOf("--json");
    if (jsonIdx !== -1 && process.argv[jsonIdx + 1]) {
      input = JSON.parse(process.argv[jsonIdx + 1]);
    } else {
      const payloadPath = path.join(__dirname, "input_payload.json");
      const raw = JSON.parse(await fs.readFile(payloadPath, "utf8"));
      input = raw.quickQuoteRequest?.firearm;
    }

    if (!input) { console.error("No input found."); process.exit(1); }

    const result = await scrapeFirearm(input);

    // Output to stdout — no file creation
    console.log(JSON.stringify(result, null, 2));
  })().catch(e => { console.error(e); process.exit(1); });
}
