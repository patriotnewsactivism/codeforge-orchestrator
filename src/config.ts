/**
 * Configuration — loaded from environment variables
 */

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export const config = {
  /** Convex deployment URL (e.g., https://your-deployment.convex.cloud) */
  convexUrl: requireEnv("CONVEX_URL"),

  /** Shared secret for authenticating with Convex HTTP endpoints */
  orchestratorSecret: requireEnv("RAILWAY_ORCHESTRATOR_SECRET"),

  /** Viktor Spaces API for AI model access */
  viktorApiUrl: requireEnv("VIKTOR_SPACES_API_URL"),
  viktorProjectName: requireEnv("VIKTOR_SPACES_PROJECT_NAME"),
  viktorProjectSecret: requireEnv("VIKTOR_SPACES_PROJECT_SECRET"),

  /** Polling interval in ms */
  pollInterval: parseInt(process.env.POLL_INTERVAL ?? "3000", 10),

  /** Max depth for agent spawning (prevents infinite recursion) */
  maxAgentDepth: parseInt(process.env.MAX_AGENT_DEPTH ?? "4", 10),

  /** Max concurrent agents per task */
  maxConcurrentAgents: parseInt(process.env.MAX_CONCURRENT_AGENTS ?? "8", 10),

  /** Max retry loops for debug/fix cycle */
  maxRetryLoops: parseInt(process.env.MAX_RETRY_LOOPS ?? "5", 10),

  /** ── Multi-model routing (optional — falls back to Viktor gateway) ──
   * Set OPENROUTER_API_KEY for access to all providers with one key, or set
   * individual provider keys. Preference order: openrouter → deepseek → xai →
   * moonshot → viktor gateway. */
  openrouterKey: process.env.OPENROUTER_API_KEY ?? "",
  deepseekKey: process.env.DEEPSEEK_API_KEY ?? "",
  xaiKey: process.env.XAI_API_KEY ?? "",
  moonshotKey: process.env.MOONSHOT_API_KEY ?? "",

  /** Model id overrides per semantic class. Provider naming drifts, so these
   * let you correct ids without a code change. */
  modelReasoning: process.env.MODEL_REASONING ?? "",
  modelCode: process.env.MODEL_CODE ?? "",
  modelLongCtx: process.env.MODEL_LONGCTX ?? "",

  /** Escalate to the reasoning model once a subtask has failed this many times */
  escalateAfterAttempts: parseInt(process.env.ESCALATE_AFTER_ATTEMPTS ?? "2", 10),

  /** Race the role model against the reasoning model on critical paths */
  enableRacing: (process.env.ENABLE_MODEL_RACING ?? "false") === "true",

  /** Per-call timeout for model requests */
  modelTimeoutMs: parseInt(process.env.MODEL_TIMEOUT_MS ?? "180000", 10),

  /** GitHub integration (optional — set to enable git features) */
  githubRepo: process.env.GITHUB_REPO ?? "",           // "owner/repo"
  githubToken: process.env.GITHUB_TOKEN ?? "",          // PAT with repo scope
  githubBaseBranch: process.env.GITHUB_BASE_BRANCH ?? "main",
};
