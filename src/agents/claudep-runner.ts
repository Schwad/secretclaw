/**
 * claudep-runner.ts — Execute prompts via `claudep -p` (full-personality Claude).
 *
 * Two entry points:
 *   - runClaudepP()            — one-shot run (crons, subagents, no continuity)
 *   - runClaudepPWithSession() — persistent session run (main chat); supports
 *                                 rollover when Claude Code session files grow
 *                                 beyond a tunable threshold.
 *
 * Observability: every event is appended to ~/tmp/clawtracker.txt in BOTH a
 * human-readable line AND a structured JSON line, so failures can be parsed
 * and understood without rerunning.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const CLAUDEP_SCRIPT = path.join(os.homedir(), ".claude", "commands", "claudep-p.sh");
const CLAUDEP_SESSION_SCRIPT = path.join(
  os.homedir(),
  ".claude",
  "commands",
  "claudep-p-session.sh",
);
const TRACKER_FILE = path.join(os.homedir(), "tmp", "clawtracker.txt");
const LOCK_DIR = path.join(os.homedir(), "tmp", "claudep-locks");

// Rollover thresholds — tuned for "catches most issues out of the box".
// Turn count: rolling over after ~60 back-and-forths gives substantial
// continuity while staying well clear of context limits. File size: 1.5 MB
// is a secondary trigger in case turns are unusually long. Either trigger
// fires rollover. Adjustable via env vars for tuning without a rebuild.
const ROLLOVER_TURN_LIMIT =
  Number(process.env.CLAUDEP_ROLLOVER_TURNS) || 60;
const ROLLOVER_FILE_SIZE_LIMIT =
  Number(process.env.CLAUDEP_ROLLOVER_BYTES) || 1_500_000;

export type ClaudepRunResult = {
  status: "ok" | "error" | "timeout";
  output: string;
  error?: string;
  durationMs: number;
  exitCode?: number | null;
};

export type ClaudepRunWithSessionResult = ClaudepRunResult & {
  sessionId: string;
  rolledOver?: boolean;
  previousSessionId?: string;
  turnNumber?: number;
  mode?: "resume" | "new";
  fallback?: boolean;
};

async function appendTracker(line: string, structured?: Record<string, unknown>): Promise<void> {
  try {
    const dir = path.dirname(TRACKER_FILE);
    await fs.mkdir(dir, { recursive: true });
    let payload = line + "\n";
    if (structured) {
      payload += JSON.stringify({ ts: new Date().toISOString(), ...structured }) + "\n";
    }
    await fs.appendFile(TRACKER_FILE, payload);
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

function summarize(s: string): string {
  return truncate(s.replace(/\n/g, " "), 200);
}

// ---------------------------------------------------------------------------
// One-shot runner (crons, subagents)
// ---------------------------------------------------------------------------

export async function runClaudepP(params: {
  prompt: string;
  context: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  workingDir?: string;
}): Promise<ClaudepRunResult> {
  const startedAt = Date.now();

  await appendTracker(
    `[${iso()}] START | ${params.context} | prompt=${summarize(params.prompt)}`,
    {
      event: "start",
      ctx: params.context,
      prompt_chars: params.prompt.length,
      prompt_preview: truncate(params.prompt, 500),
    },
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

    const timeoutMs = params.timeoutMs ?? 10 * 60 * 1000;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      const duration = Date.now() - startedAt;
      void appendTracker(`[${iso()}] TIMEOUT | ${params.context} | ${duration}ms`, {
        event: "timeout",
        ctx: params.context,
        duration_ms: duration,
      });
      settle({
        status: "timeout",
        output: stdout.trim(),
        error: "timed out",
        durationMs: duration,
      });
    }, timeoutMs);

    if (params.abortSignal) {
      const onAbort = () => {
        child.kill("SIGTERM");
        const duration = Date.now() - startedAt;
        void appendTracker(`[${iso()}] ABORT | ${params.context} | ${duration}ms`, {
          event: "abort",
          ctx: params.context,
          duration_ms: duration,
        });
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
        {
          event: "spawn_error",
          ctx: params.context,
          duration_ms: duration,
          error: err.message,
        },
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
          `[${iso()}] OK | ${params.context} | ${duration}ms | output=${summarize(stdout.trim())}`,
          {
            event: "ok",
            ctx: params.context,
            duration_ms: duration,
            output_chars: stdout.trim().length,
            output_preview: truncate(stdout.trim(), 500),
            exit_code: code,
          },
        );
        settle({ status: "ok", output: stdout.trim(), durationMs: duration, exitCode: code });
      } else {
        void appendTracker(
          `[${iso()}] ERROR | ${params.context} | ${duration}ms | exit=${code} | stderr=${summarize(stderr)}`,
          {
            event: "error",
            ctx: params.context,
            duration_ms: duration,
            exit_code: code,
            stderr_preview: truncate(stderr, 500),
          },
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

// ---------------------------------------------------------------------------
// Per-session mutex (file-based, one process at a time per UUID)
// ---------------------------------------------------------------------------

async function ensureLockDir(): Promise<void> {
  await fs.mkdir(LOCK_DIR, { recursive: true });
}

function lockFileFor(sessionId: string): string {
  // Sanitize the UUID to be safe as a filename (UUIDs are already safe, but be defensive).
  const safe = sessionId.replace(/[^a-zA-Z0-9-]/g, "_");
  return path.join(LOCK_DIR, `${safe}.lock`);
}

async function acquireSessionLock(sessionId: string, ctx: string): Promise<() => Promise<void>> {
  await ensureLockDir();
  const lockPath = lockFileFor(sessionId);
  const waitStart = Date.now();
  const maxWaitMs = 5 * 60 * 1000;
  const pollMs = 200;

  for (;;) {
    try {
      // O_EXCL — fails if file exists. Atomic on POSIX.
      const fh = await fs.open(lockPath, "wx");
      await fh.writeFile(String(process.pid));
      await fh.close();
      const waitedMs = Date.now() - waitStart;
      if (waitedMs > 0) {
        await appendTracker(
          `[${iso()}] MUTEX_ACQUIRED | ${ctx} | session=${sessionId} | waited=${waitedMs}ms`,
          { event: "mutex_acquired", ctx, session_id: sessionId, wait_ms: waitedMs },
        );
      }
      return async () => {
        try {
          await fs.unlink(lockPath);
        } catch {
          // Best-effort release.
        }
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw err;
      }
      // Check for stale lock (owner process died).
      try {
        const pidStr = await fs.readFile(lockPath, "utf8");
        const pid = Number(pidStr);
        if (Number.isFinite(pid) && pid > 0) {
          try {
            // Signal 0 just checks if the process exists.
            process.kill(pid, 0);
            // Process is alive — keep waiting.
          } catch {
            // Process is gone — stale lock. Remove and retry.
            await fs.unlink(lockPath).catch(() => {});
            await appendTracker(
              `[${iso()}] MUTEX_STALE_CLEARED | ${ctx} | session=${sessionId} | dead_pid=${pid}`,
              { event: "mutex_stale_cleared", ctx, session_id: sessionId, dead_pid: pid },
            );
            continue;
          }
        }
      } catch {
        // Lock file might have been released between our check and read. Retry.
      }

      if (Date.now() - waitStart > maxWaitMs) {
        await appendTracker(
          `[${iso()}] MUTEX_TIMEOUT | ${ctx} | session=${sessionId} | waited=${Date.now() - waitStart}ms`,
          {
            event: "mutex_timeout",
            ctx,
            session_id: sessionId,
            wait_ms: Date.now() - waitStart,
          },
        );
        throw new Error(`claudep mutex timeout for session ${sessionId}`);
      }

      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}

// ---------------------------------------------------------------------------
// Session file size detection (for rollover)
// ---------------------------------------------------------------------------

async function resolveClaudeSessionFileSize(sessionId: string): Promise<number | undefined> {
  // Claude Code stores session transcripts under ~/.claude/projects/<hash>/.
  // The hash depends on the cwd used when the session was created. We don't
  // know the hash ahead of time — instead, grep all project directories for
  // a file matching the session UUID.
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  try {
    const projectDirs = await fs.readdir(projectsDir);
    for (const dir of projectDirs) {
      const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
      try {
        const stat = await fs.stat(candidate);
        return stat.size;
      } catch {
        // File not in this project dir — continue.
      }
    }
  } catch {
    // Projects dir missing or unreadable — we'll rely on turn count only.
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Session-aware runner (main chat)
// ---------------------------------------------------------------------------

type SessionState = {
  /** Current Claude Code session UUID. */
  sessionId: string;
  /** True once the first message has been dispatched for this UUID. */
  initialized: boolean;
  /** Number of turns taken in this session since it was created/rolled over. */
  turnCount: number;
};

