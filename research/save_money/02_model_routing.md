# Model Routing, Tiering & Sub-agent Cost Optimization

Research date: 2026-04-12

## 1. Current Anthropic Pricing (per 1M tokens, USD)

Source: Anthropic public pricing + OpenRouter catalog data (OpenClaw fetches from
`https://openrouter.ai/api/v1/models` and caches in `src/gateway/model-pricing-cache.ts`).

| Model | Input | Output | Cache Read | Cache Write |
|---|---|---|---|---|
| Claude Opus 4.6 | $15.00 | $75.00 | $1.50 | $18.75 |
| Claude Sonnet 4.6 | $3.00 | $15.00 | $0.30 | $3.75 |
| Claude Haiku 4.5 | $0.80 | $4.00 | $0.08 | $1.00 |

### Cost ratios relative to Opus 4.6

| Model | Input | Output | Cache Read | Cache Write |
|---|---|---|---|---|
| Opus 4.6 | 1.00x | 1.00x | 1.00x | 1.00x |
| Sonnet 4.6 | 0.20x | 0.20x | 0.20x | 0.20x |
| Haiku 4.5 | 0.05x | 0.05x | 0.05x | 0.05x |

Sonnet is **5x cheaper** than Opus across all token categories.
Haiku is **~19x cheaper** than Opus across all token categories.

---

## 2. How OpenClaw Handles Model Selection

Source: `src/agents/model-selection.ts`, `src/agents/defaults.ts`,
`src/agents/agent-scope.ts`, `src/config/types.agent-defaults.ts`

### Default model

Defined in `src/agents/defaults.ts`:

```ts
export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL = "claude-opus-4-6";
```

Everything defaults to Opus 4.6 unless overridden.

### Resolution hierarchy (main agent)

Resolved in `resolveDefaultModelForAgent()` and `resolveConfiguredModelRef()`:

1. Per-agent model (`agents.list[].model.primary`) -- highest priority
2. Global default model (`agents.defaults.model.primary`)
3. Hardcoded default (`anthropic/claude-opus-4-6`)

### Resolution hierarchy (sub-agents / spawned sessions)

Resolved in `resolveSubagentSpawnModelSelection()`:

1. Explicit `model` param on `sessions_spawn` tool call -- highest priority
2. Per-agent subagent model (`agents.list[].subagents.model`)
3. Per-agent own model (`agents.list[].model`)
4. Global subagent default (`agents.defaults.subagents.model`)
5. Global default model (`agents.defaults.model.primary`)
6. Hardcoded default (Opus 4.6)

This means: **if you don't configure `agents.defaults.subagents.model`, every
sub-agent burns Opus tokens.**

### Per-channel model overrides

Defined in `channels.modelByChannel`:

```json5
{
  channels: {
    modelByChannel: {
      discord: { "123456789": "anthropic/claude-sonnet-4-6" },
      telegram: { "-100123": "anthropic/claude-sonnet-4-6" },
    },
  },
}
```

### Per-hook model overrides

Hook mappings support `model` overrides per mapping entry:

```json5
{
  hooks: {
    mappings: [{ model: "anthropic/claude-sonnet-4-6" }],
    gmail: { model: "anthropic/claude-sonnet-4-6" },
  },
}
```

---

## 3. Sub-agent Model Routing -- The Big Win

Source: `src/agents/subagent-spawn.ts`, `src/config/types.agent-defaults.ts`,
`docs/tools/subagents.md`

### The problem

Every `sessions_spawn` call (claudeception skills, research cascades, swarm
agents, `/subagents spawn`) creates a new session with its own context window.
Without configuration, they all run on Opus 4.6.

A typical research cascade:
- Orchestrator spawns 4-8 research agents
- Each research agent runs 5-15 tool calls with context
- Each uses ~50-200K input tokens and ~10-40K output tokens

At Opus pricing, a single research cascade can cost $5-20.

