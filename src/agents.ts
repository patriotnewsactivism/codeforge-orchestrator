/**
 * Agent Runners — Each agent role has a specialized prompt and behavior.
 * Agents execute via the AI model and write results back through the Convex client.
 */
import { config } from "./config.js";
import { convexClient, type ConvexFile } from "./convex-client.js";
import { callAI, callAIJson } from "./ai.js";

// ═══════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════

interface PlannerOutput {
  subtasks: Array<{
    role: "architect" | "coder" | "debugger" | "tester" | "reviewer" | "integrator";
    assignment: string;
    files?: string[];
    dependsOn?: string[];
  }>;
  summary: string;
}

interface CoderOutput {
  changes: Array<{
    path: string;
    action: "create" | "edit" | "delete";
    content: string;
  }>;
  summary: string;
}

interface ReviewerOutput {
  approved: boolean;
  issues: Array<{
    file: string;
    issue: string;
    severity: "error" | "warning" | "suggestion";
  }>;
  summary: string;
}

interface AgentContext {
  taskId: string;
  projectId: string;
  agentUid: string;
  role: string;
  assignment: string;
  depth: number;
  parentAgentUid?: string;
}

// ═══════════════════════════════════════════════
// Agent counter (for unique IDs within a task)
// ═══════════════════════════════════════════════

const agentCounters = new Map<string, number>();

function nextAgentUid(taskId: string, role: string): string {
  const key = `${taskId}:${role}`;
  const count = (agentCounters.get(key) ?? 0) + 1;
  agentCounters.set(key, count);
  return `${role}-${count}`;
}

export function resetCounters(taskId: string): void {
  for (const key of agentCounters.keys()) {
    if (key.startsWith(`${taskId}:`)) {
      agentCounters.delete(key);
    }
  }
}

// ═══════════════════════════════════════════════
// Helper: Build file context string
// ═══════════════════════════════════════════════

function buildFileContext(files: ConvexFile[], maxChars = 40000): string {
  const codeFiles = files.filter((f) => !f.isDirectory);
  let ctx = "";
  for (const f of codeFiles) {
    const entry = `--- ${f.path} ---\n${f.content}\n\n`;
    if (ctx.length + entry.length > maxChars) {
      ctx += `--- (${codeFiles.length - codeFiles.indexOf(f)} more files truncated) ---\n`;
      break;
    }
    ctx += entry;
  }
  return ctx;
}

// ═══════════════════════════════════════════════
// PLANNER AGENT
// ═══════════════════════════════════════════════

export async function runPlanner(
  ctx: AgentContext,
  files: ConvexFile[]
): Promise<PlannerOutput> {
  await convexClient.updateAgentStatus(ctx.taskId, ctx.agentUid, "running");
  await convexClient.logEvent({
    taskId: ctx.taskId,
    projectId: ctx.projectId,
    agentUid: ctx.agentUid,
    agentRole: "planner",
    type: "thinking",
    content: `Analyzing request: "${ctx.assignment}"`,
  });

  const fileList = files
    .filter((f) => !f.isDirectory)
    .map((f) => f.path)
    .join("\n");

  const prompt = `You are the Planner agent in an autonomous code generation swarm. Your job is to break a user request into concrete sub-tasks for specialized agents.

USER REQUEST: "${ctx.assignment}"

PROJECT FILES:
${fileList}

AVAILABLE AGENT ROLES:
- architect: Designs file structure, component hierarchy, data models
- coder: Writes actual code for specific files/modules
- debugger: Fixes errors, handles edge cases
- tester: Validates code works correctly
- reviewer: Reviews code quality before merge

RULES:
1. Break the request into 2-8 sub-tasks
2. Each sub-task should be specific enough for one agent to complete
3. Assign file ownership to coders to avoid conflicts
4. If the task is simple (1-2 files), use fewer agents
5. For complex tasks, use architect first, then coders
6. Always end with a reviewer task

Return ONLY JSON (no markdown):
{
  "subtasks": [
    { "role": "architect", "assignment": "Design the file structure for...", "files": ["path1", "path2"] },
    { "role": "coder", "assignment": "Implement the login component in...", "files": ["src/login.tsx"] },
    { "role": "reviewer", "assignment": "Review all changes for quality and consistency" }
  ],
  "summary": "Brief plan summary"
}`;

  const result = await callAIJson<PlannerOutput>(prompt);

  await convexClient.logEvent({
    taskId: ctx.taskId,
    projectId: ctx.projectId,
    agentUid: ctx.agentUid,
    agentRole: "planner",
    type: "planning",
    content: `Plan created: ${result.subtasks.length} sub-tasks — ${result.summary}`,
    metadata: JSON.stringify(result),
  });

  return result;
}

