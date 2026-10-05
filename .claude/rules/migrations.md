---
paths:
  - "hindsight-api-slim/hindsight_api/alembic/**"
---

# Adding Database Migrations

Hindsight runs the same Alembic tree against PostgreSQL and Oracle 23ai. Each
migration file dispatches through `run_for_dialect`, which calls either
`_pg_upgrade` or `_oracle_upgrade` based on the live connection. A pytest lint
(`tests/test_migration_shape.py`) fails CI if a migration omits the dispatcher.

1. **Create a new migration file** in `hindsight-api-slim/hindsight_api/alembic/versions/`:
   - File name format: `<revision_id>_<description>.py` (e.g., `f1a2b3c4d5e6_add_new_index.py`)
   - Use a unique hex revision ID (12 chars)
   - Set `down_revision` to the previous migration's revision ID

2. **Migration template** (the `script.py.mako` template scaffolds this; fill in the bodies):
   ```python
   """Description of the migration

   Revision ID: f1a2b3c4d5e6
   Revises: <previous_revision_id>
   Create Date: YYYY-MM-DD
   """
   from collections.abc import Sequence
   from alembic import context, op

   from hindsight_api.alembic._dialect import run_for_dialect

   revision: str = "f1a2b3c4d5e6"
   down_revision: str | Sequence[str] | None = "<previous_revision_id>"
   branch_labels: str | Sequence[str] | None = None
   depends_on: str | Sequence[str] | None = None


   def _pg_schema_prefix() -> str:
       """Schema-qualifier for raw SQL on PG (multi-tenant search_path)."""
       schema = context.config.get_main_option("target_schema")
       return f'"{schema}".' if schema else ""


   def _pg_upgrade() -> None:
       schema = _pg_schema_prefix()
       op.execute(f"CREATE INDEX ... ON {schema}table_name(...)")


   def _pg_downgrade() -> None:
       schema = _pg_schema_prefix()
       op.execute(f"DROP INDEX IF EXISTS {schema}index_name")


   def _oracle_upgrade() -> None:
       # Oracle 23ai equivalent. Use op.get_bind().exec_driver_sql for forms
       # that Alembic core does not model (vector/text indexes, partitions).
       op.execute("CREATE INDEX ... ON table_name(...)")


   def _oracle_downgrade() -> None:
       op.execute("DROP INDEX IF EXISTS index_name")


   def upgrade() -> None:
       run_for_dialect(pg=_pg_upgrade, oracle=_oracle_upgrade)


   def downgrade() -> None:
       run_for_dialect(pg=_pg_downgrade, oracle=_oracle_downgrade)
   ```

   **Dialect-only migrations.** If a change genuinely doesn't apply to one
   dialect (e.g. enabling `pg_trgm` is PG-only), omit the unused slot:
   ```python
   def upgrade() -> None:
       run_for_dialect(pg=_pg_upgrade)  # oracle slot intentionally absent → no-op
   ```
   Make the asymmetry deliberate. Don't leave an Oracle slot empty just because
   you didn't think about it — copy-pasting a PG migration without the Oracle
   half is exactly how schemas drift.

3. **Run migrations locally**:
   ```bash
   # Set database URL and run migrations for the base schema plus all tenants
   uv run hindsight-admin run-db-migration

   # Run on a specific tenant schema
   uv run hindsight-admin run-db-migration --schema tenant_xyz
   ```