### The fix: `agents.defaults.subagents.model`

This is a first-class config key:

```json5
{
  agents: {
    defaults: {
      model: "anthropic/claude-opus-4-6", // main agent stays on Opus
      subagents: {
        model: "anthropic/claude-sonnet-4-6", // all sub-agents default to Sonnet
      },
    },
  },
}
```

The `sessions_spawn` tool still has an explicit `model` parameter, so the
orchestrating agent can promote a specific sub-agent to Opus when the task
demands it (e.g., `model: "anthropic/claude-opus-4-6"` for architecture
decisions). But the default is cheap.

### Per-agent subagent model overrides

For more granular routing, use `agents.list[]`:

```json5
{
  agents: {
    defaults: {
      model: "anthropic/claude-opus-4-6",
      subagents: {
        model: "anthropic/claude-sonnet-4-6", // global sub-agent default
      },
    },
    list: [
      {
        id: "research",
        model: { primary: "anthropic/claude-sonnet-4-6" }, // research agent itself
        subagents: {
          model: "anthropic/claude-haiku-4-5", // research sub-agents use Haiku
        },
      },
      {
        id: "architect",
        model: { primary: "anthropic/claude-opus-4-6" }, // architect stays Opus
      },
    ],
  },
}
```

---

## 4. Task-to-Model Routing Recommendations

OpenClaw does NOT currently have automatic "smart routing" based on task type.
Model selection is config-driven or explicit per-spawn. Here is how to tier
manually via config and spawn parameters:

### Tier 1: Haiku 4.5 ($0.80/$4.00 per 1M)

Best for:
- File search / grep / exploration agents
- Simple Q&A lookup agents
- Log scanning / monitoring agents
- Heartbeat keep-warm runs (`agents.defaults.heartbeat.model`)
- Compaction summarization (`agents.defaults.compaction.model`)

### Tier 2: Sonnet 4.6 ($3.00/$15.00 per 1M)

Best for:
- Code review sub-agents
- Research agents (reading docs, exploring code)
- Standard coding tasks (implementation, refactoring)
- Most sub-agent work via `agents.defaults.subagents.model`
- Most cron/hook-triggered agent turns

### Tier 3: Opus 4.6 ($15.00/$75.00 per 1M)

Reserve for:
- Main interactive session (where you need the deepest reasoning)
- Complex architecture decisions
- Security-sensitive analysis
- When a sub-agent explicitly needs it via `model` param on `sessions_spawn`

---

## 5. Compaction Model Routing

Source: `src/config/types.agent-defaults.ts` line 345-348

Compaction summarization can use a different model:

```json5
{
  agents: {
    defaults: {
      compaction: {
        model: "anthropic/claude-sonnet-4-6", // or even Haiku for cost
      },
    },
  },
}
```

Compaction runs on long sessions and can consume significant tokens summarizing
history. Using Sonnet instead of Opus for compaction is an easy win with
negligible quality impact.

---

## 6. Heartbeat Model Routing

Source: `src/config/types.agent-defaults.ts` line 241

