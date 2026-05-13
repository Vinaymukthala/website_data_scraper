import { canUseLlmReview, llmConfig } from "./config.js";
import { loadPrompt } from "./promptLoader.js";
import { createStructuredResponse } from "./client.js";
import { assessRowSuspicion } from "./suspicion.js";
import { rowReviewSchema } from "./reviewSchema.js";

function buildUserPayload({ providerName, query, row, suspicion }) {
  return JSON.stringify({
    providerName,
    query,
    suspicion,
    row,
  }, null, 2);
}

function mergeRowWithCorrection(row, review) {
  const corrected = review?.corrected || {};

  const merged = {
    ...row,
    brand: corrected.brand || row.brand || "",
    model: corrected.model || row.model || "",
    caliber: corrected.caliber || row.caliber || "",
    condition: corrected.condition || row.condition || "",
    description: corrected.description || row.description || "",
  };

  return merged;
}

export async function maybeReviewAndRepairRow({ providerName, query, row }) {
  const suspicion = assessRowSuspicion(row);
  if (suspicion.score < llmConfig.minSuspicionScore) {
    console.log(
      `[${providerName}] LLM review skipped: below suspicion threshold score=${suspicion.score} title=${JSON.stringify(row?.title || "")}`
    );
    return {
      row,
      suspicion,
      review: null,
    };
  }

  if (!canUseLlmReview()) {
    const reason = llmConfig.enabled ? "missing_api_key" : "disabled";
    console.log(
      `[${providerName}] LLM review skipped: ${reason} score=${suspicion.score} title=${JSON.stringify(row?.title || "")}`
    );
    return {
      row,
      suspicion,
      review: null,
    };
  }

  console.log(
    `[${providerName}] LLM review started: score=${suspicion.score} title=${JSON.stringify(row?.title || "")}`
  );

  const [systemPrompt, userPrompt] = await Promise.all([
    loadPrompt("row-review-system.txt"),
    loadPrompt("row-review-user.txt"),
  ]);

  const userContent = `${userPrompt.trim()}\n\nEvidence JSON:\n${buildUserPayload({ providerName, query, row, suspicion })}`;

  try {
    const review = await createStructuredResponse({
      system: systemPrompt,
      user: userContent,
      jsonSchema: rowReviewSchema,
    });

    const mergedRow = mergeRowWithCorrection(row, review);

    return {
      row: mergedRow,
      suspicion,
      review,
    };
  } catch (error) {
    console.warn(
      `[${providerName}] LLM review failed: ${error.message}`
    );
    return {
      row,
      suspicion,
      review: null,
    };
  }
}
