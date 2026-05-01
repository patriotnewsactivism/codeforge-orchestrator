/**
 * Convex HTTP Client — calls the custom HTTP endpoints on the Convex backend.
 * All communication between Railway orchestrator and Convex goes through here.
 */
import { config } from "./config.js";

interface ConvexFile {
  _id: string;
  projectId: string;
  path: string;
  name: string;
  content: string;
  language?: string;
  isDirectory: boolean;
}

interface SwarmTask {
  _id: string;
  projectId: string;
  userId: string;
  prompt: string;
  status: string;
  priority: string;
  startedAt: number;
}

interface AgentInstance {
  _id: string;
  taskId: string;
  projectId: string;
  agentUid: string;
  parentAgentUid?: string;
  role: string;
  status: string;
  assignment: string;
  depth: number;
  filesOwned?: string[];
  result?: string;
  errorMessage?: string;
}

export type { ConvexFile, SwarmTask, AgentInstance };

class ConvexClient {
  private baseUrl: string;
  private secret: string;

  constructor() {
    // Convex HTTP routes are at the deployment URL
    this.baseUrl = config.convexUrl;
    this.secret = config.orchestratorSecret;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.secret}`,
    };
  }

  private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }
    const res = await fetch(url.toString(), { headers: this.headers() });
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(new URL(path, this.baseUrl).toString(), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  // ─── Task Operations ────────────────────────────────

  async getPendingTasks(): Promise<SwarmTask[]> {
    const data = await this.get<{ tasks: SwarmTask[] }>("/api/swarm/tasks/pending");
    return data.tasks;
  }

  async updateTaskStatus(
    taskId: string,
    status: string,
    extra?: {
      errorMessage?: string;
      totalAgentsSpawned?: number;
      totalFilesChanged?: number;
      rootAgentId?: string;
    }
  ): Promise<void> {
    await this.post("/api/swarm/tasks/status", { taskId, status, ...extra });
  }

  // ─── Agent Operations ───────────────────────────────

  async spawnAgent(args: {
    taskId: string;
    projectId: string;
    agentUid: string;
    parentAgentUid?: string;
    role: string;
    assignment: string;
    depth: number;
    filesOwned?: string[];
  }): Promise<string> {
    const data = await this.post<{ agentId: string }>("/api/swarm/agents/spawn", args);
    return data.agentId;
  }

  async updateAgentStatus(
    taskId: string,
    agentUid: string,
    status: string,
    extra?: { result?: string; errorMessage?: string }
  ): Promise<void> {
    await this.post("/api/swarm/agents/status", {
      taskId,
      agentUid,
      status,
      ...extra,
    });
  }

  async getTaskAgents(taskId: string): Promise<AgentInstance[]> {
    const data = await this.get<{ agents: AgentInstance[] }>("/api/swarm/task/agents", { taskId });
    return data.agents;
  }

  // ─── Event Operations ───────────────────────────────

  async logEvent(args: {
    taskId: string;
    projectId: string;
    agentUid: string;
    agentRole: string;
    type: string;
    content: string;
    metadata?: string;
  }): Promise<void> {
    await this.post("/api/swarm/events", args);
  }

  async logEventsBatch(
    events: Array<{
      taskId: string;
      projectId: string;
      agentUid: string;
      agentRole: string;
      type: string;
      content: string;
      metadata?: string;
    }>
  ): Promise<void> {
    await this.post("/api/swarm/events/batch", { events });
  }

  // ─── File Operations ────────────────────────────────

  async getProjectFiles(projectId: string): Promise<ConvexFile[]> {
    const data = await this.get<{ files: ConvexFile[] }>("/api/swarm/project/files", { projectId });
    return data.files;
  }

  async writeFile(projectId: string, path: string, content: string): Promise<void> {
    await this.post("/api/swarm/files/write", { projectId, path, content });
  }

  // ─── Sandbox Operations ─────────────────────────────

  async logSandboxResult(args: {
    taskId: string;
    projectId: string;
    agentUid: string;
    command: string;
    stdout?: string;
    stderr?: string;
    exitCode: number;
    durationMs: number;
  }): Promise<void> {
    await this.post("/api/swarm/sandbox", args);
  }
  // ─── Memory Operations ───────────────────────────────

  async getTopMemories(
    projectId: string,
    limit = 20,
    category?: string
  ): Promise<Array<{
    _id: string;
    category: string;
    title: string;
    content: string;
    importance: number;
    usageCount: number;
  }>> {
    const params: Record<string, string> = { projectId, limit: String(limit) };
    if (category) params.category = category;
    const data = await this.get<{ memories: any[] }>("/api/memory/top", params);
    return data.memories;
  }

  async createMemory(args: {
    projectId: string;
    category: string;
    title: string;
    content: string;
    importance?: number;
    sourceTaskId?: string;
    sourceAgentRole?: string;
  }): Promise<string> {
    const data = await this.post<{ memoryId: string }>("/api/memory/create", args);
    return data.memoryId;
  }

  async useMemory(memoryId: string): Promise<void> {
    await this.post("/api/memory/use", { memoryId });
  }

  // ─── Retrospective Operations ───────────────────────

  async createRetrospective(args: {
    taskId: string;
    projectId: string;
    taskSummary: string;
    totalAgents: number;
    totalFiles: number;
    durationMs: number;
    sandboxPassedFirst: boolean;
    reviewPassedFirst: boolean;
    retryCount: number;
    whatWorked: string[];
    whatFailed: string[];
    improvements: string[];
    newMemories: string[];
    qualityScore: number;
  }): Promise<string> {
    const data = await this.post<{ retroId: string }>("/api/retrospective/create", args);
    return data.retroId;
  }

  // ─── Agent Message Bus ──────────────────────────────

  async sendAgentMessage(args: {
    taskId: string;
    projectId: string;
    fromAgentUid: string;
    fromAgentRole: string;
    toAgentUid?: string;
    toAgentRole?: string;
    messageType: string;
    content: string;
  }): Promise<string> {
    const data = await this.post<{ messageId: string }>("/api/agents/message", args);
    return data.messageId;
  }

  async getMessagesForAgent(
    taskId: string,
    agentUid: string,
    agentRole: string
  ): Promise<Array<{
    _id: string;
    fromAgentUid: string;
    fromAgentRole: string;
    messageType: string;
    content: string;
    timestamp: number;
  }>> {
    const data = await this.get<{ messages: any[] }>("/api/agents/messages", {
      taskId,
      agentUid,
      agentRole,
    });
    return data.messages;
  }
}

export const convexClient = new ConvexClient();
