/**
 * CodeForge Orchestrator — Persistent Railway Worker
 *
 * Polls Convex for pending swarm tasks, spawns agents, and manages
 * the entire lifecycle. Runs indefinitely on Railway.
 */
import { config } from "./config.js";
import { convexClient } from "./convex-client.js";
import { orchestrateTask } from "./agents.js";

const activeTasks = new Set<string>();

async function pollForTasks(): Promise<void> {
  try {
    const pendingTasks = await convexClient.getPendingTasks();

    for (const task of pendingTasks) {
      // Skip if we're already working on this task
      if (activeTasks.has(task._id)) continue;

      // Check concurrency limit
      if (activeTasks.size >= 3) {
        console.log(`[orchestrator] At capacity (${activeTasks.size}/3 tasks). Waiting.`);
        break;
      }

      activeTasks.add(task._id);
      console.log(`[orchestrator] Picked up task ${task._id}: "${task.prompt.substring(0, 80)}"`);

      // Run task in background (don't await — allows parallel task execution)
      orchestrateTask(task)
        .catch((err) => {
          console.error(`[orchestrator] Task ${task._id} crashed:`, err);
        })
        .finally(() => {
          activeTasks.delete(task._id);
        });
    }
  } catch (error) {
    console.error("[orchestrator] Poll error:", error);
  }
}

async function healthCheck(): Promise<void> {
  const http = await import("http");
  const port = parseInt(process.env.PORT ?? "3000", 10);
  http
    .createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          activeTasks: activeTasks.size,
          uptime: process.uptime(),
        })
      );
    })
    .listen(port);
  console.log(`[orchestrator] Health check listening on port ${port}`);
}

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════");
  console.log("  CodeForge Orchestrator v1.0");
  console.log("  Polling interval:", config.pollInterval, "ms");
  console.log("  Max agent depth:", config.maxAgentDepth);
  console.log("  Max concurrent agents:", config.maxConcurrentAgents);
  console.log("═══════════════════════════════════════════════");

  // Start health check server
  await healthCheck();

  // Main polling loop — runs forever
  while (true) {
    await pollForTasks();
    await new Promise((resolve) => setTimeout(resolve, config.pollInterval));
  }
}

main().catch((err) => {
  console.error("[orchestrator] Fatal error:", err);
  process.exit(1);
});
