/**
 * AI Module — role-aware wrapper over the multi-model router (./models.ts).
 *
 * Agents call callAIJson(prompt, { role: "coder", ... }) and the router picks
 * the right model, escalates on repeated failure, and reports token usage.
 * Role is optional so older call sites keep working on the default routing.
 */
import {
  callModel,
  extractJson,
  isParseableJson,
  type AgentRole,
  type ModelResult,
} from "./models.js";

export interface AICallOptions {
  role?: AgentRole;
  /** 0-based attempt number for this subtask; drives model escalation. */
  attempt?: number;
  /** Race against the reasoning model (only if ENABLE_MODEL_RACING=true). */
  race?: boolean;
  /** Receives the winning model + token usage, for feed logging. */
  onUsage?: (result: ModelResult) => void;
}

/**
 * Call the AI model for a role and get raw text back.
 */
export async function callAI(prompt: string, opts: AICallOptions = {}): Promise<string> {
  const result = await callModel(prompt, {
    role: opts.role ?? "coder",
    attempt: opts.attempt,
    race: opts.race,
    onUsage: opts.onUsage,
  });
  return result.text;
}

/**
 * Call the AI model for a role and parse a JSON response.
 *
 * JSON-parseability is used as the racing validator, so a model that returns
 * prose instead of JSON loses the race rather than breaking the task.
 */
export async function callAIJson<T>(prompt: string, opts: AICallOptions = {}): Promise<T> {
  const result = await callModel(prompt, {
    role: opts.role ?? "coder",
    attempt: opts.attempt,
    race: opts.race,
    onUsage: opts.onUsage,
    validate: isParseableJson,
  });
  return extractJson<T>(result.text);
}

export type { ModelResult, AgentRole };
