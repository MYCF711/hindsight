# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hindsight is an agent memory system that provides long-term memory for AI agents using biomimetic data structures. Memories are organized as:
- **World facts**: General knowledge ("The sky is blue")
- **Experience facts**: The agent's own experiences ("I visited Paris in 2023")
- **Observations**: Beliefs consolidated automatically from several facts, with their evidence ("User prefers functional programming patterns")
- **Mental models**: Curated standing answers to a question, rewritten as the bank learns

## Development Commands

### Local Development (API + UI)
```bash
# Start both API server and control plane UI
./scripts/dev/start.sh
```

### API Server (Python/FastAPI)
```bash
# Start API server only (loads .env automatically)
./scripts/dev/start-api.sh

# Run all tests (parallelized with pytest-xdist)
cd hindsight-api-slim && uv run pytest tests/

# Run specific test file
cd hindsight-api-slim && uv run pytest tests/test_http_api_integration.py -v

# Run single test function
cd hindsight-api-slim && uv run pytest tests/test_retain.py::test_retain_with_chunks -v

# Lint and format
cd hindsight-api-slim && uv run ruff check .
cd hindsight-api-slim && uv run ruff format .

# Type checking (uses ty - extremely fast type checker from Astral)
cd hindsight-api-slim && uv run ty check hindsight_api/
```

### Control Plane (Next.js)
```bash
./scripts/dev/start-control-plane.sh
# Or manually:
cd hindsight-control-plane && npm run dev

# Run frontend unit tests
cd hindsight-control-plane && npm test

# Run frontend linter
cd hindsight-control-plane && npm run lint
```

### CLI Tool (Rust)
```bash
# Build CLI binary (hindsight-cli/target/release/hindsight)
cd hindsight-cli && cargo build --release

# Run CLI tests
cd hindsight-cli && cargo test
```

### System Tests (Blackbox End-to-End)
```bash
# Prerequisite: server needs pg0 installed in api-slim
(cd hindsight-api-slim && uv sync --frozen --extra embedded-db)

# Run blackbox integration tests against local embedded Postgres & stub provider
# (The stub handles LLM, embeddings, and reranking without downloading models)
cd hindsight-system-tests && uv run pytest tests/ -v
```

### Documentation Site (Docusaurus)
```bash
./scripts/dev/start-docs.sh
```


### Generating Clients/OpenAPI
```bash
# Regenerate the OpenAPI spec after changing an endpoint
./scripts/generate-openapi.sh

# Regenerate all client SDKs (Python, TypeScript, Rust, Go)
./scripts/generate-clients.sh
```

### Benchmarks
```bash
# Accuracy benchmarks: LoComo, LongMemEval, BEAM and the coding-agent suite come
# from AMB (vectorize-io/agent-memory-benchmark), which owns their datasets,
# judge and scoring. Run them against a local server, or any deployment with
# --api-url. See hindsight-system-evals/README.md.
cd hindsight-system-evals
uv run run-amb --dataset locomo --split locomo10
uv run run-amb --dataset longmemeval --split s -- --category single-session-user

# Performance benchmarks
./scripts/benchmarks/run-perf-test.sh                      # System perf (mock LLM + pg0)
./scripts/benchmarks/run-perf-test.sh --scale tiny          # Quick smoke test
./scripts/benchmarks/run-consolidation.sh
```

## Architecture

