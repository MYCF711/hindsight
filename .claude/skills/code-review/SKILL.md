---
name: code-review
description: Review changed code against project standards. Checks for missing tests, dead code, type safety, lint issues, and coding conventions. Run after completing any implementation work.
---

# Code Review

Review all changed code against the project's quality standards and coding conventions.

## Code Standards

The coding standards live in path-scoped rules under `.claude/rules/`. Read the ones that
match the diff before reviewing, because the review steps below check against them:

- `python.md`: supported interpreters, Python style, type safety, API layer and data access,
  HTTP middleware, outbound HTTP, bank/tenant isolation, database locking, concurrency
- `typescript.md`: TypeScript style
- `code-comments.md`: when and how to comment
- `docs-examples.md`: code examples in `hindsight-docs/`

Branch hygiene and general principles are in CLAUDE.md under Key Conventions.

## Review Steps

### 1. Check branch hygiene

- Run `git log --oneline main..HEAD` to list all commits on the branch.
- Verify every commit is relevant to the feature/PR. Flag any unrelated commits.
- Check the branch is based on a recent `origin/main` (no stale base).

### 2. Identify changed files

Run `git diff --name-only HEAD` (unstaged) and `git diff --cached --name-only` (staged) to get all changed files. If there are no local changes, diff against the base branch using `git diff main...HEAD --name-only` and `git diff main...HEAD` to review all commits on the current branch.

### 3. Run linters

```bash
./scripts/hooks/lint.sh
```

Report any failures without fixing them.

### 4. Check for dead code

For each changed Python file, check for:
- Unused imports (Ruff should catch these, but verify)
- Functions/methods/classes that were added but are never called from anywhere
- Variables assigned but never read
- Commented-out code blocks that should be removed

For each changed TypeScript file, check for:
- Unused imports
- Unused variables or functions
- Commented-out code

### 5. Check type safety (Python)

For each changed Python file, check for violations:
- **No raw `dict` for structured data** — must use Pydantic model or dataclass, even for internal/private functions (only exception: truly dynamic/unknown keys)
- **No multi-item tuple returns** — must use dataclass or Pydantic model, even for internal/private functions (no exceptions)
- **Missing type hints** on function parameters and return types
- **Missing `@field_validator`** for datetime fields that should be timezone-aware

### 6. Check for missing tests

For each new or significantly changed function/endpoint/class:
- Check if there is a corresponding test addition or update
- New API endpoints need integration tests
- New utility functions need unit tests
- Bug fixes should have a regression test

Flag any new logic that lacks test coverage.

**LLM-behaviour changes need a real-LLM judge test, not MockLLM.** If the change alters how the model interprets a prompt (fact/observation extraction, `fact_type` (world/experience) classification, speaker attribution, instruction-following, prompt wording), there must be a test marked `pytest.mark.hs_llm_core` that runs the real pipeline and asserts via `tests.llm_judge.assert_meets_criteria` (not string/enum matching). Flag these as findings:
- A prompt/classification change verified only by MockLLM or string assertions (MockLLM echoes input — such tests pass spuriously). **Should fix.**
- A test that hard-asserts `fact_type == "world"/"experience"` (or other model-decided output) instead of judging it — non-deterministic, will flake across providers/runs. **Should fix** (move the classification check into the judge `criteria`; keep only genuinely deterministic structural asserts direct).
- Deterministic mechanics (prompt assembly, suppression/branching logic) that are covered *only* by a slow LLM test — these should also have fast non-LLM unit tests. **Note.**

See `.claude/rules/llm-judge-tests.md` for the full pattern.

### 6a. Check tests assert memory state via the engine API, not raw SQL

