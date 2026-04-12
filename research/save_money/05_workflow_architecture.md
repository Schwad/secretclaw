# Workflow Architecture, Session Design & Radical Cost Reduction

Research for a power user spending ~GBP100/day (~$125/day, ~$3,750/month) on Claude Opus 4.6 via OpenClaw.

---

## 1. Per-Session Overhead: Personality + Memory System

### Measured overhead (from `~/.claude/`)

| Component | Size (bytes) | Est. tokens | Injected where |
|---|---|---|---|
| `personality/core.md` | 10,035 | ~2,500 | CLAUDE.md (every session) |
| `~/.claude/CLAUDE.md` total (with personality + memories) | 16,133 | ~4,000 | System context |
| Project `CLAUDE.md` (this repo) | 35,634 | ~8,900 | System context |
| `load-old-memories.sh` output (SessionStart hook) | 58,568 | ~14,600 | Conversation context |
| All 22 command/skill `.md` files (descriptions only in prompt) | 151,582 | ~37,900 (full), ~2,000 (descriptions only) | Skill metadata in system prompt |

### What the model actually receives per session start

The system prompt is assembled from multiple sources:

1. **System prompt core** (~2K tokens): tool list, skills metadata, runtime line, workspace info
2. **Global CLAUDE.md** (~4K tokens): personality, date, git rules, ZAR context, Nexus instructions, full Philippe biography, memory system instructions, life/environment details
3. **Project CLAUDE.md** (~8.9K tokens): repo guidelines, architecture boundaries, build commands, coding style, testing guidelines, commit guidelines, docs linking, etc.
4. **SessionStart hook output** (~14.6K tokens): 5 full session memories, 50 one-liner session memories, 12 full micro-memories, 35 one-liner micro-memories
5. **Memory in CLAUDE.md** (~1K tokens): most recent session memory injected directly

**Total estimated first-turn input: ~30K-31K tokens**

### Comparison: minimal setup

A minimal Claude Code session (no personality, no memories, no custom CLAUDE.md) starts at roughly:
- System prompt core: ~2K tokens
- Minimal project CLAUDE.md: ~500 tokens
- **Total: ~2.5K tokens**

**The personality/memory system adds ~28K tokens of overhead per session start** -- roughly 12x the minimal baseline.

### Cost of this overhead

At Anthropic Opus 4.6 pricing ($15/1M input tokens):
- Per-session overhead: 28K tokens = **$0.42 per session start** (input only)
- With prompt caching (short, cache read at $1.875/1M): **$0.053 per cached turn**
- Cache write cost on first turn: $18.75/1M x 28K = **$0.53 first turn**

Over a heavy usage day (say 15-20 sessions, 30 turns each):
- Without caching: 28K x 30 turns x 15 sessions x $15/1M = **$189** just for system prompt re-reads
- With prompt caching (assuming 90% cache hit): ~$25-30 for system prompt across the day

**Prompt caching is already saving ~$160/day on system prompt alone.**

---

## 2. Session Splitting vs Long Sessions

### How context accumulates

OpenClaw tracks context window usage and triggers compaction when context approaches the limit. The cost curve of a long session:

- **Turn 1**: System prompt (~30K tokens input) + user message + response
- **Turn 10**: ~30K system + ~50K conversation history = ~80K input
- **Turn 30**: ~30K system + ~150K conversation = ~180K input
- **Turn 50**: Compaction triggered, context summarized, drops to ~80K, then grows again

Each turn re-sends the ENTIRE conversation history as input. This is the fundamental cost driver.

### The math of session splitting

**Scenario A: One 30-turn session**
- Average input per turn: ~100K tokens (growing from 30K to 180K)
- Total input: 30 x 100K = 3M tokens = **$45 input cost**
- Total output: 30 x 2K avg = 60K tokens = **$4.50 output cost**
- **Total: ~$49.50**