// ═══════════════════════════════════════════════
// ARCHITECT AGENT
// ═══════════════════════════════════════════════

export async function runArchitect(
  ctx: AgentContext,
  files: ConvexFile[]
): Promise<CoderOutput> {
  await convexClient.updateAgentStatus(ctx.taskId, ctx.agentUid, "running");
  await convexClient.logEvent({
    taskId: ctx.taskId,
    projectId: ctx.projectId,
    agentUid: ctx.agentUid,
    agentRole: "architect",
    type: "thinking",
    content: `Designing architecture: ${ctx.assignment}`,
  });

  const fileContext = buildFileContext(files);

  const prompt = `You are the Architect agent. Design the file structure and code architecture for a task.

TASK: ${ctx.assignment}

EXISTING PROJECT FILES:
${fileContext}

Design the structure. If files need to be created or modified, return them with full content.
Return ONLY JSON (no markdown):
{
  "changes": [
    { "path": "src/components/NewComponent.tsx", "action": "create", "content": "full file content here" },
    { "path": "src/App.tsx", "action": "edit", "content": "full updated file content here" }
  ],
  "summary": "What architecture decisions were made"
}`;

  const result = await callAIJson<CoderOutput>(prompt);

  // Write files
  for (const change of result.changes) {
    const cleanContent = change.content
      .replace(/^```[\w]*\n?/, "")
      .replace(/\n?```$/, "")
      .trim();

    if (change.action !== "delete") {
      await convexClient.writeFile(ctx.projectId, change.path, cleanContent);
      await convexClient.logEvent({
        taskId: ctx.taskId,
        projectId: ctx.projectId,
        agentUid: ctx.agentUid,
        agentRole: "architect",
        type: change.action === "create" ? "file_created" : "file_edited",
        content: `${change.action === "create" ? "Created" : "Updated"} ${change.path}`,
        metadata: JSON.stringify({ path: change.path }),
      });
    }
  }

  await convexClient.updateAgentStatus(ctx.taskId, ctx.agentUid, "done", {
    result: result.summary,
  });

  return result;
}

// ═══════════════════════════════════════════════
// CODER AGENT
// ═══════════════════════════════════════════════

export async function runCoder(
  ctx: AgentContext,
  files: ConvexFile[]
): Promise<CoderOutput> {
  await convexClient.updateAgentStatus(ctx.taskId, ctx.agentUid, "running");
  await convexClient.logEvent({
    taskId: ctx.taskId,
    projectId: ctx.projectId,
    agentUid: ctx.agentUid,
    agentRole: "coder",
    type: "thinking",
    content: `Writing code: ${ctx.assignment}`,
  });

  const fileContext = buildFileContext(files);

  const prompt = `You are a Coder agent in an autonomous swarm. Write high-quality code for your assigned task.

TASK: ${ctx.assignment}

EXISTING PROJECT FILES:
${fileContext}

Write clean, production-quality code. Use existing project conventions (styling, imports, patterns).
If creating new files, include all imports and exports.
If editing existing files, return the FULL updated file content.

Return ONLY JSON (no markdown):
{
  "changes": [
    { "path": "src/components/Example.tsx", "action": "create", "content": "full file content" }
  ],
  "summary": "What was implemented"
}`;

  const result = await callAIJson<CoderOutput>(prompt);

  // Write files
  const changedFiles: string[] = [];
  for (const change of result.changes) {
    const cleanContent = change.content
      .replace(/^```[\w]*\n?/, "")
      .replace(/\n?```$/, "")
      .trim();

    if (change.action !== "delete") {
      await convexClient.writeFile(ctx.projectId, change.path, cleanContent);
      changedFiles.push(change.path);
      await convexClient.logEvent({
        taskId: ctx.taskId,
        projectId: ctx.projectId,
        agentUid: ctx.agentUid,
        agentRole: "coder",
        type: change.action === "create" ? "file_created" : "file_edited",
        content: `${change.action === "create" ? "Created" : "Updated"} ${change.path}`,
        metadata: JSON.stringify({ path: change.path }),
      });
    }
  }

  await convexClient.updateAgentStatus(ctx.taskId, ctx.agentUid, "done", {
    result: `${result.summary} (${changedFiles.length} files)`,
  });

  return result;
}

