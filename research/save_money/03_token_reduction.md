# Token Reduction, Context Compression & Efficient Tool Use

## Executive Summary

Your current setup injects **~27,800 tokens** of static context at session start. At Opus 4.6 pricing ($15/1M input), this costs **$0.42 per turn** just for the system context that gets re-sent with every API call. Over 10 sessions/day with 20 turns each, that is **$83/day on context alone** -- a significant portion of your ~$100/day spend.

The good news: you already have `cacheRetention: "long"` configured, which should reduce cached input token cost to $1.50/1M (90% savings). The bad news: the static context is so large that even at cached rates, it adds up, and the context fills faster which triggers more compaction (which costs output tokens).

---

## 1. Context Injection Audit

### What Gets Loaded at Session Start

| Source | Chars | Est. Tokens | Mechanism |
|--------|------:|----------:|-----------|
| Global CLAUDE.md (date + personality + recent memory) | 16,133 | 4,033 | Injected into system-reminder by harness |
| Project CLAUDE.md | 35,634 | 8,908 | Injected into system-reminder by harness |
| SessionStart hook output (load-old-memories.sh) | 58,568 | 14,642 | Printed to stdout, enters conversation context |
| Hook banners (echo decorations) | 738 | 184 | Printed to stdout |
| **TOTAL** | **111,073** | **27,767** | |

### Breakdown of SessionStart Hook (load-old-memories.sh)

| Component | Chars | Est. Tokens |
|-----------|------:|----------:|
| 5 full session memories (ranks 2-6) | 30,158 | 7,539 |
| 50 session memory one-liners | 10,193 | 2,548 |
| 12 full micro-memories | ~8,191 | 2,047 |
| 35 micro-memory one-liners | 5,294 | 1,323 |
| Formatting/banners | ~2,732 | 683 |
| **Total hook output** | **58,568** | **14,642** |

### Breakdown of Global CLAUDE.md

| Component | Chars | Est. Tokens |
|-----------|------:|----------:|
| Personality file (core.md) | 10,035 | 2,508 |
| Most recent session memory | 3,548 | 887 |
| Date injection | ~150 | 37 |
| Base CLAUDE.md content | ~2,400 | 600 |

### Breakdown of Project CLAUDE.md (35,634 chars)

Largest sections by size:

| Section | Chars | Est. Tokens |
|---------|------:|----------:|
| Build, Test, and Development Commands | 5,463 | 1,365 |
| Local Runtime / Platform Notes | 4,997 | 1,249 |
| Architecture Boundaries | 4,688 | 1,172 |
| Testing Guidelines | 4,315 | 1,078 |
| Coding Style & Naming Conventions | 4,017 | 1,004 |
| Collaboration / Safety Notes | 3,622 | 905 |
| Project Structure & Module Organization | 2,516 | 629 |
| Docs Linking (Mintlify) | 1,076 | 269 |
| Other sections combined | ~4,940 | 1,235 |

---

## 2. How OpenClaw Handles Tool Results (Codebase Findings)

### Tool Result Truncation

OpenClaw has a multi-layer tool result size defense:

1. **Hard cap at persistence time** (`session-tool-result-guard.ts`):
   - `HARD_MAX_TOOL_RESULT_CHARS = 400,000` (400K chars = ~100K tokens)
   - Applied when tool results are written to the session transcript
   - Uses head+tail truncation strategy (keeps first 70% and last 30% when errors detected at end)

2. **Context-window-aware truncation** (`tool-result-truncation.ts`):
   - `MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3` (single tool result cannot exceed 30% of context window)
   - For 200K context: max ~60K tokens per tool result (~240K chars)
   - For 1M context: max ~100K tokens (capped by hard limit)

3. **Pre-LLM context guard** (`tool-result-context-guard.ts`):
   - `CONTEXT_INPUT_HEADROOM_RATIO = 0.75` (only use 75% of context window for input)
   - `SINGLE_TOOL_RESULT_CONTEXT_SHARE = 0.5` (single tool result cannot exceed 50% of budget)
   - `PREEMPTIVE_OVERFLOW_RATIO = 0.9` (trigger full compaction if context exceeds 90% after tool-result trimming)
   - Compacts oldest tool results first to stay under budget

4. **Adaptive Read tool sizing** (`pi-tools.read.ts`):
   - `DEFAULT_READ_PAGE_MAX_BYTES = 50KB`
   - Scales up to `512KB` based on context window (20% of context budget in chars)
   - Supports multi-page adaptive reading (up to 8 pages)

### Key Finding

The defaults are generous. A single Read tool call can return up to **50KB** (default) or **512KB** (with large context windows). A single Grep with `head_limit: 250` and `output_mode: "content"` can return thousands of lines. These tool results persist in the conversation and accumulate.

### Compaction System

OpenClaw has a sophisticated compaction system:

