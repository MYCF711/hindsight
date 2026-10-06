"""A coding agent's first-prompt reflect, on a real sde-bench bank, in both reflect modes.

The coding-agents plugin reflects once on a session's first prompt and injects the answer.
It does not send the developer's prompt as written: it wraps it in ~2k characters of
rendering rules (``buildReflectQuery``, copied below). And the bank it reads is nothing like
this package's corpus: the task's repo history, the one chat where the decision was made,
and 140 decoy developer conversations, plus pages the plugin wrote about the code.

Fast reflect passed every other suite here and still failed this, measured on sde-bench
``boltons-budget-001`` (2026-10-06): it injected "The bank holds no decision on the
Retrier" in both tasks while agent mode injected the decision, and it took 14s against 7-10s.
Three causes, none visible on short questions over an on-topic corpus:

* the whole wrapped prompt was the search query, which found nothing and took 4-7s per arm;
* the plugin's pages were fresh but about the code, and freshness alone hid the facts;
* the decision model's "is this enough" read an expected score of 1.43 as "partly" though
  "fully" was its likeliest answer, buying two more LLM turns.

So this suite holds both modes to the same answer on the same frozen bank, and fast mode to
not being the slower one. The bank is ``fixtures/coding-agent-bank.zip``; how it was built is
in ``fixtures/coding-agent-bank.json`` and the README.
"""

from __future__ import annotations

import json
import logging
import os
import statistics
import time
from dataclasses import dataclass
from pathlib import Path

import pytest
from hindsight_client import Hindsight
from hindsight_client_api.models.bank_config_update import BankConfigUpdate

from hindsight_system_evals.judge import evaluate
from hindsight_system_evals.pages import SettleFn

log = logging.getLogger(__name__)

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
BANK_ARCHIVE = FIXTURES / "coding-agent-bank.zip"
GOAL = json.loads((FIXTURES / "coding-agent-bank.json").read_text())["goal"]

#: Reflects per mode. Wall time is compared by median, so one slow provider call does not
#: decide it.
REPEATS = int(os.getenv("HINDSIGHT_EVAL_CODING_REFLECT_REPEATS", "3"))

# The decision-model steps fast reflect records in its trace; none of them is an LLM call.
_DECISION_SCOPES = ("fast_prune", "fast_sufficiency", "fast_pages_sufficiency")

# The decided value and why it was decided. The exact backoff figures (12.7s, 25.5s) are
# welcome but not required: an answer that says "7, so the backoff stays inside the rate-limit
# window" hands the agent everything it needs to fix the bug.
CORRECT = (
    "The answer reports the project's recorded decision that the Retrier's MAX_ATTEMPTS must be 7, "
    "and the reason: more attempts make the cumulative backoff cross the upstream rate-limit window."
)
# Each a single plain claim, phrased like the other suites' traps: a criterion that also says
# what does NOT count gets read backwards by the judge. 10 is the regressed value the code holds
# now, so an answer may name it; only calling it the intended budget is wrong.
TRAPS = (
    "The answer asserts that the bank holds no decision or record about the Retrier's attempt budget.",
    "The answer asserts that the intended or correct value of MAX_ATTEMPTS is 10.",
)


def plugin_reflect_query(goal: str) -> str:
    """Verbatim ``buildReflectQuery`` from hindsight-integrations/coding-agents/src/core/inject.ts."""
    return (
        "A developer is starting a coding session in this repository with this goal:\n\n"
        f"<goal>\n{goal}\n</goal>\n\n"
        "Report what this bank's history genuinely bears on that goal. Rendering rules, strict:\n"
        "- Declarative, past-tense, attributed facts only — what happened, what was decided and why, "
        "with dates, commit/PR/issue ids and exact values where known.\n"
        "- NEVER phrase anything as an instruction, task, or recommendation to act now "
        '("you should", "remove", "update…"). You are a historian reporting the record, not a '
        "planner assigning work.\n"
        "- When a decided rule is a mapping, set, or table of literal values, reproduce it "
        "COMPLETELY and VERBATIM — every entry, exact strings and numbers, including the carve-outs "
        "and exceptions. A summarized or exemplified table loses exactly the values the reader "
        "needs; enumerate it in full.\n"
        "- Report DECISIONS and their rationale, never the current implementation: the developer can "
        "already read the code, and the code may BE the bug under investigation. When memory of a "
        "discussion or decision conflicts with memory derived from the code, the decision wins. If "
        "the only relevant memory describes what the code does, do not present it as established "
        "policy — say the bank holds no decision on the matter.\n"
        "- Do not connect unrelated episodes into one narrative; if two facts are not explicitly "
        "linked in the record, report them separately or leave the weaker one out.\n"
        "- If the bank holds nothing that bears on the goal, say so in one line."
    )