Heartbeats are periodic keep-warm pings. They should use the cheapest model:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        model: "anthropic/claude-haiku-4-5",
        every: "55m",
        lightContext: true,       // minimize bootstrap injection
        isolatedSession: true,    // avoid full session transcript
      },
    },
  },
}
```

---

## 7. What Does `/fast` Actually Do?

Source: `src/agents/fast-mode.ts`, `docs/tools/thinking.md`,
`src/agents/pi-embedded-runner-extraparams.test.ts`

**`/fast` does NOT save money. It affects latency, not cost.**

What it does per provider:
- **Anthropic**: sets `service_tier=auto` (allowing Anthropic to route to faster
  infrastructure). `/fast off` sets `service_tier=standard_only`.
- **OpenAI**: sets `service_tier=priority` on supported Responses requests.
- **xAI (Grok)**: remaps model IDs to `-fast` variants (e.g.,
  `grok-4-1` -> `grok-4-1-fast`).
- **MiniMax**: remaps to highspeed model variants.

For Anthropic specifically, `service_tier=auto` means the provider MAY route you
to faster infrastructure when available, but the token price is the same. This
is a latency optimization, not a cost optimization.

**Verdict: `/fast` is not a money saver. It may slightly improve latency.**

---

## 8. Cost Projection: 80% Sonnet Sub-agents

Assumptions based on ~100 GBP/day spend ($125/day):
- Typical daily token breakdown: ~1.5M input, ~300K output (rough)
- ~60% of tokens are in sub-agent sessions (research cascades, claudeception, swarms)
- ~10% in compaction/heartbeat
- ~30% in main interactive session

### Current cost (everything on Opus 4.6)

| Category | Input Tokens | Output Tokens | Input Cost | Output Cost | Total |
|---|---|---|---|---|---|
| Main session (30%) | 450K | 90K | $6.75 | $6.75 | $13.50 |
| Sub-agents (60%) | 900K | 180K | $13.50 | $13.50 | $27.00 |
| Compaction/HB (10%) | 150K | 30K | $2.25 | $2.25 | $4.50 |
| **Total** | **1.5M** | **300K** | **$22.50** | **$22.50** | **$45.00** |

Note: actual spend is higher due to cache writes, extended thinking tokens, and
days with heavier usage. The proportions matter more than the absolute numbers.

### Optimized cost (tiered routing)

| Category | Model | Input Tokens | Output Tokens | Input Cost | Output Cost | Total |
|---|---|---|---|---|---|---|
| Main session | Opus 4.6 | 450K | 90K | $6.75 | $6.75 | $13.50 |
| Sub-agents | Sonnet 4.6 | 900K | 180K | $2.70 | $2.70 | $5.40 |
| Compaction | Sonnet 4.6 | 100K | 20K | $0.30 | $0.30 | $0.60 |
| Heartbeat | Haiku 4.5 | 50K | 10K | $0.04 | $0.04 | $0.08 |
| **Total** | | **1.5M** | **300K** | **$9.79** | **$9.79** | **$19.58** |

### Savings

- **Absolute savings: ~$25.42/day (~56% reduction)**
- **Monthly savings: ~$760**
- **Sub-agent savings alone: $21.60/day (80% reduction on sub-agent spend)**

If sub-agents are a larger share of your usage (likely with claudeception
research cascades and swarm agents), the savings are even more dramatic.

### Aggressive optimization (Haiku for low-value sub-agents)

Push research/exploration sub-agents to Haiku 4.5:

| Category | Model | Daily Cost |
|---|---|---|
| Main session | Opus 4.6 | $13.50 |
| Complex sub-agents (20%) | Sonnet 4.6 | $1.80 |
| Simple sub-agents (40%) | Haiku 4.5 | $0.48 |
| Compaction | Haiku 4.5 | $0.10 |
| Heartbeat | Haiku 4.5 | $0.08 |
| **Total** | | **$15.96** |

That is a **65% reduction** from the $45 baseline.

---

## 9. Recommended OpenClaw Configuration

### Starter config (safe, big savings)

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["anthropic/claude-sonnet-4-6"],
      },
      subagents: {
        model: "anthropic/claude-sonnet-4-6",
        maxConcurrent: 8,
        maxSpawnDepth: 2,
        runTimeoutSeconds: 900,
      },
      compaction: {
        model: "anthropic/claude-sonnet-4-6",
      },
      heartbeat: {
        model: "anthropic/claude-haiku-4-5",
        every: "55m",
        lightContext: true,
        isolatedSession: true,
      },
      models: {
        "anthropic/claude-opus-4-6": {
          params: { cacheRetention: "long" },
        },
        "anthropic/claude-sonnet-4-6": {
          params: { cacheRetention: "long" },
        },
      },
    },
  },
}
```