export type RunClaudepPWithSessionParams = {
  /** Human-readable identifier (e.g., "main:nick-telegram") — only used for logging. */
  context: string;
  /** The user's message. */
  prompt: string;
  /** Current session state. On first call, generate a new UUID and pass { initialized:false, turnCount:0 }. */
  state: SessionState;
  /** Called whenever state should be persisted (new session ID, turn counter update, etc.) */
  onStateUpdate: (state: SessionState) => Promise<void> | void;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  workingDir?: string;
};

export async function runClaudepPWithSession(
  params: RunClaudepPWithSessionParams,
): Promise<ClaudepRunWithSessionResult> {
  const release = await acquireSessionLock(params.state.sessionId, params.context);
  try {
    return await runClaudepPWithSessionLocked(params);
  } finally {
    await release();
  }
}

async function runClaudepPWithSessionLocked(
  params: RunClaudepPWithSessionParams,
): Promise<ClaudepRunWithSessionResult> {
  // --- Rollover check -----------------------------------------------------
  let rolledOver = false;
  let previousSessionId: string | undefined;

  if (params.state.initialized && shouldRollover(params.state)) {
    // Check actual file size as a secondary gate (turn count can lie if turns are short).
    const fileSize = await resolveClaudeSessionFileSize(params.state.sessionId);
    const triggerFile = fileSize !== undefined && fileSize >= ROLLOVER_FILE_SIZE_LIMIT;
    const triggerTurns = params.state.turnCount >= ROLLOVER_TURN_LIMIT;
    if (triggerFile || triggerTurns) {
      await appendTracker(
        `[${iso()}] ROLLOVER_START | ${params.context} | session=${params.state.sessionId} | turns=${params.state.turnCount} | file_size=${fileSize ?? "unknown"}`,
        {
          event: "rollover_start",
          ctx: params.context,
          session_id: params.state.sessionId,
          turns: params.state.turnCount,
          file_size_bytes: fileSize,
          trigger: triggerFile ? "file_size" : "turn_count",
        },
      );
      try {
        await runRolloverSummarization(params);
        previousSessionId = params.state.sessionId;
        params.state.sessionId = crypto.randomUUID();
        params.state.initialized = false;
        params.state.turnCount = 0;
        await params.onStateUpdate(params.state);
        rolledOver = true;
        await appendTracker(
          `[${iso()}] ROLLOVER_DONE | ${params.context} | old=${previousSessionId} | new=${params.state.sessionId}`,
          {
            event: "rollover_done",
            ctx: params.context,
            previous_session_id: previousSessionId,
            new_session_id: params.state.sessionId,
          },
        );
      } catch (err) {
        // Rollover summarization failed — log and continue on the old session.
        // Better to degrade than break the live chat.
        const msg = err instanceof Error ? err.message : String(err);
        await appendTracker(
          `[${iso()}] ROLLOVER_FAILED | ${params.context} | session=${params.state.sessionId} | error=${msg}`,
          {
            event: "rollover_failed",
            ctx: params.context,
            session_id: params.state.sessionId,
            error: msg,
          },
        );
      }
    }
  }

  // --- Execute the turn ---------------------------------------------------
  const startedAt = Date.now();
  const mode: "resume" | "new" = params.state.initialized ? "resume" : "new";
  await appendTracker(
    `[${iso()}] START | ${params.context} | session=${params.state.sessionId} | mode=${mode} | turn=${params.state.turnCount + 1} | prompt=${summarize(params.prompt)}`,
    {
      event: "start",
      ctx: params.context,
      session_id: params.state.sessionId,
      mode,
      turn: params.state.turnCount + 1,
      prompt_chars: params.prompt.length,
      prompt_preview: truncate(params.prompt, 500),
      rolled_over: rolledOver,
    },
  );

  const result = await runSessionedProcess(params, mode, startedAt);

  // --- Fallback on initial failure ----------------------------------------
  // If we tried to resume and Claude Code rejected it (session missing or
  // corrupted), retry as a new session. If the new-session attempt also
  // fails, bubble up.
  if (result.status === "error" && mode === "resume") {
    const maybeMissing =
      /session.*not found/i.test(result.error ?? "") ||
      /no such session/i.test(result.error ?? "") ||
      /unknown session/i.test(result.error ?? "");
    if (maybeMissing) {
      await appendTracker(
        `[${iso()}] FALLBACK_RESUME_TO_NEW | ${params.context} | session=${params.state.sessionId}`,
        {
          event: "fallback_resume_to_new",
          ctx: params.context,
          session_id: params.state.sessionId,
        },
      );
      // Treat the session as uninitialized and retry with --session-id.
      params.state.initialized = false;
      await params.onStateUpdate(params.state);
      const retryStartedAt = Date.now();
      const retry = await runSessionedProcess(params, "new", retryStartedAt);
      if (retry.status === "ok") {
        params.state.initialized = true;
        params.state.turnCount += 1;
        await params.onStateUpdate(params.state);
        return {
          ...retry,
          sessionId: params.state.sessionId,
          rolledOver,
          previousSessionId,
          turnNumber: params.state.turnCount,
          mode: "new",
          fallback: true,
        };
      }
      return {
        ...retry,
        sessionId: params.state.sessionId,
        rolledOver,
        previousSessionId,
        turnNumber: params.state.turnCount,
        mode: "new",
        fallback: true,
      };
    }
  }

  // --- Record success/failure in state ------------------------------------
  if (result.status === "ok") {
    params.state.initialized = true;
    params.state.turnCount += 1;
    await params.onStateUpdate(params.state);
  }

  return {
    ...result,
    sessionId: params.state.sessionId,
    rolledOver,
    previousSessionId,
    turnNumber: params.state.turnCount,
    mode,
  };
}

