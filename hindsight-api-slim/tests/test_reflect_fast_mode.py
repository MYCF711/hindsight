"""Fast reflect: the first retrieval runs without an LLM, and a decision model may end it.

Agent mode spends one LLM turn per retrieval layer only to write a search string.
Fast mode runs those layers in parallel with the question as the query, then asks a
decision model whether the evidence already answers it. These tests pin the
mechanics with a scripted provider; whether the answers hold up is the system
evals' job.
"""

from unittest.mock import AsyncMock

import pytest

from hindsight_api.engine.reflect.agent import run_reflect_agent
from hindsight_api.engine.response_models import LLMCallResult, LLMToolCall, LLMToolCallResult, TokenUsage


class _ScriptedProvider:
    """Answers each ``call_with_tools`` from a script and records the tool choice."""

    def __init__(self, scripted: list[LLMToolCallResult]):
        self._scripted = scripted
        self.tool_choices: list[str] = []

    async def call_with_tools(self, *, tool_choice, **_):
        self.tool_choices.append(tool_choice.function_name or tool_choice.mode.value)
        return self._scripted.pop(0)


def _done() -> LLMToolCallResult:
    return LLMToolCallResult(
        tool_calls=[LLMToolCall(id="d", name="done", arguments={"answer": "A", "memory_ids": ["mem-1"]})],
        finish_reason="tool_calls",
    )


def _functions() -> dict[str, AsyncMock]:
    return {
        "search_mental_models_fn": AsyncMock(return_value={"mental_models": [{"id": "mm-1", "content": "page"}]}),
        "read_mental_models_fn": AsyncMock(return_value={"mental_models": []}),
        "search_observations_fn": AsyncMock(return_value={"observations": [{"id": "obs-1", "text": "o"}]}),
        "recall_fn": AsyncMock(return_value={"memories": [{"id": "mem-1", "text": "m"}]}),
        "expand_fn": AsyncMock(return_value={"memories": []}),
    }


async def _reflect(provider: _ScriptedProvider, functions: dict[str, AsyncMock], sufficient: AsyncMock | None):
    return await run_reflect_agent(
        llm_config=provider,
        bank_id="b",
        query="where does Alice live?",
        bank_profile={"name": "T", "mission": "M"},
        has_mental_models=True,
        budget="mid",
        max_iterations=6,
        fast=True,
        evidence_is_sufficient_fn=sufficient,
        **functions,
    )


@pytest.mark.asyncio
async def test_sufficient_evidence_costs_one_llm_call():
    provider = _ScriptedProvider([_done()])
    functions = _functions()
    sufficient = AsyncMock(return_value=True)

    result = await _reflect(provider, functions, sufficient)

    assert result.text == "A"
    # Every layer ran once, with the question itself, and no LLM wrote a query.
    for name in ("search_mental_models_fn", "search_observations_fn", "recall_fn"):
        assert functions[name].await_count == 1
        assert functions[name].await_args.args[0] == "where does Alice live?"
    assert provider.tool_choices == ["done"], "the answer is the only LLM call"
    # The decision model saw the evidence all three layers returned.
    question, evidence = sufficient.await_args.args
    assert question == "where does Alice live?"
    assert all(marker in evidence for marker in ("page", '"o"', '"m"'))
    assert [c.scope for c in result.llm_trace] == ["fast_sufficiency", "closing_done"]


@pytest.mark.asyncio
async def test_insufficient_evidence_hands_over_to_the_agent():
    follow_up = LLMToolCallResult(
        tool_calls=[LLMToolCall(id="r", name="recall", arguments={"query": "Alice's new address"})],
        finish_reason="tool_calls",
    )
    provider = _ScriptedProvider([follow_up, _done()])
    functions = _functions()

    result = await _reflect(provider, functions, AsyncMock(return_value=False))

    assert result.text == "A"
    # The LLM's first turn is a free one, and the follow-up query is its own.
    assert provider.tool_choices == ["auto", "auto"]
    assert functions["recall_fn"].await_args_list[-1].args[0] == "Alice's new address"


