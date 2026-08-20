/**
 * CodeForge Orchestrator — Persistent Worker
 *
 * Polls Convex for pending swarm tasks, spawns agents, and manages
 * the entire lifecycle. Runs indefinitely.
 */
import { config } from "./config.js";
import { describeRouting, routingTable } from "./models.js";
import { convexClient } from "./convex-client.js";
import { orchestrateTask } from "./agents.js";
import { cleanupAllSessions } from "./sandbox.js";

const activeTasks = new Set<string>();

/**
 * Identity for this worker process. Used so a task can record who holds it and
 * so a restarted worker recognises its own abandoned claims.
 */
const WORKER_ID = `${process.env.WORKER_ID ?? "worker"}-${process.pid}-${Date.now()}`;

/** How often we stamp liveness on the tasks we are actively running. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** How often we sweep for tasks abandoned by workers that died. */
const RECLAIM_INTERVAL_MS = 60_000;

/**
 * Stamp a heartbeat for every task we hold, so the reclaim sweep can tell the
 * difference between "slow but alive" and "the worker is gone".
 */
async function sendHeartbeats(): Promise<void> {
  for (const taskId of activeTasks) {
    try {
      await convexClient.heartbeatTask(taskId, WORKER_ID);
    } catch (error) {
      console.error(
        `[orchestrator] Heartbeat failed for ${taskId}:`,
        error instanceof Error ? error.message : error
      );
    }
  }
}

/**
 * Requeue tasks stranded in a non-terminal status by a dead worker.
 *
 * Pickup only looks at "pending", so without this sweep a task whose worker
 * crashed mid-run is invisible to every future worker and sits untouched
 * forever — neither completed nor failed.
 */
async function sweepStaleTasks(): Promise<void> {
  try {
    const { requeued, failed } = await convexClient.reclaimStaleTasks();
    if (requeued.length > 0) {
      console.log(
        `[orchestrator] Requeued ${requeued.length} abandoned task(s): ${requeued.join(", ")}`
      );
    }
    if (failed.length > 0) {
      console.log(
        `[orchestrator] Gave up on ${failed.length} repeatedly-abandoned task(s): ${failed.join(", ")}`
      );
    }
  } catch (error) {
    console.error(
      "[orchestrator] Reclaim sweep failed:",
      error instanceof Error ? error.message : error
    );
  }
}

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

      // Claim it first so two workers can never run the same task.
      const claimed = await convexClient.claimTask(task._id, WORKER_ID);
      if (!claimed) {
        console.log(`[orchestrator] Task ${task._id} already claimed by another worker — skipping.`);
        continue;
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
          modelRouting: routingTable(),
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
  console.log("  " + describeRouting());
  console.log("═══════════════════════════════════════════════");

  console.log("  Worker ID:", WORKER_ID);

  // Start health check server
  await healthCheck();

  // Release anything a previous worker (or a previous life of this one) left
  // stranded before we start taking new work.
  await sweepStaleTasks();

  setInterval(() => void sendHeartbeats(), HEARTBEAT_INTERVAL_MS);
  setInterval(() => void sweepStaleTasks(), RECLAIM_INTERVAL_MS);

  // Main polling loop — runs forever
  while (true) {
    await pollForTasks();
    await new Promise((resolve) => setTimeout(resolve, config.pollInterval));
  }
}

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[orchestrator] SIGTERM received — cleaning up sandbox sessions...");
  cleanupAllSessions();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[orchestrator] SIGINT received — cleaning up sandbox sessions...");
  cleanupAllSessions();
  process.exit(0);
});

main().catch((err) => {
  console.error("[orchestrator] Fatal error:", err);
  cleanupAllSessions();
  process.exit(1);
});