Tests must verify what a retain / recall / consolidation produced by calling the public
`MemoryEngine` read API — `list_memory_units` (units and their `metadata` / `tags`; counts via
`total`; `document_id` / `fact_type` / `entity_id` filters), `list_entities` (canonical names,
mention counts), `get_graph_data` (nodes/edges), `get_bank_stats`, `recall_async` — **not** by
reaching into the memory tables (`memory_units`, `memory_links`, `unit_entities`) with raw SQL via
`pool.acquire()` / `conn.fetch*`. Asserting on those tables couples the test to a storage-layer
detail and checks a proxy instead of the observable property (see **General Principles** → tests
assert the property, and the handler rule in **7b**).

**Flag as should fix** any added or changed test whose assertion runs a `SELECT` / `COUNT` against
`memory_units` / `memory_links` / `unit_entities` where an engine read method returns the same
fact. Prime tell: `async with pool.acquire() as conn:` followed by `SELECT ... FROM memory_units`
inside a test body; a `fetchval("SELECT count(*) FROM memory_units ...")` that `list_memory_units`
`["total"]` would return; a `canonical_name` query that `list_entities` covers.

Direct SQL on those tables is legitimate **only** when it forces or inspects internal state the
public API cannot express — e.g. an `UPDATE documents SET updated_at` that forges a race, or a
raw `memory_links` row-count that the deduped `get_graph_data` edge list cannot reproduce. Those
must carry a comment saying why the direct access is necessary; flag any that do not.

### 6b. Check user-facing capabilities have a system test

`hindsight-system-tests/` holds blackbox stories that drive a real `hindsight-api`
process through the published Python client — no engine access, no SQL, no internal
imports. They exist because the api-slim suite is one test per *mechanism*,
which catches mechanism bugs and misses **composition** bugs: consolidation wiping the
facts under it, a delta refresh missing a backdated window, a transfer dropping
mental-model evidence, a reprocess that is a silent no-op. Every one of those spanned
steps no single-mechanism test crosses. Tracking issue: #4214.

A change needs a system story when it **adds a capability a user can name**, or when it
**makes two existing capabilities meet**. Concretely, flag as **should fix** a PR that:

- adds or changes an API endpoint, a retain/recall/reflect parameter, or a bank-config
  field that alters observable behaviour;
- adds a new derived layer or lifecycle step (an observation kind, a refresh trigger, a
  background operation);
- makes an existing feature interact with another for the first time — a new
  combination is exactly what the unit suite cannot see;
- fixes a composition bug. The regression test belongs here, not only in api-slim,
  because the bug lived in the seam between steps.

It does **not** need one for: internal refactors with no observable change, performance
work, a mechanism already covered by an existing story, or anything whose only surface
is the control plane (this suite is API-only by design).

When reviewing an added or changed story, check:

- **It goes through the client.** `client.aretain(...)`, not `httpx` and not
  `MemoryEngine`. Reaching around the published client hides SDK defects the suite
  exists to surface — `import_bank_template` was uncallable from every SDK (#4232) and
  only a client-driven test could show it. **Must fix** if a story bypasses the client
  to make itself pass.
- **Every LLM call is declared.** An unscripted call fails the test with the rule to
  paste in; a story that answers one with a plausible default proves nothing. Never
  add a catch-all rule to quiet a miss.
- **Background work is awaited, not disabled.** Retain enqueues consolidation; a story
  that switches it off to stay deterministic has removed the half where the composition
  bugs live. Use `settled(bank_id)`.
- **It asserts the whole deterministic payload**, not the presence of a keyword. With
  the LLM, embedder and reranker all stubbed, recall is a pure function of its input —
  ranking, scores and rendered text are all pinnable, and "the word appears somewhere"
  passes just as happily when fusion inverts.
- **A known defect fails, rather than being documented.** If the PR leaves a contract
  unmet, the story asserts the behaviour we *want* and is red until it is fixed — not
  `xfail`, which keeps the run green so nothing forces the question, and not a test
  pinning today's wrong answer, which breaks the day someone fixes it and teaches the
  next reader to delete tests. **Must fix** either shape.

The suite's README documents the conventions; `tests/test_01_retain_and_recall.py` is
the reference for how total the assertions should be.

### 7. Check API consistency

If any files in `hindsight-api-slim/hindsight_api/api/` were changed:
- Were the OpenAPI specs regenerated? (`./scripts/generate-openapi.sh`)
- Were the client SDKs regenerated? (`./scripts/generate-clients.sh`)
- Were the control plane proxy routes updated? (`hindsight-control-plane/src/app/api/`)

### 7a. Check TS/Python wrapper-client parity

Two of the generated SDKs ship a **hand-written, maintained convenience wrapper** on top of the auto-generated low-level client — and *only* these two:
- **TypeScript**: `hindsight-clients/typescript/src/index.ts` (`HindsightClient`)
- **Python**: `hindsight-clients/python/hindsight_client/hindsight_client.py` (`Hindsight`)

(The Rust/Go/etc. clients are generated-only — no wrapper to keep in sync.)

These wrappers are what most third-party consumers actually call, and they must expose the same surface. **If a change touches one wrapper's method — adds/removes a parameter, changes a default, forwards a new query/body field — the equivalent method in the *other* wrapper must get the same change in the same (or an immediately-following) PR.** A parameter that exists in the generated SDK but is dropped by one wrapper silently strips it for every consumer of that language (this is exactly what #2975 / #3042 fixed for `detail`/`tags_match`/`limit`/`offset` on `listMentalModels`/`getMentalModel`). **Should fix** — flag any wrapper method that gains capabilities in one language but not the other, and add a matching mapping regression test on both sides.

Note: the `client-coverage-check` CI tool only validates **request-body** fields, not GET **query** parameters — so query-param parity gaps are *not* caught automatically and must be checked by hand here.

### 7b. Check API-layer data-access boundary

For each changed handler in `hindsight-api-slim/hindsight_api/api/` (e.g. `http.py`, `mcp.py`):
- **Flag any direct DB access in the handler** — `acquire_with_retry`, `conn.fetch` / `fetchrow` / `execute`, raw SQL strings, or `fq_table(...)`. These are a **must fix**: the query must be moved into a `MemoryEngine` method that returns a typed model, and the handler must call that method.
- **Verify authentication is enforced in the engine** — the handler must delegate to an engine method that authenticates via `request_context` (`_authenticate_tenant`, typically through `get_bank_profile`). A handler that reads/writes tenant-scoped data without an engine method enforcing auth is a **must fix** (tenant data could leak across schemas).

### 7c. Check bank/tenant query scoping

For **every SQL statement added or changed** in the diff (grep the diff for `conn.fetch`, `conn.fetchrow`, `conn.fetchval`, `conn.execute`, `executemany`, and any raw `SELECT`/`INSERT`/`UPDATE`/`DELETE` f-strings, including multi-line ones), verify it cannot touch another bank's rows. The rules are in **Bank/Tenant Isolation in Queries** in `.claude/rules/python.md`.

For each statement against a multi-bank table (`memory_units`, `documents`, `entities`, `mental_models`, `knowledge_pages`, `memory_links`, `observation_history`, …), confirm it is scoped by one of the three legitimate mechanisms:
1. explicit `AND bank_id = $n`;
2. a globally-unique single-column PK (`*.id` uuid, or the bank-encoded `chunks.chunk_id`) — **not** a composite-PK id like `documents.id`/`document_id` or `mental_models.id`;
3. transitively, through a globally-unique id set that was itself selected from a bank-scoped query in the same call.

**Flag as a must fix** any statement filtering a multi-bank table by a caller-supplied, non-globally-unique key (`document_id`, `mental_models.id`, an entity name, …) with **no** `bank_id` predicate — construct the concrete two-bank scenario (two banks share the id; the statement reads/counts/updates/deletes the wrong bank's rows or over-reports) to confirm it's real before flagging. Prime tells: a `bank_id`-carrying sibling statement right next to a `bank_id`-less one; a `WHERE bank_id` guarded by `if bank_id:` with a `None` default; an import/transfer write that inherits a source `bank_id` instead of pinning the destination.

### 7d. Check list endpoints paginate

For every added or changed `GET` handler that returns a collection, confirm it takes `limit`/`offset` and returns `total`. **API Layer & Data Access** in `.claude/rules/python.md` has the exact shape. Then check the fix is real end to end, since a param that nothing enforces is worse than none:

- **The bound reaches the work, not just the response.** Verify the page size actually limits the expensive part — the SQL `LIMIT`/`OFFSET`, or (when paging must happen after an in-process filter, as in `list_banks` where the `filter_bank_list` extension hook can drop any bank) an explicit slice with the per-item work — live store counts, `get_bank_configs`, re-embedding — done for the page only. Paging in SQL *before* a filter that can drop rows is a **must fix**: it hands back short or empty pages and a `total` that counts rows the caller can't see.
- **Every in-repo consumer pages.** A new default `limit` silently truncates callers that used to get everything: the control plane (`src/lib/api.ts` + the `src/app/api/` proxy route + any context/selector that holds the full list), the CLI (`hindsight-cli/src/api.rs`), MCP tools, and the Zapier dynamic dropdowns. Each must either page through to completion or expose paging in its UI — flag any consumer left on a single default-sized page.
- **Search moves server-side with it.** A picker that filtered client-side over the full list now only filters the loaded page. If the endpoint gained `q`, the UI must send it (and disable its local filtering, e.g. cmdk's `shouldFilter={false}`); if it didn't, say why the collection is small enough not to need it.
- **Tests that look up their own row must not depend on landing on page 1** — they should search or pass an explicit `limit`, not rely on default ordering.

### 8. Check code comments

For each non-trivial change:
- **New non-obvious logic** — is there a comment explaining the reasoning?
- **Changed approach** — does the comment include what was done before and why it changed?
- **Stale comments** — do existing comments near the changed code still accurately describe the behavior?

### 9. Check integration completeness

If any files in `hindsight-integrations/` were added or changed, verify:
- **Tests exist** — the integration must have tests that simulate/exercise the external framework (not just pure unit tests of helpers). Check for a `tests/` directory with meaningful test files.
- **CI job exists** — check `.github/workflows/test.yml` for a corresponding `test-<name>-integration` job. If missing, flag it.
- **Release process** — check that the integration name is in the `VALID_INTEGRATIONS` array in `scripts/release-integration.sh` AND in the `INTEGRATIONS` dict in `hindsight-dev/hindsight_dev/generate_changelog.py` (the changelog generator keeps its own list; a release fails at the changelog step if the name is missing there). If either is missing, flag it.
- **Docs gallery + sidebar entry** — the integration must have an entry in `hindsight-docs/src/data/integrations.json`. This file is the **single source of truth** that drives both the integrations gallery and the docs sidebar (the sidebar category is injected from it at render time across all docs versions). The entry needs an internal `/sdks/integrations/<slug>` `link` and a matching page at `hindsight-docs/docs-integrations/<slug>.md(x)`. The `hindsight-docs/scripts/check-integrations.mjs` build step enforces both directions — forward: every internal JSON entry has a doc page; reverse: every released tag (`integrations/<name>/vX.Y.Z`) appears in the JSON (private infra like `cloudflare-oauth-proxy` is in the script's `EXCLUDED` set). Flag any integration that is released (or being released) but missing from `integrations.json`, and any JSON entry without a doc page. Do **not** hand-edit `versioned_sidebars/*.json` to add integration links — they are positional placeholders filled from the JSON.
- **Code standards** — the integration code must follow all Python style rules (type hints, no raw dicts, no tuple returns, etc.).

### 9a. Check parity across sibling implementations

Whenever the same capability is implemented once per *variant* — one per harness, per language, per
dialect, per provider — the new or changed variant is where a capability silently goes missing. The
defect never looks like a bug in the diff: the code that's wrong is the code that **isn't there**,
and every existing test still passes because the sibling that forgot is by definition the one nobody
wrote a test for. That is how dsh shipped in daemon mode without ever starting a daemon (#3524):
`ensureDaemon` sat in the hook-only wrappers, so all five persistent-plugin harnesses lacked it.

Known sibling families in this repo (this is not the whole list — the rule is about the *shape*):

| Family | Where |
|---|---|
| Coding-agent harnesses | `hindsight-integrations/coding-agents/src/` (hook harnesses vs. persistent-plugin harnesses: dsh, opencode, Kilo, Cline, Prime Agent) |
| Wrapper SDK clients | TypeScript + Python wrappers — see step 7a |
| Alembic migrations | `_pg_upgrade` / `_oracle_upgrade` in every migration |
| Dataplane ↔ control plane | `api/http.py` params vs `hindsight-control-plane/src/app/api/**` proxy routes + `lib/api.ts` |
| LLM providers | per-provider branches in `engine/llm_wrapper.py` |

**Procedure — do this by hand; no linter catches it.** When the diff adds a new sibling, or changes
one sibling of a family:

1. **Enumerate the family.** List every existing sibling (`ls` the directory, grep the registry).
2. **Diff the capability list, not the code.** For each capability the *other* siblings have —
   lifecycle hooks called, setup/teardown performed, config flags honoured, opt-outs respected,
   registry/installer/docs entries — confirm the changed sibling has it, or that its absence is
   deliberate and commented. Grep is the tool: `grep -rn ensureDaemon src` proves who calls it.
3. **Prefer hoisting over copying.** If the capability now exists in N places, the fix is usually to
   move it into the one path every sibling already shares (e.g. `RuntimeCore`, `buildHookOutput`),
   not to paste an Nth copy that the N+1th sibling will forget again.
4. **Demand a structural guard, not just a unit test.** A test for the sibling that forgot doesn't
   exist by construction, so ask for a test that asserts *over the whole family*: enumerate the
   siblings from the filesystem/registry and assert each satisfies the contract, with an explicit,
   commented exemption list. Precedents: `registry covers every installable harness`
   (`harness/registry.test.ts`), `every harness entrypoint reaches a daemon` (`core/daemon.test.ts`),
   `test_backup_tables_covers_entire_schema`, `test_migration_shape.py`.

Flag a capability present in every sibling but one as a **must fix** — state which siblings have it,
which doesn't, and what the user-visible symptom is (for #3524: every `hindsight_*` tool call fails
with ECONNREFUSED and nothing ever starts the daemon). A new sibling family member landing with no
family-wide guard test is a **should fix**.

### 10. Check MCP tool registration completeness

If any new MCP tools were added or existing tools renamed in `hindsight-api-slim/hindsight_api/mcp_tools.py`:
- **`_ALL_TOOLS` set** in `mcp_tools.py` — must include the new tool name
- **`tools_to_register` default set** in `register_mcp_tools()` in `mcp_tools.py` — must include the new tool name
- **`_SINGLE_BANK_TOOLS` set** in `hindsight-api-slim/hindsight_api/api/mcp.py` — must include the new tool if it is bank-scoped (not a bank-management tool like `list_banks`/`create_bank`)
- **`MCP_TOOL_GROUPS`** in `hindsight-control-plane/src/components/bank-config-view.tsx` — must include the new tool in the appropriate group for the UI tool selector
- **Tool count assertions** in tests (e.g., `test_mcp_tools.py`) — must be updated to reflect the new count

### 11. Check backup/restore table coverage

If a migration adds a new PostgreSQL table (look for `CREATE TABLE` / `op.create_table` in `hindsight-api-slim/hindsight_api/alembic/versions/`):
- **`BACKUP_TABLES`** in `hindsight-api-slim/hindsight_api/admin/cli.py` — must include the new table, placed after any table it references via foreign key (parents before children). A missing entry is silent data loss: the table is never backed up, and restore's `TRUNCATE banks CASCADE` wipes any FK-to-banks child (e.g. `mental_models`, `directives`) on restore even though it was never saved.
- The guard test `test_backup_tables_covers_entire_schema` in `tests/test_admin_backup_restore.py` enforces this — flag it as a **must fix** if a new table is absent from `BACKUP_TABLES`.
- Oracle-only tables (e.g. `observation_sources`) are intentionally excluded — admin backup/restore is PostgreSQL-only.

### 11b. Check new config flags update the env template

If the diff adds a new configuration field (a new `ENV_*` / `HINDSIGHT_*` env var
in `hindsight-api-slim/hindsight_api/config.py`):
- **`.env.example`** (repo root) — must add the variable (commented if optional)
  alongside the docs entry in `hindsight-docs/docs/developer/configuration.mdx`.
  A flag added to `config.py` but absent from `.env.example` is a **should fix**.
- **`hindsight-embed/hindsight_embed/env.example`** — the bundled copy must stay
  byte-identical to the repo-root `.env.example` (it seeds embed/profile configs).
  The `test_bundled_template_matches_repo_root` sync test fails on drift; if the
  root file changed without re-copying, flag it as a **must fix**.

### 11c. Check for advisory locks

Grep the diff for `advisory` (`git diff main...HEAD | grep -in advisory`). Any new
`pg_advisory_lock` / `pg_try_advisory_lock` / `pg_advisory_xact_lock` /
`pg_advisory_unlock` call is a **must fix** (see Database Locking in `.claude/rules/python.md`). Point the
author at the alternatives (per-process objects, idempotent DDL, row-level
constraints) rather than just asking them to drop the lock.

### 11e. Check for BaseHTTPMiddleware

```bash
git diff main...HEAD -- '*.py' | grep -nE "@app\.middleware\(|BaseHTTPMiddleware"
```

Any new `@app.middleware("http")` or `BaseHTTPMiddleware` subclass is a **must fix**
(see "HTTP Middleware" in `.claude/rules/python.md`). Ask for a pure-ASGI middleware (or an `APIRoute` subclass
if the logic needs routing context), and check that a `send` wrapper sanitises any
header value derived from client input.

### 11f. Check outbound HTTP is aiohttp and async

```bash
git diff main...HEAD -- '*.py' ':!**/tests/**' | grep -nE "^\+.*(import httpx|from httpx|import requests|urllib\.request|http\.client|noqa: TID251|\.Client\(|asyncio\.to_thread|run_in_executor)"
```

Any new httpx use or sync HTTP call in production code is a **must fix** (see
"Outbound HTTP" in `.claude/rules/python.md`). `ruff` catches the imports; review catches what it can't: a sync
SDK client where an async one exists, a sync call pushed into `to_thread` /
`run_in_executor`, an `aiohttp.ClientSession` created outside `LoopLocalSession`, and any
`# noqa: TID251` that is not configuring or classifying a third-party SDK.

### 11g. Check docs code examples come from tested snippets

If the diff touches `hindsight-docs/docs/**`, look for new or changed fenced blocks (```` ```python ````, ```` ```bash ````, ```` ```typescript ````, ```` ```go ````, …) that call Hindsight: SDK client methods, `hindsight <cmd>` CLI commands, or `curl` to `/v1/...`. Each must be a `<CodeSnippet>` backed by a section in `hindsight-docs/examples/api/` (see `.claude/rules/docs-examples.md`). Also check the example file actually exercises the call (not just prints it) and cleans up its banks. Flag an inline API example as a **must fix**.

The live `/developer/...` URLs serve the latest snapshot in `hindsight-docs/versioned_docs/version-<latest>/`, not `docs/` (that is `/developer/next/`); a release syncs `docs/` into it. A docs fix meant to be live before the next release must be copied into that snapshot too.

### 11d. Check concurrency primitives

See "Concurrency" in `.claude/rules/python.md`. Grep the diff:

```bash
git diff main...HEAD -- '*.py' | grep -nE "asyncio\.(Lock|Semaphore|Event|Condition|BoundedSemaphore|Future)\(|threading\.(Lock|RLock)\("
```

**Must fix:**
- An `asyncio` primitive created at module scope, or stored on a process-wide
  singleton — it binds to the first loop that waits on it and breaks every other one.
- A `threading.Lock` held across an `await` — this blocks the event loop instead of
  yielding.
- An in-flight/coalescing map holding `asyncio.Future`s keyed without the running loop.

**Also check the change does not quietly drop an interpreter:**
- A new dependency, or a version bump, with no wheel for one of 3.11-3.14 — the
  `build-api-python-versions` CI matrix installs and smoke-tests every one of them.
- Syntax or stdlib usage newer than 3.11 (`uv run ty check` catches most of it).
- A test that assumes one event loop per process, when what it covers is shared state.

**Should fix:**
- New process-global mutable state (dict/set/list, `lru_cache` over mutable values)
  with no lock, or iterated somewhere it can be mutated concurrently.

### 12. Review against other coding standards

Check the diff for violations of the standards listed under Code Standards:
- Python files at project root (not allowed)
- Missing async patterns (should be async throughout)
- Pydantic models for request/response
- Line length > 120 chars
- New features/code beyond what was asked (over-engineering)
- Unnecessary error handling for impossible scenarios
- Premature abstractions or speculative helpers
- Backwards-compatibility hacks (unused vars, re-exports, "removed" comments)

### 13. Report findings

Present a clear summary organized by severity:

**Must fix** — issues that will break CI or violate hard project rules:
- Unrelated commits on the branch
- Lint failures
- Missing type hints on public functions
- Raw dict usage for structured data (including internal code)
- Multi-item tuple returns (including internal code)
- Missing tests for new endpoints
- A new user-facing capability, or a new combination of existing ones, with no story in `hindsight-system-tests/` (see step 6b)
- A system story that bypasses the published client, silences an unscripted LLM call, or disables background work to stay deterministic
- Direct DB access (raw SQL / `acquire_with_retry` / `fq_table`) in an `api/` handler instead of a `MemoryEngine` method
- Tenant-scoped data accessed without authentication enforced in the engine (`_authenticate_tenant` / `get_bank_profile`)
- A SQL statement against a multi-bank table filtered by a caller-supplied, non-globally-unique key without a `bank_id` predicate (cross-bank read/write leak — see step 7c)
- New integration missing tests, CI job, or release-integration.sh entry
- Released/added integration missing from `hindsight-docs/src/data/integrations.json`, or a JSON entry with no `docs-integrations/<slug>` page (fails the docs build via `check-integrations.mjs`)
- New PostgreSQL table missing from `BACKUP_TABLES` in `admin/cli.py` (silent data loss on restore)
- A capability every sibling implementation has except the one in the diff (see step 9a) — a
  harness, dialect, provider or language variant that skips a lifecycle step the others perform
- An `asyncio` lock/semaphore/event created at import time or owned by a process-wide
  singleton, or a `threading.Lock` held across an `await` (see step 11d)
- An inline docs code example that calls Hindsight (SDK, CLI, or `curl /v1/...`) instead of a `<CodeSnippet>` from a tested `hindsight-docs/examples/api/` file (see step 11g)
- A change that works on only some of the supported interpreters, 3.11 through 3.14
  (see Supported interpreters in `.claude/rules/python.md`)

**Should fix** — issues that hurt code quality:
- Dead code / unused imports missed by linter
- Missing tests for non-trivial utility functions
- Over-engineering beyond the task scope

**Note** — observations that may or may not need action:
- API changes that might need client regeneration
- Patterns that deviate from nearby code style

For each finding, include the file path, line number, and a brief explanation.

Do not auto-fix any issues. Report all findings and let the user decide what to address. If there are no findings, confirm the code looks good.