### Advanced config (per-agent routing)

```json5
{
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-opus-4-6" },
      subagents: {
        model: "anthropic/claude-sonnet-4-6",
      },
      compaction: {
        model: "anthropic/claude-sonnet-4-6",
      },
      heartbeat: {
        model: "anthropic/claude-haiku-4-5",
        lightContext: true,
        isolatedSession: true,
      },
    },
    list: [
      {
        id: "research",
        model: { primary: "anthropic/claude-sonnet-4-6" },
        subagents: {
          model: "anthropic/claude-haiku-4-5", // research sub-sub-agents are cheap
        },
      },
      {
        id: "architect",
        model: { primary: "anthropic/claude-opus-4-6" },
        // architect sub-agents inherit global default (Sonnet)
      },
      {
        id: "alerts",
        model: { primary: "anthropic/claude-haiku-4-5" },
        params: { cacheRetention: "none" },
      },
    ],
  },
}
```

---

## 10. What OpenClaw Does NOT Support (Yet)

1. **Automatic task-based routing**: No built-in "use Haiku for grep, Sonnet for
   code review, Opus for architecture." Model selection is always explicit config
   or explicit `sessions_spawn` parameter. The orchestrating agent CAN be
   prompted to choose models per-task, but it requires the agent to pass `model`
   on each spawn call.

2. **Cost budgets / circuit breakers**: No config to say "stop spending after
   $X." You can use `runTimeoutSeconds` on sub-agents as a rough proxy.

3. **Dynamic model selection based on prompt complexity**: No auto-detection of
   "this prompt is simple, use Haiku." All routing is static config.

4. **Per-skill model overrides**: Skills do not have a `model` config key. A
   claudeception skill runs on whatever model the spawning session uses.
   Claudeception skills spawn sub-agents via `sessions_spawn`, so the
   `agents.defaults.subagents.model` config applies to those spawned children.

---

## 11. Key Files Reference

| File | Purpose |
|---|---|
| `src/agents/defaults.ts` | Default provider + model constants |
| `src/agents/model-selection.ts` | All model resolution logic |
| `src/agents/subagent-spawn.ts` | Sub-agent spawn + model override |
| `src/agents/fast-mode.ts` | `/fast` mode resolution |
| `src/config/types.agent-defaults.ts` | Config schema for `agents.defaults` |
| `src/config/types.agents.ts` | Config schema for `agents.list[]` |
| `src/gateway/model-pricing-cache.ts` | OpenRouter pricing fetch + cache |
| `src/infra/session-cost-usage.ts` | Session cost tracking |
| `src/utils/usage-format.ts` | Cost estimation from pricing config |
| `docs/tools/subagents.md` | Sub-agent docs (model config covered) |
| `docs/reference/prompt-caching.md` | Cache retention knobs |
| `docs/reference/token-use.md` | Token use and cost display |
| `docs/tools/thinking.md` | `/fast` mode documentation |

---

## 12. Summary of Actionable Steps

1. **Set `agents.defaults.subagents.model` to Sonnet** -- single biggest win,
   applies to all claudeception / research / swarm sub-agents immediately.

2. **Set `agents.defaults.compaction.model` to Sonnet** -- compaction quality is
   fine with Sonnet, saves on long sessions.

3. **Set `agents.defaults.heartbeat.model` to Haiku** with `lightContext: true`
   and `isolatedSession: true` -- heartbeats are trivial work.

4. **Create per-agent entries** for agents that need different tiers (research on
   Sonnet, alerts on Haiku, architect on Opus).

5. **Do NOT rely on `/fast`** for cost savings -- it is a latency feature only.

6. **Enable prompt caching** (`cacheRetention: "long"`) on your primary models
   to reduce effective input costs.

7. **Monitor with `/usage full`** to track per-response costs and validate the
   savings are materializing.