**Scenario B: Three 10-turn sessions (same work)**
- Average input per turn: ~55K tokens (30K base + 25K avg history)
- Total input: 30 x 55K = 1.65M tokens = **$24.75 input cost**
- Total output: same 60K = **$4.50**
- System prompt re-load cost: 3 x 28K x $15/1M = **$1.26**
- **Total: ~$30.51** (38% cheaper)

**Scenario C: Six 5-turn sessions**
- Average input per turn: ~42K tokens
- Total input: 30 x 42K = 1.26M tokens = **$18.90 input cost**
- System prompt re-load: 6 x 28K x $15/1M = **$2.52**
- **Total: ~$25.92** (48% cheaper)

### Interaction with prompt caching

With `cacheRetention: "short"` (5-minute TTL):
- Cache hits only apply within the same session where turns happen within 5 minutes
- Starting a new session always pays full cache-write cost on turn 1
- `cacheRetention: "long"` (1-hour TTL) would help if you start a new session within the hour

**Optimal strategy**: Use `cacheRetention: "long"` + heartbeat keep-warm. Split sessions but reuse the same session key when possible so the cache persists.

### When to split

- **Split**: After completing a distinct task (PR, investigation, bug fix)
- **Split**: When you notice the `/status` context usage exceeding 50%
- **Continue**: When the next question directly depends on current context
- **Continue**: When you are mid-task and would need to re-explain everything

### Actionable configuration

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long"
    contextPruning:
      mode: "cache-ttl"
      ttl: "1h"
    heartbeat:
      every: "55m"