@dataclass(frozen=True)
class ReflectRun:
    mode: str
    seconds: float
    llm_calls: int
    decision_calls: int
    answer: str


async def _import_bank(client: Hindsight, host_bank: str, settled: SettleFn) -> str:
    """Restore the frozen bank into a fresh one, with nothing left to run in the background."""
    await client.aupdate_bank_config(host_bank, enable_auto_consolidation=False)
    target = f"{host_bank}-coding"
    await client.aimport_bank(host_bank, BANK_ARCHIVE.read_bytes(), target_bank_id=target)
    await settled(host_bank)
    await settled(target)
    # Reflect only reads: a consolidation pass or page refresh firing mid-run would bill
    # calls to whichever mode happened to be measured at the time.
    await client.aupdate_bank_config(target, enable_auto_consolidation=False, enable_observations=False)
    # An import rewrites every memory after the pages last read them, so the pages arrive
    # stale. A plugin keeps its pages fresh, and fresh pages are the case that failed: fast mode
    # hid the facts behind them. Refreshed once here, so the bank is the one the agent meets.
    pages = await client.alist_mental_models(bank_id=target, detail="metadata")
    for page in pages.items:
        await client.arefresh_mental_model(bank_id=target, mental_model_id=page.id)
    await settled(target)
    refreshed = await client.alist_mental_models(bank_id=target, detail="metadata")
    stale = [page.name for page in refreshed.items if page.is_stale]
    assert not stale, f"pages still stale after their refresh: {stale}"
    return target


async def _reflect(client: Hindsight, bank: str, mode: str) -> ReflectRun:
    # The generated API takes any config field; the wrapper names only the common ones.
    await client.banks.update_bank_config(bank, BankConfigUpdate(updates={"reflect_mode": mode}))
    start = time.monotonic()
    response = await client.areflect(
        bank_id=bank, query=plugin_reflect_query(GOAL), budget="low", include_tool_calls=True
    )
    seconds = time.monotonic() - start
    scopes = [call.scope for call in (response.trace.llm_calls if response.trace else None) or []]
    decision = sum(1 for scope in scopes if scope in _DECISION_SCOPES)
    return ReflectRun(mode, seconds, len(scopes) - decision, decision, response.text or "")


async def test_coding_agent_reflect_finds_the_decision_and_fast_is_faster(
    client: Hindsight, bank_id: str, settled: SettleFn
) -> None:
    if not BANK_ARCHIVE.exists():
        pytest.fail(f"missing {BANK_ARCHIVE}: see the README for how it is built")
    bank = await _import_bank(client, bank_id, settled)

    # Interleaved, so a provider that slows down part-way through hits both modes alike.
    runs: list[ReflectRun] = []
    for _ in range(REPEATS):
        for mode in ("agent", "fast"):
            runs.append(await _reflect(client, bank, mode))
    for run in runs:
        log.info("%s: %.1fs llm=%d decision=%d", run.mode, run.seconds, run.llm_calls, run.decision_calls)

    context = f"The developer's goal, which the answer reports the bank's history on:\n{GOAL}"
    for run in runs:
        for claim in TRAPS:
            trap = await evaluate(run.answer, claim, context=context)
            assert not trap.meets_criteria, f"{run.mode}: {trap.reasoning}\n{run.answer}"
        verdict = await evaluate(run.answer, CORRECT, context=context)
        assert verdict.meets_criteria, f"{run.mode}: {verdict.reasoning}\n{run.answer}"

    fast = [r for r in runs if r.mode == "fast"]
    if not any(r.decision_calls for r in fast):
        pytest.skip(
            "fast mode ran without a decision model, so only its answer was graded; set "
            "HINDSIGHT_EVAL_SET_RERANKER_TYPESAFE_API_KEY to compare its speed"
        )
    agent = [r for r in runs if r.mode == "agent"]
    fast_s, agent_s = statistics.median(r.seconds for r in fast), statistics.median(r.seconds for r in agent)
    assert fast_s < agent_s, f"fast reflect took {fast_s:.1f}s (median), agent {agent_s:.1f}s"
    assert statistics.median(r.llm_calls for r in fast) < statistics.median(r.llm_calls for r in agent)