@pytest.mark.asyncio
async def test_without_a_decision_model_the_agent_decides_after_the_parallel_retrieval():
    provider = _ScriptedProvider([_done()])
    functions = _functions()

    result = await _reflect(provider, functions, None)

    assert result.text == "A"
    assert provider.tool_choices == ["auto"], "no forced turns: the retrieval already ran"
    assert functions["recall_fn"].await_count == 1


@pytest.mark.asyncio
async def test_a_failing_decision_model_falls_back_to_the_agent():
    provider = _ScriptedProvider([_done()])

    result = await _reflect(provider, _functions(), AsyncMock(side_effect=RuntimeError("HTTP 403")))

    assert result.text == "A"
    assert provider.tool_choices == ["auto"]


@pytest.mark.asyncio
async def test_pruned_evidence_never_reaches_the_answer():
    provider = _ScriptedProvider([_done()])
    functions = _functions()
    functions["search_observations_fn"] = AsyncMock(
        return_value={
            "observations": [
                {"id": "obs-keep", "text": "Alice lives in Berlin", "source_fact_ids": ["sf-keep"]},
                {"id": "obs-drop", "text": "Bob likes tea", "source_fact_ids": ["sf-drop"]},
            ],
            "source_facts": {
                "sf-keep": {"id": "sf-keep", "text": "moved"},
                "sf-drop": {"id": "sf-drop", "text": "tea"},
            },
        }
    )
    functions["recall_fn"] = AsyncMock(
        return_value={
            "memories": [{"id": "mem-1", "text": "Alice moved to Berlin"}, {"id": "mem-2", "text": "Bob's tea"}],
            "chunks": {"ch-1": {"chunk_text": "Alice, Berlin"}, "ch-2": {"chunk_text": "tea notes"}},
        }
    )

    async def prune(question: str, texts: list[str]) -> list[bool]:
        assert question == "where does Alice live?"
        return ["Alice" in text for text in texts]

    sufficient = AsyncMock(return_value=True)
    result = await run_reflect_agent(
        llm_config=provider,
        bank_id="b",
        query="where does Alice live?",
        bank_profile={"name": "T", "mission": "M"},
        has_mental_models=True,
        budget="mid",
        max_iterations=6,
        fast=True,
        evidence_is_sufficient_fn=sufficient,
        prune_evidence_fn=prune,
        **{k: v for k, v in functions.items()},
    )

    evidence = sufficient.await_args.args[1]
    assert "Alice lives in Berlin" in evidence and "Alice moved to Berlin" in evidence and "Alice, Berlin" in evidence
    assert not any(gone in evidence for gone in ("Bob likes tea", "Bob's tea", "tea notes", '"tea"'))
    assert '"moved"' in evidence, "a kept observation keeps its source facts"
    assert result.text == "A"
    assert [c.scope for c in result.llm_trace] == ["fast_prune", "fast_sufficiency", "closing_done"]


@pytest.mark.asyncio
async def test_a_failing_pruner_keeps_all_evidence():
    provider = _ScriptedProvider([_done()])
    sufficient = AsyncMock(return_value=True)

    await run_reflect_agent(
        llm_config=provider,
        bank_id="b",
        query="q",
        bank_profile={"name": "T", "mission": "M"},
        has_mental_models=True,
        max_iterations=6,
        fast=True,
        evidence_is_sufficient_fn=sufficient,
        prune_evidence_fn=AsyncMock(side_effect=RuntimeError("HTTP 500")),
        **_functions(),
    )

    evidence = sufficient.await_args.args[1]
    assert '"o"' in evidence and '"m"' in evidence


def _fresh_page_functions() -> dict[str, AsyncMock]:
    functions = _functions()
    functions["search_mental_models_fn"] = AsyncMock(
        return_value={"mental_models": [{"id": "mm-1", "content": "the page", "is_stale": False}]}
    )
    return functions


@pytest.mark.asyncio
async def test_fresh_pages_that_answer_hide_the_lower_layers():
    """Pages the decision model says answer alone are read without the facts beside them."""
    provider = _ScriptedProvider([_done()])
    sufficient = AsyncMock(return_value=True)

    result = await _reflect(provider, _fresh_page_functions(), sufficient)

    pages_only = sufficient.await_args_list[0].args[1]
    assert "the page" in pages_only and '"o"' not in pages_only and '"m"' not in pages_only
    assert sufficient.await_count == 1, "the pages' verdict is the only check needed"
    assert [c.scope for c in result.llm_trace] == ["fast_pages_sufficiency", "closing_done"]


