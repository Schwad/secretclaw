/**
 * claudep-runner.ts — Execute prompts via `claudep -p` (full-personality Claude).
 *
 * Every cron job, subagent, and scheduled task shells out through this runner
 * so that Philippe's hooks, personality, and memory pipeline fire on every
 * invocation. This is Nick's fork — Anthropic-only, by design.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const CLAUDEP_SCRIPT = path.join(os.homedir(), ".claude", "commands", "claudep-p.sh");
const TRACKER_FILE = path.join(os.homedir(), "tmp", "clawtracker.txt");

export type ClaudepRunResult = {
  status: "ok" | "error" | "timeout";
  output: string;
  error?: string;
  durationMs: number;
  exitCode?: number | null;
};

async function appendTracker(line: string): Promise<void> {
  try {
    const dir = path.dirname(TRACKER_FILE);
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(TRACKER_FILE, line + "\n");
  } catch {
    // Observability is best-effort — never block the run.
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

function iso(): string {
  return new Date().toISOString();
}

/**
 * Run a prompt through `claudep -p` and capture the result.
 *
 * @param params.prompt   - The prompt text sent to Claude.
 * @param params.context  - Human-readable label for tracker (e.g. "cron:morning-briefing").
 * @param params.abortSignal - Optional AbortSignal for cancellation.
 * @param params.timeoutMs   - Timeout in ms (default: 10 minutes).
 * @param params.workingDir  - cwd for the child process (default: $HOME).
 */
export async function runClaudepP(params: {
  prompt: string;
  context: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  workingDir?: string;
}): Promise<ClaudepRunResult> {
  const startedAt = Date.now();

  await appendTracker(
    `[${iso()}] START | ${params.context} | prompt=${truncate(params.prompt.replace(/\n/g, " "), 200)}`,
  );

  return new Promise<ClaudepRunResult>((resolve) => {
    const child = spawn("bash", [CLAUDEP_SCRIPT, params.prompt], {
      cwd: params.workingDir || os.homedir(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (result: ClaudepRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Default 10-minute timeout — Claude -p can be slow on big prompts.
    const timeoutMs = params.timeoutMs ?? 10 * 60 * 1000;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      const duration = Date.now() - startedAt;
      void appendTracker(`[${iso()}] TIMEOUT | ${params.context} | ${duration}ms`);
      settle({ status: "timeout", output: stdout.trim(), error: "timed out", durationMs: duration });
    }, timeoutMs);

    if (params.abortSignal) {
      const onAbort = () => {
        child.kill("SIGTERM");
        const duration = Date.now() - startedAt;
        void appendTracker(`[${iso()}] ABORT | ${params.context} | ${duration}ms`);
        settle({
          status: "timeout",
          output: stdout.trim(),
          error: "aborted",
          durationMs: duration,
        });
      };
      if (params.abortSignal.aborted) {
        onAbort();
        return;
      }
      params.abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err) => {
      const duration = Date.now() - startedAt;
      void appendTracker(
        `[${iso()}] SPAWN_ERROR | ${params.context} | ${duration}ms | ${err.message}`,
      );
      settle({
        status: "error",
        output: "",
        error: `Failed to spawn claudep: ${err.message}`,
        durationMs: duration,
      });
    });

    child.on("close", (code) => {
      const duration = Date.now() - startedAt;
      if (code === 0) {
        void appendTracker(
          `[${iso()}] OK | ${params.context} | ${duration}ms | output=${truncate(stdout.trim().replace(/\n/g, " "), 200)}`,
        );
        settle({ status: "ok", output: stdout.trim(), durationMs: duration, exitCode: code });
      } else {
        void appendTracker(
          `[${iso()}] ERROR | ${params.context} | ${duration}ms | exit=${code} | stderr=${truncate(stderr.replace(/\n/g, " "), 200)}`,
        );
        settle({
          status: "error",
          output: stdout.trim(),
          error: stderr.trim() || `exit code ${code}`,
          durationMs: duration,
          exitCode: code,
        });
      }
    });
  });
}
