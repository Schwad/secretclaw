# Prompt Caching & Context Window Management

Research date: 2026-04-12
Goal: Reduce ~GBP100/day Claude API spend via prompt caching optimization.

---

## 1. How Anthropic Prompt Caching Works

### The Mechanism

Anthropic's prompt caching works on **prefix matching**. The API caches contiguous
prefixes of the input — system prompt, then messages — and on subsequent requests,
if the prefix matches an existing cache entry, those tokens are served from cache
at a 90% discount.

Key rules:
- **Prefix-only**: Caching works from the start of the system prompt forward. If
  byte 5001 changes, everything from byte 5001 onward is a cache miss — even if
  bytes 5002-50000 are identical to the previous request.
- **Minimum cacheable length**: 1024 tokens (roughly 4KB of text) for the prefix
  to be eligible for caching.
- **Cache breakpoints**: You mark where cache boundaries live using
  `cache_control: { type: "ephemeral" }` on content blocks. Anthropic caches up
  to 4 breakpoints per request.
- **TTL**: "ephemeral" = 5-minute TTL. Each cache hit resets the 5-minute timer.
  "long" = 1 hour (Anthropic direct API only).
- **Pricing** (Claude Opus 4.6 / 1M context):
  - Input tokens (uncached): $15 / 1M tokens
  - Cache write: $18.75 / 1M tokens (25% surcharge on first write)
  - Cache read (hit): $1.50 / 1M tokens (90% discount)
  - Output tokens: $75 / 1M tokens

### The Math That Matters

For a 27K-token system prompt + context:
- **Uncached**: 27,000 * ($15/1M) = $0.405 per turn
- **Cache write (first)**: 27,000 * ($18.75/1M) = $0.506
- **Cache hit**: 27,000 * ($1.50/1M) = $0.041 per turn

That is a **~10x cost reduction per turn** on input tokens when cache hits.

At ~100 turns/day with Opus 4.6, cached input alone saves:
- Uncached: $40.50/day just on input context
- Cached: $4.10/day on input context
- **Savings: ~$36/day or ~GBP28/day**

---

## 2. How OpenClaw Currently Handles Prompt Caching

### Cache retention defaults

In `src/agents/pi-embedded-runner/anthropic-cache-retention.ts`:

```typescript
// For direct Anthropic provider, defaults to "short" (5-min TTL)
return isAnthropicDirect ? "short" : undefined;
```

This means **caching IS enabled by default** for the Anthropic provider. Good.

### Where cache_control breakpoints are placed

The upstream `pi-ai` library (`node_modules/@mariozechner/pi-ai/dist/providers/anthropic.js`)
places `cache_control` at exactly **two breakpoints**:

1. **System prompt**: The entire system prompt gets a single `cache_control: { type: "ephemeral" }`
   on the last text block of the `system` array.

2. **Last user message**: The last content block of the final user message gets
   `cache_control`, which caches the full conversation history prefix.

This is the standard 2-breakpoint strategy:
- Breakpoint 1: System prompt (stable across turns, cache hit rate should be ~100%)
- Breakpoint 2: Conversation history up to the current turn (only the new message
  is uncached)

### Context pruning (cache-ttl mode)

OpenClaw has a `cache-ttl` context pruning mode (`src/agents/pi-hooks/context-pruning/`)
that delays aggressive context pruning while the cache is still warm. This is smart —
it avoids invalidating a cached prefix by pruning messages that were part of it.

### Cache trace diagnostics

`src/agents/cache-trace.ts` provides optional JSONL tracing of what goes into each
API call (system prompt digest, message fingerprints). Enable with
`OPENCLAW_CACHE_TRACE=1` to verify cache behavior.

---

## 3. The Current Problem: Your System Prompt Structure

### What gets assembled per turn

Your setup injects context at **three layers**, all landing in the system prompt:

| Layer | Source | Size | How injected |
|-------|--------|------|-------------|
| Core system prompt | `buildAgentSystemPrompt()` | ~3,500 tokens | Built by OpenClaw at runtime |
| Project CLAUDE.md | `/Users/nickschwaderer/Progrumms/clawdbot/CLAUDE.md` | ~8,900 tokens (35KB) | Loaded as bootstrap context file, injected in `# Project Context` |
| Global CLAUDE.md | `~/.claude/CLAUDE.md` | ~4,000 tokens (16KB) | Loaded as bootstrap context file, injected in `# Project Context` |
| SessionStart hook output | `load-old-memories.sh` | ~14,600 tokens (58KB) | Goes into conversation as first user-ish turn, NOT system prompt |
| **Total system prompt** | | **~16,400+ tokens** | |
| **Total first-turn context** | | **~27,500+ tokens** | |

### The global CLAUDE.md breakdown

Your `~/.claude/CLAUDE.md` (16KB) contains three dynamically-injected sections plus
a small static core:

| Section | Size | Stability |
|---------|------|-----------|
| Session date (`### === SESSION DATE ===`) | 105 bytes | **Changes every session** (timestamp) |
| Core global instructions | 2,158 bytes | Static |
| Personality (`### === PERSONALITY MODE START ===`) | 10,183 bytes | Static within session, changes rarely |
| Memories (`### === MEMORIES MODE START ===`) | 3,687 bytes | **Changes every session** |

### How `claudep` assembles this

When you run `claudep`, these shell scripts execute sequentially:

1. `load.sh` — git sync, then **prepends today's date** to `~/.claude/CLAUDE.md`
2. `load-personality.sh` — **appends** `~/.claude/personality/core.md` to `~/.claude/CLAUDE.md`
3. `load-memories.sh` — **appends** most recent session memory to `~/.claude/CLAUDE.md`
4. `claude --dangerously-skip-permissions` — starts Claude Code

Then at session start, the `SessionStart` hook runs `load-old-memories.sh`, whose
~58KB stdout goes into the conversation context.

### The cache-busting problem

Here is the critical issue: **the session date is PREPENDED to CLAUDE.md**.

The `load.sh` script does:
```bash
# Prepend date to CLAUDE.md
TEMP_FILE=$(mktemp)
cat > "$TEMP_FILE" << EOF
$DATE_MARKER
Today is $TODAY_FORMATTED
$DATE_END_MARKER
EOF
cat "$CLAUDE_MD" >> "$TEMP_FILE"
mv "$TEMP_FILE" "$CLAUDE_MD"
```

This means the CLAUDE.md content starts with a **dynamic timestamp** that changes
every session. But because Anthropic caching is **prefix-based**, this timestamp
at the very start of the global CLAUDE.md will NOT bust the system prompt cache,
because the global CLAUDE.md is loaded as a **context file** which appears inside
`# Project Context` — which comes AFTER the core system prompt.

However, there is still an ordering concern. Let me trace exactly how context files
are ordered.

### Context file ordering

Bootstrap files are loaded by `loadWorkspaceBootstrapFiles()` in
`src/agents/workspace.ts`. The file loading order is deterministic:
1. AGENTS.md (or CLAUDE.md symlink)
2. TOOLS.md
3. SOUL.md
4. IDENTITY.md
5. USER.md
6. MEMORY.md
7. BOOTSTRAP.md
8. Extra bootstrap files from config

The global `~/.claude/CLAUDE.md` is loaded separately and injected as a context
file alongside project files. The ordering in the system prompt `# Project Context`
section is:

```
# Project Context
## <file1.path>
<file1.content>

## <file2.path>
<file2.content>
...
```

**The global CLAUDE.md (with its dynamic date/personality/memories) comes as one
of these context files.** The exact ordering depends on how the bootstrap resolver
merges global vs project files, but the key finding is:

**If the global CLAUDE.md changes between sessions (which it always does — date
and memories change), the cache breakpoint on the system prompt will bust because
the content of the system prompt text block changes.**

---

## 4. The Real Cache Busters

### Cache buster #1: Session date in global CLAUDE.md (MEDIUM impact)

The date string (`Today is Sunday, April 12th, 2026 at 11:31 am`) changes on
every session start. It is prepended to `~/.claude/CLAUDE.md` which becomes part
of the system prompt.

**Impact**: Cache misses on the first turn of every new session. But within a
session, this is stable.

### Cache buster #2: Session memories in global CLAUDE.md (MEDIUM impact)

The `MEMORIES MODE` section changes every session (different memory file loaded).

**Impact**: Same as above — cache miss on session boundaries, stable within session.

### Cache buster #3: SessionStart hook output (LOW impact on system prompt)

