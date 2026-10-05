---
paths:
  - "**/*.py"
  - "**/pyproject.toml"
---

# Python standards

## Supported interpreters

**CPython 3.11** is the baseline — what `docker/standalone/Dockerfile` ships, and what
the `.python-version` pin and `uv.lock` resolve for. The package supports 3.11 through
3.14; `build-api-python-versions` in CI installs and smoke-tests each of them, so a
dependency floor that excludes one of those interpreters is a break, not a follow-up.

## Python Style
- Python 3.11+, type hints required — and see Supported interpreters above
- Async throughout (asyncpg, async FastAPI)
- Pydantic models for request/response
- Ruff for linting (line-length 120)
- No Python files at project root - maintain clean directory structure
- **Never use multi-item tuple return values** — not even for internal/private functions. Always use a dataclass or Pydantic model. No exceptions, no "it's just two values" shortcuts. If a function returns more than one value, define a named type for it.

## Type Safety with Pydantic Models
**Never use raw `dict` types for structured data.** This applies to all code, including internal helpers and private functions. If the dict has known keys, it must be a dataclass or Pydantic model:
- Use Pydantic `BaseModel` for all data structures passed between functions
- Use `@dataclass` for lightweight internal data containers when Pydantic validation isn't needed
- Add `@field_validator` for type coercion (e.g., ensuring datetimes are timezone-aware)
- Avoid `dict.get()` patterns - use typed model attributes instead
- Parse external data (JSON, API responses) into Pydantic models at the boundary
- This catches type errors at parse time, not deep in business logic
- The only acceptable `dict` usage is for truly dynamic/unknown keys (e.g., arbitrary metadata, JSON blobs with no fixed schema)

```python
# BAD - error-prone dict access
def process(data: dict) -> str:
    return data.get("name", "")  # No validation, silent failures

# GOOD - typed and validated
class UserData(BaseModel):
    name: str
    created_at: datetime

    @field_validator("created_at", mode="before")
    @classmethod
    def ensure_tz_aware(cls, v):
        if isinstance(v, str):
            v = datetime.fromisoformat(v.replace("Z", "+00:00"))
        if v.tzinfo is None:
            return v.replace(tzinfo=timezone.utc)
        return v

def process(data: UserData) -> str:
    return data.name  # Type-safe, validated at construction
```

## API Layer & Data Access
- **No direct database access in `api/http.py`** (or any API router). HTTP handlers must not build SQL, call `acquire_with_retry` / `conn.fetch` / `conn.fetchrow` / `conn.execute`, or reference `fq_table(...)`. All persistence and queries live in `MemoryEngine` (the engine layer). A handler parses/validates the request, calls an engine method, shapes the HTTP response, and maps domain results to status codes (e.g. a `None` return → 404).
- **Authentication/tenancy is enforced inside each engine method, not assumed by the handler.** Every engine method that touches bank-scoped data must authenticate via `request_context` — typically `await self._authenticate_tenant(request_context)` (often indirectly through `get_bank_profile(...)`) — so the correct tenant schema is resolved before any query runs. Handlers must thread `request_context` through to the engine method; never query a tenant-scoped table assuming the schema is already set.
- Engine methods return typed models (Pydantic/dataclass), not raw dicts (see Type Safety).
- **Every list endpoint paginates, following the existing ones.** A `GET` that returns a collection whose size grows with the data (banks, documents, memories, entities, operations, webhook deliveries, audit logs, …) must take `limit`/`offset` and bound its result — an unbounded list is an unbounded payload plus unbounded per-row work (per-item counts, config resolution, embedding hydration). Copy the shape `list_documents` uses, don't invent a new one: `limit: int = Query(default=100, ge=0)` and `offset: int = Query(default=0, ge=0)` on the handler, matching keyword args on the engine method, and a response carrying the page **plus `total`, `limit`, `offset`** so a client knows when to stop. Add a `q` search param when the collection is something a user picks from in a UI — client-side filtering only ever sees the loaded page. Bounded-by-construction endpoints are the exception, not the rule: a tree/export that is whole-structure by design, or a table capped at write time (e.g. `observation_history` / `mental_model_history`, trimmed to `*_max_entries` on insert). If it isn't bounded, paginate it.