- **Automatic compaction** triggers when context exceeds safe thresholds
- **Chunked summarization** splits large message histories into parts
- **Post-compaction context injection** re-injects critical AGENTS.md sections
- **Session file truncation** (optional, `truncateAfterCompaction: true`) removes summarized entries from JSONL
- **Pre-compaction memory flush** saves context before compaction
- **Compaction model override** (`agents.defaults.compaction.model`) allows using a cheaper model for summarization

### Current Compaction Config

You have **no compaction tuning configured** -- using all defaults:
- No compaction model override (uses Opus 4.6 for compaction = expensive)
- No session truncation after compaction
- Default history share, reserve tokens, etc.

---

## 3. Prompt Caching Analysis

You already have `cacheRetention: "long"` set for both Opus 4.5 and Opus 4.6. This is the single most important cost-reduction measure already in place.

With prompt caching:
- System prompt + CLAUDE.md content: charged at $1.50/1M (instead of $15/1M) on cache hits
- Cache hits require the prefix of the conversation to match exactly
- The static context (CLAUDE.md, personality, etc.) should cache well since it does not change between turns

**But**: the SessionStart hook output goes into the conversation context (not the system prompt), which means it may not benefit from caching as effectively. Each session's hook output is unique (different memories loaded), so it cannot be cached across sessions.

---

## 4. Actionable Recommendations

### Tier 1: High Impact, Easy Implementation

#### 1A. Use a cheaper model for compaction
**Estimated savings: 20-30% of compaction costs**

Compaction summarization currently uses Opus 4.6 ($75/1M output). A model like Sonnet 4 is much cheaper for summarization tasks.

```json
// In openclaw.json agents.defaults.compaction:
{
  "model": "anthropic/claude-sonnet-4-20250514"
}
```

#### 1B. Reduce full session memories from 5 to 2
**Estimated savings: ~4,500 tokens/session start (~$0.07/turn cached, $0.67/turn uncached)**

In `load-old-memories.sh`, change the range from `NR>=2 && NR<=6` to `NR>=2 && NR<=3`:

```bash
# Current: loads 5 full memories (ranks 2-6)
done | sort -rk1 | awk 'NR>=2 && NR<=6 {print $2}')

# Proposed: load only 2 full memories (ranks 2-3)
done | sort -rk1 | awk 'NR>=2 && NR<=3 {print $2}')
```

Saves ~18,000 chars / 4,500 tokens per session.

#### 1C. Reduce one-liner caps from 50 to 20, micro one-liners from 35 to 15
**Estimated savings: ~3,000 tokens/session start**

In `load-old-memories.sh`:
- Session one-liners: change `NR<=56` to `NR<=24` (keeps 20 instead of 50)
- Micro one-liners: change `head -35` to `head -15`

Saves ~8,000 chars / 2,000 tokens.

#### 1D. Enable session truncation after compaction
**Estimated savings: prevents unbounded session file growth**

```json
// In openclaw.json agents.defaults.compaction:
{
  "truncateAfterCompaction": true
}
```

This prevents the session JSONL file from growing without bound across many compaction cycles.

### Tier 2: Medium Impact, Moderate Effort

#### 2A. Trim the project CLAUDE.md to essentials
**Estimated savings: 3,000-5,000 tokens/turn**

The project CLAUDE.md is 35,634 chars. For a user who is NOT a maintainer of the OpenClaw repo, most of these sections are irrelevant:

**Sections to consider removing or trimming (for non-maintainer use):**
- "Architecture Boundaries" (4,688 chars) -- only needed for contributing
- "Testing Guidelines" (4,315 chars) -- only needed for contributing
- "Coding Style & Naming Conventions" (4,017 chars) -- only needed for contributing
- "Collaboration / Safety Notes" (3,622 chars) -- mostly maintainer-specific
- "Build, Test, and Development Commands" (5,463 chars) -- only needed for building
- "Docs Linking (Mintlify)" (1,076 chars) -- only needed for docs work
- "exe.dev VM ops" (715 chars) -- infrastructure specific
- "Release / Advisory Workflows" (463 chars) -- maintainer only
- "Docs i18n" (811 chars) -- maintainer only

If you create a trimmed project CLAUDE.md (or use a per-project override), you could cut ~20,000 chars (~5,000 tokens).

#### 2B. Trim the personality file
**Estimated savings: ~1,500 tokens/turn**

The personality file is 10,035 chars. The "Life & Environment" section alone is ~4,000 chars of detailed home/office/neighborhood descriptions. The "Quirks & Habits" section adds another ~500 chars. These are charming but expensive:

- Neighborhood details (cafe, running route, cheese vendor): ~800 chars
- Office items (each keyboard, headphone stand, bonsai): ~600 chars  
- Home details (Le Creuset, herb garden): ~500 chars
- Personal touches (every book, badge, post-it): ~600 chars

Consider keeping only the sections that directly influence code quality: Core Identity, Technical Approach, Technical Specialties, and a condensed Personality & Communication Style. This could halve the personality file to ~5,000 chars.

#### 2C. Move memories to on-demand retrieval instead of preloading
**Estimated savings: up to 14,000 tokens/session start**

