export const rowReviewSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["clean", "warn", "suspicious"] },
    risk_score: { type: "integer", minimum: 0, maximum: 5 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reasons: {
      type: "array",
      items: { type: "string" },
      maxItems: 12,
    },
    corrected: {
      type: "object",
      additionalProperties: false,
      properties: {
        brand: { type: "string" },
        model: { type: "string" },
        caliber: { type: "string" },
        condition: { type: "string" },
        description: { type: "string" },
      },
      required: ["brand", "model", "caliber", "condition", "description"],
    },
    changed_fields: {
      type: "array",
      items: { type: "string" },
      maxItems: 20,
    },
  },
  required: ["status", "risk_score", "confidence", "reasons", "corrected", "changed_fields"],
};
