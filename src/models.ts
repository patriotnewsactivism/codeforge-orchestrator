/**
 * Models Module — Provider-agnostic multi-model router.
 *
 * Routes each agent role to the model best suited for it, with:
 *   - per-role routing (env-overridable)
 *   - automatic escalation to a stronger reasoning model after repeated failures
 *   - model racing (fire N models in parallel, first valid response wins)
 *   - token usage accounting per call
 *
 * All external providers are OpenAI-compatible chat-completions APIs, so one
 * client shape covers OpenRouter, DeepSeek, xAI and Moonshot. If no provider
 * key is configured we fall back to the Viktor tool gateway, which is how the
 * orchestrator behaved before this module existed.
 */
import { config } from "./config.js";

export type Provider = "openrouter" | "deepseek" | "xai" | "moonshot" | "viktor";

export type AgentRole =
  | "planner"
  | "architect"
  | "coder"
  | "debugger"
  | "tester"
  | "reviewer"
  | "integrator"
  | "retrospective";

export interface ModelSpec {
  provider: Provider;
  /** Provider-specific model id */
  model: string;
  /** Human label for the swarm feed */
  label: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ModelResult {
  text: string;
  spec: ModelSpec;
  usage: Usage;
  durationMs: number;
}

const PROVIDER_BASE_URLS: Record<Exclude<Provider, "viktor">, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  deepseek: "https://api.deepseek.com/v1",
  xai: "https://api.x.ai/v1",
  moonshot: "https://api.moonshot.ai/v1",
};

/** Which provider key is actually present, in preference order. */
function activeProvider(): Provider {
  if (config.openrouterKey) return "openrouter";
  if (config.deepseekKey) return "deepseek";
  if (config.xaiKey) return "xai";
  if (config.moonshotKey) return "moonshot";
  return "viktor";
}

function keyFor(provider: Provider): string {
  switch (provider) {
    case "openrouter":
      return config.openrouterKey;
    case "deepseek":
      return config.deepseekKey;
    case "xai":
      return config.xaiKey;
    case "moonshot":
      return config.moonshotKey;
    default:
      return "";
  }
}

/**
 * Semantic model classes. We route roles to a *class*, then resolve the class
 * to a concrete model id for whichever provider is configured. Model ids drift
 * as providers rename things, so every id is env-overridable.
 */
type ModelClass = "reasoning" | "code" | "longctx";

function resolve(cls: ModelClass): ModelSpec {
  const provider = activeProvider();

  if (provider === "viktor") {
    return { provider: "viktor", model: "viktor-gateway", label: "Viktor gateway" };
  }

  if (provider === "openrouter") {
    const ids: Record<ModelClass, string> = {
      reasoning: config.modelReasoning || "x-ai/grok-4.1-fast",
      code: config.modelCode || "deepseek/deepseek-v3.2-exp",
      longctx: config.modelLongCtx || "moonshotai/kimi-k2-0905",
    };
    return { provider, model: ids[cls], label: ids[cls] };
  }

  // Direct provider keys: the provider dictates the family, class picks the tier.
  const directDefaults: Record<Exclude<Provider, "viktor" | "openrouter">, Record<ModelClass, string>> = {
    deepseek: { reasoning: "deepseek-reasoner", code: "deepseek-chat", longctx: "deepseek-chat" },
    xai: { reasoning: "grok-4.1-fast-reasoning", code: "grok-4.1-fast", longctx: "grok-4.1-fast" },
    moonshot: { reasoning: "kimi-k2-0905-preview", code: "kimi-k2-0905-preview", longctx: "kimi-k2-0905-preview" },
  };

  const override =
    cls === "reasoning" ? config.modelReasoning : cls === "code" ? config.modelCode : config.modelLongCtx;

  const model = override || directDefaults[provider as keyof typeof directDefaults][cls];
  return { provider, model, label: model };
}

/**
 * Role → model class routing table. This is the heart of the router: cheap
 * high-throughput models do the mechanical work, reasoning models do the
 * thinking, long-context models review whole diffs.
 */
const ROLE_CLASS: Record<AgentRole, ModelClass> = {
  planner: "reasoning",
  architect: "reasoning",
  coder: "code",
  debugger: "reasoning",
  tester: "code",
  reviewer: "longctx",
  integrator: "code",
  retrospective: "longctx",
};

export function modelForRole(role: AgentRole): ModelSpec {
  return resolve(ROLE_CLASS[role]);
}

/** The model we escalate to when a role's normal model keeps failing. */
export function escalationModel(): ModelSpec {
  return resolve("reasoning");
}

export function routingTable(): Array<{ role: AgentRole; model: string; provider: Provider }> {
  return (Object.keys(ROLE_CLASS) as AgentRole[]).map((role) => {
    const spec = modelForRole(role);
    return { role, model: spec.model, provider: spec.provider };
  });
}

// ── Low-level calls ────────────────────────────────────────────────────────────

const EMPTY_USAGE: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string };
}