The `load-old-memories.sh` output (~58KB) goes to **stdout of the hook**, which
OpenClaw captures. This becomes part of the conversation context but NOT part of
the system prompt. So it does NOT bust the system prompt cache.

However, it does affect the **conversation history cache breakpoint** (breakpoint 2
on the last user message). Since this large blob is injected as a first message,
it is cached on the first turn and stays cached as the conversation progresses.

### Cache buster #4: Tool list changes (RARE)

The system prompt includes tool definitions. These only change if tools are
added/removed between turns (rare in normal conversation).

### Summary: Within a session, caching is WORKING

The good news: **within a single session, the system prompt is stable across turns**.
OpenClaw explicitly tests for this in `prompt-composition.test.ts`:

```typescript
it("keeps the system prompt stable after warmup for normal user-turn scenarios")
```

The cache busters only fire at session boundaries. Within a session, both the
system prompt breakpoint and the conversation history breakpoint should be hitting
cache consistently.

---

## 5. Strategies to Save Money

### Strategy A: Reduce the size of what gets cached (HIGHEST ROI)

Even with perfect caching, you are still paying for cache read tokens. At 27K
tokens per turn, that is $0.041/turn in cache reads. Cutting the context size
directly reduces both cache-miss costs and cache-hit costs.

#### A1: Trim the personality file (save ~1,500 tokens)

The personality file (`~/.claude/personality/core.md`) is 10KB. It includes
extensive details about home furnishings, neighborhood cafes, and physical
objects that rarely affect code output. Consider a "core" vs "extended"
personality split:

- **Core personality** (~4KB): Identity, communication style, technical approach,
  collaborative dynamics, relationship with Nick
- **Extended personality** (~6KB): Home details, office objects, neighborhood life,
  personal touches — load only when explicitly needed

**Savings**: ~1,500 tokens/turn = $0.023/turn cached, $0.225/turn uncached

#### A2: Trim the project CLAUDE.md (save ~3,000-5,000 tokens)

The OpenClaw project CLAUDE.md is 35KB (~8,900 tokens). It contains extensive
guidance about:
- Plugin architecture boundaries (several KB)
- Docs i18n pipeline details
- VM ops instructions
- Testing guidelines
- Coding style rules
- Release workflows
- Platform-specific notes

For a power user focused on specific work (e.g., your ZAR work, not OpenClaw
maintainership), much of this is irrelevant context. Consider:

- A minimal CLAUDE.md (~15KB) covering just the patterns you use
- Moving deep-dive sections to AGENTS.md files in subdirectories (read on demand)

**Savings**: ~3,000-5,000 tokens/turn = very significant at scale

#### A3: Stop loading old memories into the system prompt (save ~900 tokens)

The `MEMORIES MODE` section adds ~922 tokens of the most recent session memory.
This is already injected into CLAUDE.md and becomes part of every turn's system
prompt. Meanwhile, `load-old-memories.sh` separately loads older memories into the
conversation.

Consider:
- Remove the memory injection into CLAUDE.md (the `load-memories.sh` step)
- Keep only the SessionStart hook for memory context
- Or move memory to a tool-based retrieval pattern (only fetch when relevant)

**Savings**: ~922 tokens/turn on system prompt

#### A4: Make SessionStart hook output leaner (save ~10,000+ tokens)

The `load-old-memories.sh` currently outputs 58KB (~14,600 tokens). After the
April 10 audit, this was reduced from ~100KB but is still large. Current contents:

- 5 full session memories (ranked 2-6 most recent)
- 50 one-liner session summaries
- 12 full micro-memories
- 35 one-liner micro-memories

Consider aggressive trimming:
- 2 full session memories instead of 5 (save ~40%)
- 20 one-liner summaries instead of 50 (save ~30 one-liners)
- 5 full micro-memories instead of 12 (save ~7 entries)
- 15 one-liner micro-memories instead of 35 (save ~20 entries)

**Savings**: ~6,000-8,000 tokens on conversation context. Not directly on system
prompt, but reduces the context size that eats into the 1M window and costs money
at cache-write rates on the first turn.

### Strategy B: Optimize content ordering for cache hits

#### B1: Move static content first in global CLAUDE.md

