# OpenClaw Configuration & API-Level Cost Optimizations

Research date: 2026-04-12
Target: Power user spending ~GBP100/day on Claude Opus 4.6 via OpenClaw

---

## 1. Thinking Level / Reasoning Effort (HIGHEST IMPACT)

### Current State

The user's system shows "reasoning effort level: high". OpenClaw defaults
Anthropic Claude 4.6 models to `adaptive` thinking when no explicit level is
configured. Thinking/reasoning tokens are **output tokens** -- billed at the
full output rate ($15/MTok for Opus 4.6).

### Available Levels

From `src/auto-reply/thinking.shared.ts` and `src/agents/anthropic-vertex-stream.ts`:

```
off       -> thinking disabled entirely
minimal   -> effort: "low"   (Anthropic API)
low       -> effort: "low"
medium    -> effort: "medium"
high      -> effort: "high"
xhigh     -> effort: "max"   (Opus only)
adaptive  -> model decides per-turn (Claude 4.6 default)
```

### Configuration

Set a global default:

```json5
{
  agents: {
    defaults: {
      thinkingDefault: "low",   // or "medium", "off", "adaptive"
    },
  },
}
```

Or per-model:

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {
          params: { thinking: "low" },
        },
      },
    },
  },
}
```

Or per-message using the slash command:

```
/think off
/think low
/think medium
/think high
```

### Estimated Savings

With `high` thinking, Opus can generate 10,000-50,000+ thinking tokens per turn
at $15/MTok output pricing. Switching from `high` to `low`:
- Thinking tokens drop by roughly 60-80%
- If thinking is 40% of your daily token spend, this alone saves 25-30%
- **Estimated: GBP20-35/day savings**

Using `adaptive` (the default) lets the model self-regulate, which is generally
cheaper than always-on `high` but more expensive than forced `low`.

Recommendation: set `thinkingDefault: "low"` globally, then use `/think high`
or `/think medium` per-message when you actually need deep reasoning.

---

## 2. Prompt Caching (HIGH IMPACT)

### How It Works

Anthropic prompt caching reuses unchanged prompt prefixes across turns. Cache
reads are 90% cheaper than regular input tokens. Cache writes cost 25% more
than regular input on first use, but subsequent hits are dramatically cheaper.

From `docs/reference/prompt-caching.md`:

### Configuration

```json5
{
  agents: {
    defaults: {
      params: {
        cacheRetention: "long",  // "none" | "short" | "long"
      },
    },
  },
}
```

- `"short"` -> 5-minute TTL
- `"long"`  -> 1-hour TTL

OpenClaw auto-seeds `cacheRetention: "short"` for Anthropic API-key profiles,
but you should upgrade to `"long"` if your sessions last more than 5 minutes.

### Pair with Heartbeat Keep-Warm

If your cache TTL is 1 hour, set heartbeat just under that to avoid expensive
re-caching after idle gaps:

```json5
{
  agents: {
    defaults: {
      params: { cacheRetention: "long" },
      heartbeat: {
        every: "55m",
        isolatedSession: true,   // avoids full transcript cost
        lightContext: true,      // only loads HEARTBEAT.md
      },
    },
  },
}
```

### Estimated Savings

For a typical session with a 10K-token system prompt repeated across 50 turns:
- Without caching: 500K input tokens = $7.50 (at $15/MTok Opus input)
- With caching: 10K write + 490K cache reads = $1.88 + $0.74 = $2.62
- **Saves ~65% on system prompt costs**
- **Estimated: GBP10-20/day depending on session patterns**

---

## 3. Context Pruning (HIGH IMPACT)

### What It Does

Prunes old tool results (exec outputs, file reads, search results) from the
context window before each LLM call. This is in-memory only -- does not modify
on-disk history. Reduces token count sent to the model on every turn.

From `src/agents/pi-hooks/context-pruning/settings.ts`:

### Configuration

```json5
{
  agents: {
    defaults: {
      contextPruning: {
        mode: "cache-ttl",     // "off" | "cache-ttl"
        ttl: "5m",             // how long before pruning kicks in
        keepLastAssistants: 3, // preserve recent assistant turns
        softTrim: {
          maxChars: 4000,      // max chars kept per trimmed result
          headChars: 1500,     // keep first N chars
          tailChars: 1500,     // keep last N chars
        },
        hardClear: {
          enabled: true,       // fully replace with placeholder after ratio
          placeholder: "[Old tool result content cleared]",
        },
        minPrunableToolChars: 50000, // only prune results > 50K chars
      },
    },
  },
}
```

Note: OpenClaw auto-enables pruning for Anthropic auth profiles, but defaults
may not be aggressive enough. Tuning `softTrim` and `hardClear` more
aggressively for code-heavy sessions can significantly reduce context size.

### Estimated Savings

Tool results in coding sessions can be 30-60% of context. Aggressive pruning:
- Reduces per-turn input tokens by 20-40% in long sessions
- **Estimated: GBP10-25/day savings**

---

## 4. Model Selection & Fallbacks (HIGH IMPACT)

### Use Sonnet for Routine Work

The single biggest lever: not every task needs Opus.

From `src/config/defaults.ts`, Opus is the default model. But Sonnet 4.6 is
roughly 5x cheaper per token and handles most coding tasks comparably.

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-6",
        fallbacks: ["anthropic/claude-opus-4-6"],
      },
      models: {
        "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
        "anthropic/claude-opus-4-6": { alias: "opus" },
      },
    },
  },
}
```