// ═══════════════════════════════════════════════
// DEBUGGER AGENT
// ═══════════════════════════════════════════════

export async function runDebugger(
  ctx: AgentContext,
  files: ConvexFile[],
  errorContext?: string
): Promise<CoderOutput> {
  await convexClient.updateAgentStatus(ctx.taskId, ctx.agentUid, "running");
  await convexClient.logEvent({
    taskId: ctx.taskId,
    projectId: ctx.projectId,
    agentUid: ctx.agentUid,
    agentRole: "debugger",
    type: "error_found",
    content: `Debugging: ${ctx.assignment}`,
  });

  const fileContext = buildFileContext(files);

  const prompt = `You are a Debugger agent. Find and fix bugs in the code.

TASK: ${ctx.assignment}

${errorContext ? `ERROR CONTEXT:\n${errorContext}\n\n` : ""}EXISTING PROJECT FILES:
${fileContext}

Analyze the code for bugs, missing imports, type errors, and logic issues.
Fix everything you find. Return the corrected files with FULL content.

Return ONLY JSON (no markdown):
{
  "changes": [
    { "path": "src/file.tsx", "action": "edit", "content": "full corrected file content" }
  ],
  "summary": "What bugs were found and fixed"
}`;

  const result = await callAIJson<CoderOutput>(prompt);

  for (const change of result.changes) {
    const cleanContent = change.content
      .replace(/^```[\w]*\n?/, "")
      .replace(/\n?```$/, "")
      .trim();

    if (change.action !== "delete") {
      await convexClient.writeFile(ctx.projectId, change.path, cleanContent);
      await convexClient.logEvent({
        taskId: ctx.taskId,
        projectId: ctx.projectId,
        agentUid: ctx.agentUid,
        agentRole: "debugger",
        type: "error_fixed",
        content: `Fixed ${change.path}`,
        metadata: JSON.stringify({ path: change.path }),
      });
    }
  }

  await convexClient.updateAgentStatus(ctx.taskId, ctx.agentUid, "done", {
    result: result.summary,
  });

  return result;
}

// ═══════════════════════════════════════════════
// REVIEWER AGENT
// ═══════════════════════════════════════════════

export async function runReviewer(
  ctx: AgentContext,
  files: ConvexFile[]
): Promise<ReviewerOutput> {
  await convexClient.updateAgentStatus(ctx.taskId, ctx.agentUid, "running");
  await convexClient.logEvent({
    taskId: ctx.taskId,
    projectId: ctx.projectId,
    agentUid: ctx.agentUid,
    agentRole: "reviewer",
    type: "thinking",
    content: `Reviewing code quality: ${ctx.assignment}`,
  });

  const fileContext = buildFileContext(files);

  const prompt = `You are a Reviewer agent. Check code quality, consistency, and correctness.

TASK: Review the project after: ${ctx.assignment}

PROJECT FILES:
${fileContext}

Check for:
1. Missing imports or exports
2. Inconsistent naming or patterns
3. Potential runtime errors
4. Security issues
5. Missing error handling
6. Broken references between files

Return ONLY JSON (no markdown):
{
  "approved": true/false,
  "issues": [
    { "file": "src/file.tsx", "issue": "Missing import for useState", "severity": "error" }
  ],
  "summary": "Overall assessment"
}`;

  const result = await callAIJson<ReviewerOutput>(prompt);

  const eventType = result.approved ? "review_pass" : "review_fail";
  await convexClient.logEvent({
    taskId: ctx.taskId,
    projectId: ctx.projectId,
    agentUid: ctx.agentUid,
    agentRole: "reviewer",
    type: eventType,
    content: result.approved
      ? `✓ Review passed: ${result.summary}`
      : `✗ Review failed (${result.issues.length} issues): ${result.summary}`,
    metadata: JSON.stringify(result.issues),
  });

  await convexClient.updateAgentStatus(ctx.taskId, ctx.agentUid, "done", {
    result: result.summary,
  });

  return result;
}