### Monorepo Structure
- **hindsight-api-slim/**: Core FastAPI server with memory engine (Python, uv)
- **hindsight-api/**: Published distribution package providing `hindsight-api`, `hindsight-worker`, `hindsight-local-mcp`, and `hindsight-admin` CLI entrypoints
- **hindsight-all/** & **hindsight-all-slim/**: Full and slim standalone distribution bundle packages
- **hindsight-all-npm/**: Node.js lifecycle manager embedding local daemon (published as `@vectorize-io/hindsight-all`)
- **hindsight-control-plane/**: Admin UI (Next.js, npm)
- **hindsight-cli/**: CLI tool (Rust, cargo, uses progenitor for API client)
- **hindsight-clients/**: Generated SDK clients (Python, TypeScript, Rust, Go)
- **hindsight-docs/**: Docusaurus documentation site
- **hindsight-integrations/**: Framework integrations (LiteLLM, CrewAI, LangGraph, Pydantic AI, AG2, Claude Code, coding-agents, etc.)
- **hindsight-embed/**: Embedded Python CLI and local daemon manager (connects to local API or falls back to uvx hindsight-api)
- **hindsight-system-tests/**: Blackbox end-to-end integration test suite driven through SDK against local stubs
- **hindsight-system-evals/**: End-to-end quality evaluation suites scored by independent LLM judges against real providers
- **hindsight-integration-tests/**: E2E and integration test suites requiring a running server (live API or docker-compose)
- **hindsight-extensions/**: Server extension slots (tenancy/auth, HTTP endpoints, MCP tools, operation validators, memory defense)
- **hindsight-tools/**: Published agent tools SDK (`@vectorize-io/hindsight-agent-sdk`, harness-agnostic agent knowledge tools)
- **hindsight-dev/**: Development tools and benchmarks

### Core Engine (hindsight-api-slim/hindsight_api/engine/)
- `memory_engine.py`: Main orchestrator for retain/recall/reflect operations
- `llm_wrapper.py`: LLM abstraction supporting OpenAI, Anthropic, Gemini, VertexAI, Groq, MiniMax, Ollama, LM Studio, LiteLLM, Claude Code, GitHub Copilot, DeepSeek, Fireworks, Codex (openai-codex), xAI (xai-oauth), Llama.cpp, Nous, etc. (See `hindsight-docs/docs/developer/configuration.mdx` for full provider lists)
- `embeddings.py`: Embedding generation supporting local (SentenceTransformers) and standalone/remote providers (in-process: onnx; remote: tei, openai, cohere, zeroentropy, litellm, google, etc.)
- `cross_encoder.py`: Reranking supporting local (CrossEncoder) and standalone/remote providers (in-process: flashrank, jina-mlx; remote: tei, cohere, siliconflow, zeroentropy, litellm, google, alibaba, etc.)
- `query_analyzer.py`: Query intent analysis

**retain/**: Memory ingestion pipeline
- `orchestrator.py`: Coordinates the retain flow
- `fact_extraction.py`: LLM-based fact extraction from content

**search/**: Multi-strategy retrieval
- `retrieval.py`: Main retrieval orchestrator
- `graph_retrieval.py`: Graph retrieval abstract base class
- `fusion.py`: Reciprocal rank fusion for combining results
- `reranking.py`: Cross-encoder reranking

**memories/**: The memories store, which owns every table a memory touches (`base.py` is the interface, `postgres.py` + `pg/` the default Postgres store — the only code allowed to name those tables)
- `pg/entity_resolver.py`: Entity extraction and normalization
- `pg/links.py`: Entity link creation and management
- `pg/link_expansion.py`: Link expansion graph retrieval

### API Layer (hindsight-api-slim/hindsight_api/api/)
- `http.py`: FastAPI HTTP routers for all REST endpoints
- `mcp.py`: Model Context Protocol server implementation

Main operations:
- **Retain**: Store memories, extracts facts/entities/relationships, supports document chunking
- **Recall**: Retrieve memories via 4 parallel strategies (semantic, BM25, graph, temporal) + reranking
- **Reflect**: Disposition-aware reasoning using memories and mental models
- **Knowledge Base**: Tree of auto-refreshing synthetic documents (mental models) synthesized by LLM from bank observations; searchable, exportable as markdown, and mountable read-only to the filesystem via hindsight-cli (`hindsight fs mount`)
- **Directives & Mental Models**: Manage behavioral guidelines (Directives) and curated standing answers (Mental Models)

### Database
PostgreSQL with pgvector (also supports Oracle 23ai). Schema managed via Alembic migrations in `hindsight-api-slim/hindsight_api/alembic/`. Migrations run automatically on API startup.

Key tables: `banks`, `documents`, `chunks`, `entities`, `memory_units`, `unit_entities`, `memory_links`

## Key Conventions

Task-specific instructions live in `.claude/rules/`: language standards, migrations, config
flags, control-plane routes, integrations and LLM-judge tests. Each file loads when you work on
files that match its `paths:` list.

### Code Quality

Run the lint script after Python or TypeScript/Node changes:
```bash
./scripts/hooks/lint.sh
```

Dead-code detection runs in CI (the `check-unused-code` job) at two levels:
- **Blocking:** unused imports (ruff `F401`) and variables (`F841`) — `lint.sh` auto-removes
  them and `verify-generated-files` fails on any leftover diff; and **knip** for orphaned
  control-plane files / unused (or unlisted) `package.json` dependencies.
- **Advisory:** whole unused Python functions (vulture) and unused control-plane *exports*
  (the shadcn/ui surface is kept on purpose) — surfaced, not gated.

Run both locally with:
```bash
./scripts/hooks/check-unused.sh
```

Run the project's code-review skill (`.claude/skills/code-review/SKILL.md`) after implementation and before pushing or opening a PR. It checks the change against project standards (missing tests, dead code, type safety and more). Fix its "must fix" findings first.

### Branch Hygiene
- **Always start new feature branches from `origin/main`** — rebase to ensure a clean base.
- **Only include commits relevant to the PR/branch/feature** — no unrelated changes. If the branch contains commits that don't belong, they must be removed before merging.

### General Principles
- Don't add features, refactor code, or make "improvements" beyond what was asked
- Don't add unnecessary error handling for impossible scenarios
- Don't create helpers or abstractions for one-time operations
- No backwards-compatibility hacks (unused vars, re-exports, "removed" comments)
- Three similar lines of code is better than a premature abstraction

### Testing

Most tests are deterministic (MockLLM, pure functions) and assert directly. Tests of LLM
behaviour use a real LLM and an LLM judge, as described in `.claude/rules/llm-judge-tests.md`.

**A user-facing capability needs a blackbox story in `hindsight-system-tests/`.**
Those drive a real `hindsight-api` process through the published Python client, with no
engine access and no SQL. They catch the bugs that the api-slim suite structurally cannot,
in the seam *between* steps, where consolidation wipes the facts under it or a transfer
drops its evidence. Add a story when a change adds a
capability someone can name, or makes two existing capabilities meet for the first
time; the composition is the part nothing else tests. See that package's README, and
`.claude/skills/code-review/SKILL.md` step 6b for the review checklist.

### Memory Banks
- Each bank is an isolated memory store (like a "brain" for one user/agent)
- Dispositions (skepticism, literalism, empathy traits 1-5) and bank mission (`reflect_mission`, formerly background) are configured via Bank Config (`PATCH /v1/default/banks/{bank_id}/config`), affecting reflect
- Bank isolation is strict - no cross-bank data leakage
- Legacy profile and background endpoints are retired (return HTTP 410) in favor of Bank Config

### API Design
- All endpoints operate on a single bank per request
- Multi-bank queries are client responsibility to orchestrate
- Disposition traits only affect reflect, not recall

### Changelogs

Never add "Unreleased" entries to changelogs (e.g. `hindsight-docs/src/pages/changelog/**`). Changelog entries are written by the release script (`./scripts/release-integration.sh`) when a version is actually cut. If a bug fix or feature needs documenting before release, describe it in the PR/commit — the release tooling will surface it in the published changelog section.

## Environment Setup

### Recommended: One-Shot Bootstrap
Run the dev environment setup script to automatically install toolchains (uv, Node, Rust), sync workspace dependencies, prime local ML models, and build core artifacts:
```bash
./scripts/dev/setup.sh
```

### Manual Setup
```bash
cp .env.example .env
# Edit .env with the LLM provider/model and credentials for your setup

# Python deps (workspace-wide)
uv sync

# Node deps (uses npm workspaces)
npm install
```

Common server settings:
- `HINDSIGHT_API_PORT`: API server port (default: `8888`)
- `HINDSIGHT_CP_PORT`: Control Plane dev script port (default: `9999`, Next.js app reads `PORT`)
- `HINDSIGHT_CP_DATAPLANE_API_URL`: Control Plane backend URL (default: `http://localhost:8888`)

LLM settings:
- `HINDSIGHT_API_LLM_PROVIDER`: openai, anthropic, gemini, deepseek, groq, minimax, ollama, lmstudio, fireworks, openai-codex, xai-oauth, etc. (See `hindsight-docs/docs/developer/configuration.mdx` for full provider lists)
- `HINDSIGHT_API_LLM_API_KEY`: API key for providers that require one
- `HINDSIGHT_API_LLM_MODEL`: Model name (defaults are provider-specific)

Optional (uses local models by default; see configuration docs for full lists):
- `HINDSIGHT_API_EMBEDDINGS_PROVIDER`: local (default), tei, onnx, openai, cohere, zeroentropy, litellm, google, etc.
- `HINDSIGHT_API_RERANKER_PROVIDER`: local (default), tei, cohere, flashrank, siliconflow, zeroentropy, litellm, google, alibaba, etc.
- `HINDSIGHT_API_DATABASE_URL`: External PostgreSQL (uses embedded pg0 by default)
- `HINDSIGHT_API_ENABLE_BANK_CONFIG_API`: Allow per-bank config *writes* (default: true; reads are always allowed)
