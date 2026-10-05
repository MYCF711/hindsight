---
paths:
  - "hindsight-api-slim/hindsight_api/config.py"
  - ".env.example"
  - "hindsight-embed/hindsight_embed/env.example"
  - "hindsight-docs/docs/developer/configuration.mdx"
---

# Adding New API Configuration Flags

Configuration follows a hierarchical system: **Global (env vars) → Tenant (via extension) → Bank (database)**.

Fields must be categorized as either **hierarchical** (can be overridden per-tenant/bank) or **static** (server-level only).

### Adding a New Configuration Field

1. **config.py** (`hindsight-api-slim/hindsight_api/config.py`):
   - Add `ENV_*` constant for the environment variable name (e.g., `ENV_MY_SETTING = "HINDSIGHT_API_MY_SETTING"`)
   - Add `DEFAULT_*` constant for the default value
   - Add field to `HindsightConfig` dataclass with type annotation
   - **Mark as configurable** by adding to `_CONFIGURABLE_FIELDS` set if the field should be overridable per-tenant/bank via API
   - Add initialization in `from_env()` method

   ```python
   # Configurable field (can be overridden per-tenant/bank via API)
   _CONFIGURABLE_FIELDS = {
       ...,
       "my_setting",  # Add here for configurable
   }

   # Static field - just don't add to _CONFIGURABLE_FIELDS
   ```

2. **main.py** (`hindsight-api-slim/hindsight_api/main.py`):
   - No change is needed for ordinary environment-backed config fields. The CLI starts from `_get_raw_config()`,
     so new `HindsightConfig` fields are carried through automatically.
   - If the new field should be overridable by a CLI flag, add the argparse option in `_parse_cli_args()` and include
     that field in the `dataclasses.replace(config, ...)` call near the "CLI override" comment.

3. **Use hierarchical config in MemoryEngine**:
   ```python
   # Config is resolved automatically per bank via ConfigResolver
   config_dict = await self._config_resolver.get_bank_config(bank_id, context)
   value = config_dict["my_setting"]
   ```

4. **Use static config** (non-hierarchical):
   ```python
   from ...config import get_config
   config = get_config()
   value = config.my_static_field
   ```

5. **Documentation** (`hindsight-docs/docs/developer/configuration.mdx`):
   - Add to appropriate section table with Variable, Description, Default
   - Mark if it's hierarchical (can be overridden per-bank)

6. **Env template** (`.env.example`):
   - Add the variable to the appropriate section, commented if optional, with a
     short inline comment describing it (mirror the documentation entry).
   - This file is the single source of truth for the env template:
     `scripts/dev/setup.sh` copies it to `.env`, and `hindsight-embed` ships a
     bundled copy (`hindsight-embed/hindsight_embed/env.example`) that seeds
     embed/profile configs. After editing `.env.example`, re-copy it to the
     embed package (`cp .env.example hindsight-embed/hindsight_embed/env.example`)
     or the `test_bundled_template_matches_repo_root` sync test will fail.

### Hierarchical vs Static Guidelines

**Hierarchical** (per-bank overridable):
- LLM settings (provider, model, API key, base URL)
- Operation-specific settings (retain mode, chunk size, etc.)
- Feature flags that vary by customer/bank

**Static** (server-level only):
- Infrastructure settings (database URL, port, host)
- Global limits (max concurrent operations)
- System-wide feature flags
