---
paths:
  - "hindsight-integrations/**"
  - "scripts/release-integration.sh"
---

# Adding New Integrations

Every new integration in `hindsight-integrations/` must satisfy all of the following before it can be merged:

1. **Tests are required** — tests must simulate or exercise the external system (mock the framework's interfaces and verify the integration actually calls Hindsight correctly). Pure unit tests of helper functions are not sufficient.
2. **CI job** — add a test job in `.github/workflows/test.yml` following the existing pattern (e.g., `test-crewai-integration`). The job must build, install deps, and run `uv run pytest tests -v`. Also add the integration to `detect-changes` outputs so it only runs when its files change.
3. **Release process** — add the integration name to the `VALID_INTEGRATIONS` array in `scripts/release-integration.sh` so it can be released via the standard release workflow.
4. **Follow project code standards** — Python style, type safety, no raw dicts for structured data, no multi-item tuple returns (see `.claude/rules/python.md`).

If any of these are missing, the integration is incomplete and must not be pushed or merged.