Currently `load.sh` **prepends** the date to CLAUDE.md. This means the file starts
with dynamic content. While the ordering within `# Project Context` may mitigate
this (project CLAUDE.md might come first), the safest optimization is:

**Change `load.sh` to APPEND the date instead of prepending it.**

Or better: remove the date from CLAUDE.md entirely and let it come through the
`system-reminder` tag (which OpenClaw/Claude Code already handles — the
`# currentDate` section is visible in the system-reminder).

Current order in global CLAUDE.md:
```
[SESSION DATE] (dynamic)        <-- cache buster at top
[core instructions] (static)
[PERSONALITY] (stable)
[MEMORIES] (dynamic)            <-- cache buster at bottom
```

Optimal order:
```
[core instructions] (static)    <-- stable prefix
[PERSONALITY] (stable)          <-- still stable
[SESSION DATE] (dynamic)        <-- moved after stable content
[MEMORIES] (dynamic)            <-- last (or removed entirely)
```

This way, if the content files are ordered with global CLAUDE.md first, the stable
prefix is maximized.

**However**: the reality is that the system prompt cache breakpoint covers the
ENTIRE system prompt as one text block. So reordering within the CLAUDE.md only
matters if we split the system prompt into multiple blocks with separate
`cache_control` breakpoints.

#### B2: Split the system prompt into multiple cached blocks

The current `pi-ai` Anthropic provider creates a single `system` text block with
one `cache_control`. This means the entire system prompt is one cache unit — if
any byte changes, the whole thing is a cache miss.

A more sophisticated approach would split the system prompt into multiple blocks:

```json
{
  "system": [
    {
      "type": "text",
      "text": "<core system prompt - stable across sessions>",
      "cache_control": { "type": "ephemeral" }
    },
    {
      "type": "text",
      "text": "<project CLAUDE.md - stable across sessions>",
      "cache_control": { "type": "ephemeral" }
    },
    {
      "type": "text",
      "text": "<dynamic per-session content - personality, date, memories>"
    }
  ]
}
```

This way, even when the per-session content changes, the first two blocks hit
cache. Anthropic allows up to 4 cache breakpoints per request.

**This requires a change in the pi-ai library** (`providers/anthropic.js`), or a
stream wrapper in OpenClaw that restructures the system payload before it hits the
wire.

#### B3: Use `cacheRetention: "long"` for 1-hour TTL

The default is `"short"` (5-minute ephemeral TTL). For active work sessions,
5 minutes is usually fine. But if you step away for 6 minutes to make tea,
the entire cache is evicted and the next turn pays full price.

Set `cacheRetention: "long"` in your config:

```json
{
  "agents": {
    "defaults": {
      "models": {
        "anthropic/claude-opus-4-6": {
          "params": {
            "cacheRetention": "long"
          }
        }
      }
    }
  }
}
```

This extends the TTL to 1 hour on the Anthropic direct API. At the cost of
slightly more aggressive server-side resource usage, you get much more forgiving
cache lifetimes.

**Cost note**: There may be no additional cost for "long" vs "short" — Anthropic
does not currently charge differently. The `ttl: "1h"` parameter was added in
2025 and is treated as a hint.

### Strategy C: Keep the cache warm

#### C1: Heartbeat / ScheduleWakeup for cache warming

If you have a `cron` tool or `ScheduleWakeup`, you could schedule a lightweight
"keepalive" request every 4 minutes that sends the same system prompt prefix.
This keeps the cache warm even during idle periods.

**However**, this is counterproductive for cost savings — you are paying for
API calls just to keep the cache warm. Only worth it if:
- Your idle periods are typically 5-10 minutes (just over the TTL)
- Each cache-miss re-warm costs significantly more than a keepalive

At 27K tokens, a cache-miss costs $0.506 (cache write) vs a keepalive costing
$0.041 (cache read) + $0.075+ (output for heartbeat ack). Keepalive total: ~$0.12.
So a keepalive pays for itself if you would otherwise miss cache within 4 turns.

**Verdict**: Not worth it at current usage patterns. The "long" TTL (Strategy B3)
is much simpler and cheaper.

### Strategy D: Reduce output token spend (SEPARATE from caching)

Output tokens cost $75/1M for Opus 4.6 — 5x more than input. A single verbose
response of 2,000 tokens costs $0.15. This is where most of the daily spend goes.

