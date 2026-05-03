/**
 * HTTP API for firearm price scraping.
 *
 * POST body: same shape as input_payload.json — { "firearm": { firearmType, brand, model, caliber } }
 *   Also accepts { "quickQuoteRequest": { "firearm": { ... } } } or a flat firearm object.
 *
 * Env: PORT (default 3000), plus scraper env (SCRAPER_API_KEY, SCRAPE_TIMEOUT_MS, etc.)
 */
import express from "express";
import { scrapeFirearm } from "./scraperService.js";

const PORT = Number(process.env.PORT) || 3000;

/**
 * @param {unknown} body
 * @returns {{ firearmType: string, brand: string, model: string, caliber: string } | null}
 */
function extractFirearmInput(body) {
  if (!body || typeof body !== "object") return null;

  let f = body.firearm;
  if (!f && body.quickQuoteRequest && typeof body.quickQuoteRequest === "object") {
    f = body.quickQuoteRequest.firearm;
  }
  if (!f && (body.brand != null || body.model != null)) {
    f = body;
  }
  if (!f || typeof f !== "object") return null;

  const firearmType = f.firearmType ?? f.firearmtype ?? "";
  const brand = f.brand != null ? String(f.brand).trim() : "";
  const model = f.model != null ? String(f.model).trim() : "";
  const caliber = f.caliber != null ? String(f.caliber).trim() : "";

  if (!firearmType || !brand || !model || !caliber) return null;

  return { firearmType: String(firearmType).trim(), brand, model, caliber };
}

const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/scrape", async (req, res) => {
  const input = extractFirearmInput(req.body);
  if (!input) {
    return res.status(400).json({
      error:
        "Invalid body. Expected { \"firearm\": { \"firearmType\", \"brand\", \"model\", \"caliber\" } } (see input_payload.json).",
    });
  }

  try {
    const result = await scrapeFirearm(input);
    return res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /must include|invalid/i.test(message) ? 400 : 500;
    return res.status(status).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`Scraper API listening on http://localhost:${PORT}`);
  console.log(`  POST /scrape  — JSON body like input_payload.json`);
});
