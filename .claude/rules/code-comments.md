---
paths:
  - "**/*.py"
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.mjs"
  - "**/*.rs"
  - "**/*.go"
---

# Code comments

- **Always comment non-trivial technical decisions** with the reasoning behind the choice. If someone would ask "why is it done this way?", there should be a comment.
- **Keep comments up to date with history** — when changing an approach, update the comment to explain what was tried before and why it was changed. Comments serve as a tracker of previous implementations that likely had problems.
- Don't comment obvious code — only where the "why" isn't self-evident from the code itself.

```python
# BAD - no context for future readers
results = await asyncio.gather(*tasks, return_exceptions=True)

# GOOD - explains the non-obvious choice
# Use return_exceptions=True to avoid cancelling sibling tasks on failure.
# Previously we used TaskGroup but it cancelled all tasks when one failed,
# causing partial writes that left orphaned entity links (see #412).
results = await asyncio.gather(*tasks, return_exceptions=True)
```
