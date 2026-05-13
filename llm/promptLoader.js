import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const promptCache = new Map();

export async function loadPrompt(name) {
  if (promptCache.has(name)) {
    return promptCache.get(name);
  }

  const promptPath = path.join(__dirname, "prompts", name);
  const content = await fs.readFile(promptPath, "utf8");
  promptCache.set(name, content);
  return content;
}
