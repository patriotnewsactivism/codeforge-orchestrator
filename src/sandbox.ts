/**
 * Sandbox Execution Engine — Phase 2
 * 
 * Runs code in isolated temp directories with:
 * - Strict timeouts (configurable, default 30s)
 * - Output capture (stdout + stderr)
 * - Resource limits (max output size)
 * - Auto-cleanup
 * - npm/node execution support
 * - TypeScript compilation validation
 * 
 * Each execution gets a fresh temp directory with project files written to disk.
 * Commands run as child processes with enforced time limits.
 */
import { execSync, spawn } from "child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { config } from "./config.js";
import { convexClient, type ConvexFile } from "./convex-client.js";

// ═══════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════

export interface SandboxResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

export interface SandboxSession {
  id: string;
  workDir: string;
  createdAt: number;
}

interface SandboxOptions {
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Max output size in bytes (default: 64KB) */
  maxOutputBytes?: number;
  /** Working directory override */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
}

// ═══════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════

const DEFAULT_TIMEOUT = 30_000; // 30 seconds
const MAX_OUTPUT_BYTES = 64 * 1024; // 64KB
const SANDBOX_PREFIX = "codeforge-sandbox-";

// Track active sessions for cleanup
const activeSessions = new Map<string, SandboxSession>();

// ═══════════════════════════════════════════════
// Session Management
// ═══════════════════════════════════════════════

/**
 * Create a new sandbox session — a temporary directory
 * pre-populated with project files.
 */
export function createSession(
  sessionId: string,
  files: ConvexFile[]
): SandboxSession {
  const workDir = mkdtempSync(join(tmpdir(), SANDBOX_PREFIX));

  // Write all project files to disk
  for (const file of files) {
    if (file.isDirectory) continue;
    const filePath = join(workDir, file.path);
    const fileDir = dirname(filePath);
    mkdirSync(fileDir, { recursive: true });
    writeFileSync(filePath, file.content ?? "", "utf-8");
  }

  const session: SandboxSession = {
    id: sessionId,
    workDir,
    createdAt: Date.now(),
  };

  activeSessions.set(sessionId, session);
  console.log(`[sandbox] Created session ${sessionId} at ${workDir} with ${files.filter(f => !f.isDirectory).length} files`);
  return session;
}

/**
 * Destroy a sandbox session — remove temp directory.
 */
export function destroySession(sessionId: string): void {
  const session = activeSessions.get(sessionId);
  if (!session) return;

  try {
    rmSync(session.workDir, { recursive: true, force: true });
    console.log(`[sandbox] Destroyed session ${sessionId}`);
  } catch (err) {
    console.error(`[sandbox] Failed to clean up session ${sessionId}:`, err);
  }

  activeSessions.delete(sessionId);
}

/**
 * Clean up all active sessions (called on shutdown).
 */
export function cleanupAllSessions(): void {
  for (const [id] of activeSessions) {
    destroySession(id);
  }
}

// ═══════════════════════════════════════════════
// Command Execution
// ═══════════════════════════════════════════════

/**
 * Execute a command in a sandbox session.
 * Returns captured stdout, stderr, exit code, and timing.
 */
export function execInSandbox(
  session: SandboxSession,
  command: string,
  options: SandboxOptions = {}
): Promise<SandboxResult> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const maxOutput = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  const cwd = options.cwd ?? session.workDir;
  const env = {
    ...process.env,
    HOME: session.workDir,
    NODE_ENV: "development",
    ...options.env,
  };

  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let resolved = false;

    // Split command into parts for spawn
    const parts = command.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    const child = spawn(cmd, args, {
      cwd,
      env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Capture stdout with size limit
    child.stdout.on("data", (data: Buffer) => {
      if (stdout.length < maxOutput) {
        stdout += data.toString();
        if (stdout.length > maxOutput) {
          stdout = stdout.substring(0, maxOutput) + "\n[output truncated]";
        }
      }
    });

    // Capture stderr with size limit
    child.stderr.on("data", (data: Buffer) => {
      if (stderr.length < maxOutput) {
        stderr += data.toString();
        if (stderr.length > maxOutput) {
          stderr = stderr.substring(0, maxOutput) + "\n[output truncated]";
        }
      }
    });

    // Timeout handler
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);

    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);

      const result: SandboxResult = {
        command,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: timedOut ? 124 : (code ?? 1),
        durationMs: Date.now() - startTime,
        timedOut,
      };

      if (timedOut) {
        result.stderr += `\n[TIMEOUT] Command killed after ${timeout}ms`;
      }

      resolve(result);
    });

    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);

      resolve({
        command,
        stdout: "",
        stderr: `[SPAWN ERROR] ${err.message}`,
        exitCode: 127,
        durationMs: Date.now() - startTime,
        timedOut: false,
      });
    });
  });
}

// ═══════════════════════════════════════════════
// High-Level Sandbox Operations
// ═══════════════════════════════════════════════

/**
 * Install npm dependencies in a sandbox session.
 */
export async function installDependencies(
  session: SandboxSession
): Promise<SandboxResult> {
  // Check if package.json exists
  const pkgPath = join(session.workDir, "package.json");
  if (!existsSync(pkgPath)) {
    return {
      command: "npm install",
      stdout: "No package.json found — skipping install",
      stderr: "",
      exitCode: 0,
      durationMs: 0,
      timedOut: false,
    };
  }

  return execInSandbox(session, "npm install --no-audit --no-fund", {
    timeout: 60_000, // 60s for installs
  });
}

/**
 * Run TypeScript compilation check (no emit, just type-check).
 */
