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

  /** GitHub integration (optional — set to enable git features) */
  githubRepo: process.env.GITHUB_REPO ?? "",           // "owner/repo"
  githubToken: process.env.GITHUB_TOKEN ?? "",          // PAT with repo scope
  githubBaseBranch: process.env.GITHUB_BASE_BRANCH ?? "main",
};