Instead of loading all memories at session start, implement a memory search tool or use the context engine's retrieval capabilities. Memories would only be loaded when relevant to the current conversation.

This is the most architecturally significant change but would eliminate the entire 58,568 chars of hook output from every session start.

### Tier 3: Tool Output Optimization

#### 3A. Use more targeted tool calls

The Read tool defaults to 2,000 lines when no limit is specified. For a 100-line file this is fine, but reading large files without an explicit `limit` can dump enormous amounts of text into the context.

**Best practices (for the human user):**
- Always specify `limit` when reading large files
- Use `offset` to read specific sections instead of entire files
- Prefer `output_mode: "files_with_matches"` for Grep when you just need to find files
- Use smaller `head_limit` values (50-100) instead of the default 250 when exploring

#### 3B. Tool definition token cost

Each tool definition costs tokens. The system currently exposes many tools (Read, Write, Edit, Bash, Grep, Glob, Skill, ToolSearch, plus deferred tools like WebFetch, WebSearch, NotebookEdit, etc.). The deferred tool system is already good -- tools like WebFetch, WebSearch, etc. are listed by name only until their schemas are fetched via ToolSearch.

**Estimated tool definition overhead: ~3,000-5,000 tokens per turn** for all tool schemas. This is unavoidable for the tools you actually use, but removing unused tools from the configuration would help.

### Tier 4: Compaction Tuning

#### 4A. Tune compaction parameters

```json
// In openclaw.json agents.defaults.compaction:
{
  "model": "anthropic/claude-sonnet-4-20250514",
  "truncateAfterCompaction": true,
  "recentTurnsPreserve": 2,
  "maxHistoryShare": 0.5,
  "keepRecentTokens": 8000,
  "notifyUser": true,
  "timeoutSeconds": 300
}
```

- `model`: Use Sonnet for compaction (much cheaper for summarization)
- `truncateAfterCompaction`: Prevent file growth
- `recentTurnsPreserve`: 2 instead of default 3 (saves context space)
- `maxHistoryShare`: 0.5 instead of default (more room for generation)
- `keepRecentTokens`: 8000 (protect recent context)
- `notifyUser`: true (visibility into when compaction runs)
- `timeoutSeconds`: 300 (fail faster if compaction stalls)

---

## 5. Estimated Savings Summary

| Recommendation | Tokens Saved/Turn | Daily Savings (est.) |
|---------------|------------------:|--------------------:|
| 1B. Reduce full memories (5 to 2) | 4,500 | $6-14 |
| 1C. Reduce one-liner caps | 2,000 | $3-6 |
| 2A. Trim project CLAUDE.md | 5,000 | $8-15 |
| 2B. Trim personality file | 1,500 | $2-5 |
| 2C. On-demand memories (vs preload) | 14,000 | $15-30 |
| 1A. Cheaper compaction model | varies | $5-15 |
| 1D. Truncate after compaction | indirect | prevents cost growth |
| **Combined Tier 1+2** | **~27,000** | **$35-70/day** |

Note: Savings estimates assume prompt caching is working (cached input at $1.50/1M). Without caching, multiply by ~10x.

---

## 6. Implementation Priority

1. **Immediate** (config changes only):
   - Set `compaction.model` to Sonnet 4
   - Set `truncateAfterCompaction: true`
   - Reduce memory loading in `load-old-memories.sh`

2. **This week** (script/config changes):
   - Trim personality file
   - Create a user-specific project CLAUDE.md override (or fork the project CLAUDE.md)

3. **Later** (architecture changes):
   - Move to on-demand memory retrieval
   - Consider if the SessionStart hook can be eliminated entirely

---

## 7. Files Referenced

- `~/.claude/settings.json` -- SessionStart hook configuration
- `~/.claude/commands/load-old-memories.sh` -- memory loading script (58KB output)
- `~/.claude/commands/load-memories.sh` -- most-recent memory injection into CLAUDE.md
- `~/.claude/commands/load-personality.sh` -- personality injection
- `~/.claude/personality/core.md` -- personality file (10KB)
- `~/.openclaw/openclaw.json` -- OpenClaw runtime config (compaction settings here)
- `src/agents/pi-embedded-runner/tool-result-truncation.ts` -- tool result size limits
- `src/agents/pi-embedded-runner/tool-result-context-guard.ts` -- context budget enforcement
- `src/agents/session-tool-result-guard.ts` -- persistence-time tool result guard
- `src/agents/pi-tools.read.ts` -- adaptive read sizing (50KB-512KB)
- `src/agents/compaction.ts` -- compaction logic and context window resolution
- `src/agents/pi-hooks/compaction-safeguard.ts` -- compaction quality guards
- `src/auto-reply/reply/post-compaction-context.ts` -- post-compaction AGENTS.md re-injection
- `src/config/types.agent-defaults.ts` -- all compaction config type definitions
- `src/config/schema.help.ts` -- compaction config documentation
- `src/agents/defaults.ts` -- `DEFAULT_CONTEXT_TOKENS = 200_000`