export async function typeCheck(
  session: SandboxSession
): Promise<SandboxResult> {
  const tsconfigPath = join(session.workDir, "tsconfig.json");
  if (!existsSync(tsconfigPath)) {
    // Try running with --noEmit on all .ts/.tsx files
    return execInSandbox(session, "npx tsc --noEmit --allowJs --esModuleInterop", {
      timeout: 30_000,
    });
  }
  return execInSandbox(session, "npx tsc --noEmit", { timeout: 30_000 });
}

/**
 * Run a build command (npm run build).
 */
export async function runBuild(
  session: SandboxSession
): Promise<SandboxResult> {
  return execInSandbox(session, "npm run build", { timeout: 60_000 });
}

/**
 * Run tests (npm test).
 */
export async function runTests(
  session: SandboxSession
): Promise<SandboxResult> {
  return execInSandbox(session, "npm test", { timeout: 60_000 });
}

/**
 * Run a lint check.
 */
export async function runLint(
  session: SandboxSession
): Promise<SandboxResult> {
  return execInSandbox(session, "npx eslint . --max-warnings 0", { timeout: 30_000 });
}

/**
 * Execute arbitrary code in a sandboxed Node.js process.
 * Wraps the code in a temp file and runs it.
 */
export async function execCode(
  session: SandboxSession,
  code: string,
  filename = "_sandbox_exec.mjs"
): Promise<SandboxResult> {
  const filePath = join(session.workDir, filename);
  writeFileSync(filePath, code, "utf-8");
  return execInSandbox(session, `node ${filename}`, { timeout: 15_000 });
}

// ═══════════════════════════════════════════════
// Full Sandbox Pipeline — Used by agents
// ═══════════════════════════════════════════════

export interface ValidationResult {
  passed: boolean;
  installResult?: SandboxResult;
  typeCheckResult?: SandboxResult;
  buildResult?: SandboxResult;
  testResult?: SandboxResult;
  errors: string[];
  summary: string;
}

/**
 * Run a full validation pipeline on project files:
 * 1. Write files to temp dir
 * 2. npm install
 * 3. TypeScript type-check
 * 4. Build (optional)
 * 5. Tests (optional)
 * 
 * Returns a structured result with pass/fail and all output.
 */
export async function validateProject(
  taskId: string,
  projectId: string,
  agentUid: string,
  files: ConvexFile[],
  options: {
    runBuild?: boolean;
    runTests?: boolean;
    logToConvex?: boolean;
  } = {}
): Promise<ValidationResult> {
  const sessionId = `validate-${taskId}-${agentUid}-${Date.now()}`;
  const session = createSession(sessionId, files);
  const errors: string[] = [];
  const result: ValidationResult = {
    passed: true,
    errors: [],
    summary: "",
  };

  try {
    // Step 1: Install dependencies
    const installResult = await installDependencies(session);
    result.installResult = installResult;
    if (installResult.exitCode !== 0) {
      errors.push(`npm install failed (exit ${installResult.exitCode}): ${installResult.stderr.substring(0, 500)}`);
    }

    if (options.logToConvex) {
      await convexClient.logSandboxResult({
        taskId,
        projectId,
        agentUid,
        command: "npm install",
        stdout: installResult.stdout.substring(0, 2000),
        stderr: installResult.stderr.substring(0, 2000),
        exitCode: installResult.exitCode,
        durationMs: installResult.durationMs,
      });
    }

    // Step 2: TypeScript type-check (only if install succeeded)
    if (installResult.exitCode === 0) {
      const tcResult = await typeCheck(session);
      result.typeCheckResult = tcResult;
      if (tcResult.exitCode !== 0) {
        errors.push(`TypeScript errors:\n${tcResult.stderr.substring(0, 1000)}`);
      }

      if (options.logToConvex) {
        await convexClient.logSandboxResult({
          taskId,
          projectId,
          agentUid,
          command: "tsc --noEmit",
          stdout: tcResult.stdout.substring(0, 2000),
          stderr: tcResult.stderr.substring(0, 2000),
          exitCode: tcResult.exitCode,
          durationMs: tcResult.durationMs,
        });
      }
    }

    // Step 3: Build (optional)
    if (options.runBuild && installResult.exitCode === 0) {
      const buildResult = await runBuild(session);
      result.buildResult = buildResult;
      if (buildResult.exitCode !== 0) {
        errors.push(`Build failed:\n${buildResult.stderr.substring(0, 1000)}`);
      }

      if (options.logToConvex) {
        await convexClient.logSandboxResult({
          taskId,
          projectId,
          agentUid,
          command: "npm run build",
          stdout: buildResult.stdout.substring(0, 2000),
          stderr: buildResult.stderr.substring(0, 2000),
          exitCode: buildResult.exitCode,
          durationMs: buildResult.durationMs,
        });
      }
    }

    // Step 4: Tests (optional)
    if (options.runTests && installResult.exitCode === 0) {
      const testResult = await runTests(session);
      result.testResult = testResult;
      if (testResult.exitCode !== 0) {
        errors.push(`Tests failed:\n${testResult.stderr.substring(0, 1000)}`);
      }

      if (options.logToConvex) {
        await convexClient.logSandboxResult({
          taskId,
          projectId,
          agentUid,
          command: "npm test",
          stdout: testResult.stdout.substring(0, 2000),
          stderr: testResult.stderr.substring(0, 2000),
          exitCode: testResult.exitCode,
          durationMs: testResult.durationMs,
        });
      }
    }

    result.errors = errors;
    result.passed = errors.length === 0;
    result.summary = result.passed
      ? `All checks passed (install + type-check${options.runBuild ? " + build" : ""}${options.runTests ? " + tests" : ""})`
      : `${errors.length} check(s) failed:\n${errors.join("\n---\n")}`;

    return result;
  } finally {
    destroySession(sessionId);
  }
}
