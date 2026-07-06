// Locate Claude Code session transcripts on disk.
import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";

export function claudeProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

export interface SessionFile {
  path: string;
  projectDir: string; // the encoded ~/.claude/projects/<dir> name (storage key only)
  mtimeMs: number;
  size: number;
  isSidechainFile: boolean; // lives under a subagents/ subtree
}

/**
 * Recursively find every session .jsonl under ~/.claude/projects.
 * - includes main sessions AND subagent files (subagents agent-*.jsonl and workflow agent files)
 * - SKIPS journal.jsonl (different schema — not a message transcript)
 */
export async function listSessionFiles(root = claudeProjectsDir()): Promise<SessionFile[]> {
  const out: SessionFile[] = [];
  async function walk(dir: string, projectDir: string, underSubagents: boolean) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        const nowSub = underSubagents || e.name === "subagents";
        await walk(full, projectDir, nowSub);
      } else if (e.isFile() && e.name.endsWith(".jsonl") && e.name !== "journal.jsonl") {
        try {
          const s = await stat(full);
          out.push({
            path: full,
            projectDir,
            mtimeMs: s.mtimeMs,
            size: s.size,
            isSidechainFile: underSubagents,
          });
        } catch {
          /* ignore unreadable file */
        }
      }
    }
  }
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const p of projects) {
    if (p.isDirectory()) await walk(join(root, p.name), p.name, false);
  }
  return out;
}
