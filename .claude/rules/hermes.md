---
paths:
  - "hindsight-integrations/hermes/**"
  - "hindsight-docs/docs-integrations/hermes.md"
  - "hindsight-docs/scripts/sync-hermes-doc.mjs"
---

# Hermes docs are generated from one README

Same arrangement, one generator: `hindsight-integrations/hermes/README.md` is the single source for
the Hermes integration page. **Never edit `hindsight-docs/docs-integrations/hermes.md` by hand** —
it is generated:

```bash
node hindsight-docs/scripts/sync-hermes-doc.mjs                  # README -> docs page
```

The docs build runs the same script with `--check`, so a stale page fails the build. Sections listed
in the script's `DROP_SECTIONS` (currently `Development`) stay repo-only, which is where
maintainer-facing notes belong — anything else in the README ships to the public page.

Shipping a change to that directory reaches no user until the Hermes plugin catalog pin moves: open
a follow-up PR against `NousResearch/hermes-agent` bumping `sha` and `version` together in
`plugin-catalog/hindsight.yaml`.