function shouldRollover(state: SessionState): boolean {
  return state.initialized && state.turnCount >= ROLLOVER_TURN_LIMIT;
}

async function runRolloverSummarization(
  params: RunClaudepPWithSessionParams,
): Promise<void> {
  const summarizationPrompt = [
    "IMPORTANT SYSTEM MESSAGE: This session is about to be rolled over because it has grown large enough that Anthropic's Claude Code may start silently compacting or losing context.",
    "",
    "Before we roll over, please update your chat anchor file at ~/clawd/philippe/chat-anchor.md.",
    "Append a new section under '## Rolled-Over Session Summaries' with today's date.",
    "",
    "In that section, preserve:",
    "- Key facts Nick shared about himself, his life, or current work since the last rollover",
    "- Ongoing threads, unresolved questions, or active projects",
    "- Running jokes, callbacks, or emotional texture we've built up",
    "- Any decisions or commitments made",
    "- The current state of our collaborative dynamic",
    "",
    "Use the Edit tool to append this to chat-anchor.md (do NOT overwrite the existing content — append).",
    "",
    "Keep the summary concise but rich enough that a future-you reading only the anchor file understands our context.",
    "",
    "When done, reply with exactly 'Anchor updated.' and nothing else.",
  ].join("\n");

  const summaryResult = await runSessionedProcess(
    {
      ...params,
      prompt: summarizationPrompt,
    },
    "resume",
    Date.now(),
  );

  if (summaryResult.status !== "ok") {
    throw new Error(`summarization run failed: ${summaryResult.error ?? "unknown"}`);
  }
}