// ═══════════════════════════════════════════════
// TASK ORCHESTRATOR — Runs the full swarm for a task
// ═══════════════════════════════════════════════

export async function orchestrateTask(task: {
  _id: string;
  projectId: string;
  prompt: string;
}): Promise<void> {
  const { _id: taskId, projectId, prompt } = task;
  console.log(`[orchestrator] Starting task ${taskId}: "${prompt.substring(0, 60)}..."`);

  try {
    // Mark task as planning
    await convexClient.updateTaskStatus(taskId, "planning");

    // Get current project files
    let files = await convexClient.getProjectFiles(projectId);

    // ── Step 1: Planner ──────────────────────────
    const plannerUid = nextAgentUid(taskId, "planner");
    await convexClient.spawnAgent({
      taskId,
      projectId,
      agentUid: plannerUid,
      role: "planner",
      assignment: prompt,
      depth: 0,
    });

    const plan = await runPlanner(
      { taskId, projectId, agentUid: plannerUid, role: "planner", assignment: prompt, depth: 0 },
      files
    );

    await convexClient.updateAgentStatus(taskId, plannerUid, "done", {
      result: plan.summary,
    });

    // Mark task as running
    await convexClient.updateTaskStatus(taskId, "running", {
      rootAgentId: plannerUid,
    });

    // ── Step 2: Execute sub-tasks ────────────────
    // Separate by role priority: architects first, then coders in parallel, then reviewer
    const architects = plan.subtasks.filter((s) => s.role === "architect");
    const coders = plan.subtasks.filter((s) => s.role === "coder");
    const others = plan.subtasks.filter(
      (s) => !["architect", "coder", "reviewer"].includes(s.role)
    );
    const reviewers = plan.subtasks.filter((s) => s.role === "reviewer");

    let totalAgents = 1; // planner
    let totalFilesChanged = 0;

    // Run architects sequentially (they define structure)
    for (const sub of architects) {
      const uid = nextAgentUid(taskId, "architect");
      totalAgents++;
      await convexClient.spawnAgent({
        taskId,
        projectId,
        agentUid: uid,
        parentAgentUid: plannerUid,
        role: "architect",
        assignment: sub.assignment,
        depth: 1,
        filesOwned: sub.files,
      });
      const result = await runArchitect(
        { taskId, projectId, agentUid: uid, role: "architect", assignment: sub.assignment, depth: 1, parentAgentUid: plannerUid },
        files
      );
      totalFilesChanged += result.changes.length;
      // Refresh files after architect changes
      files = await convexClient.getProjectFiles(projectId);
    }

    // Run coders in parallel
    if (coders.length > 0) {
      const coderPromises = coders.map(async (sub) => {
        const uid = nextAgentUid(taskId, "coder");
        totalAgents++;
        await convexClient.spawnAgent({
          taskId,
          projectId,
          agentUid: uid,
          parentAgentUid: plannerUid,
          role: "coder",
          assignment: sub.assignment,
          depth: 1,
          filesOwned: sub.files,
        });
        // Use snapshot of files (coders work on different files so this is safe)
        return runCoder(
          { taskId, projectId, agentUid: uid, role: "coder", assignment: sub.assignment, depth: 1, parentAgentUid: plannerUid },
          files
        );
      });

      const coderResults = await Promise.allSettled(coderPromises);
      for (const r of coderResults) {
        if (r.status === "fulfilled") {
          totalFilesChanged += r.value.changes.length;
        } else {
          console.error(`[orchestrator] Coder failed:`, r.reason);
        }
      }

      // Refresh files after all coders
      files = await convexClient.getProjectFiles(projectId);
    }

    // Run other agents (debuggers, testers, etc.) sequentially
    for (const sub of others) {
      const uid = nextAgentUid(taskId, sub.role);
      totalAgents++;
      await convexClient.spawnAgent({
        taskId,
        projectId,
        agentUid: uid,
        parentAgentUid: plannerUid,
        role: sub.role,
        assignment: sub.assignment,
        depth: 1,
        filesOwned: sub.files,
      });

      if (sub.role === "debugger") {
        const result = await runDebugger(
          { taskId, projectId, agentUid: uid, role: "debugger", assignment: sub.assignment, depth: 1, parentAgentUid: plannerUid },
          files
        );
        totalFilesChanged += result.changes.length;
        files = await convexClient.getProjectFiles(projectId);
      } else {
        // Generic coder-like agent for other roles
        const result = await runCoder(
          { taskId, projectId, agentUid: uid, role: sub.role, assignment: sub.assignment, depth: 1, parentAgentUid: plannerUid },
          files
        );
        totalFilesChanged += result.changes.length;
        files = await convexClient.getProjectFiles(projectId);
      }
    }

    // ── Step 3: Review ───────────────────────────
    await convexClient.updateTaskStatus(taskId, "verifying");

    let reviewPassed = false;
    let retryCount = 0;

    while (!reviewPassed && retryCount < config.maxRetryLoops) {
      // Run reviewer
      const reviewerUid = nextAgentUid(taskId, "reviewer");
      totalAgents++;
      await convexClient.spawnAgent({
        taskId,
        projectId,
        agentUid: reviewerUid,
        parentAgentUid: plannerUid,
        role: "reviewer",
        assignment: `Review all changes for: ${prompt}`,
        depth: 1,
      });

      const review = await runReviewer(
        { taskId, projectId, agentUid: reviewerUid, role: "reviewer", assignment: prompt, depth: 1, parentAgentUid: plannerUid },
        files
      );

      if (review.approved) {
        reviewPassed = true;
      } else {
        retryCount++;
        if (retryCount < config.maxRetryLoops) {
          // Spawn debugger to fix review issues
          const debugUid = nextAgentUid(taskId, "debugger");
          totalAgents++;
          const issuesSummary = review.issues
            .map((i) => `${i.file}: ${i.issue} (${i.severity})`)
            .join("\n");

          await convexClient.spawnAgent({
            taskId,
            projectId,
            agentUid: debugUid,
            parentAgentUid: reviewerUid,
            role: "debugger",
            assignment: `Fix review issues:\n${issuesSummary}`,
            depth: 2,
          });

          const debugResult = await runDebugger(
            {
              taskId,
              projectId,
              agentUid: debugUid,
              role: "debugger",
              assignment: `Fix review issues`,
              depth: 2,
              parentAgentUid: reviewerUid,
            },
            files,
            issuesSummary
          );
          totalFilesChanged += debugResult.changes.length;
          files = await convexClient.getProjectFiles(projectId);
        }
      }
    }

    // ── Step 4: Complete ─────────────────────────
    await convexClient.logEvent({
      taskId,
      projectId,
      agentUid: "system",
      agentRole: "system",
      type: "task_complete",
      content: `Task complete — ${totalAgents} agents, ${totalFilesChanged} files changed`,
    });

    await convexClient.updateTaskStatus(taskId, "completed", {
      totalAgentsSpawned: totalAgents,
      totalFilesChanged,
    });

    console.log(
      `[orchestrator] Task ${taskId} completed: ${totalAgents} agents, ${totalFilesChanged} files`
    );
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[orchestrator] Task ${taskId} failed:`, errMsg);

    await convexClient.logEvent({
      taskId,
      projectId,
      agentUid: "system",
      agentRole: "system",
      type: "task_failed",
      content: `Task failed: ${errMsg}`,
    });

    await convexClient.updateTaskStatus(taskId, "failed", {
      errorMessage: errMsg,
    });
  } finally {
    resetCounters(taskId);
  }
}