## HTTP Middleware
- **Never add a `BaseHTTPMiddleware`** — that means no `@app.middleware("http")` (the decorator installs one) and no `add_middleware(SomethingSubclassingBaseHTTPMiddleware)`. Starlette runs each such middleware's downstream app in a **child task**, piping the request and response through a pair of anyio memory-object streams. That costs a task spawn plus several scheduling hops per request, and because the cost is *scheduling*, it grows exactly when the event loop is already contended: removing the API's two of them took `/health/live` from ~2.4k to ~7.9k rps and p99 from ~107ms to ~18ms at the same concurrency (#4235). It also breaks `Request.is_disconnected()` for everything underneath it — the `http.disconnect` event never reaches the route (#2122) — and swallows `BackgroundTask` / streaming semantics in subtle ways.
- **Write a pure-ASGI middleware instead**: a class with `__init__(self, app)` and `async def __call__(self, scope, receive, send)` that passes straight through for `scope["type"] != "http"` and wraps `send` when it needs to observe the response (read the status off the `http.response.start` message, append headers to `message["headers"]` as raw byte pairs). One `await` in the same task, no hops. `hindsight_api/api/observability.py` and `api/disconnect.py` are the models to copy.
- **Prefer moving the work down a layer when it needs routing context.** Anything that has to know which endpoint was hit — its parameters, its signature, its body model — belongs in an `APIRoute` subclass (`app.router.route_class = ...`), not in a middleware that re-derives the route by walking `app.routes` and calling `route.matches()`. The route is already resolved there, and per-route facts can be computed once at startup instead of per request. See `api/unknown_params.py`. Note that `include_router` does not apply the app's `route_class` to a router's own routes — FastAPI <= 0.140 keeps each source route's class, >= 0.141 materialises from the source router's `route_class` — so routes from an included/extension router need `use_unknown_params_routes(router)` before the include.
- **Header values built from client input must be sanitised** before they reach `message["headers"]`: query-param and body-field names are percent-decoded attacker input, so a non-latin-1 name raises mid-`send` (a 500 from a typo) and a name containing CR/LF splits the response.

## Outbound HTTP: aiohttp, async only
- **Production code makes HTTP calls with aiohttp, never httpx.** httpx's async client costs noticeably more per request than aiohttp (httpcore pool, anyio layers), and that overhead lands on the hottest paths we have — embeddings, reranking and LLM calls on every retain and recall. Build clients with `hindsight_api/engine/aiohttp_session.py`: `LoopLocalSession` (one `ClientSession` per event loop, created lazily — never create a session in `__init__` or in an `initialize()` that may run under `asyncio.run` in another thread), `per_phase_timeout` (httpx-style per-phase timeouts; aiohttp's `total` would cut off a long streamed body), and `raise_for_status` (raises `UpstreamHTTPError`, which keeps the body and a `status_code` that `remote_retry` classifies on).
- **Sync HTTP is forbidden in production code** — no `requests`, `urllib.request`, `urllib3`, `http.client`, `httpx.Client`, and no sync SDK client (`openai.OpenAI`, `cohere.Client`, `litellm.embedding`, …) where the SDK has an async one. A sync call either blocks the event loop or needs a thread per in-flight request; use the async form on the loop instead. Wrapping a sync call in `asyncio.to_thread` / `run_in_executor` is not a fix. The only accepted exception is an SDK that offers no async API at all (e.g. `google.auth` credential refresh) — run that in a thread and say why in a comment.
- **Enforced by ruff** (`TID251`, `banned-api` in `hindsight-api-slim/pyproject.toml`). `import httpx` is allowed only to *configure or classify* a third-party SDK that is built on it (`llm_transport.build_sdk_timeout` for the OpenAI/Anthropic SDKs, `remote_retry` classifying their errors), with a `# noqa: TID251` plus a comment naming the SDK. Reject any other `noqa: TID251`. `http_probe.py` is the one per-file exemption (stdlib-only readiness probe, its own process).
- **Tests are exempt.** FastAPI's `TestClient` / `httpx.ASGITransport` are fine. To stub an upstream for an aiohttp client, serve it from `tests/aiohttp_stub.py::stub_server` rather than mocking the session.