@pytest.mark.asyncio
async def test_fresh_pages_that_do_not_answer_keep_the_facts():
    """Fresh is not on topic: pages about the code must not hide a decision in the facts."""
    provider = _ScriptedProvider([_done()])
    # No on the pages alone, yes once the facts are in.
    sufficient = AsyncMock(side_effect=[False, True])

    await _reflect(provider, _fresh_page_functions(), sufficient)

    evidence = sufficient.await_args_list[1].args[1]
    assert "the page" in evidence and '"o"' in evidence and '"m"' in evidence


@pytest.mark.asyncio
async def test_without_a_decision_model_fresh_pages_hide_nothing():
    provider = _ScriptedProvider([_done()])

    await _reflect(provider, _fresh_page_functions(), None)

    assert provider.tool_choices == ["auto"]


class _QueryWritingProvider(_ScriptedProvider):
    """Also answers the tool-less call that distills a long request into a search query."""

    def __init__(self, scripted):
        super().__init__(scripted)
        self.distill_prompts: list[str] = []

    async def call(self, *, messages, **_):
        self.distill_prompts.append(messages[-1]["content"])
        return LLMCallResult(content="Retrier attempt budget", usage=TokenUsage(input_tokens=1, output_tokens=1))


@pytest.mark.asyncio
async def test_a_long_request_is_searched_with_a_distilled_query():
    """A plugin's 2k-character prompt found nothing and took seconds per search when searched as is."""
    long_request = "Restore the Retrier attempt budget. " + "Rendering rule: report history only. " * 40
    provider = _QueryWritingProvider([_done()])
    functions = _functions()

    result = await run_reflect_agent(
        llm_config=provider,
        bank_id="b",
        query=long_request,
        bank_profile={"name": "T", "mission": "M"},
        has_mental_models=True,
        max_iterations=6,
        fast=True,
        evidence_is_sufficient_fn=AsyncMock(return_value=True),
        **functions,
    )

    assert provider.distill_prompts == [long_request]
    for name in ("search_mental_models_fn", "search_observations_fn", "recall_fn"):
        assert functions[name].await_args.args[0] == "Retrier attempt budget"
    assert [c.scope for c in result.llm_trace][0] == "fast_query"


@pytest.mark.asyncio
async def test_a_short_question_is_searched_as_written():
    provider = _QueryWritingProvider([_done()])
    functions = _functions()

    await _reflect(provider, functions, AsyncMock(return_value=True))

    assert provider.distill_prompts == []
    assert functions["recall_fn"].await_args.args[0] == "where does Alice live?"


@pytest.mark.asyncio
async def test_the_first_batch_skips_the_search_reranker_only_when_the_decision_model_prunes():
    """The decision model re-ranks the first batch; a cross-encoder pass before it is wasted time."""
    from hindsight_api.engine.reflect.tools import skip_search_rerank

    seen: list[bool] = []

    async def recall(query, *args):
        seen.append(skip_search_rerank.get())
        return {"memories": [{"id": "mem-1", "text": "m"}]}

    follow_up = LLMToolCallResult(
        tool_calls=[LLMToolCall(id="r", name="recall", arguments={"query": "follow-up"})],
        finish_reason="tool_calls",
    )
    for prune, expected in (
        (AsyncMock(side_effect=lambda q, texts: [True] * len(texts)), [True, False]),
        (None, [False, False]),
    ):
        seen.clear()
        functions = _functions()
        functions["recall_fn"] = AsyncMock(side_effect=recall)
        await run_reflect_agent(
            llm_config=_ScriptedProvider([follow_up, _done()]),
            bank_id="b",
            query="q",
            bank_profile={"name": "T", "mission": "M"},
            has_mental_models=True,
            max_iterations=6,
            fast=True,
            evidence_is_sufficient_fn=AsyncMock(return_value=False),
            prune_evidence_fn=prune,
            **functions,
        )
        # The first batch, then the agent's own follow-up search, which always reranks.
        assert seen == expected
