const EMBEDDED_LABEL_RE = /\b(?:manufacturer|model|caliber|gauge|frame material|grips|model number|sights|capacity|overall length|barrel length|finish type)\b\s*:?/i;
const PLACEHOLDER_RE = /^(other(?:\s+\w+){0,2}|n\/a|na|unknown|see description)$/i;

function normalize(value) {
  return String(value || "").trim().toUpperCase();
}

function titleContainsToken(title, token) {
  const upTitle = normalize(title);
  const upToken = normalize(token);
  return Boolean(upToken) && upTitle.includes(upToken);
}

function isPlaceholder(value) {
  return PLACEHOLDER_RE.test(String(value || "").trim());
}

function fieldLooksPolluted(value) {
  return EMBEDDED_LABEL_RE.test(String(value || ""));
}

function isOverlongAtomicField(value, maxLength) {
  return String(value || "").trim().length > maxLength;
}

export function assessRowSuspicion(row) {
  const reasons = [];
  let score = 0;

  const title = row?.title || "";
  const brand = row?.brand || "";
  const model = row?.model || "";
  const caliber = row?.caliber || "";
  const description = row?.description || "";
  const attributes = row?.attributes || {};

  if (!brand || isPlaceholder(brand)) {
    score += 3;
    reasons.push("missing_or_placeholder_brand");
  } else if (!titleContainsToken(title, brand)) {
    score += 2;
    reasons.push("brand_conflicts_with_title");
  }

  if (!model || isPlaceholder(model)) {
    score += 3;
    reasons.push("missing_or_placeholder_model");
  }

  if (!caliber || isPlaceholder(caliber)) {
    score += 3;
    reasons.push("missing_or_placeholder_caliber");
  }

  for (const [key, value] of Object.entries({ brand, model, caliber })) {
    if (fieldLooksPolluted(value)) {
      score += 3;
      reasons.push(`${key}_contains_embedded_label`);
    }
  }

  if (isOverlongAtomicField(brand, 40)) {
    score += 1;
    reasons.push("brand_overlong");
  }
  if (isOverlongAtomicField(model, 80)) {
    score += 1;
    reasons.push("model_overlong");
  }
  if (isOverlongAtomicField(caliber, 30)) {
    score += 1;
    reasons.push("caliber_overlong");
  }

  for (const [key, value] of Object.entries(attributes)) {
    if (fieldLooksPolluted(value)) {
      score += 2;
      reasons.push(`attribute_${key}_contains_embedded_label`);
    }
  }

  if (description && caliber && !titleContainsToken(description, caliber) && titleContainsToken(title, caliber)) {
    score += 1;
    reasons.push("description_does_not_support_caliber");
  }

  const status = score >= 4 ? "suspicious" : score >= 2 ? "warn" : "clean";
  return { status, score, reasons };
}
