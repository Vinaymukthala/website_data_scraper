import { llmConfig } from "./config.js";

function buildUrl(pathname) {
  return `${llmConfig.baseUrl.replace(/\/$/, "")}${pathname}`;
}

function buildSchemaResponseFormat(jsonSchema) {
  return {
    type: "json_schema",
    json_schema: {
      name: "row_review",
      strict: true,
      schema: jsonSchema,
    },
  };
}

function extractResponsesOutputText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  const outputs = Array.isArray(payload?.output) ? payload.output : [];
  for (const output of outputs) {
    const contents = Array.isArray(output?.content) ? output.content : [];
    for (const content of contents) {
      if (typeof content?.text === "string" && content.text.trim()) {
        return content.text;
      }

      if (typeof content?.json === "object" && content.json) {
        return JSON.stringify(content.json);
      }
    }
  }

  return "";
}

async function createChatCompletionsResponse({ system, user, jsonSchema }) {
  const response = await fetch(buildUrl("/chat/completions"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${llmConfig.apiKey}`,
    },
    signal: AbortSignal.timeout(llmConfig.timeoutMs),
    body: JSON.stringify({
      model: llmConfig.model,
      temperature: llmConfig.temperature,
      max_completion_tokens: llmConfig.maxOutputTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: buildSchemaResponseFormat(jsonSchema),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`LLM review failed: ${response.status} ${response.statusText} ${errorText}`.trim());
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("LLM review returned no message content");
  }

  return JSON.parse(content);
}

async function createResponsesApiResponse({ system, user, jsonSchema }) {
  const response = await fetch(buildUrl("/responses"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${llmConfig.apiKey}`,
    },
    signal: AbortSignal.timeout(llmConfig.timeoutMs),
    body: JSON.stringify({
      model: llmConfig.model,
      temperature: llmConfig.temperature,
      max_output_tokens: llmConfig.maxOutputTokens,
      input: [
        { role: "system", content: [{ type: "input_text", text: system }] },
        { role: "user", content: [{ type: "input_text", text: user }] },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "row_review",
          schema: jsonSchema,
          strict: true,
        },
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`LLM review failed: ${response.status} ${response.statusText} ${errorText}`.trim());
  }

  const payload = await response.json();
  const outputText = extractResponsesOutputText(payload);
  if (!outputText) {
    throw new Error("LLM review returned no output text");
  }

  return JSON.parse(outputText);
}

export async function createStructuredResponse({ system, user, jsonSchema }) {
  if (llmConfig.apiMode === "responses") {
    return createResponsesApiResponse({ system, user, jsonSchema });
  }

  return createChatCompletionsResponse({ system, user, jsonSchema });
}