Then use `/model opus` only when you need deep reasoning on complex problems.

### Use Cheaper Models for Subagents

From `src/config/types.agent-defaults.ts`:

```json5
{
  agents: {
    defaults: {
      subagents: {
        model: "anthropic/claude-sonnet-4-6",
        thinking: "low",
        maxConcurrent: 1,
      },
    },
  },
}
```

### Use Cheaper Models for Compaction

From `docs/gateway/configuration-reference.md`:

```json5
{
  agents: {
    defaults: {
      compaction: {
        model: "anthropic/claude-sonnet-4-6",  // cheaper than Opus for summaries
        mode: "safeguard",
      },
    },
  },
}
```

### Estimated Savings (Model Switch)

Switching primary from Opus to Sonnet for 70% of work:
- Opus: $15/$75 per MTok (input/output)
- Sonnet: $3/$15 per MTok (input/output)
- **Estimated: GBP40-60/day savings if you can shift 70% of work to Sonnet**

---

## 5. Bootstrap & System Prompt Size Controls

### Reduce What Gets Injected

Every session starts with a system prompt containing tools, skills, bootstrap
files (AGENTS.md, CLAUDE.md, etc.). Oversized prompts burn input tokens on every
turn.

From `src/config/types.agent-defaults.ts`:

```json5
{
  agents: {
    defaults: {
      bootstrapMaxChars: 10000,        // default: 20000
      bootstrapTotalMaxChars: 80000,   // default: 150000
      imageMaxDimensionPx: 800,        // default: 1200 (reduce for screenshots)
    },
  },
}
```

Use `/context detail` to see exactly what is being injected and how much each
piece costs. Trim large AGENTS.md, CLAUDE.md, and TOOLS.md files.

### Estimated Savings

Halving system prompt size from 20K to 10K tokens, over 50 turns per session:
- Saves ~500K input tokens/session = $7.50 at Opus rates
- **Estimated: GBP5-15/day savings**

---

## 6. Anthropic 1M Context Beta

### What It Is