```

---

## 3. Claudeception / Agent Orchestration Cost Compound

### The problem

Each claudeception skill (`claudeception.md`, `claudeception:cascade.md`, `claudeception:research.md`, etc.) launches multiple sub-agents. Each sub-agent:

1. Gets its own full context window
2. Receives its own system prompt (including subagent-context instructions)
3. Re-sends conversation history on every turn
4. Cannot share prompt cache with other agents

### Measured orchestration overhead

The claudeception command files total **104,486 bytes** (~26K tokens) of instructions. The orchestrator pattern is:

1. **Orchestrator agent**: receives full system prompt + claudeception instructions + task
2. **Research agents** (2-3 parallel): each gets subagent system prompt + research brief
3. **Implementation agents** (2-5 parallel): each gets subagent system prompt + implementation brief
4. **Review agents** (1-2 parallel): each gets subagent system prompt + review brief

For a typical claudeception run with 5 parallel agents:

| Component | Tokens per agent | x5 agents | Total |
|---|---|---|---|
| Subagent system prompt | ~2K | 10K | 10K |
| Project CLAUDE.md bootstrap | ~8.9K | 44.5K | 44.5K |
| Task brief from orchestrator | ~1K | 5K | 5K |
| Agent's own conversation (10 turns avg) | ~50K avg | 250K | 250K |
| **Subtotal per orchestration** | | | **~310K** |
| Orchestrator's own context | | | **~100K** |
| **Grand total** | | | **~410K tokens** |

At $15/1M input: a single claudeception run costs ~**$6.15 in input alone**.

### Cascade orchestration (orchestrators launching orchestrators)

The `claudeception:cascade.md` pattern allows orchestrators to spawn sub-orchestrators. A 2-level cascade with 3 sub-orchestrators each spawning 3 agents:

- Level 0 (root orchestrator): 1 agent, ~100K context
- Level 1 (sub-orchestrators): 3 agents, ~80K each = 240K
- Level 2 (implementation): 9 agents, ~60K each = 540K
- **Total: ~880K input tokens = $13.20 per cascade run**

### Strategies to reduce orchestration cost

#### A. Use subagent system prompt mode "minimal"

OpenClaw already supports `PromptMode: "full" | "minimal" | "none"` for subagents. The subagent system prompt (`buildSubagentSystemPrompt`) is already minimal (~2K tokens vs ~30K for full). This is already working.

#### B. Reduce parallel agent count

Instead of 5 parallel research agents, use 2. Instead of 5 implementation agents, use 2-3. The orchestration overhead scales linearly with agent count.

**Current**: 5 research + 5 implementation + 2 review = 12 agents
**Optimized**: 2 research + 3 implementation + 1 review = 6 agents
**Savings**: ~50% reduction in orchestration input costs

#### C. Use subdirectory focus aggressively

The claudeception patterns support `subdirectory` to scope agents. This reduces the amount of codebase they explore (fewer tool calls, less tool-result context).

#### D. Share research artifacts instead of re-researching

When the orchestrator synthesizes research findings, pass a compact summary to implementation agents instead of having them re-explore. The claudeception prompt already instructs this, but being disciplined about it saves 2-3 research turns per implementation agent.

#### E. Use Sonnet for research and review agents

Configure model fallbacks so research and review sub-agents use Claude Sonnet 4.6 ($3/1M input, $15/1M output) instead of Opus ($15/$75). Research agents primarily read and summarize -- Sonnet excels at this.

**Cost of 3 research agents on Sonnet vs Opus**:
- Opus: 3 x 50K x $15/1M = $2.25
- Sonnet: 3 x 50K x $3/1M = $0.45
- **Savings: $1.80 per orchestration run**

#### F. Avoid cascade when flat works

The cascade pattern (orchestrators spawning orchestrators) should be reserved for genuinely multi-domain problems. Most single-PR tasks work fine with flat orchestration. Eliminating one cascade level saves 30-40% of total orchestration cost.

---

## 4. Local / Open-Source Models for Simple Tasks

### Ollama integration (already built into OpenClaw)

OpenClaw has a first-class Ollama plugin (`extensions/ollama/`) that supports:
- Auto-discovery of locally running Ollama models
- Streaming, embeddings, and model fallback
- Configuration via `models.providers.ollama`

### Viable local models for cost reduction

| Task type | Recommended local model | Quality vs Opus | Speed |
|---|---|---|---|
| File reading/summarization | Qwen 2.5 32B | 70-80% | Fast |
| Simple code edits | DeepSeek Coder V2 33B | 65-75% | Fast |
| Git operations | Qwen 2.5 14B | 80% (for commands) | Very fast |
| Text formatting | Llama 3.3 70B | 75-85% | Moderate |
| Complex reasoning | Not viable locally | 30-50% | Slow |
| Architecture decisions | Not viable locally | 20-40% | Slow |

### Hybrid routing strategy

OpenClaw supports model fallback chains. Configure a primary model and fallbacks:

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
      fallbacks:
        - "anthropic/claude-sonnet-4-6"
        - "ollama/qwen2.5:32b"
```

However, OpenClaw's fallback is for **error recovery** (rate limits, timeouts), not task-based routing. True task-based routing would require:

1. A custom context engine plugin that classifies task complexity
2. Or manual model switching (`/model ollama/qwen2.5:32b` for simple tasks)

### Practical approach: agent-level model assignment

For multi-agent setups, assign cheaper models per agent role:

```yaml
agents:
  list:
    - id: "research"
      default: true
      model:
        primary: "anthropic/claude-opus-4-6"
    - id: "simple"
      model:
        primary: "anthropic/claude-sonnet-4-6"
    - id: "local"
      model:
        primary: "ollama/qwen2.5:32b"
```

### Estimated savings from hybrid approach

If 30% of interactions are simple enough for Sonnet and 10% for local:
- Current: 100% Opus = $125/day
- Hybrid: 60% Opus ($75) + 30% Sonnet ($7.50) + 10% local ($0) = **$82.50/day**
- **Savings: ~$42.50/day (34%)**

---

## 5. Anthropic Batch API

### What the Batch API offers

The Anthropic Message Batches API (`/v1/messages/batches`) processes requests asynchronously at **50% discount** on both input and output tokens. Results are available within 24 hours (typically much faster).

### Current OpenClaw support

Based on code search, OpenClaw does **not** currently have built-in Batch API support. The references to "batch" in the codebase relate to message batching in the context engine and session management, not the Anthropic Batch API.