Strategies:
- Use `effortLevel: "low"` for routine tasks
- Use Sonnet 4.6 ($3/$15) for simple tasks, Opus only for complex ones
- Configure `textVerbosity` via extra params where available
- Keep personality instructions concise about response length

---

## 6. Cost Calculations

### Current estimated per-turn cost (Opus 4.6, 1M context)

Assumptions: 100 turns/day, average 1,500 output tokens, 27K system/context tokens,
cache hitting ~80% of the time (misses on session start, compaction, new sessions).

| Component | Tokens | Cost/turn (cached) | Cost/turn (uncached) |
|-----------|--------|-------------------|---------------------|
| System prompt (cache hit) | 16,400 | $0.025 | - |
| System prompt (cache miss) | 16,400 | - | $0.308 |
| Conversation history (avg, cached) | 10,000 | $0.015 | - |
| Conversation history (uncached) | 10,000 | - | $0.188 |
| New user message | 500 | $0.008 | $0.008 |
| Output tokens | 1,500 | $0.113 | $0.113 |
| **Turn total (cache hit)** | | **$0.161** | |
| **Turn total (cache miss)** | | | **$0.617** |
| **Daily (80% hit rate)** | | **$17.84** | |

### With optimizations applied

After strategies A1 (trim personality), A3 (remove memories from CLAUDE.md),
B3 (long TTL), and assuming 95% cache hit rate:

| Component | Tokens | Cost/turn (cached) |
|-----------|--------|-------------------|
| System prompt (trimmed) | 13,000 | $0.020 |
| Conversation history | 10,000 | $0.015 |
| New user message | 500 | $0.008 |
| Output tokens | 1,500 | $0.113 |
| **Turn total (cache hit)** | | **$0.156** |
| **Daily (95% hit rate)** | | **$15.83** |

### Savings from optimizations alone

- **GBP 28-36/day saved** from improving cache hit rate (80% -> 95%)
- **GBP 2-5/day saved** from trimming system prompt size
- **Total: GBP 30-41/day savings** (~30-40% reduction)

### The biggest lever: model selection

For comparison, if 50% of turns used Sonnet 4.6 ($3/$15) instead of Opus 4.6 ($15/$75):
- Daily cost drops from ~GBP80 to ~GBP45
- Combined with caching optimizations: ~GBP30/day

---

## 7. Actionable Recommendations (Priority Order)

### P0: Verify caching is actually working (5 minutes)

Run with cache trace enabled to confirm cache hits:

```bash
OPENCLAW_CACHE_TRACE=1 claude
```

Then inspect `~/.openclaw/logs/cache-trace.jsonl` to see if system prompt digests
are stable across turns and if the API response includes `cache_read_input_tokens`.

### P1: Set long cache retention (2 minutes)

Add to your OpenClaw config:

```json
{
  "agents": {
    "defaults": {
      "params": {
        "cacheRetention": "long"
      }
    }
  }
}
```

Expected savings: 5-15% more cache hits (every tea break saved).

### P2: Remove date prepending from load.sh (5 minutes)

The date is already injected by the `system-reminder` tag (visible in your
conversation: `# currentDate`). The prepended date in CLAUDE.md is redundant.
Remove the date injection from `load.sh` entirely — it is already handled by
the harness.

Change in `~/.claude/commands/load.sh`: comment out or remove the entire
"PHASE 2: INJECT TODAY'S DATE" section.

### P3: Remove memory injection from CLAUDE.md (5 minutes)

The `load-memories.sh` step appends ~922 tokens of the latest session memory
to CLAUDE.md. This makes the system prompt different every session. The same
information (plus more) is available through the SessionStart hook output.

Either:
- Remove the `load-memories.sh` call from the `claudep` alias
- Or move this content to a tool-based retrieval pattern

Change in `~/.zshrc`:
```bash
alias claude_with_personality='~/.claude/commands/load.sh && ~/.claude/commands/load-personality.sh && claude --dangerously-skip-permissions'
```

### P4: Trim SessionStart hook output (15 minutes)

In `~/.claude/commands/load-old-memories.sh`, reduce:
- Full session memories: 5 -> 2 (saves ~3,000 tokens)
- One-liner summaries: 50 -> 20 (saves ~1,500 tokens)
- Full micro-memories: 12 -> 5 (saves ~1,000 tokens)
- One-liner micro-memories: 35 -> 15 (saves ~500 tokens)