Anthropic's 1M context window is beta-gated. OpenClaw supports it via a model
param. From `docs/reference/token-use.md`:

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {
          params: {
            context1m: true,
          },
        },
      },
    },
  },
}
```

### Cost Implication

**Warning**: Enabling 1M context is a cost amplifier, not a saver. If you have
this enabled, sessions that grow large will process enormous token counts. Only
enable if you genuinely need it; for cost savings, you should NOT enable this
unless required.

The `contextTokens` setting caps how OpenClaw estimates context limits:

```json5
{
  agents: {
    defaults: {
      contextTokens: 200000,  // default; reduce to force earlier compaction
    },
  },
}
```

Setting this lower (e.g., 100000) will trigger compaction sooner, keeping
per-turn input costs lower at the expense of losing some conversation history.

---

## 7. Compaction Configuration

### Optimize Compaction Behavior

Compaction summarizes old conversation turns when approaching the context limit.
Faster and more aggressive compaction reduces per-turn input token costs.

```json5
{
  agents: {
    defaults: {
      compaction: {
        mode: "safeguard",
        model: "anthropic/claude-sonnet-4-6",   // use Sonnet for compaction
        reserveTokensFloor: 24000,
        maxHistoryShare: 0.3,    // keep history smaller (default: 0.5)
        truncateAfterCompaction: true,  // prevent unbounded JSONL growth
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 6000,
        },
      },
    },
  },
}
```

Key tuning:
- `maxHistoryShare: 0.3` (default 0.5) means less history is kept, forcing
  more aggressive summarization and keeping per-turn input tokens lower
- `truncateAfterCompaction: true` saves disk but also prevents oversized
  session files from being re-read
- Using Sonnet for compaction saves money vs using Opus

### Estimated Savings

Using Sonnet for compaction + more aggressive history limits:
- **Estimated: GBP3-8/day savings**

---

## 8. Usage Monitoring & Tracking

### Built-in Cost Visibility

OpenClaw has extensive usage tracking from `src/infra/session-cost-usage.ts`:

In-chat commands:
- `/status` -- shows session tokens, context usage, estimated cost
- `/usage full` -- appends per-response usage footer to every reply
- `/usage cost` -- shows aggregated cost summary from session logs

CLI commands:
- `openclaw status --usage` -- full per-provider breakdown
- `openclaw channels list` -- shows provider quota windows

### Provider Usage Dashboard

From `src/infra/provider-usage.ts`, OpenClaw tracks usage windows for Anthropic
(and other providers) showing percentage remaining. Use `/status` to see this
inline.

### Recommendation

Always run with `/usage tokens` or `/usage full` enabled so you can see the
cost of every response. This makes waste visible immediately.

---

## 9. Per-Agent Cost Strategies

### Multi-Agent Cost Optimization

Configure different agents with different cost profiles:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        default: true,
        model: { primary: "anthropic/claude-sonnet-4-6" },
        thinkingDefault: "low",
        params: { cacheRetention: "long" },
      },
      {
        id: "deep-research",
        model: { primary: "anthropic/claude-opus-4-6" },
        thinkingDefault: "high",
      },
      {
        id: "quick",
        model: { primary: "anthropic/claude-sonnet-4-6" },
        thinkingDefault: "off",
        fastModeDefault: true,
      },
    ],
  },
}
```

This way, only deliberate deep-research tasks use the expensive Opus model.

---

## 10. Session Management

### Automatic Session Reset

Long-running sessions accumulate context that gets re-sent on every turn.
Configure aggressive session resets:

```json5
{
  session: {
    reset: {
      mode: "idle",
      idleMinutes: 30,    // reset after 30 min idle
    },
    maintenance: {
      mode: "enforce",
      pruneAfter: "7d",
      maxEntries: 200,
    },
  },
}
```

### Parent Fork Token Guard

From `src/config/types.base.ts`:

```json5
{
  session: {
    parentForkMaxTokens: 50000,  // skip parent fork if too large
  },
}
```

---

## 11. Anthropic Fast Mode / Service Tier

### What It Does

From `docs/providers/anthropic.md`, OpenClaw supports Anthropic's service tier
system:

```
/fast on   -> service_tier: "auto"    (may use priority capacity, faster)
/fast off  -> service_tier: "standard_only"
```

This is about **latency**, not cost. However, `standard_only` may avoid
priority-tier surcharges if Anthropic implements tiered pricing. Currently
no cost difference, but worth being aware of.

---

## 12. Heartbeat Cost Reduction