## Bank/Tenant Isolation in Queries
- **Bank isolation is a hard security invariant: no query may read, count, update, or delete another bank's rows.** Tenant isolation is enforced at the schema level (the resolved `search_path` / `fq_table(...)` qualifier, gated by `_authenticate_tenant`); bank isolation is enforced *within* a schema by a `bank_id` predicate on every statement that touches a multi-bank table.
- **Every SQL statement against a multi-bank table must be constrained by `bank_id`** — directly in the `WHERE`, or transitively (see below). Multi-bank tables carry a `bank_id` column: `memory_units`, `documents`, `entities`, `mental_models`, `knowledge_pages`, `memory_links`, `observation_history`, and similar.
- **The trap: filtering by a caller-supplied, non-globally-unique key without `bank_id`.** Keys like `document_id` and `mental_models.id` are unique only *per bank* (their PK is composite, e.g. `(id, bank_id)`), so the *same* id legally exists in every bank. A statement like `UPDATE memory_units SET tags = $1 WHERE document_id = $2` — no `bank_id` — silently reads/writes **every** bank's rows that share the id. This is the exact defect from #3429/#3430. Adding `AND bank_id = $n` fixes it.
- **Three ways a statement is legitimately scoped** (accept these; flag anything that fits none):
  1. **Explicit** `WHERE ... AND bank_id = $n`.
  2. **Globally-unique single-column PK.** Filtering by a global uuid PK (`memory_units.id`, `entities.id`, `knowledge_pages.id`) or a bank-encoded key (`chunks.chunk_id`, built by `engine/chunk_ids.py`) cannot collide across banks. Note that the chunk id is only injective because that helper escapes the separator inside each component. The plain `{bank_id}_{document_id}_{idx}` join it replaced let `('a', 'b_c')` and `('a_b', 'c')` address the same row (#4244), so ids written before it are not safe to treat as bank-scoped. Contrast the *composite*-PK ids (`documents.id`/`document_id`, `mental_models.id`), which are dangerous and must carry `bank_id`.
  3. **Transitive.** Junction tables without a `bank_id` column (`unit_entities`, `entity_cooccurrences`, `observation_sources`) are safe only when reached through globally-unique unit/entity ids that were themselves selected from a bank-scoped query in the same call, and edges are intra-bank by construction. If the id set could contain another bank's ids, it is not scoped.
- **Watch two smells:** (a) a caller-supplied id used in the `WHERE` with no adjacent `bank_id`, while a *neighbouring* statement in the same method does carry `bank_id` (asymmetry is the tell); (b) a `bank_id` predicate applied only under `if bank_id:` with a `bank_id: str | None = None` default — latent even if all current callers pass one.
- **Cross-bank by design must rewrite `bank_id` to the destination.** The transfer/import path is the only one that legitimately crosses banks; verify every write pins the *destination* `bank_id` and never inherits a source row's `bank_id`.

## Database Locking
- **Never use PostgreSQL advisory locks** (`pg_advisory_lock`, `pg_try_advisory_lock`, `pg_advisory_xact_lock`, `pg_advisory_unlock`, …) in migrations, engine code, or anything else. Hindsight runs against connection poolers and managed/PG-compatible services where advisory locks are unreliable or unsupported: session-level locks silently leak or vanish when a pooler hands the session to another client, and callers can block forever on a lock the server never grants. Reject any new occurrence, including ones that look "safe" because they are transaction-scoped.
- The pre-existing usage in `hindsight_api/migrations.py` is grandfathered, not a precedent — it is tracked for removal. Don't copy it.
- Design the concurrency out instead of locking around it: give each process its own object to write (e.g. per-schema DDL rather than a shared `public.` object), make the operation idempotent, or use a real row/table constraint (`INSERT ... ON CONFLICT`, `SELECT ... FOR UPDATE` in a fixed order). See #2690 for a migration that reached for `pg_advisory_xact_lock` and had to be reverted.

## Concurrency: asyncio vs threading primitives

A Hindsight process runs threads (executors, `asyncio.to_thread`) and, across tests
and tooling, more than one event loop. The rules below are silent when broken — the
code passes tests and fails under load.

**Which lock.** The choice is not style, it is ownership:

- `asyncio.Lock` / `Semaphore` / `Event` / `Condition` / `Future` **bind to the event
  loop that first waits on them.** Use them only for objects owned by a single loop —
  per-request, per-connection, or state hanging off an object that one loop created
  and only that loop touches. A `RuntimeError: ... is bound to a different event loop`
  is this rule being broken.
- `threading.Lock` for anything reachable from more than one loop: module-level
  singletons, process-wide caches, registries. It is loop-agnostic. **It may only
  guard await-free critical sections** — never hold one across `await`, or you block
  the whole loop rather than yielding.

If a critical section must await *and* the object is process-global, that is a design
problem, not a locking problem: scope the state per loop instead.

**Never create an asyncio primitive at import time.** A module-level
`asyncio.Lock()`/`Semaphore()` is constructed before any loop exists and then shared
by all of them. It also fails on a *single*-loop build the moment two loops appear in
one process (tests, `asyncio.run` in a thread). Build them lazily inside the object
that owns them.

**Coalescing futures are per-loop.** A cache that dedupes concurrent loads behind an
`asyncio.Future` must key its in-flight map by `(running loop, key)`. Sharing the
cached *data* across loops is fine and desirable; sharing the future is not.

**Module-level mutable state.** A process-global dict/set/list reachable from more
than one thread needs a guard, and must never be iterated while another thread may
mutate it (`RuntimeError: dictionary changed size during iteration` at best; a C
extension handed borrowed references into a resizing dict can segfault). Prefer
warm-once-under-a-lock over locking the hot path.
