# Design Specification: neuralgentics-core v1

**Version**: 1.0  
**Date**: 2026-05-22  
**Status**: DESIGN (code scaffolded, server.py pending)  
**Target**: `neuralgentics/packages/core/`  
**Python**: 3.11+

---

## Table of Contents

1. [Component Overview & Communication Diagram](#1-component-overview--communication-diagram)
2. [File Structure](#2-file-structure)
3. [API Routes (FastAPI)](#3-api-routes-fastapi)
4. [LLM Client Design](#4-llm-client-design)
5. [Intent Broker Prompt Engineering](#5-intent-broker-prompt-engineering)
6. [Background Extractor Design](#6-background-extractor-design)
7. [Configuration (Environment Variables)](#7-configuration-environment-variables)
8. [Dependencies](#8-dependencies)
9. [Security Considerations](#9-security-considerations)
10. [Error Handling Strategy](#10-error-handling-strategy)

---

## 1. Component Overview & Communication Diagram

### 1.1 What neuralgentics-core Is

`neuralgentics-core` is an internal Python FastAPI service (port **8902**). It provides two capabilities:

1. **Intent-to-Tool Broker** — Maps natural-language user intents ("research something on the web") to specific MCP server + tool + arguments, using a local Qwen3-0.6B model for classification.
2. **Session Log Context Extractor** — Background asyncio task that periodically reads conversation logs, uses the same local model to extract key facts/decisions/actions, and posts them to `memini-core` for persistent memory.

Both capabilities share a single `LLMClient` instance that connects to a **local llama-server** (llama.cpp serving a GGUF model) on port 8903.

### 1.2 System Context Diagram

```
                          ┌──────────────────────────────────────────┐
                          │           OpenCode Base (TUI)            │
                          │                                          │
                          │  agent reads AGENTS.md → declarative     │
                          │  capabilities (NOT 100+ tool schemas)    │
                          └──────┬───────────────────┬───────────────┘
                                 │                   │
                    "intent: research the web"        │ writes session
                                 │                 logs to JSONL
                                 ▼                   │
┌────────────────────────────────────────────────────────────────────┐
│                     neuralgentics-core (port 8902)                 │
│                                                                    │
│  ┌───────────────────────┐        ┌─────────────────────────────┐ │
│  │   Intent-to-Tool      │        │  Session Log Context        │ │
│  │   Broker              │        │  Extractor (background)     │ │
│  │                       │        │                             │ │
│  │  POST /broker/        │        │  polls JSONL every 60s      │ │
│  │    resolve_intent     │        │  extracts facts/decisions   │ │
│  │                       │        │  posts to memini-core       │ │
│  └──────┬────────────────┘        └──────────┬──────────────────┘ │
│         │                                    │                    │
│         │  ┌─────────────────────┐          │                    │
│         │  │  CapabilityRegistry  │          │                    │
│         │  │  (JSON-backed,       │          │                    │
│         │  │   name+desc only)    │          │                    │
│         │  └─────────────────────┘          │                    │
│         │                                    │                    │
│         │  ┌─────────────────────┐          │                    │
│         └──►  LLMClient          ◄──────────┘                    │
│            │  (httpx singleton)  │                                │
│            │  OpenAI-compat API  │                                │
│            └─────────┬───────────┘                                │
└──────────────────────┼────────────────────────────────────────────┘
                       │ HTTP POST /v1/chat/completions
                       ▼
    ┌──────────────────────────────────────────────────────────┐
    │  llama-server (llama.cpp) — port 8903                    │
    │  Model: Qwen3-0.6B GGUF (UD-Q4_K_XL ~400MB)              │
    │  CPU-only inference                                       │
    └──────────────────────────────────────────────────────────┘

                       POST insights to /memory/add
                       │
                       ▼
    ┌──────────────────────────────────────────────────────────┐
    │  memini-core (FastAPI) — port 8900                        │
    │  PostgreSQL/pgvector — semantic memory                    │
    └──────────────────────────────────────────────────────────┘

    ┌──────────────────────────────────────────────────────────┐
    │  MCP Broker — port 8901                                   │
    │  (external tool proxying, NOT called by neuralgentics-    │
    │   core directly. Broker RESOLVES which server+tool to     │
    │   call; the orchestrator/plugin actually makes the call)  │
    └──────────────────────────────────────────────────────────┘
```

### 1.3 Port Allocation Summary

| Port | Service | Protocol | Role |
|------|---------|----------|------|
| 8900 | memini-core | HTTP JSON | Memory storage + retrieval |
| 8901 | MCP Broker | MCP over stdio | External tool proxy |
| **8902** | **neuralgentics-core** | **HTTP JSON** | **Intent broker + context extractor** |
| 8903 | llama-server | OpenAI-compat HTTP | Local LLM inference |

### 1.4 Information Flow: Intent Resolution

```
1. Agent expresses intent: "I need to search GitHub for open issues labeled 'bug'"
2. Orchestrator/Plugin sends: POST /broker/resolve_intent {intent, session_id}
3. neuralgentics-core:
   a. Loads CapabilityRegistry → formats as numbered list
   b. Constructs prompt: SYSTEM_PROMPT + capabilities + user intent
   c. Calls LLMClient.chat(messages) → receives JSON
   d. Parses: {"server":"github-mcp","tool":"search_issues","args":{"q":"bug label:bug"},"confidence":0.92}
   e. Returns ResolveIntentResponse
4. Orchestrator uses resolved server+tool+args to call MCP Broker: POST /call
5. MCP Broker proxies the call to the actual external MCP server
```

### 1.5 Architecture Principles

- **No MCP for native components.** `neuralgentics-core` communicates with llama-server and memini-core via plain HTTP JSON. MCP is strictly for external tool proxying through the separate broker on port 8901.
- **Token reduction.** The `CapabilityRegistry` stores only `name` + `description` — not full JSON schemas. This reduces the prompt tokens agents consume from ~8,000 (35 full tool schemas) to ~800 (declarative capability list).
- **Single model, shared client.** Both the broker and extractor use the same `LLMClient` singleton, initialized once at server startup via FastAPI lifespan.
- **Background, non-blocking.** The session extractor runs as an `asyncio.Task`; failures are logged and retried on the next cycle.

---

## 2. File Structure

### 2.1 Package Layout

```
packages/core/
├── pyproject.toml                    # Project metadata, deps, scripts
├── capabilities.json                 # Declarative capability registry (source of truth)
├── uv.lock                           # Lockfile (uv)
├── .venv/                            # Virtual environment
├── src/
│   └── neuralgentics_core/
│       ├── __init__.py               # Package metadata (__version__)
│       ├── config.py                 # pydantic-settings (NEURO_ prefix)
│       ├── models.py                 # Pydantic v2 request/response models
│       ├── llm.py                    # LLMClient: OpenAI-compat via httpx
│       ├── broker.py                 # CapabilityRegistry + resolve_intent()
│       ├── extractor.py              # SessionExtractor: background asyncio task
│       └── server.py                 # FastAPI app, routes, lifespan  ← TODO
└── tests/
    ├── __init__.py
    ├── conftest.py                   # Fixtures: mock LLM, test client
    ├── test_models.py                # Pydantic model validation
    ├── test_broker.py                # Intent resolution logic
    ├── test_extractor.py             # Extraction cycle + dedup
    └── test_server.py                # API route tests
```

### 2.2 File Responsibilities

| File | Status | Responsibility |
|------|--------|----------------|
| `config.py` | ✅ Implemented | Loads all settings from `NEURO_*` env vars. Provides `settings` singleton. |
| `models.py` | ✅ Implemented | Pydantic v2 models: `Capability`, `ResolveIntentRequest/Response`, `RegisterCapabilityRequest/Response`, `HealthResponse`. |
| `llm.py` | ✅ Implemented | `LLMClient` with `chat(messages) → str` and `health_check() → bool`. `get_llm_client()` singleton accessor. |
| `broker.py` | ✅ Implemented | `CapabilityRegistry` (JSON-backed, dynamic registration). `resolve_intent()` function. |
| `extractor.py` | ✅ Implemented | `SessionExtractor` class with `start()`, `stop()`, internal `_run_loop()`. |
| `capabilities.json` | ✅ Implemented | Source-of-truth capability list (18 entries). |
| **`server.py`** | ❌ **TODO** | FastAPI app with lifespan, routes, error handlers, startup initialization. |

### 2.3 Implementation Gap

The missing `server.py` must:

1. Create FastAPI app with title/version metadata.
2. Implement `lifespan` to initialize `LLMClient` singleton on startup, close on shutdown.
3. Wire routes: `POST /broker/resolve_intent`, `GET /broker/capabilities`, `POST /broker/capabilities`, `GET /extractor/status`, `GET /health`.
4. Start the `SessionExtractor` background task during lifespan startup.
5. Register exception handlers for structured error responses.
6. Add CORS middleware for local development.

---

## 3. API Routes (FastAPI)

### 3.1 Base URL

`http://localhost:8902`

All request/response bodies are `application/json`.

### 3.2 Route Table

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/broker/resolve_intent` | Resolve natural language intent → server + tool + args |
| `GET` | `/broker/capabilities` | List all registered capabilities |
| `POST` | `/broker/capabilities` | Dynamically register a new capability |
| `GET` | `/extractor/status` | Get extractor running status and stats |
| `GET` | `/health` | Liveness check + LLM connectivity |

### 3.3 `POST /broker/resolve_intent`

**Request:**

```json
{
  "intent": "search GitHub for open issues labeled bug",
  "session_id": "sess_abc123",
  "context": "User is working on the boomerang-v3 repository"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `intent` | `string` | Yes | Natural-language description of what the user wants |
| `session_id` | `string` | Yes | Session identifier for context tracking |
| `context` | `string` | No | Optional additional context to improve resolution |

**Response (200, high confidence):**

```json
{
  "server": "github-mcp",
  "tool": "search_issues",
  "args": {"q": "bug label:bug"},
  "confidence": 0.92,
  "requires_clarification": false
}
```

**Response (200, low confidence — requires clarification):**

```json
{
  "server": "none",
  "tool": "none",
  "args": {},
  "confidence": 0.15,
  "requires_clarification": true
}
```

**Response (500, LLM unavailable):**

```json
{
  "server": "none",
  "tool": "none",
  "args": {},
  "confidence": 0.0,
  "requires_clarification": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `server` | `string` | Target server name (e.g. `github-mcp`, `searxng`) or `"none"` |
| `tool` | `string` | Target capability/tool name or `"none"` |
| `args` | `object` | Extracted arguments for the tool (empty if none) |
| `confidence` | `float` | 0.0–1.0 confidence score |
| `requires_clarification` | `bool` | `true` when confidence < `confidence_threshold` (default 0.7) |

### 3.4 `GET /broker/capabilities`

**Response (200):**

```json
{
  "capabilities": [
    {"name": "web_search", "description": "Search the web for information using a search engine query"},
    {"name": "github_search_issues", "description": "Search GitHub for issues by query string, owner, or repository"},
    {"name": "memory_query", "description": "Search semantic memory for relevant past context, decisions, or facts"}
  ],
  "count": 18
}
```

### 3.5 `POST /broker/capabilities`

**Request:**

```json
{
  "name": "web_search",
  "description": "Search the web for information using a search engine query"
}
```

**Response (200):**

```json
{
  "name": "web_search",
  "status": "registered"
}
```

Dynamic registration **overwrites** existing capabilities with the same name.

### 3.6 `GET /extractor/status`

**Response (200):**

```json
{
  "enabled": true,
  "running": true,
  "log_file": "~/.config/neuralgentics/sessions/latest.jsonl",
  "interval": 60,
  "insights_posted": 42,
  "last_cycle_at": "2026-05-22T14:30:00Z",
  "last_error": null
}
```

### 3.7 `GET /health`

**Response (200, all OK):**

```json
{
  "status": "ok",
  "version": "0.1.0",
  "llm_connected": true,
  "extractor_running": true,
  "capabilities_loaded": 18
}
```

**Response (200, LLM down — degraded):**

```json
{
  "status": "degraded",
  "version": "0.1.0",
  "llm_connected": false,
  "extractor_running": false,
  "capabilities_loaded": 18
}
```

---

## 4. LLM Client Design

### 4.1 Architecture

```
LLMClient (singleton)
├── chat(messages: list[dict], temperature=0.3, max_tokens=512) → str
├── health_check() → bool
├── close() → None
└── _get_client() → httpx.AsyncClient (lazy init)
```

### 4.2 Design Decisions

| Decision | Rationale |
|----------|-----------|
| **httpx instead of openai SDK** | Minimal dependency footprint. llama-server's API is OpenAI-compatible but not a full OpenAI endpoint. httpx is already a project dependency. |
| **Lazy `_get_client()`** | Avoids creating the httpx client at import time. Only allocated on first actual use. Supports clean reconnection if the client is closed. |
| **Singleton via `init_llm_client()` / `get_llm_client()`** | Both the broker and extractor share one client. Initialized once during FastAPI lifespan startup. |
| **`RuntimeError` on uninitialized access** | `get_llm_client()` raises if called before `init_llm_client()`. Prevents silent failures from misconfigured startup order. |
| **`health_check()` hits `/models`** | llama-server exposes `GET /v1/models` for lightweight liveness checks. Does not consume inference capacity. |

### 4.3 Chat Completion Flow

```
LLMClient.chat(messages, temperature, max_tokens)
  │
  ├─ _get_client() → lazy httpx.AsyncClient(timeout=settings.llm_timeout)
  │
  ├─ Build payload:
  │   {
  │     "model": "qwen3-0.6b",
  │     "messages": [...],
  │     "temperature": 0.3,
  │     "max_tokens": 512
  │   }
  │
  ├─ POST {base_url}/chat/completions
  │
  ├─ httpx.raise_for_status() → HTTPStatusError on 4xx/5xx
  │
  └─ Extract: data["choices"][0]["message"]["content"]
       Returns raw string (broker/extractor do their own JSON parsing)
```

### 4.4 Timeout & Retry

- **Single-request timeout**: `llm_timeout` (default 30s), enforced at the httpx client level.
- **No built-in retry.** Retry logic belongs in callers (`broker.py`, `extractor.py`) where context-specific decisions can be made (retry vs. graceful degradation).
- **Exponential backoff recommendation** for the extractor (it's non-user-facing): 1s → 2s → 4s → 8s, max 3 attempts, then skip cycle.

### 4.5 Temperature Strategy

| Use Case | Temperature | Rationale |
|----------|-------------|-----------|
| Intent resolution | `0.2` | Deterministic tool matching — need reproducible results |
| Context extraction | `0.1` | Fact extraction — should be maximally faithful to logs |

Both values are intentionally low because creative generation is not desired for either task.

---

## 5. Intent Broker Prompt Engineering

### 5.1 System Prompt (Current)

```text
You are a tool-matching assistant. Given a list of capabilities and a user intent,
select the SINGLE BEST capability and extract any arguments.

Respond ONLY with valid JSON in this exact format:
{"server": "<server>", "tool": "<capability>", "args": {<key:val>}, "confidence": <0.0-1.0>}

Rules:
- Pick exactly one capability from the list that best matches the intent.
- Extract relevant args from the intent text.
- Set confidence high (0.8-1.0) for clear matches, medium (0.5-0.7) for partial.
- If no capability matches, set tool to "none", server to "none", confidence to 0.1.
- Do NOT include any text outside the JSON object.
```

### 5.2 User Message Format

```
Capabilities:
1. github_search_issues: Search GitHub for issues by query string, owner, or repository
2. web_search: Search the web for information using a search engine query
3. memory_query: Search semantic memory for relevant past context, decisions, or facts
...

Intent: search GitHub for open issues labeled bug
Context: User is working on the boomerang-v3 repository
```

### 5.3 Prompt Engineering Analysis

**Strengths:**
- Explicit JSON-only output constraint minimizes parsing failures.
- Confidence scoring enables fallback/clarification flow.
- Numbered capability list is efficient for small models (Qwen3-0.6B).

**Limitations (current implementation):**

| Issue | Severity | Description |
|-------|----------|-------------|
| No server name in output | **HIGH** | Prompt says `"server": "<server>"` but the capability list doesn't include which server each tool belongs to. Need to map tool → server after LLM response or include it in the capabilities list. |
| No examples in prompt | MEDIUM | Zero-shot prompting may produce inconsistent output on edge cases. 1-2 few-shot examples would improve reliability for Qwen3-0.6B. |
| Qwen3 thinking tokens | LOW | Qwen3 models may emit `</think>...` prefix. The JSON parser (`_parse_llm_response`) handles this via regex, but it's fragile. |
| No validation of tool name | MEDIUM | LLM may hallucinate a tool name not in the registry. Post-response validation needed. |

### 5.4 Improved System Prompt (Recommended)

```text
You are a tool-matching assistant. Given a list of available tools and a user intent,
you must select exactly ONE tool that best matches the intent and extract any arguments.

Available tools are listed below as "tool_name (server_name): description".
Output ONLY a single JSON object in this exact format:

{"tool": "<tool_name>", "args": {<key>: <value>}, "confidence": <float_0_to_1>}

Rules:
- Choose the ONE tool from the list that best matches the intent.
- Extract relevant arguments from the intent text as key-value pairs.
- If no tool matches, set tool to "none", confidence to 0.0.
- Confidence: 0.85-1.0 for exact matches, 0.60-0.84 for partial matches, below 0.60 for weak matches.
- Output ONLY the JSON object. No markdown, no explanation, no code blocks.
- Do NOT include any text outside the JSON braces.

Example 1:
User: "search the web for Python async patterns"
Output: {"tool": "web_search", "args": {"q": "Python async patterns"}, "confidence": 0.95}

Example 2:
User: "what's the weather like today?"
Output: {"tool": "none", "args": {}, "confidence": 0.0}
```

**User message format (updated):**

```
Tools:
1. github_search_issues (github-mcp): Search GitHub for issues by query string, owner, or repository
2. web_search (searxng): Search the web for information using a search engine query
3. memory_query (memini-core): Search semantic memory for relevant past context, decisions, or facts
...

Intent: search GitHub for open issues labeled bug
```

### 5.5 Post-LLM Validation (Recommended Code Path)

After parsing the LLM response:

```
parsed = _parse_llm_response(raw)
↓
1. Check if "tool" exists in parsed → if not, fallback
2. Look up tool_name in CapabilityRegistry.get_capability(tool)
   → If not found, confidence = 0.0, requires_clarification = true
3. Resolve server from registry (each capability maps to a server)
4. Clamp confidence to [0.0, 1.0]
5. requires_clarification = confidence < settings.confidence_threshold
```

### 5.6 Capability-to-Server Mapping

The `CapabilityRegistry` currently stores flat `{name: Capability}`. To support server resolution, each capability should include its server origin. The `Capability` model should be extended:

```python
class Capability(BaseModel):
    name: str          # e.g., "web_search"
    description: str   # e.g., "Search the web..."
    server: str = ""   # e.g., "searxng"     ← NEW FIELD (backward-compat default "")
```

And `capabilities.json` updated:

```json
[
  {"name": "web_search",       "server": "searxng",       "description": "Search the web..."},
  {"name": "github_search_issues", "server": "github-mcp","description": "Search GitHub..."},
  {"name": "memory_query",     "server": "memini-core",   "description": "Search semantic memory..."}
]
```

### 5.7 Token Budget

| Component | Approximate Tokens |
|-----------|-------------------|
| System prompt (~250 words) | ~180 tokens |
| Capability list (18 entries, ~15 words each) | ~270 tokens |
| User intent + context | ~30-100 tokens |
| **Total prompt** | **~480-550 tokens** |
| Max response | 256 tokens |

Total per resolution: ~750 tokens. At Qwen3-0.6B CPU inference, expect latency of **2-5 seconds** per resolution.

---

## 6. Background Extractor Design

### 6.1 Architecture

```
SessionExtractor
├── start() → asyncio.create_task(_run_loop())
├── stop() → cancel task + close HTTP client
├── _run_loop() → while True: _extract_cycle() → sleep(interval)
├── _extract_cycle() → read log → LLM extract → post to memini-core
├── _parse_insights(raw) → list[dict]
└── _post_to_memini(content, type) → bool
```

### 6.2 Extraction Cycle (every 60 seconds)

```
1. Read log file → list of JSON objects (last 50 entries only)
   ├─ File not found? → skip cycle (defer to next interval)
   └─ Empty file? → skip cycle
2. Format: dump last 50 entries as JSON string
3. Send to LLM:
   └─ System: EXTRACTION_PROMPT
   └─ User:   "Session logs:\n{json_text}"
4. Parse LLM response → list of {"content": str, "type": str}
5. For each insight:
   ├─ Compute SHA-256 checksum of content
   ├─ If checksum in _seen_checksums → skip (dedup)
   ├─ POST to memini-core: /memory/add
   │   payload: {content, source_type: "session", metadata: {...}}
   └─ Add checksum to _seen_checksums
```

### 6.3 Log File Format (JSONL)

Expected location: `~/.config/neuralgentics/sessions/latest.jsonl`

Each line is a JSON object. Example entries:

```jsonl
{"timestamp": "2026-05-22T14:25:00Z", "type": "agent_message", "agent": "boomerang-coder", "content": "Implementing the broker resolve_intent endpoint"}
{"timestamp": "2026-05-22T14:25:30Z", "type": "tool_call", "tool": "write_file", "params": "...", "result": "success"}
{"timestamp": "2026-05-22T14:26:00Z", "type": "user_message", "content": "Can you also add error handling?"}
{"timestamp": "2026-05-22T14:26:30Z", "type": "decision", "agent": "boomerang-architect", "content": "Using httpx instead of openai SDK for minimal footprint"}
```

The extractor is format-agnostic: it passes raw JSON objects to the LLM, which extracts semantics irrespective of schema.

### 6.4 Extraction Prompt

```text
You are a context extraction assistant. Given session log entries, extract the most important:
- Key facts
- Decisions made
- Action items

Respond with a JSON array of objects, each with "content" and "type" fields.
Types: "fact", "decision", "action_item".

Example:
[{"content": "User prefers dark mode", "type": "fact"},
 {"content": "Switch to PostgreSQL", "type": "decision"}]

If the logs contain nothing noteworthy, return an empty array: []
Respond ONLY with the JSON array, no other text.
```

### 6.5 Dedup Strategy

| Mechanism | Description |
|-----------|-------------|
| **SHA-256 checksum** | Each insight's content is hashed. Hash is compared against in-memory `_seen_checksums` set. |
| **Last-50-entries window** | Only the most recent 50 log lines are processed per cycle. Avoids reprocessing ancient history. |
| **No memini-core dedup** | The extractor trusts its own checksums. It does NOT query memini-core to check for duplicates (would create a dependency loop). |

**Limitation:** Checksum-based dedup is **exact-match only**. Slight phrasing variations ("User prefers dark mode" vs "User likes dark mode") will produce different checksums and may be stored as duplicate insights. This is acceptable given the extractor's background/non-critical nature.

### 6.6 memini-core POST Payload

```python
{
    "content": "User prefers PostgreSQL for local development",
    "source_type": "session",
    "metadata": {
        "extracted_by": "neuralgentics-core",
        "insight_type": "fact",       # "fact" | "decision" | "action_item"
        "extracted_at": "2026-05-22T14:30:00Z"
    }
}
```

Target endpoint: `POST {memini_core_url}/memory/add`

### 6.7 Error Recovery

| Scenario | Behavior |
|----------|----------|
| Log file missing | Log debug, skip cycle |
| Log file unreadable | Log exception, skip cycle |
| LLM call fails | Log exception, skip cycle (no crash) |
| memini-core POST fails | Log exception per insight, continue |
| Empty insights from LLM | Log debug, skip cycle |
| Malformed JSONL line | Log debug, skip that line only |

**Crucially:** The extractor never crashes the server. All errors are caught per-cycle and logged.

---

## 7. Configuration (Environment Variables)

All settings use the `NEURO_` prefix (configured via `pydantic-settings` `model_config`).

### 7.1 Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NEURO_HOST` | `0.0.0.0` | Bind address for the FastAPI server |
| `NEURO_PORT` | `8902` | Listen port |
| `NEURO_LLM_BASE_URL` | `http://localhost:8903/v1` | Base URL of the OpenAI-compatible LLM endpoint (llama-server) |
| `NEURO_LLM_MODEL` | `qwen3-0.6b` | Model name to pass in chat completion requests |
| `NEURO_LLM_TIMEOUT` | `30.0` | HTTP timeout (seconds) for LLM requests |
| `NEURO_CONFIDENCE_THRESHOLD` | `0.7` | Below this, `requires_clarification` is set to `true` |
| `NEURO_CAPABILITIES_PATH` | `[package_dir]/capabilities.json` | Path to the capabilities JSON file |
| `NEURO_EXTRACTOR_ENABLED` | `true` | Whether the background extractor runs |
| `NEURO_LOG_FILE_PATH` | `~/.config/neuralgentics/sessions/latest.jsonl` | Path to the session log JSONL file |
| `NEURO_EXTRACTOR_INTERVAL` | `60` | Seconds between extraction cycles |
| `NEURO_MEMINI_CORE_URL` | `http://localhost:8900` | Base URL of the memini-core HTTP API |

### 7.2 Example .env

```bash
# neuralgentics/packages/core/.env
NEURO_LLM_BASE_URL=http://localhost:8903/v1
NEURO_LLM_MODEL=qwen3-0.6b
NEURO_CONFIDENCE_THRESHOLD=0.65
NEURO_EXTRACTOR_ENABLED=true
NEURO_EXTRACTOR_INTERVAL=120
NEURO_MEMINI_CORE_URL=http://localhost:8900
```

### 7.3 Startup Command

```bash
# Development
cd neuralgentics/packages/core
uv run neuralgentics-core

# Or: uv run python -m neuralgentics_core.server

# With custom config
NEURO_PORT=8999 NEURO_LLM_TIMEOUT=60 uv run neuralgentics-core
```

---

## 8. Dependencies

### 8.1 `pyproject.toml` (Current)

```toml
[project]
name = "neuralgentics-core"
version = "0.1.0"
description = "Intent-to-Tool Broker and Session Log Context Extractor for Neuralgentics"
requires-python = ">=3.11"
dependencies = [
    "fastapi>=0.115",
    "uvicorn[standard]>=0.32",
    "pydantic>=2.9",
    "pydantic-settings>=2.5",
    "httpx>=0.27",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0",
    "pytest-asyncio>=0.24",
    "ruff>=0.4",
]
```

### 8.2 Dependency Rationale

| Dependency | Version | Role | Why This, Not That |
|------------|---------|------|---------------------|
| `fastapi` | ≥0.115 | HTTP server + OpenAPI docs | Standard for Python async HTTP. Minimal overhead. |
| `uvicorn` | ≥0.32 | ASGI server | Fast, production-ready, standard with FastAPI. |
| `pydantic` | ≥2.9 | Request/response validation | v2 is required (v1 style deprecated). Type-safe. |
| `pydantic-settings` | ≥2.5 | Env var loading | Reads `NEURO_*` vars. Better than manual `os.getenv`. |
| `httpx` | ≥0.27 | Async HTTP client | Used for both LLM inference AND memini-core POSTs. No additional HTTP lib needed. |
| `pytest` | ≥8.0 | Testing | Standard. |
| `pytest-asyncio` | ≥0.24 | Async test support | Needed because all I/O is async. |
| `ruff` | ≥0.4 | Linting + formatting | Fast, single binary, project standard. |

### 8.3 What's NOT Included (Intentional Omissions)

| Library | Reason for Omission |
|---------|---------------------|
| `openai` SDK | llama-server API is simple enough for raw httpx. Avoids large dependency. |
| `aiohttp` | httpx already covers all HTTP needs (sync + async). |
| `python-dotenv` | pydantic-settings handles `.env` loading natively. |
| `celery` / `arq` | Background task is simple enough for `asyncio.Task`. No task queue needed. |
| `structlog` | Standard `logging` module is sufficient at this scale. |
| `tenacity` | Retry logic is simple and domain-specific; custom loop is clearer. |

### 8.4 Version Compatibility

- Python **3.11+** (uses `Self` type, `asyncio.TaskGroup`, match-case)
- llama-server must serve an OpenAI-compatible `/v1/chat/completions` endpoint
- memini-core API must accept `POST /memory/add` with the schema defined above
- PostgreSQL **15+** with pgvector for memini-core (not directly used by neuralgentics-core)

---

## 9. Security Considerations

### 9.1 Trust Model

`neuralgentics-core` is an **internal service** running on `localhost`. It is not exposed to the network. Security focuses on input validation, safe defaults, and defense-in-depth rather than authentication.

| Boundary | Risk | Mitigation |
|----------|------|------------|
| No auth on API | Any local process can call the broker resolver | Bind to `127.0.0.1` in production (not `0.0.0.0`). Document that this is local-only. |
| LLM prompt injection | Malicious intent text could manipulate model behavior | Intent text is embedded within a structured JSON request sent to a local model; the model cannot access external systems. Worst case: incorrect tool selection. |
| Session log reading | Extractor reads user conversation data | Log file path is configurable but defaults to a known location. File is read-only (extractor never writes). |
| memini-core POST | Insights posted to memory may contain sensitive info | memini-core is also local-only. Extractor strips nothing — assumes the log content is already sanitized. |

### 9.2 Input Validation

All request bodies are validated by Pydantic v2:

| Field | Validation |
|-------|-----------|
| `intent` | Required `str`, min length 1, max length 2000 |
| `session_id` | Required `str`, min length 1, max length 255 |
| `context` | Optional `str`, max length 5000 |

Pydantic automatically rejects malformed JSON, missing required fields, and type violations.

### 9.3 LLM Response Safety

- The LLM response is **never executed as code**. It is parsed as JSON only.
- If JSON parsing fails, defaults are returned: `{"tool": "none", "confidence": 0.0}`.
- No shell commands are constructed from LLM output. The tool name and args are forwarded as structured data to the caller (orchestrator), which is responsible for safe invocation.

### 9.4 No Authentication (by Design)

`neuralgentics-core` has **no authentication layer**. This is intentional:

1. All services (ports 8900-8903) run on localhost only.
2. Adding auth would require token management across 4+ services with marginal security gain in a single-machine development environment.
3. If network exposure is ever needed, a reverse proxy (nginx/Caddy) with mTLS should be placed in front, not baked into the service.

### 9.5 CORS

For local development with browser-based debugging tools, the FastAPI app should allow CORS from `localhost` origins:

```python
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:*"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)
```

### 9.6 Dependency Supply Chain

- All dependencies are pinned in `uv.lock`.
- `safety check` or `pip-audit` should be run in CI.
- No dependencies fetch models at runtime (model must be pre-downloaded and served by llama-server).

---

## 10. Error Handling Strategy

### 10.1 Principles

1. **Graceful degradation over crashing.** The service should stay alive even when dependencies (LLM, memini-core) are unavailable.
2. **Structured error responses.** Every error response uses a consistent JSON envelope.
3. **Caller decides retry.** The broker API returns clear error states; the caller (orchestrator) decides whether to retry or fall back.
4. **Log everything.** All errors are logged at appropriate levels (warning for transient, error for persistent).

### 10.2 Error Response Envelope

All non-200 responses follow this format:

```json
{
  "error": {
    "code": "LLM_UNAVAILABLE",
    "message": "The LLM inference server at http://localhost:8903/v1 is not responding",
    "detail": "Connection refused after 3 attempts"
  }
}
```

### 10.3 Error Codes

| HTTP Status | Code | When |
|-------------|------|------|
| 400 | `VALIDATION_ERROR` | Pydantic validation failure (malformed request) |
| 404 | `NOT_FOUND` | Unknown route or resource |
| 500 | `LLM_UNAVAILABLE` | llama-server not reachable |
| 500 | `LLM_TIMEOUT` | llama-server took too long |
| 500 | `LLM_PARSE_ERROR` | LLM returned unparseable response |
| 500 | `MEMINI_UNAVAILABLE` | memini-core not reachable |
| 500 | `INTERNAL_ERROR` | Unexpected server error |
| 503 | `SERVICE_DEGRADED` | Service running but LLM health check failed |

### 10.4 Broker Error Handling Flow

```
resolve_intent(request)
  │
  ├─ Try: LLMClient.chat(messages)
  │   ├─ Success → parse JSON → return ResolveIntentResponse
  │   ├─ httpx.TimeoutException → return {confidence: 0.0, requires_clarification: true}
  │   ├─ httpx.HTTPStatusError → return {confidence: 0.0, requires_clarification: true}
  │   └─ json.JSONDecodeError (LLM response) → return {confidence: 0.0, requires_clarification: true}
  │
  └─ All paths return a valid ResolveIntentResponse.
     NO exception propagates to FastAPI layer.
```

The broker **never raises exceptions** for LLM failures. It always returns a response with `confidence: 0.0` and `requires_clarification: true` on failure. This allows the orchestrator to implement retry logic or prompt the user for clarification.

### 10.5 Extractor Error Handling Flow

```
_run_loop()
  │
  ├─ while True:
  │   └─ Try: _extract_cycle()
  │       ├─ asyncio.CancelledError → propagate (clean shutdown)
  │       └─ Any other Exception → log.exception(), continue loop
  │   └─ await asyncio.sleep(interval)
  │
_extract_cycle()
  │
  ├─ FileNotFoundError → log debug, return (skip cycle)
  ├─ OSError → log exception, return (skip cycle)
  ├─ json.JSONDecodeError (per-line) → log debug, skip that line
  ├─ LLM call failure → log exception, return (skip cycle)
  ├─ LLM response parse failure → log warning, return (skip cycle)
  └─ memini-core POST failure → log exception per insight, continue posting others
```

The extractor uses **defensive per-error handling**: a failure in one step never prevents processing of remaining steps in the same cycle (where possible), and a failed cycle never prevents the next scheduled cycle.

### 10.6 FastAPI Exception Handlers

The `server.py` should register handlers for unhandled exceptions that escape the route handlers:

```python
@app.exception_handler(httpx.TimeoutException)
async def llm_timeout_handler(request, exc):
    return JSONResponse(
        status_code=500,
        content={"error": {"code": "LLM_TIMEOUT", "message": str(exc)}}
    )

@app.exception_handler(Exception)
async def generic_exception_handler(request, exc):
    logger.exception("Unhandled exception")
    return JSONResponse(
        status_code=500,
        content={"error": {"code": "INTERNAL_ERROR", "message": "Internal server error"}}
    )
```

### 10.7 Logging Strategy

| Level | When |
|-------|------|
| `INFO` | Service startup/shutdown, capability loaded, insight posted count, registration events |
| `WARNING` | LLM parse failures, memini-core POST failures (transient), empty extraction results |
| `ERROR` | Persistent failures (3+ consecutive failed cycles), unhandled exceptions |
| `DEBUG` | Per-cycle extraction details, LLM request/response contents (development only) |

Configure via standard `logging` module or `LOG_LEVEL` env var. No structured logging library needed at this scale.

### 10.8 Startup Dependency Check

On server startup (FastAPI lifespan), the app should:

1. Initialize `LLMClient` singleton.
2. Run `llm_client.health_check()`.
3. Load `CapabilityRegistry` from file.
4. If LLM check fails → log warning, start in **degraded mode** (health endpoint returns `"status": "degraded"`).
5. Start `SessionExtractor` background task.
6. Log readiness: `"neuralgentics-core ready on 0.0.0.0:8902 (LLM: healthy, extractor: enabled)"`

---

## Appendix A: Sequence Diagram — Full Intent Resolution Flow

```
Orchestrator        neuralgentics-core      llama-server        MCP Broker       github-mcp
    │                      │                      │                  │                │
    │ POST /broker/        │                      │                  │                │
    │   resolve_intent     │                      │                  │                │
    │─────────────────────►│                      │                  │                │
    │                      │                      │                  │                │
    │                      │ POST /v1/chat/       │                  │                │
    │                      │   completions        │                  │                │
    │                      │─────────────────────►│                  │                │
    │                      │                      │                  │                │
    │                      │    {"tool":"github_  │                  │                │
    │                      │     search_issues",  │                  │                │
    │                      │     "args":{...},    │                  │                │
    │                      │     "confidence":0.92}                  │                │
    │                      │◄─────────────────────│                  │                │
    │                      │                      │                  │                │
    │    ResolveIntentResp │                      │                  │                │
    │◄─────────────────────│                      │                  │                │
    │                      │                      │                  │                │
    │ POST /call           │                      │                  │                │
    │  {server:"github-mcp", tool:"search_issues", args:{...}}       │                │
    │─────────────────────────────────────────────►│                  │                │
    │                      │                      │                  │                │
    │                      │                      │  JSON-RPC call   │                │
    │                      │                      │─────────────────►│                │
    │                      │                      │                  │                │
    │                      │                      │       result     │                │
    │                      │                      │◄─────────────────│                │
    │                      │                      │                  │                │
    │    tool result       │                      │                  │                │
    │◄─────────────────────────────────────────────│                  │                │
```

---

## Appendix B: Implementation Checklist

- [ ] **server.py** — Create FastAPI app with lifespan, routes, CORS, error handlers
- [ ] **models.py** — Add `server` field to `Capability` model
- [ ] **capabilities.json** — Add `server` field to all 18 entries
- [ ] **broker.py** — Format capability list with server names; add post-LLM validation
- [ ] **config.py** — Add `LOG_LEVEL` setting
- [ ] **tests/conftest.py** — Mock LLMClient fixture, test FastAPI client
- [ ] **tests/test_server.py** — Route tests: health, resolve_intent, capabilities, extractor status
- [ ] **tests/test_broker.py** — Intent resolution with mock LLM: happy path, no match, LLM down
- [ ] **tests/test_extractor.py** — Extraction cycle: valid logs, empty logs, dedup, memini-core down
- [ ] **Docker Compose** — Add neuralgentics-core service to `docker-compose.yml`
- [ ] **scripts/serve.sh** — Add neuralgentics-core startup to serve script
- [ ] **docs/ARCHITECTURE_PLAN_V5.md** — Update component status to show neuralgentics-core server.py as complete

---

## Appendix C: Key Design Decisions Log

| # | Decision | Rationale | Date |
|---|----------|-----------|------|
| 1 | Use httpx directly instead of `openai` SDK | llama-server is OpenAI-compatible but not a full OpenAI endpoint. httpx is already a dependency. | 2026-05-22 |
| 2 | Singleton LLM client shared by broker + extractor | Avoids duplicate connections to llama-server. Simple lifecycle via FastAPI lifespan. | 2026-05-22 |
| 3 | Broker returns valid response even on LLM failure (confidence=0.0) | Graceful degradation. Orchestrator decides retry vs. fallback vs. user prompt. | 2026-05-22 |
| 4 | No authentication layer | All services localhost-only. Auth would add complexity without meaningful security gain. | 2026-05-22 |
| 5 | Capability registry is JSON-backed, not database-backed | Simple, version-controllable, no DB dependency for neuralgentics-core. | 2026-05-22 |
| 6 | Extractor stores SHA-256 checksums in-memory, not in DB | Avoids memini-core dependency loop. Acceptable for background/non-critical task. | 2026-05-22 |
| 7 | Qwen3-0.6B as the default model | 600M params, fits in ~400MB RAM (Q4_K_XL), runs on CPU. Sufficient for classification/extraction tasks. | 2026-05-22 |
| 8 | Capability list includes server name in user message (not in JSON output) | Keeps LLM output simple; server resolution is a deterministic post-processing step. | 2026-05-22 |
| 9 | Port 8902 for neuralgentics-core | Adjacent to memini-core (8900) and broker (8901). Creates a logical service port range. | 2026-05-22 |
| 10 | Pydantic v2 with `model_config` env_prefix | Clean env var management without manual `os.getenv` calls. | 2026-05-22 |

---

*This design document supersedes any inline design comments in the source files. Implementation must follow this specification. Questions or deviations should be raised as review items before code changes.*
