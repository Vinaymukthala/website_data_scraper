import "../env/loadEnv.js";

export const llmConfig = {
  enabled: process.env.LLM_REVIEW_ENABLED === "true",
  apiKey: process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || "",
  baseUrl: process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL || "https://api.openai.com/v1",
  apiMode: process.env.LLM_API_MODE || "chat_completions",
  model: process.env.LLM_REVIEW_MODEL || process.env.OPENAI_MODEL || "gpt-4.1-mini",
  maxOutputTokens: Number(process.env.LLM_REVIEW_MAX_TOKENS) || 700,
  temperature: Number(process.env.LLM_REVIEW_TEMPERATURE) || 0,
  minSuspicionScore: Number(process.env.LLM_REVIEW_MIN_SUSPICION_SCORE) || 2,
  timeoutMs: Number(process.env.LLM_REVIEW_TIMEOUT_MS) || 12_000,
  maxRowsPerProvider: Number(process.env.LLM_REVIEW_MAX_ROWS_PER_PROVIDER) || 2,
};

export function canUseLlmReview() {
  return llmConfig.enabled && Boolean(llmConfig.apiKey);
}
