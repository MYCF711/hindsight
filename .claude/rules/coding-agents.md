---
paths:
  - "hindsight-integrations/coding-agents/**"
  - "hindsight-control-plane/src/lib/harness-logo.ts"
  - "hindsight-control-plane/src/components/ui/harness-logo.tsx"
  - "hindsight-control-plane/public/img/harness/**"
  - "hindsight-docs/scripts/sync-coding-agents-doc.mjs"
---

# Coding-agents integration

## Harness Attribution (which coding agent wrote a document)

`hindsight-integrations/coding-agents/` stamps the coding agent on every
document it retains, so the control plane can show its logo instead of another
`key=value` chip:

- `metadata.harness = "<id>"` — the authoritative field
- tag `harness:<id>` — the same value, so the documents list can filter on it

The ids are defined by that integration's HookSpecs
(`src/harness/hook-lifecycle.ts`, 15 harnesses) and persistent-plugin
entrypoints (`src/harness/registry.ts`, 7 harnesses):
currently `antigravity-cli`, `claude-code`, `cline-cli`, `codebuddy`, `codex`,
`copilot-cli`, `cursor-cli`, `dcode`, `devin-cli`, `dsh`, `factory-droid`,
`grok-build`, `kilo`, `kimi-code`, `opencode`, `opencode2`, `pi`,
`prime-agent`, `qwen-code`, `traecode`, `workbuddy`, `zcode`.

The control plane resolves the value in
`hindsight-control-plane/src/lib/harness-logo.ts` (metadata wins over the tag) and
renders it with `components/ui/harness-logo.tsx` in the documents table and the
document detail dialog. **Adding a harness to the integration means adding it to
that registry in the same change**: copy its icon from
`hindsight-docs/static/img/icons/` (or take it from the agent's own brand assets
when the docs site carries none) into
`hindsight-control-plane/public/img/harness/` and add one entry. Don't register
ids nothing writes — a test asserts the registry matches the emitted set, plus an
explicit list of retired ids kept so already-retained documents keep their logo.
An unregistered harness is not an error: it renders no logo and still shows as
ordinary metadata.

## Coding-agents docs are generated from one README

`hindsight-integrations/coding-agents/README.md` is the single source for that package's
configuration. **Never edit `skill/SKILL.md` or the docs page by hand** — both are generated:

```bash
cd hindsight-integrations/coding-agents && npm run skill:build   # README -> skill/SKILL.md
node hindsight-docs/scripts/sync-coding-agents-doc.mjs           # README -> docs page
```

The regions the skill copies are marked `<!-- skill:begin -->` / `<!-- skill:end -->` in the README;
the agent-only half (tools, crediting, corrections) lives in `skill-src/preamble.md`.
`src/docs-freshness.test.ts` fails on a stale skill or an undocumented `RawConfig` field. Run
`./scripts/hooks/lint.sh` before regenerating, because prettier re-pads the README's tables and a
generated file built from unformatted source fails the byte comparison in CI.