### Workloads that could use batch mode

| Workload | Interactive? | Batch viable? | Est. daily tokens | Savings at 50% |
|---|---|---|---|---|
| CI code reviews | No | Yes | ~500K | $3.75 |
| Automated PR summaries | No | Yes | ~200K | $1.50 |
| Cron-scheduled tasks | No | Yes | ~300K | $2.25 |
| Standing orders (heartbeat) | Semi | Maybe | ~100K | $0.75 |
| Interactive coding sessions | Yes | No | ~5M+ | N/A |
| Memory/journal generation | No | Yes | ~100K | $0.75 |

**Total potential batch savings: ~$9/day ($270/month)**

### Implementation path

Building a batch mode for non-interactive workloads would require:

1. A new provider stream wrapper that queues requests to `/v1/messages/batches`
2. A polling mechanism to collect results
3. Integration with the cron/standing-order system
4. Configuration to flag specific agents/tasks as batch-eligible

This is a meaningful engineering effort but the 50% discount on eligible workloads is significant for automated pipelines.

### Quick win: use batch API for memory operations

The `preserve-memory` and `sync-openclaw-memories.sh` operations generate summaries. These could be batched since they don't need real-time responses.

---

## 6. Conversation Design Patterns

### Cost curve of conversation length

The fundamental cost equation for a conversation of N turns:

```
Total input cost = sum(system_prompt + conversation_history[0..i]) for i in 0..N
                 = N * system_prompt + sum(history[0..i])
                 = N * S + H * N * (N+1) / 2    (where H = avg tokens per turn)
```

This is **quadratic in conversation length**. Doubling the number of turns roughly quadruples the total input cost.

| Turns | Avg input/turn | Total input | Cost (Opus) |
|---|---|---|---|
| 5 | 40K | 200K | $3.00 |
| 10 | 55K | 550K | $8.25 |
| 20 | 85K | 1.7M | $25.50 |
| 30 | 115K | 3.45M | $51.75 |
| 50 | 140K (post-compaction) | 7M | $105.00 |

### The compaction cliff

OpenClaw compacts when context approaches the window limit (~200K tokens by default). After compaction:
- History is summarized to ~20-30K tokens
- The cost curve "resets" to a lower baseline
- But compaction itself costs a full-context turn

**Insight**: Deliberately triggering `/compact` before the automatic threshold can save money by keeping the context smaller during the growth phase.

### Design patterns ranked by cost efficiency

#### Pattern 1: Focused micro-sessions (most efficient)
- 3-5 turns per session
- One clear objective per session
- No personality overhead (use `claude` not `claudep`)
- **Cost: $2-4 per task**

#### Pattern 2: Task-scoped sessions (recommended default)
- 8-12 turns per session
- One PR or investigation per session
- Compact after large tool outputs
- **Cost: $8-15 per task**

#### Pattern 3: Extended working sessions (current typical)
- 20-40 turns
- Multiple tasks, context switching
- Personality + memory system active
- **Cost: $30-60 per session**

#### Pattern 4: Marathon sessions (most expensive)
- 50+ turns
- Multiple compactions
- Heavy tool use with large outputs
- **Cost: $80-150+ per session**

### When to start fresh vs continue

**Start fresh when**:
- Switching to a completely different task/repo
- Context is above 60% (check `/status`)
- The current conversation has accumulated irrelevant context
- You need a different model or thinking level

**Continue when**:
- The next question directly builds on current work
- You're mid-investigation and the context is valuable
- The session is still under 30% context usage

### The "two-mode" discipline

For maximum savings, maintain two interaction modes:

1. **`claude` (no personality)**: For focused technical work. Smaller system prompt, faster, cheaper. Use for:
   - Quick file reads and edits
   - Running tests
   - Simple git operations
   - Code review

2. **`claudep` (personality mode)**: For collaborative work. Richer but more expensive. Use for:
   - Architecture discussions
   - Complex debugging
   - Learning and exploration
   - Work that benefits from Philippe's context

