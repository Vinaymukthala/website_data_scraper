/**
 * Shared utility functions for firearm scraper providers.
 *
 * Exports:
 *   parseUsdPrice(input)        — extract a numeric USD price from text
 *   conditionFromText(text)     — infer New/Used/Unknown from description
 *   toAbsoluteUrl(base, href)   — safely resolve a relative URL
 *   ensureNotBlocked(page, ctx) — throw if page is a bot-block/challenge page
 */

// ── Price parsing ────────────────────────────────────────────────────────────

export function parseUsdPrice(input) {
  if (input == null) return null;
  const s = String(input).replace(/[^\d.,]/g, "");
  if (!s) return null;
  const n = Number.parseFloat(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// ── Condition inference ──────────────────────────────────────────────────────

export function conditionFromText(text) {
  const s = String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return "Unknown";
  if (/\bused\b|\bpre[- ]?owned\b|\brefurb\b/.test(s)) return "Used";
  if (/\blike new\b/.test(s)) return "Used";
  if (/\bnew\b|\bnib\b/.test(s)) return "New";
  return "Unknown";
}

// ── URL helper ───────────────────────────────────────────────────────────────

export function toAbsoluteUrl(baseUrl, href) {
  try { return new URL(href, baseUrl).href; }
  catch { return null; }
}

// ── Bot-block detection ──────────────────────────────────────────────────────

function isLikelyBotBlock(title, bodyText) {
  const t = String(title || "").toLowerCase();
  const b = String(bodyText || "").toLowerCase();

  if (/attention required|just a moment|cloudflare/.test(t)) return true;
  if (/access denied|request blocked|forbidden|not authorized/.test(t)) return true;
  if (/cloudflare/.test(b) && /just a moment|checking your browser/.test(b)) return true;
  if (/enable javascript and cookies to continue/.test(b)) return true;
  if (/are you a human|verify you are human|captcha/.test(b)) return true;
  return false;
}

export async function ensureNotBlocked(page, contextLabel) {
  const title = await page.title().catch(() => "");
  const bodySample = await page
    .evaluate(() => (document.body?.innerText || "").slice(0, 1600))
    .catch(() => "");

  if (isLikelyBotBlock(title, bodySample)) {
    const snippet = String(bodySample || "").replace(/\s+/g, " ").slice(0, 240);
    const err = new Error(
      `${contextLabel}: blocked/challenge page. title=${JSON.stringify(title)} snippet=${JSON.stringify(snippet)}`
    );
    err.name = "ScrapeBlockedError";
    throw err;
  }
}
