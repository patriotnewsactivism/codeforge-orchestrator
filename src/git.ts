/**
 * Git Integration — GitHub API operations for branch/commit/PR management.
 *
 * Each swarm task gets its own branch. File changes are committed automatically.
 * On task completion, a PR is created back to main.
 */
import { config } from "./config.js";

const GITHUB_API = "https://api.github.com";

interface GitConfig {
  owner: string;
  repo: string;
  token: string;
  baseBranch: string;
}

function getGitConfig(): GitConfig | null {
  const repo = config.githubRepo; // e.g. "owner/repo"
  const token = config.githubToken;
  if (!repo || !token) return null;
  const [owner, repoName] = repo.split("/");
  return { owner, repo: repoName, token, baseBranch: config.githubBaseBranch || "main" };
}

async function githubFetch(
  path: string,
  git: GitConfig,
  options: RequestInit = {}
): Promise<Response> {
  const url = `${GITHUB_API}/repos/${git.owner}/${git.repo}${path}`;
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `token ${git.token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      ...((options.headers as Record<string, string>) || {}),
    },
  });
}

/** Get the latest commit SHA on a branch */
export async function getLatestCommit(branchName: string): Promise<string | null> {
  const git = getGitConfig();
  if (!git) return null;

  const res = await githubFetch(`/git/ref/heads/${branchName}`, git);
  if (!res.ok) return null;
  const data = await res.json();
  return data.object?.sha ?? null;
}

/** Create a new branch from base */
export async function createBranch(branchName: string): Promise<boolean> {
  const git = getGitConfig();
  if (!git) {
    console.log("[git] No GitHub config, skipping branch creation");
    return false;
  }

  // Get base branch SHA
  const baseSha = await getLatestCommit(git.baseBranch);
  if (!baseSha) {
    console.error(`[git] Could not get SHA for base branch ${git.baseBranch}`);
    return false;
  }

  const res = await githubFetch("/git/refs", git, {
    method: "POST",
    body: JSON.stringify({
      ref: `refs/heads/${branchName}`,
      sha: baseSha,
    }),
  });

  if (res.ok) {
    console.log(`[git] Created branch: ${branchName}`);
    return true;
  }

  // Branch might already exist
  if (res.status === 422) {
    console.log(`[git] Branch ${branchName} already exists`);
    return true;
  }

  const err = await res.text();
  console.error(`[git] Failed to create branch: ${err}`);
  return false;
}

/**
 * Commit files to a branch.
 * Creates a tree with the changed files, then a commit, then updates the branch ref.
 */
export async function commitFiles(
  branchName: string,
  files: Array<{ path: string; content: string }>,
  message: string
): Promise<string | null> {
  const git = getGitConfig();
  if (!git || files.length === 0) return null;

  try {
    // 1. Get current branch HEAD
    const headSha = await getLatestCommit(branchName);
    if (!headSha) {
      console.error(`[git] Could not get HEAD for branch ${branchName}`);
      return null;
    }

    // 2. Get the tree SHA of the HEAD commit
    const commitRes = await githubFetch(`/git/commits/${headSha}`, git);
    if (!commitRes.ok) return null;
    const commitData = await commitRes.json();
    const baseTreeSha = commitData.tree.sha;

    // 3. Create blobs for each file
    const treeItems = [];
    for (const file of files) {
      const blobRes = await githubFetch("/git/blobs", git, {
        method: "POST",
        body: JSON.stringify({
          content: file.content,
          encoding: "utf-8",
        }),
      });
      if (!blobRes.ok) {
        console.error(`[git] Failed to create blob for ${file.path}`);
        continue;
      }
      const blobData = await blobRes.json();
      treeItems.push({
        path: file.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blobData.sha,
      });
    }

    if (treeItems.length === 0) return null;

    // 4. Create a new tree
    const treeRes = await githubFetch("/git/trees", git, {
      method: "POST",
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: treeItems,
      }),
    });
    if (!treeRes.ok) return null;
    const treeData = await treeRes.json();

    // 5. Create the commit
    const newCommitRes = await githubFetch("/git/commits", git, {
      method: "POST",
      body: JSON.stringify({
        message,
        tree: treeData.sha,
        parents: [headSha],
      }),
    });
    if (!newCommitRes.ok) return null;
    const newCommitData = await newCommitRes.json();

    // 6. Update the branch ref
    const refRes = await githubFetch(`/git/refs/heads/${branchName}`, git, {
      method: "PATCH",
      body: JSON.stringify({ sha: newCommitData.sha }),
    });

    if (refRes.ok) {
      console.log(`[git] Committed ${files.length} file(s) to ${branchName}: ${newCommitData.sha.substring(0, 7)}`);
      return newCommitData.sha;
    }

    return null;
  } catch (err) {
    console.error("[git] Commit failed:", err);
    return null;
  }
}

/** Create a pull request */
export async function createPR(
  branchName: string,
  title: string,
  body: string
): Promise<{ number: number; url: string } | null> {
  const git = getGitConfig();
  if (!git) return null;

  const res = await githubFetch("/pulls", git, {
    method: "POST",
    body: JSON.stringify({
      title,
      body,
      head: branchName,
      base: git.baseBranch,
    }),
  });

  if (res.ok) {
    const data = await res.json();
    console.log(`[git] Created PR #${data.number}: ${data.html_url}`);
    return { number: data.number, url: data.html_url };
  }

  const err = await res.text();
  console.error(`[git] Failed to create PR: ${err}`);
  return null;
}

/** Check if git integration is configured */
export function isGitEnabled(): boolean {
  return !!getGitConfig();
}

/** Generate a branch name from a task ID and prompt */
export function generateBranchName(taskId: string, prompt: string): string {
  // Create a short slug from the prompt
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join("-");
  const shortId = taskId.slice(-6);
  return `codeforge/${slug}-${shortId}`;
}