**Estimated savings from disciplined mode switching**: If 40% of interactions don't need personality mode:
- Current: 100% personality overhead = ~$12/day in system prompt costs
- Optimized: 60% personality + 40% minimal = ~$8/day
- **Savings: ~$4/day ($120/month)**

---

## 7. OpenClaw Plugins and Community Tools for Cost Optimization

### Built-in cost visibility

- **`/status`**: Shows context usage, token counts, estimated cost
- **`/usage full`**: Per-response usage footer with input/output/cache breakdown
- **`/usage cost`**: Local cost summary from session logs
- **`/context list` / `/context detail`**: Breakdown of what's in the prompt
- **`model-usage` skill**: CodexBar CLI integration for per-model cost analysis

### Built-in cost reduction features

1. **Prompt caching** (`cacheRetention: "short" | "long"`): Already active, reduces repeated input costs by 87.5% on cache hits
2. **Cache-TTL pruning** (`contextPruning.mode: "cache-ttl"`): Prunes stale context to avoid re-caching bloated history
3. **Heartbeat keep-warm**: Prevents cache expiry during idle periods
4. **Thinking levels** (`off | minimal | low | medium | high | xhigh | adaptive`): Lower thinking = fewer output tokens (thinking tokens count as output)
5. **Context engine plugins**: Pluggable context management (the `lossless-claw` example in docs)
6. **Image downscaling** (`agents.defaults.imageMaxDimensionPx`): Reduces vision token usage
7. **Tool result truncation**: Automatic truncation of large tool outputs
8. **Compaction**: Automatic and manual (`/compact`) context summarization
9. **Cache trace diagnostics**: Debug cache hit/miss patterns

### Community opportunities

No dedicated "cost optimization" plugins exist yet, but the plugin architecture supports:
- Custom context engines that could implement semantic retrieval (RAG) instead of full history
- Provider plugins that route to cheaper models based on task classification
- Memory plugins that use embeddings instead of prompt injection

### Configuration for cost optimization

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long"
    contextPruning:
      mode: "cache-ttl"
      ttl: "1h"
    heartbeat:
      every: "55m"
    imageMaxDimensionPx: 800  # lower from default 1200
    bootstrapMaxChars: 15000  # lower from default 20000
    bootstrapTotalMaxChars: 100000  # lower from default 150000