Heartbeats burn tokens. From `docs/gateway/heartbeat.md`:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "55m",
        isolatedSession: true,    // ~2-5K tokens instead of ~100K
        lightContext: true,       // only HEARTBEAT.md, not full bootstrap
        model: "anthropic/claude-sonnet-4-6",  // cheaper model for heartbeats
      },
    },
  },
}
```

Without `isolatedSession`, each heartbeat re-sends the full conversation
transcript (~100K tokens for an active session). Setting `isolatedSession: true`
drops this to ~2-5K tokens.

---

## Summary: Recommended Configuration for Cost Reduction

```json5
{
  agents: {
    defaults: {
      // Use Sonnet as default, switch to Opus only when needed
      model: {
        primary: "anthropic/claude-sonnet-4-6",
        fallbacks: ["anthropic/claude-opus-4-6"],
      },
      models: {
        "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
        "anthropic/claude-opus-4-6": { alias: "opus" },
      },

      // Lower thinking by default
      thinkingDefault: "low",

      // Enable prompt caching
      params: { cacheRetention: "long" },

      // Aggressive context pruning
      contextPruning: {
        mode: "cache-ttl",
        ttl: "5m",
        softTrim: { maxChars: 3000, headChars: 1000, tailChars: 1000 },
        hardClear: { enabled: true },
        minPrunableToolChars: 30000,
      },

      // Cheaper compaction
      compaction: {
        model: "anthropic/claude-sonnet-4-6",
        mode: "safeguard",
        maxHistoryShare: 0.3,
        truncateAfterCompaction: true,
      },

      // Smaller system prompt
      bootstrapMaxChars: 12000,
      bootstrapTotalMaxChars: 80000,
      imageMaxDimensionPx: 800,

      // Cheaper subagents
      subagents: {
        model: "anthropic/claude-sonnet-4-6",
        thinking: "off",
      },

      // Cost-aware heartbeat
      heartbeat: {
        every: "55m",
        isolatedSession: true,
        lightContext: true,
        model: "anthropic/claude-sonnet-4-6",
      },
    },
  },

  // Session management
  session: {
    reset: { mode: "idle", idleMinutes: 30 },
    maintenance: { mode: "enforce", pruneAfter: "7d", maxEntries: 200 },
  },
}
```

## Estimated Total Savings

| Optimization                    | Estimated Daily Savings |
| ------------------------------- | ----------------------- |
| Model switch (Sonnet default)   | GBP40-60                |
| Thinking level (low default)    | GBP20-35                |
| Prompt caching (long)           | GBP10-20                |
| Context pruning (aggressive)    | GBP10-25                |
| Bootstrap size reduction        | GBP5-15                 |
| Compaction on Sonnet            | GBP3-8                  |
| Heartbeat optimization          | GBP1-3                  |
| **Total potential savings**     | **GBP50-85/day**        |

Note: these ranges overlap since the optimizations compound. Realistic combined
savings from all optimizations together: **50-85% reduction from GBP100/day to
GBP15-50/day**, depending on workload mix and how aggressively you can shift
from Opus to Sonnet.

## Key Slash Commands for Cost Control

- `/think low` -- reduce thinking for current message
- `/think off` -- disable thinking entirely
- `/model sonnet` -- switch to Sonnet for current session
- `/model opus` -- switch back to Opus when needed
- `/usage full` -- see cost per response
- `/usage cost` -- see aggregated costs
- `/status` -- see context size and provider quota
- `/context detail` -- see what is consuming your context window
- `/compact` -- manually compact to reduce context size

## What OpenClaw Does NOT Have (Gaps)

1. **No per-session token budget** -- there is no `maxTokensPerSession` or
   automatic session kill when a budget is exceeded
2. **No automatic model downgrade** -- no config to say "switch to Sonnet
   after spending $X"
3. **No Anthropic Batch API support** -- would give 50% discount on
   non-interactive workloads, but OpenClaw does not implement batch mode
4. **No token-efficient tool use** -- Anthropic's `token-efficient-tool-use`
   beta header (reduces tool schema token count by ~40%) does not appear to
   be implemented in OpenClaw
5. **No spending cap/alert** -- there is no alarm or circuit breaker when
   daily spending exceeds a threshold