async function runSessionedProcess(
  params: RunClaudepPWithSessionParams,
  mode: "resume" | "new",
  startedAt: number,
): Promise<ClaudepRunResult> {
  return new Promise<ClaudepRunResult>((resolve) => {
    const child = spawn(
      "bash",
      [CLAUDEP_SESSION_SCRIPT, params.state.sessionId, mode, params.prompt],
      {
        cwd: params.workingDir || os.homedir(),
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

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

    const timeoutMs = params.timeoutMs ?? 10 * 60 * 1000;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      const duration = Date.now() - startedAt;
      void appendTracker(
        `[${iso()}] TIMEOUT | ${params.context} | session=${params.state.sessionId} | ${duration}ms`,
        {
          event: "timeout",
          ctx: params.context,
          session_id: params.state.sessionId,
          duration_ms: duration,
        },
      );
      settle({
        status: "timeout",
        output: stdout.trim(),
        error: "timed out",
        durationMs: duration,
      });
    }, timeoutMs);

    if (params.abortSignal) {
      const onAbort = () => {
        child.kill("SIGTERM");
        const duration = Date.now() - startedAt;
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
        `[${iso()}] SPAWN_ERROR | ${params.context} | session=${params.state.sessionId} | ${duration}ms | ${err.message}`,
        {
          event: "spawn_error",
          ctx: params.context,
          session_id: params.state.sessionId,
          duration_ms: duration,
          error: err.message,
        },
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
          `[${iso()}] OK | ${params.context} | session=${params.state.sessionId} | ${duration}ms | output=${summarize(stdout.trim())}`,
          {
            event: "ok",
            ctx: params.context,
            session_id: params.state.sessionId,
            duration_ms: duration,
            output_chars: stdout.trim().length,
            output_preview: truncate(stdout.trim(), 500),
            exit_code: code,
          },
        );
        settle({ status: "ok", output: stdout.trim(), durationMs: duration, exitCode: code });
      } else {
        void appendTracker(
          `[${iso()}] ERROR | ${params.context} | session=${params.state.sessionId} | ${duration}ms | exit=${code} | stderr=${summarize(stderr)}`,
          {
            event: "error",
            ctx: params.context,
            session_id: params.state.sessionId,
            duration_ms: duration,
            exit_code: code,
            stderr_preview: truncate(stderr, 1000),
          },
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

// ---------------------------------------------------------------------------
// Helper: build a fresh session state for first-time use.
// ---------------------------------------------------------------------------

export function newSessionState(): SessionState {
  return {
    sessionId: crypto.randomUUID(),
    initialized: false,
    turnCount: 0,
  };
}
