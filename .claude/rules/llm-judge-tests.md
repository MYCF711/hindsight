---
paths:
  - "hindsight-api-slim/tests/**"
---

# Testing LLM behaviour

**Tests that verify LLM behaviour use a real LLM + an LLM-as-judge.** When the thing under test is *how the model interprets a prompt* (classification, attribution, dimension preservation, instruction-following), MockLLM can't simulate it and exact string/enum asserts flake across providers and runs. Use this pattern instead:

1. Mark the test module `pytestmark = pytest.mark.hs_llm_core` (single-provider; CI runs it in the core-LLM job). Use `hs_llm_mat` only for provider-matrix acceptance tests.
2. Call the real pipeline (`LLMConfig.from_env()`, `_get_raw_config()`), e.g. `extract_facts_from_text(...)`.
3. Assert with the judge, not string matching:
   ```python
   from tests.llm_judge import assert_meets_criteria
   facts_summary = "\n".join(f"- [{f.fact_type}] {f.fact}" for f in facts)
   await assert_meets_criteria(
       response=facts_summary,
       criteria="The first-person user statements are classified 'world' and attributed to the user, not the agent.",
       context="What the input said and who was speaking.",
   )
   ```

Rules of thumb:
- **Judge anything non-deterministic**, including `fact_type` classification and speaker attribution. Do not hard-assert `fact_type == "..."`; pass a `[fact_type] fact` summary to the judge instead. Structural facts that are deterministic (counts, presence of a field, that a substring was injected into a prompt) stay as direct asserts in fast unit tests.
- **Split the test surface**: cover the deterministic mechanics (prompt assembly, suppression logic) with fast non-LLM unit tests, and the model-following behaviour with one `hs_llm_core` judge test. (Example pair: `test_narrator_resolution.py` + `test_narrator_context_override.py`.)
- The judge model is independent of the test provider (defaults to Gemini); never judge with the same call you're testing.