async function callOpenAICompatible(
  spec: ModelSpec,
  prompt: string,
  timeoutMs: number,
): Promise<{ text: string; usage: Usage }> {
  const base = PROVIDER_BASE_URLS[spec.provider as Exclude<Provider, "viktor">];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${keyFor(spec.provider)}`,
        // OpenRouter attribution headers — harmless elsewhere.
        "HTTP-Referer": "https://codeforge-v2-c96b4570.viktor.space",
        "X-Title": "CodeForge Agent Swarm",
      },
      body: JSON.stringify({
        model: spec.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`${spec.provider}/${spec.model} HTTP ${response.status} — ${await response.text()}`);
    }

    const json = (await response.json()) as ChatCompletionResponse;
    if (json.error) throw new Error(`${spec.provider}/${spec.model}: ${json.error.message}`);

    const text = json.choices?.[0]?.message?.content;
    if (!text) throw new Error(`${spec.provider}/${spec.model} returned no content`);

    return {
      text,
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
        totalTokens: json.usage?.total_tokens ?? 0,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Legacy path: Viktor's tool gateway. No token accounting available. */
async function callViktorGateway(prompt: string): Promise<{ text: string; usage: Usage }> {
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
    throw new Error(`Viktor gateway HTTP ${response.status} — ${await response.text()}`);
  }

  const json = (await response.json()) as {
    success: boolean;
    result?: { search_response: string };
    error?: string;
  };
  if (!json.success || !json.result) throw new Error(json.error ?? "Viktor gateway returned no result");

  return { text: json.result.search_response, usage: EMPTY_USAGE };
}

async function invoke(spec: ModelSpec, prompt: string, timeoutMs: number): Promise<ModelResult> {
  const started = Date.now();
  const { text, usage } =
    spec.provider === "viktor"
      ? await callViktorGateway(prompt)
      : await callOpenAICompatible(spec, prompt, timeoutMs);
  return { text, spec, usage, durationMs: Date.now() - started };
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface CallOptions {
  role: AgentRole;
  /**
   * Attempt number for this logical subtask (0-based). Once it reaches
   * config.escalateAfterAttempts we switch to the reasoning model regardless
   * of the role's normal routing.
   */
  attempt?: number;
  /** Race the role model against the reasoning model; first valid answer wins. */
  race?: boolean;
  timeoutMs?: number;
  /** Called with a validated result so callers can log usage. */
  onUsage?: (result: ModelResult) => void;
  /** Validates a candidate response; racing uses this to reject bad answers. */
  validate?: (text: string) => boolean;
}

/**
 * Call the model appropriate for a role and return raw text.
 */
export async function callModel(prompt: string, opts: CallOptions): Promise<ModelResult> {
  const timeoutMs = opts.timeoutMs ?? config.modelTimeoutMs;
  const attempt = opts.attempt ?? 0;
  const escalated = attempt >= config.escalateAfterAttempts;

  const primary = escalated ? escalationModel() : modelForRole(opts.role);
  const validate = opts.validate ?? (() => true);

  const candidates: ModelSpec[] = [primary];
  if (opts.race && config.enableRacing) {
    const challenger = escalationModel();
    if (challenger.model !== primary.model) candidates.push(challenger);
  }

  const attemptOne = async (spec: ModelSpec): Promise<ModelResult> => {
    const result = await invoke(spec, prompt, timeoutMs);
    if (!validate(result.text)) {
      throw new Error(`${spec.provider}/${spec.model} produced a response that failed validation`);
    }
    return result;
  };

  let result: ModelResult;
  if (candidates.length === 1) {
    result = await attemptOne(candidates[0]);
  } else {
    // Race: first model to return a *valid* response wins.
    result = await Promise.any(candidates.map(attemptOne)).catch((err: unknown) => {
      const errors =
        err instanceof AggregateError ? err.errors.map((e) => String(e)).join("; ") : String(err);
      throw new Error(`All raced models failed: ${errors}`);
    });
  }

  opts.onUsage?.(result);
  return result;
}

/**
 * Extract JSON from a model response, tolerating markdown fences and prose.
 */
export function extractJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    const match =
      raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) ||
      raw.match(/(\{[\s\S]*\})/) ||
      raw.match(/(\[[\s\S]*\])/);
    if (match) return JSON.parse(match[1]) as T;
    throw new Error(`Failed to parse model JSON response: ${raw.substring(0, 200)}`);
  }
}

/** True if the text parses as JSON — used as the racing validator. */
export function isParseableJson(raw: string): boolean {
  try {
    extractJson(raw);
    return true;
  } catch {
    return false;
  }
}

/** Describes the active routing setup for logging on boot. */
export function describeRouting(): string {
  const provider = activeProvider();
  if (provider === "viktor") {
    return "Model routing: Viktor gateway only (no provider key set — set OPENROUTER_API_KEY to enable multi-model routing)";
  }
  const rows = routingTable()
    .map((r) => `${r.role}=${r.model}`)
    .join(", ");
  return `Model routing via ${provider}: ${rows}`;
}
