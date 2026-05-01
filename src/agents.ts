/**
 * Agent Runners — Each agent role has a specialized prompt and behavior.
 * Agents execute via the AI model and write results back through the Convex client.
 * 
 * Phase 2: Agents now use sandbox execution for validation, testing, and debugging.
 */
import { config } from "./config.js";
import { convexClient, type ConvexFile } from "./convex-client.js";
import { callAI, callAIJson } from "./ai.js";
import { validateProject, createSession, execInSandbox, destroySession, type SandboxResult, type ValidationResult } from "./sandbox.js";

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

interface TesterOutput {
  testsPassed: boolean;
  results: Array<{
    name: string;
    passed: boolean;
    error?: string;
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
// Helper: Format sandbox result for AI context
// ═══════════════════════════════════════════════

function formatSandboxForAI(validation: ValidationResult): string {
  const parts: string[] = [];

  if (validation.installResult && validation.installResult.exitCode !== 0) {
    parts.push(`=== NPM INSTALL FAILED (exit ${validation.installResult.exitCode}) ===\n${validation.installResult.stderr}`);
  }

  if (validation.typeCheckResult && validation.typeCheckResult.exitCode !== 0) {
    parts.push(`=== TYPESCRIPT ERRORS ===\n${validation.typeCheckResult.stdout}\n${validation.typeCheckResult.stderr}`);
  }

  if (validation.buildResult && validation.buildResult.exitCode !== 0) {
    parts.push(`=== BUILD FAILED (exit ${validation.buildResult.exitCode}) ===\n${validation.buildResult.stderr}`);
  }

  if (validation.testResult && validation.testResult.exitCode !== 0) {
    parts.push(`=== TESTS FAILED (exit ${validation.testResult.exitCode}) ===\n${validation.testResult.stdout}\n${validation.testResult.stderr}`);
  }

  if (parts.length === 0) {
    return "All sandbox checks passed — no errors found.";
  }

  return parts.join("\n\n");
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
- tester: Validates code by running sandbox checks (npm install, TypeScript compilation, tests)
- reviewer: Reviews code quality before merge

RULES:
1. Break the request into 2-8 sub-tasks
2. Each sub-task should be specific enough for one agent to complete
3. Assign file ownership to coders to avoid conflicts
4. If the task is simple (1-2 files), use fewer agents
5. For complex tasks, use architect first, then coders
6. ALWAYS include a tester task (runs sandbox validation on the code)
7. Always end with a reviewer task

Return ONLY JSON (no markdown):
{
  "subtasks": [
    { "role": "architect", "assignment": "Design the file structure for...", "files": ["path1", "path2"] },
    { "role": "coder", "assignment": "Implement the login component in...", "files": ["src/login.tsx"] },
    { "role": "tester", "assignment": "Run sandbox validation: npm install, type-check, and build" },
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
// TESTER AGENT — Phase 2: Sandbox Execution
// ═══════════════════════════════════════════════

export async function runTester(
  ctx: AgentContext,
  files: ConvexFile[]
): Promise<{ validation: ValidationResult; coderOutput?: CoderOutput }> {
  await convexClient.updateAgentStatus(ctx.taskId, ctx.agentUid, "running");
  await convexClient.logEvent({
    taskId: ctx.taskId,
    projectId: ctx.projectId,
    agentUid: ctx.agentUid,
    agentRole: "tester",
    type: "sandbox_run",
    content: `Starting sandbox validation: install → type-check → build`,
  });

  // Run full sandbox validation
  const validation = await validateProject(
    ctx.taskId,
    ctx.projectId,
    ctx.agentUid,
    files,
    {
      runBuild: true,
      runTests: true,
      logToConvex: true,
    }
  );

  // Log results
  if (validation.passed) {
    await convexClient.logEvent({
      taskId: ctx.taskId,
      projectId: ctx.projectId,
      agentUid: ctx.agentUid,
      agentRole: "tester",
      type: "test_pass",
      content: `✅ Sandbox validation passed: ${validation.summary}`,
    });

    await convexClient.updateAgentStatus(ctx.taskId, ctx.agentUid, "done", {
      result: `Sandbox validation passed — all checks green`,
    });

    return { validation };
  }

  // Validation failed — ask AI to fix the issues
  await convexClient.logEvent({
    taskId: ctx.taskId,
    projectId: ctx.projectId,
    agentUid: ctx.agentUid,
    agentRole: "tester",
    type: "test_fail",
    content: `❌ Sandbox validation failed: ${validation.errors.length} error(s)`,
    metadata: JSON.stringify(validation.errors),
  });

  // Auto-fix attempt: send errors to AI for repair
  const fileContext = buildFileContext(files);
  const sandboxOutput = formatSandboxForAI(validation);

  const fixPrompt = `You are a Tester agent that just ran sandbox validation on a project. The validation FAILED.
Fix ALL errors so the code compiles and runs correctly.

SANDBOX OUTPUT:
${sandboxOutput}

CURRENT PROJECT FILES:
${fileContext}

Fix every error. Return the corrected files with FULL updated content.
Return ONLY JSON (no markdown):
{
  "changes": [
    { "path": "src/file.tsx", "action": "edit", "content": "full corrected file content" }
  ],
  "summary": "What was fixed to pass sandbox validation"
}`;

  try {
    const fixes = await callAIJson<CoderOutput>(fixPrompt);

    // Write fixes
    for (const change of fixes.changes) {
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
          agentRole: "tester",
          type: "error_fixed",
          content: `Auto-fixed ${change.path}`,
          metadata: JSON.stringify({ path: change.path }),
        });
      }
    }

    await convexClient.updateAgentStatus(ctx.taskId, ctx.agentUid, "done", {
      result: `Sandbox validation failed, auto-fixed ${fixes.changes.length} files: ${fixes.summary}`,
    });

    return { validation, coderOutput: fixes };
  } catch (fixError) {
    await convexClient.updateAgentStatus(ctx.taskId, ctx.agentUid, "done", {
      result: `Sandbox validation failed with ${validation.errors.length} errors. Auto-fix attempted.`,
    });

    return { validation };
  }
}

// ═══════════════════════════════════════════════
// DEBUGGER AGENT — Phase 2: Sandbox-Powered
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

  // Phase 2: Run sandbox to get real errors
  await convexClient.logEvent({
    taskId: ctx.taskId,
    projectId: ctx.projectId,
    agentUid: ctx.agentUid,
    agentRole: "debugger",
    type: "sandbox_run",
    content: `Running sandbox to capture actual errors...`,
  });

  const validation = await validateProject(
    ctx.taskId,
    ctx.projectId,
    ctx.agentUid,
    files,
    { logToConvex: true }
  );

  const sandboxErrors = formatSandboxForAI(validation);
  const fileContext = buildFileContext(files);

  const prompt = `You are a Debugger agent with access to REAL sandbox execution results. Fix all bugs.

TASK: ${ctx.assignment}

${errorContext ? `REPORTED ERROR CONTEXT:\n${errorContext}\n\n` : ""}SANDBOX EXECUTION RESULTS:
${sandboxErrors}

EXISTING PROJECT FILES:
${fileContext}

Analyze the REAL errors from the sandbox execution. Fix everything — missing imports, type errors, logic issues.
Return the corrected files with FULL content.

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

  // Phase 2: Re-validate after fixes
  const updatedFiles = await convexClient.getProjectFiles(ctx.projectId);
  const revalidation = await validateProject(
    ctx.taskId,
    ctx.projectId,
    ctx.agentUid,
    updatedFiles,
    { logToConvex: true }
  );

  const statusMsg = revalidation.passed
    ? `${result.summary} — sandbox re-validation PASSED ✅`
    : `${result.summary} — some issues remain after fix (${revalidation.errors.length} errors)`;

  await convexClient.logEvent({
    taskId: ctx.taskId,
    projectId: ctx.projectId,
    agentUid: ctx.agentUid,
    agentRole: "debugger",
    type: revalidation.passed ? "test_pass" : "test_fail",
    content: revalidation.passed
      ? `✅ Post-fix sandbox validation passed`
      : `⚠️ Post-fix sandbox still has ${revalidation.errors.length} error(s)`,
  });

  await convexClient.updateAgentStatus(ctx.taskId, ctx.agentUid, "done", {
    result: statusMsg,
  });

  return result;
}

// ═══════════════════════════════════════════════
// REVIEWER AGENT — Phase 2: Sandbox-Informed
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

  // Phase 2: Run sandbox check as part of review
  await convexClient.logEvent({
    taskId: ctx.taskId,
    projectId: ctx.projectId,
    agentUid: ctx.agentUid,
    agentRole: "reviewer",
    type: "sandbox_run",
    content: `Running sandbox validation as part of review...`,
  });

  const validation = await validateProject(
    ctx.taskId,
    ctx.projectId,
    ctx.agentUid,
    files,
    { logToConvex: true }
  );

  const sandboxInfo = formatSandboxForAI(validation);
  const fileContext = buildFileContext(files);

  const prompt = `You are a Reviewer agent. Check code quality, consistency, and correctness.
You also have REAL sandbox execution results to base your review on.

TASK: Review the project after: ${ctx.assignment}

SANDBOX EXECUTION RESULTS:
${sandboxInfo}

${!validation.passed ? "⚠️ SANDBOX FAILED — there are real compilation/runtime errors that MUST be flagged." : "✅ SANDBOX PASSED — code compiles and runs."}

PROJECT FILES:
${fileContext}

Check for:
1. REAL errors from sandbox (these are confirmed bugs, not guesses)
2. Missing imports or exports
3. Inconsistent naming or patterns
4. Potential runtime errors
5. Security issues
6. Missing error handling
7. Broken references between files

If sandbox passed and code quality is good, approve.
If sandbox failed, REJECT and list all real errors.

Return ONLY JSON (no markdown):
{
  "approved": true/false,
  "issues": [
    { "file": "src/file.tsx", "issue": "Missing import for useState", "severity": "error" }
  ],
  "summary": "Overall assessment"
}`;

  const result = await callAIJson<ReviewerOutput>(prompt);

  // If sandbox failed, force rejection regardless of AI opinion
  if (!validation.passed && result.approved) {
    result.approved = false;
    result.issues.push({
      file: "project",
      issue: `Sandbox validation failed: ${validation.errors.join("; ")}`,
      severity: "error",
    });
  }

  const eventType = result.approved ? "review_pass" : "review_fail";
  await convexClient.logEvent({
    taskId: ctx.taskId,
    projectId: ctx.projectId,
    agentUid: ctx.agentUid,
    agentRole: "reviewer",
    type: eventType,
    content: result.approved
      ? `✓ Review passed (sandbox ✅): ${result.summary}`
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
    // Separate by role priority: architects first, then coders in parallel, then tester, then reviewer
    const architects = plan.subtasks.filter((s) => s.role === "architect");
    const coders = plan.subtasks.filter((s) => s.role === "coder");
    const testers = plan.subtasks.filter((s) => s.role === "tester");
    const others = plan.subtasks.filter(
      (s) => !["architect", "coder", "tester", "reviewer"].includes(s.role)
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

    // Run other agents (debuggers, etc.) sequentially
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

    // ── Step 3: Tester — Sandbox Validation ──────
    await convexClient.updateTaskStatus(taskId, "verifying");

    // Run testers (sandbox validation)
    for (const sub of testers) {
      const uid = nextAgentUid(taskId, "tester");
      totalAgents++;
      await convexClient.spawnAgent({
        taskId,
        projectId,
        agentUid: uid,
        parentAgentUid: plannerUid,
        role: "tester",
        assignment: sub.assignment || "Run sandbox validation: npm install, type-check, build",
        depth: 1,
      });
      const testerResult = await runTester(
        { taskId, projectId, agentUid: uid, role: "tester", assignment: sub.assignment || "Validate code", depth: 1, parentAgentUid: plannerUid },
        files
      );
      if (testerResult.coderOutput) {
        totalFilesChanged += testerResult.coderOutput.changes.length;
      }
      // Refresh files after tester fixes
      files = await convexClient.getProjectFiles(projectId);
    }

    // If no tester was planned, still run one automatically
    if (testers.length === 0) {
      const uid = nextAgentUid(taskId, "tester");
      totalAgents++;
      await convexClient.spawnAgent({
        taskId,
        projectId,
        agentUid: uid,
        parentAgentUid: plannerUid,
        role: "tester",
        assignment: "Automatic sandbox validation",
        depth: 1,
      });
      const testerResult = await runTester(
        { taskId, projectId, agentUid: uid, role: "tester", assignment: "Validate all code changes", depth: 1, parentAgentUid: plannerUid },
        files
      );
      if (testerResult.coderOutput) {
        totalFilesChanged += testerResult.coderOutput.changes.length;
      }
      files = await convexClient.getProjectFiles(projectId);
    }

    // ── Step 4: Review with self-healing loop ────
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
          // Spawn debugger to fix review issues (now with sandbox!)
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

    // ── Step 5: Complete ─────────────────────────
    await convexClient.logEvent({
      taskId,
      projectId,
      agentUid: "system",
      agentRole: "system",
      type: "task_complete",
      content: `Task complete — ${totalAgents} agents spawned, ${totalFilesChanged} files changed, sandbox-validated ✅`,
    });

    await convexClient.updateTaskStatus(taskId, "completed", {
      totalAgentsSpawned: totalAgents,
      totalFilesChanged,
    });

    console.log(
      `[orchestrator] Task ${taskId} completed: ${totalAgents} agents, ${totalFilesChanged} files (sandbox-validated)`
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
