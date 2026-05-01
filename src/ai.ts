/**
 * AI Module — Calls AI models through the Viktor tool gateway.
 * Uses the same quick_ai_search endpoint that the Convex backend uses.
 */
import { config } from "./config.js";

interface AIResponse {
  success: boolean;
  result?: { search_response: string };
  error?: string;
}

/**
 * Call the AI model with a prompt and get a text response.
 * Uses Viktor's tool gateway (quick_ai_search) for model access.
 */
export async function callAI(prompt: string): Promise<string> {
  const response = await fetch(`${config.viktorApiUrl}/api/viktor-spaces/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_name: config.viktorProjectName,
      project_secret: config.viktorProjectSecret,
      role: "quick_ai_search",
      arguments: { search_question: prompt },
    }),
  });

  if (!response.ok) {
    throw new Error(`AI call failed: HTTP ${response.status} — ${await response.text()}`);
  }

  const json = (await response.json()) as AIResponse;
  if (!json.success || !json.result) {
    throw new Error(json.error ?? "AI call returned no result");
  }

  return json.result.search_response;
}

/**
 * Call AI and parse a JSON response.
 * Tries to extract JSON from the response even if the model wraps it in markdown.
 */
export async function callAIJson<T>(prompt: string): Promise<T> {
  const raw = await callAI(prompt);

  // Try direct parse first
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Try extracting JSON from markdown code blocks or mixed text
    const jsonMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) ||
                      raw.match(/(\{[\s\S]*\})/) ||
                      raw.match(/(\[[\s\S]*\])/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1]) as T;
    }
    throw new Error(`Failed to parse AI JSON response: ${raw.substring(0, 200)}`);
  }
}
