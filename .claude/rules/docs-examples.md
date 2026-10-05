---
paths:
  - "hindsight-docs/docs/**"
  - "hindsight-docs/versioned_docs/**"
  - "hindsight-docs/examples/**"
---

# Documentation code examples

- **Every code example in `hindsight-docs/docs/` that calls Hindsight must come from a tested example file, never an inline fenced block.** That means SDK calls (Python, Node.js, Go), `hindsight ...` CLI commands, and `curl` against `/v1/...`. Put the code in `hindsight-docs/examples/api/<page>.{py,mjs,sh,go}` between `# [docs:<section>]` / `# [/docs:<section>]` markers (`//` in JS/Go), and show it with `<CodeSnippet code={...} section="<section>" language="..." />` (see `docs/developer/api/memory-banks.mdx`). CI runs every example file against a live server (`scripts/test-doc-examples.sh`), so a renamed method or flag breaks the build instead of silently breaking the docs.
- Give tabs for every language whose SDK or CLI supports the call, like the sibling sections on the page. A `.md` page that needs a snippet becomes `.mdx`.
- Fine to leave inline: install commands, env/config snippets, endpoint signature lines (`GET /v1/...`), JSON request/response shapes, and commands that need infra CI can't run (embedded server startup, admin DB commands, FUSE mounts).