```

---

## 8. Radical Strategies

### A. Pre-computing common operations

**Concept**: Cache the results of frequently-run tool operations locally so the model doesn't need to execute them.

**Implementation ideas**:
- Build a local index of project structure (`find . -name "*.ts" | tree`) and inject as a small pre-computed context file instead of having the model run `ls` and `find` repeatedly
- Pre-generate a TAGS file or code outline that the model can reference
- Cache `git log`, `git status`, and `git diff` outputs and refresh on file change

**Estimated savings**: Each tool call that reads a file costs the full file content as input tokens. A pre-computed project index (~2K tokens) could replace 5-10 file exploration tool calls per session (~20-50K tokens saved).
- **$0.30-0.75 per session, $5-15/day**

### B. Caching tool outputs locally

**Concept**: MCP server that intercepts Read/Grep/Glob results and caches them with file-modification-time invalidation.

**How it works**:
1. First `Read file.ts` call: fetches file, caches content + mtime
2. Second `Read file.ts` call in same or new session: returns cache if mtime unchanged
3. Cache hit avoids re-injecting the full file content as a new tool result

**Why this helps**: In a 30-turn session, the same files are often read 3-5 times. Each read adds the full file content to the conversation history, which then gets re-sent on every subsequent turn.

**Estimated savings**: If 30% of file reads are cache-hittable and average 500 tokens each:
- 30 turns x 3 reads/turn x 30% cache rate x 500 tokens = 13.5K tokens not re-read
- But the real savings come from not having those results in the growing conversation history
- **$1-3 per session, $15-45/day**

### C. Embeddings-based memory retrieval (replacing prompt injection)

**Concept**: Instead of injecting 58KB of memories into every session, use a semantic search MCP to retrieve only relevant memories on demand.

**Current approach**: `load-old-memories.sh` dumps ~14.6K tokens of memories into the conversation context at session start. Most of this context is irrelevant to any given session.

**Proposed approach**:
1. Index all memories with embeddings (OpenClaw already has embedding providers, including Ollama)
2. At session start, inject only a 200-token instruction: "Use the memory_search tool to recall relevant context"
3. Memory retrieval happens on-demand, returns only the 2-3 most relevant memories (~500-1000 tokens)

**Implementation using OpenClaw's existing architecture**:
- OpenClaw already has `src/agents/memory-search.ts` for memory search
- The Ollama extension already supports `createEmbeddingProvider`
- A context engine plugin could implement this as the `assemble` step

**Estimated savings**:
- Current: 14.6K tokens injected every session = $0.22/session
- Proposed: 200 tokens instruction + 1K tokens retrieved = $0.018/session
- Per session saving: ~$0.20
- **At 15 sessions/day: $3/day, $90/month**

### D. Custom MCP servers for pre-processing

**Concept**: Build MCP tools that pre-process and compress information before it reaches the model.

**Examples**:
1. **`project-context` MCP**: Returns a compressed project overview (file tree, key patterns, recent changes) in ~1K tokens instead of having the model explore with multiple tool calls
2. **`smart-grep` MCP**: Returns relevant code with surrounding context pre-formatted, rather than raw grep results that need follow-up reads
3. **`diff-summary` MCP**: Returns a semantic summary of git diffs rather than raw diff output
4. **`test-runner` MCP**: Runs tests and returns only failures with relevant context, not full output

**Estimated savings from reducing tool-result bloat**:
- Average tool result: 2K tokens
- Pre-processed result: 500 tokens
- 10 tool calls per session with 75% reduction: 15K tokens saved per session
- **$0.22/session, $3.30/day**

### E. Thinking level optimization

**Concept**: Use lower thinking levels for simple tasks, higher for complex ones.

OpenClaw supports thinking levels: `off | minimal | low | medium | high | xhigh | adaptive`

Thinking tokens count as output tokens ($75/1M for Opus). A `high` thinking response might use 5K thinking tokens ($0.375), while `low` uses 500 ($0.0375).

**Strategy**: Default to `low` thinking, escalate to `high` only for complex reasoning tasks.

**Estimated savings**: If average thinking tokens drop from 3K to 1K per turn:
- 30 turns/session x 2K saved x $75/1M = $4.50/session
- **$45-67/day across all sessions**

### F. Slim personality mode

**Concept**: Create a `core_small.md` (already exists at `~/.claude/personality/core_small.md`) that contains only essential Philippe traits in ~2K bytes instead of 10K.

**What to keep**: Core identity, communication style, technical approach (5 lines total)
**What to cut**: Life/environment details, neighborhood, quirks, office setup, personal touches

**Estimated savings**: 8K bytes = ~2K tokens saved per session
- With caching: negligible after first turn
- Without caching (new sessions): $0.03/session
- **Minor but reduces cache-write cost on session starts**

---

## 9. Before/After Cost Projections

### Current daily spending: ~$125/day

| Category | Est. daily cost | % of total |
|---|---|---|
| Interactive sessions (15 sessions, avg 20 turns) | $75 | 60% |
| Claudeception/orchestration (2 runs/day) | $25 | 20% |
| System prompt overhead | $12 | 10% |
| Memory/personality injection | $5 | 4% |
| Automated tasks (cron, heartbeat) | $8 | 6% |

### Optimized daily spending: ~$55-65/day (48-56% reduction)

| Strategy | Savings/day | Difficulty |
|---|---|---|
| Session splitting (20-turn to 8-turn avg) | $20-25 | Easy (discipline) |
| Thinking level optimization (default to low) | $15-20 | Easy (config) |
| Sonnet for research/review sub-agents | $8-10 | Easy (config) |
| Reduce orchestration agent count (12 to 6) | $5-8 | Easy (discipline) |
| Embeddings-based memory retrieval | $3 | Medium (build MCP) |
| Cache-TTL pruning + heartbeat warm | $3-5 | Easy (config) |
| Two-mode discipline (claudep vs claude) | $3-4 | Easy (discipline) |
| Pre-computed project context | $2-3 | Medium (build tool) |
| Lower `bootstrapMaxChars` | $1-2 | Easy (config) |
| **Total savings** | **$60-77** | |

### Projected monthly savings: $1,800-2,300

| Period | Current | Optimized | Savings |
|---|---|---|---|
| Daily | $125 | $55-65 | $60-70 |
| Monthly | $3,750 | $1,650-1,950 | $1,800-2,100 |
| Yearly | $45,000 | $19,800-23,400 | $21,600-25,200 |

---

## 10. Implementation Priority (Ranked by Impact/Effort)

### Tier 1: Config changes only (do today)

1. **Set `cacheRetention: "long"` + heartbeat keep-warm** -- protects cache across idle gaps
2. **Enable `contextPruning.mode: "cache-ttl"`** -- prunes bloated history after cache expiry
3. **Default thinking to `low`** -- massive output token savings
4. **Lower `bootstrapMaxChars` to 15000** -- reduces per-session bootstrap injection
5. **Lower `imageMaxDimensionPx` to 800** -- if screenshots are common

### Tier 2: Behavioral discipline (this week)

6. **Split sessions after each task** -- the single biggest savings lever
7. **Use `claude` (not `claudep`) for simple tasks** -- skip personality overhead
8. **Reduce claudeception agent count** -- fewer parallel agents, same result
9. **Assign Sonnet to research/review sub-agents** -- 80% cheaper for suitable tasks
10. **Run `/compact` proactively** when context exceeds 50%

### Tier 3: Build tooling (this month)

11. **Embeddings-based memory retrieval MCP** -- replace prompt-stuffed memories
12. **Pre-computed project context tool** -- reduce exploratory tool calls
13. **Smart tool output compression MCP** -- smaller tool results, smaller history
14. **Batch API integration for automated tasks** -- 50% off non-interactive work

### Tier 4: Architectural (future)

15. **Custom context engine plugin** with semantic retrieval
16. **Task-based model routing** (Opus for complex, Sonnet for simple, local for trivial)
17. **Shared prompt cache across sub-agents** (would require Anthropic API changes)
18. **Conversation branching** -- fork context instead of rebuilding

---

## 11. Quick-Start Configuration

Apply these settings to `~/.openclaw/openclaw.json` immediately:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["anthropic/claude-sonnet-4-6"]
      },
      models: {
        "anthropic/claude-opus-4-6": {
          params: {
            cacheRetention: "long"
          }
        },
        "anthropic/claude-sonnet-4-6": {
          params: {
            cacheRetention: "short"
          }
        }
      },
      contextPruning: {
        mode: "cache-ttl",
        ttl: "1h"
      },
      heartbeat: {
        every: "55m"
      },
      bootstrapMaxChars: 15000,
      bootstrapTotalMaxChars: 100000,
      imageMaxDimensionPx: 800
    }
  },
  diagnostics: {
    cacheTrace: {
      enabled: true  // monitor cache behavior while optimizing
    }
  }
}
```

---

## Key Insight

The single most impactful change is **session discipline**: shorter, focused sessions with proactive compaction. The quadratic cost curve of context accumulation means that a 30-turn session costs roughly 4x what three 10-turn sessions cost for the same work. Combined with prompt caching configuration and thinking level management, this alone can cut daily costs by 40-50%.

The personality/memory system, while meaningful to the collaborative experience, adds ~28K tokens of overhead per session. This is well-managed by prompt caching during a session but creates a fixed cost on every new session start. The path forward is embeddings-based retrieval (already architecturally supported by OpenClaw) to replace bulk prompt injection.