Total savings: ~6,000 tokens on conversation context.

### P5: Split personality into core/extended (30 minutes)

Create `~/.claude/personality/core-minimal.md` (~4KB) with just the essential
personality traits, and keep the full `core.md` for sessions where the rich
context matters.

### P6: Consider model routing (ongoing)

For routine tasks (file reads, simple edits, git operations), Sonnet 4.6 at
$3/$15 is 5x cheaper than Opus 4.6. OpenClaw supports model aliases — configure
a quick-switch alias.

---

## 8. What NOT to Worry About

1. **The SessionStart hook output**: Although it is 58KB, it does NOT bust the
   system prompt cache. It goes into conversation context, not the system prompt.
   And it is only sent once (first turn), then cached as part of conversation
   history.

2. **System prompt stability within a session**: OpenClaw already ensures this
   with explicit tests. The system prompt does not change between turns in a
   normal session.

3. **Cache breakpoint placement**: The pi-ai library already places breakpoints
   at the two most impactful positions (system prompt and last user message).
   The 4-breakpoint limit is not a bottleneck for most usage patterns.

4. **The 1M context window**: You are using opus[1m]. Even with 27K tokens of
   context per turn, you have 973K tokens of headroom. Context size is a cost
   issue, not a capacity issue.

---

## 9. Advanced: Multi-Block System Prompt Splitting

For maximum cache efficiency across sessions, the system prompt could be split
into multiple `system` blocks with independent cache breakpoints. This is
currently a **pi-ai library change** but could also be done via a stream wrapper.

Proposed structure:

```
system[0]: Core OpenClaw prompt (3,500 tokens) - CACHE_CONTROL
system[1]: Project CLAUDE.md (8,900 tokens) - CACHE_CONTROL  
system[2]: Global CLAUDE.md static parts (2,700 tokens) - CACHE_CONTROL
system[3]: Dynamic per-session (date, memories) (~1,000 tokens) - no cache
```

This way, even on a brand new session with different memories/date, ~15,100 of
~16,400 tokens hit cache (92% of system prompt). The cache-miss cost drops from
$0.308 to $0.024.

**Implementation path**: Create a stream wrapper in
`src/agents/pi-embedded-runner/` that intercepts the Anthropic payload before
it hits the wire and splits the single system text block into multiple blocks
with independent `cache_control` markers. The wrapper would:

1. Parse the system prompt text to identify stable vs dynamic sections
2. Split into N blocks (max 4 cache breakpoints total)
3. Apply `cache_control` to the stable blocks only

This is a medium-effort change (~2-3 hours) but provides the best theoretical
cache efficiency.

---

## Files Referenced

- `src/agents/pi-embedded-runner/anthropic-cache-retention.ts` — Cache retention resolution
- `src/agents/pi-embedded-runner/extra-params.ts` — Stream wrapper composition
- `src/agents/system-prompt.ts` — System prompt assembly
- `src/agents/prompt-composition-scenarios.ts` — Cache stability test scenarios
- `src/agents/prompt-composition.test.ts` — System prompt stability invariants
- `src/agents/cache-trace.ts` — Cache diagnostics
- `src/agents/pi-embedded-runner/cache-ttl.ts` — Cache TTL tracking
- `src/agents/pi-embedded-runner/run/attempt.thread-helpers.ts` — Cache TTL appending
- `src/agents/bootstrap-files.ts` — Bootstrap context file resolution
- `src/agents/workspace.ts` — Workspace file loading
- `src/agents/pi-embedded-helpers/bootstrap.ts` — Bootstrap budget and truncation
- `node_modules/@mariozechner/pi-ai/dist/providers/anthropic.js` — Anthropic provider cache_control placement
- `~/.claude/commands/load.sh` — Session startup (git sync + date injection)
- `~/.claude/commands/load-personality.sh` — Personality injection into CLAUDE.md
- `~/.claude/commands/load-memories.sh` — Memory injection into CLAUDE.md
- `~/.claude/commands/load-old-memories.sh` — SessionStart hook (conversation context)
- `~/.claude/settings.json` — Hook configuration
