"""TypeSafe reranker: the rank question, the cut question, and what comes back.

TypeSafe answers typed questions rather than exposing a /rerank endpoint, so the
mapping from (query, doc) pairs onto questions — and from answers back onto scores —
is this provider's whole substance. The HTTP round trip is faked; what is asserted is
the requests we build and the order and cut we derive from the answers.
"""

from contextlib import asynccontextmanager
from dataclasses import fields
from unittest.mock import patch

import pytest

from hindsight_api.config import HindsightConfig
from hindsight_api.engine.cross_encoder import (
    _OPTION_KEY_OVERHEAD,
    TypeSafeCrossEncoder,
    _strip_shared_prefix,
    _value_payload,
    rerank_shared_context,
    create_cross_encoder_from_env,
    rerank_instructions,
)
from hindsight_api.engine.token_encoding import count_tokens


class _FakeResponse:
    def __init__(self, payload: dict):
        self._payload = payload
        self.status = 200

    async def json(self, content_type=None):
        return self._payload

    def raise_for_status(self) -> None:
        return None


class _FakeSession:
    """Answers a rank question from `ranking` and a cut question from `cut_level`.

    `ranking` maps an option key ("c0", "c1", …) to the probability the model would
    give it, so a pool ranked in several rounds is answered per round exactly as the
    real API would answer it.
    """

    def __init__(self, ranking: dict[str, float], cut_level: float = 0.0, keep: dict[str, float] | None = None):
        self.ranking = ranking
        self.cut_level = cut_level
        self.keep = keep or {}
        self.posted: list[dict] = []
        self.urls: list[str] = []

    def get(self):
        return self

    @asynccontextmanager
    async def _post(self, url, headers=None, json=None):
        self.urls.append(url)
        self.posted.append(json)
        question_id, question = next(iter(json["questions"].items()))
        if question["type"] == "noul":
            # One answer per question: a pointwise request carries many of them.
            yield _FakeResponse(
                {"answers": {key: {"type": "noul", "noul": self.keep.get(key, 0.0)} for key in json["questions"]}}
            )
            return
        if question["type"] == "choice":
            keys = list(question["criteria"])
            answer = {
                "type": "choice",
                "choice": keys[0],
                "probabilities": {key: self.ranking.get(key, 0.0) for key in keys},
                "confidence": 0.9,
            }
        else:
            answer = {
                "type": "score",
                "score": self.cut_level,
                "legend": dict(enumerate(question["criteria"])),
                "confidence": 0.9,
            }
        yield _FakeResponse({"answers": {question_id: answer}, "usage": {"input_tokens": 1, "output_tokens": 1}})

    def post(self, url, headers=None, json=None):
        return self._post(url, headers=headers, json=json)

    @property
    def rank_requests(self) -> list[dict]:
        return [body for body in self.posted if next(iter(body["questions"].values()))["type"] == "choice"]

    @property
    def cut_requests(self) -> list[dict]:
        return [body for body in self.posted if next(iter(body["questions"].values()))["type"] == "score"]


def _encoder(
    ranking: dict[str, float],
    cut_level: float = 0.0,
    max_question_tokens: int | None = None,
    **kwargs,
):
    """An encoder for the listwise tests below. The mode is pinned rather than inherited
    from the default, so these keep testing the Choice shape they are about."""
    kwargs.setdefault("rank_mode", "listwise")
    encoder = TypeSafeCrossEncoder(api_key="k", **kwargs)
    if max_question_tokens is not None:
        encoder.MAX_QUESTION_TOKENS = max_question_tokens
    session = _FakeSession(ranking, cut_level)
    encoder._session = session
    return encoder, session


def _make_config(**overrides) -> HindsightConfig:
    defaults: dict = {}
    for f in fields(HindsightConfig):
        if f.type == "str":
            defaults[f.name] = ""
        elif f.type == "int":
            defaults[f.name] = 0
        elif f.type == "float":
            defaults[f.name] = 0.0
        elif f.type == "bool":
            defaults[f.name] = False
        elif str(f.type).startswith("list["):
            defaults[f.name] = []
        else:
            defaults[f.name] = None
    defaults.update(overrides)
    return HindsightConfig(**defaults)


class TestRanking:
    @pytest.mark.asyncio
    async def test_the_answer_order_becomes_the_score_order(self):
        """c2 wins, then c0, then c1 — the scores must sort the same way."""
        encoder, _ = _encoder({"c0": 0.3, "c1": 0.1, "c2": 0.6})
        scores = await encoder._predict([("q", "first"), ("q", "second"), ("q", "third")])

        assert scores[2] > scores[0] > scores[1]

    @pytest.mark.asyncio
    async def test_scores_are_positions_not_the_returned_probabilities(self):
        """A Choice probability is a share of one pool, so it is not handed on as a score."""
        encoder, _ = _encoder({"c0": 0.9, "c1": 0.07, "c2": 0.03})
        scores = await encoder._predict([("q", "a"), ("q", "b"), ("q", "c")])

        assert scores == [1.0, pytest.approx(2 / 3), pytest.approx(1 / 3)]

    @pytest.mark.asyncio
    async def test_the_whole_pool_is_one_call(self):
        encoder, session = _encoder({f"c{i}": 1.0 / (i + 1) for i in range(20)})
        await encoder._predict([("q", f"doc {i}") for i in range(20)])

        assert len(session.rank_requests) == 1
        assert len(session.cut_requests) == 0, "the cut question is only asked when pruning"

    @pytest.mark.asyncio
    async def test_candidates_are_the_options_and_the_query_is_the_question(self):
        encoder, session = _encoder({"c0": 1.0})
        await encoder._predict([("who paid?", "Alice paid the bill")])

        body = session.rank_requests[0]
        assert body["model"] == "jev-latest"
        assert "who paid?" in body["state"]
        question = body["questions"]["rank"]
        assert question["type"] == "choice"
        assert question["criteria"] == {"c0": "Alice paid the bill"}

    @pytest.mark.asyncio
    async def test_each_query_is_ranked_in_its_own_pool(self):
        """Two queries cannot share a ranking: a Choice ranks against one question."""
        encoder, session = _encoder({"c0": 0.9, "c1": 0.1})
        scores = await encoder._predict([("a", "doc-a"), ("b", "doc-b"), ("a", "doc-a2")])

        assert len(session.rank_requests) == 2
        assert len(scores) == 3
        assert scores[0] > scores[2], "query a's own two candidates keep their order"

    @pytest.mark.asyncio
    async def test_empty_pairs_make_no_request(self):
        encoder, session = _encoder({})
        assert await encoder._predict([]) == []
        assert session.posted == []


class TestRankingRules:
    @pytest.mark.asyncio
    async def test_the_banks_rules_join_the_rank_question(self):
        encoder, session = _encoder({"c0": 0.6, "c1": 0.4})
        token = rerank_instructions.set("- prefer what the user said")
        try:
            await encoder._predict([("who paid?", "a"), ("who paid?", "b")])
        finally:
            rerank_instructions.reset(token)

        instructions = session.rank_requests[0]["questions"]["rank"]["instructions"]
        assert "who paid?" in instructions
        assert "- prefer what the user said" in instructions

    @pytest.mark.asyncio
    async def test_no_rules_leaves_the_plain_question(self):
        encoder, session = _encoder({"c0": 0.6, "c1": 0.4})
        await encoder._predict([("who paid?", "a"), ("who paid?", "b")])

        assert session.rank_requests[0]["questions"]["rank"]["instructions"] == (
            "Which candidate answers the question: who paid?"
        )

    @pytest.mark.asyncio
    async def test_oversized_rules_are_capped(self):
        encoder, session = _encoder({"c0": 0.6, "c1": 0.4})
        token = rerank_instructions.set("prefer newer facts. " * 5000)
        try:
            await encoder._predict([("q", "a"), ("q", "b")])
        finally:
            rerank_instructions.reset(token)

        instructions = session.rank_requests[0]["questions"]["rank"]["instructions"]
        assert count_tokens(instructions) < 2_100


class TestChunking:
    @pytest.mark.asyncio
    async def test_a_pool_over_the_option_cap_is_ranked_in_rounds(self):
        """A Choice takes at most 255 options, so a bigger pool needs several rounds."""
        size = TypeSafeCrossEncoder.MAX_OPTIONS + 10
        encoder, session = _encoder({f"c{i}": 1.0 / (i + 1) for i in range(size)})
        scores = await encoder._predict([("q", f"doc {i}") for i in range(size)])

        # Two rounds over the halves, then one more over their winners.
        assert len(session.rank_requests) == 3
        assert all(len(body["questions"]["rank"]["criteria"]) <= 255 for body in session.rank_requests)
        assert len(scores) == size

    @pytest.mark.asyncio
    async def test_every_candidate_still_gets_a_distinct_position(self):
        size = TypeSafeCrossEncoder.MAX_OPTIONS + 10
        encoder, _ = _encoder({f"c{i}": 1.0 / (i + 1) for i in range(size)})
        scores = await encoder._predict([("q", f"doc {i}") for i in range(size)])

        assert len(set(scores)) == size, "positions must be distinct, not collapsed onto ties"
        assert min(scores) > 0.0, "nothing is pruned when prune_candidates is off"


class TestCut:
    @pytest.mark.asyncio
    async def test_the_cut_question_is_asked_only_when_pruning(self):
        encoder, session = _encoder({f"c{i}": 1.0 / (i + 1) for i in range(5)}, prune_candidates=True)
        await encoder._predict([("q", f"doc {i}") for i in range(5)])

        assert len(session.cut_requests) == 1
        question = session.cut_requests[0]["questions"]["depth"]
        assert question["type"] == "score"
        assert question["criteria"] == TypeSafeCrossEncoder.CUT_LEVELS

    @pytest.mark.asyncio
    async def test_level_zero_keeps_only_the_best_candidate(self):
        encoder, _ = _encoder({"c0": 0.2, "c1": 0.7, "c2": 0.1}, cut_level=0.0, prune_candidates=True)
        scores = await encoder._predict([("q", "a"), ("q", "b"), ("q", "c")])

        assert scores[1] > 0.0
        assert scores[0] == 0.0 and scores[2] == 0.0

    @pytest.mark.asyncio
    async def test_a_deeper_level_keeps_more(self):
        encoder, _ = _encoder({"c0": 0.2, "c1": 0.7, "c2": 0.1}, cut_level=2.0, prune_candidates=True)
        scores = await encoder._predict([("q", "a"), ("q", "b"), ("q", "c")])

        assert all(score > 0.0 for score in scores), "level 2 keeps the first three"

    @pytest.mark.asyncio
    async def test_the_cut_never_empties_the_result(self):
        """There is no 'nothing is relevant' level, so the best candidate always survives."""
        encoder, _ = _encoder({"c0": 0.4, "c1": 0.35, "c2": 0.25}, cut_level=-1.0, prune_candidates=True)
        scores = await encoder._predict([("q", "a"), ("q", "b"), ("q", "c")])

        assert sum(1 for score in scores if score > 0.0) == 1

    @pytest.mark.asyncio
    async def test_the_top_level_keeps_the_whole_shortlist(self):
        encoder, _ = _encoder(
            {f"c{i}": 1.0 / (i + 1) for i in range(4)},
            cut_level=float(len(TypeSafeCrossEncoder.CUT_LEVELS) - 1),
            prune_candidates=True,
        )
        scores = await encoder._predict([("q", f"doc {i}") for i in range(4)])

        assert all(score > 0.0 for score in scores)

    @pytest.mark.asyncio
    async def test_nothing_is_pruned_when_the_flag_is_off(self):
        encoder, _ = _encoder({"c0": 0.9, "c1": 0.05, "c2": 0.05})
        scores = await encoder._predict([("q", "a"), ("q", "b"), ("q", "c")])

        assert all(score > 0.0 for score in scores)


class TestFactory:
    def test_provider_is_built_from_config(self):
        config = _make_config(
            reranker_provider="typesafe",
            reranker_typesafe_api_key="k",
            reranker_typesafe_model="jev-latest",
            reranker_typesafe_base_url="https://api.typesafe.ai",
            reranker_typesafe_max_concurrent=8,
            reranker_typesafe_prune_candidates=True,
        )
        with patch("hindsight_api.config.get_config", return_value=config):
            encoder = create_cross_encoder_from_env()

        assert encoder.provider_name == "typesafe"
        assert encoder.model == "jev-latest"
        assert encoder.prunes_candidates is True

    def test_missing_api_key_names_its_env_var(self):
        config = _make_config(reranker_provider="typesafe")
        with patch("hindsight_api.config.get_config", return_value=config):
            with pytest.raises(ValueError, match="HINDSIGHT_API_RERANKER_TYPESAFE_API_KEY"):
                create_cross_encoder_from_env()

    def test_defaults_are_jev_and_no_pruning(self):
        config = HindsightConfig.from_env()
        assert config.reranker_typesafe_model == "jev-latest"
        assert config.reranker_typesafe_prune_candidates is False

    @pytest.mark.asyncio
    async def test_base_url_is_honoured(self):
        encoder, session = _encoder({"c0": 1.0}, base_url="https://proxy.example.com/")
        await encoder._predict([("q", "doc")])
        assert session.urls == ["https://proxy.example.com/v1/systemone"]


class TestPointwiseRanking:
    """One Noul per candidate: would showing this one help, rather than distract.

    A Choice is comparative and ranks the head of a pool well; this puts every candidate on
    one absolute scale, which is what holds the order down to wherever the caller's budget
    cuts. It is the default for that reason.
    """

    def _encoder(self, keep: dict[str, float], **kwargs):
        encoder = TypeSafeCrossEncoder(api_key="k", resolve_conflicts=False, **kwargs)
        session = _FakeSession({}, keep=keep)
        encoder._session = session
        return encoder, session

    def test_it_is_the_default(self):
        assert TypeSafeCrossEncoder(api_key="k").rank_mode == "pointwise"

    def test_an_unknown_mode_is_refused(self):
        with pytest.raises(ValueError, match="listwise"):
            TypeSafeCrossEncoder(api_key="k", rank_mode="pairwise")

    @pytest.mark.asyncio
    async def test_the_scores_order_the_candidates(self):
        encoder, _ = self._encoder({"m0": 0.1, "m1": 0.9, "m2": 0.5})
        scores = await encoder._predict([("q", "a"), ("q", "b"), ("q", "c")])
        assert scores[1] > scores[2] > scores[0]

    @pytest.mark.asyncio
    async def test_every_candidate_is_asked_about_and_the_query_is_the_state(self):
        encoder, session = self._encoder({f"m{i}": 0.5 for i in range(3)})
        await encoder._predict([("what changed?", "a"), ("what changed?", "b"), ("what changed?", "c")])
        body = session.posted[0]
        assert body["state"] == "Question: what changed?"
        assert len(body["questions"]) == 3
        assert [q["instructions"]["memory"] for q in body["questions"].values()] == ["a", "b", "c"]
        assert all(q["type"] == "noul" for q in body["questions"].values())

    @pytest.mark.asyncio
    async def test_a_pool_over_the_question_cap_is_split_across_requests(self):
        size = TypeSafeCrossEncoder.MAX_QUESTIONS + 5
        encoder, session = self._encoder({f"m{i}": 0.5 for i in range(size)})
        await encoder._predict([("q", f"candidate_{i}") for i in range(size)])
        assert len(session.posted) == 2
        assert sum(len(body["questions"]) for body in session.posted) == size

    @pytest.mark.asyncio
    async def test_candidates_scored_the_same_keep_their_input_order(self):
        """Equal scores must not reshuffle the pool: input order is the RRF order."""
        encoder, _ = self._encoder({f"m{i}": 0.5 for i in range(4)})
        scores = await encoder._predict([("q", f"candidate_{i}") for i in range(4)])
        assert scores[0] > scores[1] > scores[2] > scores[3]

    @pytest.mark.asyncio
    async def test_a_failed_batch_keeps_its_candidates(self):
        """An unranked candidate is recoverable; a deleted one is not."""
        encoder = TypeSafeCrossEncoder(api_key="k", resolve_conflicts=False)
        session = _FakeSession({})

        @asynccontextmanager
        async def post(url, headers=None, json=None):
            raise RuntimeError("upstream down")
            yield  # pragma: no cover

        session.post = lambda url, headers=None, json=None: post(url, headers=headers, json=json)
        encoder._session = session
        scores = await encoder._predict([("q", "a"), ("q", "b")])
        assert len(scores) == 2 and all(score > 0.0 for score in scores)


class TestSharedPreamble:
    """Recall prefixes every candidate with its bank context, which on a single-conversation
    bank is the same profile block on all of them. The decision provider judges and compares
    what is each candidate's own."""

    PROFILE = (
        "Conversation 1 - USER PROFILE:\n"
        "  Name: Craig Baker\n"
        "  Age: 49 years old\n"
        "  Gender: Male\n"
        "  Location: Port Matthew\n"
        "  Occupation: backend developer building a personal budget tracker\n"
        "  Interests: cycling, cooking, open source\n"
        "  Preferred stack: Flask, Postgres, plain CSS"
    )

    def test_a_preamble_every_candidate_shares_is_stripped(self):
        docs = [f"{self.PROFILE}\nThe deadline is April 5", f"{self.PROFILE}\nThe team chose Postgres"]
        assert _strip_shared_prefix(docs, [0, 1]) == {0: "The deadline is April 5", 1: "The team chose Postgres"}

    def test_a_preamble_only_some_share_is_kept(self):
        """Stripping needs the whole pool to agree, or it would cut real content."""
        docs = [f"{self.PROFILE}\nalpha", f"{self.PROFILE}\nbeta", "no profile here"]
        assert _strip_shared_prefix(docs, [0, 1, 2]) == {0: docs[0], 1: docs[1], 2: docs[2]}

    def test_identical_candidates_keep_their_text(self):
        """Stripping everything would leave nothing to rank."""
        docs = ["same line", "same line"]
        assert _strip_shared_prefix(docs, [0, 1]) == {0: "same line", 1: "same line"}

    @pytest.mark.asyncio
    async def test_the_shared_context_goes_in_the_state_once(self):
        """Not onto each candidate: identical text cannot rank them, and it costs the
        window once per candidate."""
        encoder = TypeSafeCrossEncoder(api_key="k", resolve_conflicts=False)
        session = _FakeSession({}, keep={"m0": 0.9, "m1": 0.1})
        encoder._session = session
        token = rerank_shared_context.set(self.PROFILE)
        try:
            await encoder._predict([("q", "The deadline is April 5"), ("q", "The team chose Postgres")])
        finally:
            rerank_shared_context.reset(token)
        body = session.posted[0]
        assert body["state"] == f"{self.PROFILE}\n\nQuestion: q"
        asked = [q["instructions"]["memory"] for q in body["questions"].values()]
        assert asked == ["The deadline is April 5", "The team chose Postgres"]
        assert all(self.PROFILE not in text for text in asked)

    @pytest.mark.asyncio
    async def test_the_preamble_does_not_reach_the_rank_question(self):
        encoder = TypeSafeCrossEncoder(api_key="k", resolve_conflicts=False)
        session = _FakeSession({}, keep={"m0": 0.9, "m1": 0.1})
        encoder._session = session
        await encoder._predict(
            [("q", f"{self.PROFILE}\nThe deadline is April 5"), ("q", f"{self.PROFILE}\nThe team chose Postgres")]
        )
        asked = [q["instructions"]["memory"] for q in session.posted[0]["questions"].values()]
        assert asked == ["The deadline is April 5", "The team chose Postgres"]

    def test_the_preamble_does_not_make_unrelated_candidates_conflict(self):
        """With it left in, 60 tokens of shared boilerplate put any two candidates over the
        overlap threshold, and two unrelated facts read as a disagreement."""
        encoder = TypeSafeCrossEncoder(api_key="k", resolve_conflicts=True)
        own = _strip_shared_prefix(
            [f"{self.PROFILE}\nThe deadline is April 5, 2024", f"{self.PROFILE}\nThe team chose Postgres"], [0, 1]
        )
        assert encoder._conflict_clusters("What is the deadline?", [own[0], own[1]], [0, 1]) == []


class TestConflictResolution:
    """Which of two candidates that disagree states the current answer.

    The pair here is the shape the behaviour was built on: a corrected deadline and the
    stale claim it corrects, overlapping on almost every token and differing on one number.
    Ranking cannot separate them — only asking about them together can.
    """

    STALE = "The first sprint has a deadline of April 1, 2024 for completing the basic layout and navigation"
    CURRENT = "The first sprint has a deadline of April 5, 2024 for completing the basic layout and navigation"
    OTHER = "The team chose Postgres for storage"
    QUERY = "What is the deadline for completing the first sprint?"

    def _encoder(self, choice=None, confidence=0.9, resolve=True):
        """An encoder whose conflict question answers `choice`, with the asks recorded."""
        encoder = TypeSafeCrossEncoder(api_key="k", resolve_conflicts=resolve)
        session = _FakeSession({}, cut_level=5.0)
        session.conflicts: list[dict] = []
        plain_post = session._post

        @asynccontextmanager
        async def post(url, headers=None, json=None):
            question = next(iter(json["questions"].values()))
            if question["instructions"] == encoder._CONFLICT_INSTRUCTIONS:
                session.conflicts.append(json)
                answers = {
                    key: {"type": "choice", "choice": choice, "confidence": confidence} for key in json["questions"]
                }
                yield _FakeResponse({"answers": answers})
            else:
                async with plain_post(url, headers=headers, json=json) as response:
                    yield response

        session.post = lambda url, headers=None, json=None: post(url, headers=headers, json=json)
        encoder._session = session
        return encoder, session

    @property
    def _pairs(self):
        return [(self.QUERY, self.STALE), (self.QUERY, self.CURRENT), (self.QUERY, self.OTHER)]

    @pytest.mark.asyncio
    async def test_the_superseded_candidate_is_dropped_not_demoted(self):
        """Reordering is not enough: a generator reading several stale restatements and one
        correction follows the majority, so the stale ones have to leave."""
        encoder, _ = self._encoder(choice="c1")
        scores = await encoder._predict(self._pairs)
        assert scores[0] == 0.0, "the superseded candidate must be pruned, not ranked lower"
        assert scores[1] > 0.0
        assert encoder.prunes_candidates is True

    async def test_a_restatement_is_demoted_not_deleted(self):
        """Overlap is a guess about what a candidate says, not a judgement that it is untrue,
        and it reads a standing instruction phrased like its neighbours as a restatement of
        them. Deleting on that basis cost real evidence; the caller's budget cuts from the
        back, so demoting still keeps restatements out of the answer."""
        encoder, _ = self._encoder(choice=None, confidence=0.0)
        restatement = f"{self.STALE}, as agreed"
        scores = await encoder._predict([(self.QUERY, self.STALE), (self.QUERY, restatement)])
        assert all(score > 0.0 for score in scores), "a restatement must not be pruned"
        assert scores[0] > scores[1], "it belongs behind the one it restates"

    @pytest.mark.asyncio
    async def test_a_hedged_verdict_drops_nothing(self):
        """Below the floor the model is not resolving a conflict, and a wrong drop deletes
        the answer. Keeping both leaves recall where it already was."""
        encoder, _ = self._encoder(choice="c1", confidence=0.5)
        scores = await encoder._predict(self._pairs)
        assert all(score > 0.0 for score in scores)

    @pytest.mark.asyncio
    async def test_a_question_that_does_not_ask_for_a_value_is_left_alone(self):
        """A supersession can only matter when the answer IS a value."""
        encoder, session = self._encoder(choice="c1")
        query = "Who owns the first sprint?"
        await encoder._predict([(query, self.STALE), (query, self.CURRENT)])
        assert session.conflicts == []

    @pytest.mark.asyncio
    async def test_candidates_that_are_not_about_the_question_are_left_alone(self):
        """Most candidates carry some incidental number; sharing one is not a conflict."""
        encoder, session = self._encoder(choice="c0")
        await encoder._predict(
            [
                (self.QUERY, "Version 1 of the logo was approved by the design team"),
                (self.QUERY, "Version 2 of the logo was approved by the design team"),
            ]
        )
        assert session.conflicts == []

    @pytest.mark.asyncio
    async def test_resolution_is_off_unless_asked_for(self):
        encoder, session = self._encoder(choice="c1", resolve=False)
        scores = await encoder._predict(self._pairs)
        assert session.conflicts == []
        assert all(score > 0.0 for score in scores)

    @pytest.mark.asyncio
    async def test_a_failed_conflict_call_keeps_every_candidate(self):
        """Recall returning a stale candidate beside the current one is where it was
        before; failing the whole rerank over it would be worse."""
        encoder = TypeSafeCrossEncoder(api_key="k", resolve_conflicts=True)
        session = _FakeSession({}, cut_level=5.0)
        plain_post = session._post

        @asynccontextmanager
        async def post(url, headers=None, json=None):
            if next(iter(json["questions"].values()))["instructions"] == encoder._CONFLICT_INSTRUCTIONS:
                raise RuntimeError("upstream down")
            async with plain_post(url, headers=headers, json=json) as response:
                yield response

        session.post = lambda url, headers=None, json=None: post(url, headers=headers, json=json)
        encoder._session = session
        scores = await encoder._predict(self._pairs)
        assert all(score > 0.0 for score in scores)

    def test_a_terse_correction_conflicts_with_what_it_corrects(self):
        """They overlap on almost every token and differ on one number: that is the pair
        supersession exists to settle, so it has to reach the question."""
        encoder = TypeSafeCrossEncoder(api_key="k", resolve_conflicts=True)
        assert encoder._conflict_clusters(self.QUERY, [self.STALE, self.CURRENT], [0, 1]) == [[0, 1]]

    @pytest.mark.asyncio
    async def test_a_confident_verdict_reaches_every_stale_restatement(self):
        """The same stale value restated many times spreads across several clusters, and the
        hedged ones are skipped. Dropping only the question's own members leaves the majority
        stale, which is what a generator answers from."""
        stale = [f"{self.STALE} (restated {n})" for n in range(5)]
        docs = [self.CURRENT, *stale]
        encoder, _ = self._encoder(choice="c0", confidence=0.95)
        order = list(range(len(docs)))
        superseded = await encoder._superseded(self.QUERY, docs, order)
        assert 0 not in superseded, "the winner must survive"
        assert len(superseded) == len(stale), "every candidate disagreeing with the winner goes"

    def test_a_crowded_conflict_is_narrowed_not_skipped(self):
        """A stale value restated many times against one correction is the case that matters.
        Discarding the cluster for being large leaves the majority standing, and a generator
        reading ten stale restatements and one correction answers with the stale one."""
        encoder = TypeSafeCrossEncoder(api_key="k", resolve_conflicts=True)
        stale = [f"{self.STALE} in phase {n}" for n in range(encoder.CONFLICT_MAX_CLUSTER + 5)]
        docs = [self.CURRENT, *stale]
        order = list(range(len(docs)))
        clusters = encoder._conflict_clusters(self.QUERY, docs, order)
        assert clusters, "a crowded conflict must still be resolved"
        assert all(len(cluster) <= encoder.CONFLICT_MAX_CLUSTER for cluster in clusters)
        assert any(0 in cluster for cluster in clusters), "the correction has to be in the question"

    def test_a_cluster_is_the_anchor_and_its_direct_peers_only(self):
        """Grouping transitively collapsed a whole pool into one component; anchoring on
        each top-ranked candidate is what stops the chaining."""
        encoder = TypeSafeCrossEncoder(api_key="k", resolve_conflicts=True)
        docs = [self.STALE, self.CURRENT, self.OTHER]
        assert encoder._conflict_clusters(self.QUERY, docs, [0, 1, 2]) == [[0, 1]]


class TestDateIsMetadataNotContent:
    """Recall prefixes each candidate with its date. It belongs on the text the model ranks,
    where a rule can prefer the more recent candidate, and nowhere near a comparison."""

    DATE = "[Date: June 05, 2024 (2024-06-05)] "

    def test_two_candidates_sharing_a_date_do_not_conflict_because_of_it(self):
        encoder = TypeSafeCrossEncoder(api_key="k", resolve_conflicts=True)
        docs = [f"{self.DATE}The team chose Postgres for storage", f"{self.DATE}The deadline moved to April 5"]
        assert encoder._conflict_clusters("What is the deadline?", docs, [0, 1]) == []

    def test_the_dates_digits_stay_out_of_the_value_payload(self):
        """Otherwise 2024 and 06 read as the numbers the question turns on."""
        assert _value_payload(f"{self.DATE}the deadline is April 5") == (frozenset({5}), frozenset({"april"}))

    def test_the_date_still_reaches_the_ranked_text(self):
        encoder = TypeSafeCrossEncoder(api_key="k")
        docs = [f"{self.DATE}alpha", f"{self.DATE}beta"]
        own = _strip_shared_prefix(docs, [0, 1])
        assert all(value.startswith("[Date:") for value in own.values())


class TestRerankerType:
    """The reranker type is what an operator picks; the provider says who serves it."""

    @staticmethod
    def _env(monkeypatch, **env):
        for name in (
            "HINDSIGHT_API_RERANKER_TYPE",
            "HINDSIGHT_API_RERANKER_PROVIDER",
            "HINDSIGHT_API_RERANKER_1_PROVIDER",
        ):
            monkeypatch.delenv(name, raising=False)
        for name, value in env.items():
            monkeypatch.setenv(name, value)
        return HindsightConfig.from_env()

    def test_the_type_alone_picks_the_provider(self, monkeypatch):
        """One env var is enough: the type's own default provider serves it."""
        config = self._env(monkeypatch, HINDSIGHT_API_RERANKER_TYPE="decision_model")
        assert config.reranker_type == "decision_model"
        assert config.reranker_provider == "typesafe"

    def test_the_provider_alone_still_picks_the_type(self, monkeypatch):
        """How this was configured before the type existed, so it has to keep working."""
        config = self._env(monkeypatch, HINDSIGHT_API_RERANKER_PROVIDER="typesafe")
        assert config.reranker_type == "decision_model"

    def test_the_default_is_a_cross_encoder(self, monkeypatch):
        config = self._env(monkeypatch)
        assert config.reranker_type == "cross_encoder"
        assert config.reranker_provider == "local"

    def test_an_unknown_type_names_the_ones_there_are(self, monkeypatch):
        with pytest.raises(ValueError, match="cross_encoder, decision_model"):
            self._env(monkeypatch, HINDSIGHT_API_RERANKER_TYPE="llm")

    def test_a_provider_that_does_not_serve_the_type_is_refused(self, monkeypatch):
        """Mismatched, this would score some recalls with the boosts and some without."""
        config = self._env(
            monkeypatch,
            HINDSIGHT_API_RERANKER_TYPE="cross_encoder",
            HINDSIGHT_API_RERANKER_PROVIDER="typesafe",
        )
        with patch("hindsight_api.config.get_config", return_value=config):
            with pytest.raises(ValueError, match="does not serve HINDSIGHT_API_RERANKER_TYPE"):
                create_cross_encoder_from_env()

    def test_a_fallback_of_the_other_kind_is_refused(self, monkeypatch):
        """A chain may not mix kinds: which member answered would decide the scoring."""
        config = self._env(
            monkeypatch,
            HINDSIGHT_API_RERANKER_TYPE="decision_model",
            HINDSIGHT_API_RERANKER_TYPESAFE_API_KEY="k",
            HINDSIGHT_API_RERANKER_1_PROVIDER="cohere",
            HINDSIGHT_API_RERANKER_1_COHERE_API_KEY="k",
        )
        with patch("hindsight_api.config.get_config", return_value=config):
            with pytest.raises(ValueError, match="HINDSIGHT_API_RERANKER_1_PROVIDER"):
                create_cross_encoder_from_env()

    def test_a_passthrough_fallback_serves_either_kind(self, monkeypatch):
        """rrf does no ranking, so it is a valid last member of either chain."""
        config = self._env(
            monkeypatch,
            HINDSIGHT_API_RERANKER_TYPE="decision_model",
            HINDSIGHT_API_RERANKER_TYPESAFE_API_KEY="k",
            HINDSIGHT_API_RERANKER_1_PROVIDER="rrf",
        )
        with patch("hindsight_api.config.get_config", return_value=config):
            encoder = create_cross_encoder_from_env()
        assert encoder.primary_provider_name == "typesafe"


class TestTokenBudgetingAndOrder:
    @pytest.mark.asyncio
    async def test_single_round_fast_path_when_pool_fits(self):
        """When candidates <= 250 and within token limit, only 1 request is made (no finals)."""
        encoder, session = _encoder({f"c{i}": 1.0 / (i + 1) for i in range(50)})
        scores = await encoder._predict([("q", f"short doc {i}") for i in range(50)])

        assert len(session.rank_requests) == 1
        assert "rank" in session.rank_requests[0]["questions"]
        assert len(scores) == 50

    @pytest.mark.asyncio
    async def test_non_finalists_preserve_relative_rrf_order_without_inversion(self):
        """Issue #4599: non-finalists preserve caller input order (RRF), discarding intra-group model ranks.

        The mock model assigns higher probabilities to later option positions, inverting the
        candidate ranking within each group relative to input RRF order. The finals take as
        much as one Choice holds, so candidates 20..269 compete there and 0..19 miss out.
        Under the old chunk-based concatenation, non-finalists kept their intra-group model
        ranking, so candidate 19 outranked candidate 0; they fall back to input order instead,
        because a probability from a round that is not the finals is not on a shared scale.
        """
        size = TypeSafeCrossEncoder.MAX_OPTIONS + 20  # 270 candidates
        # Intra-group model preference is opposite to initial RRF order
        encoder, session = _encoder({f"c{i}": float(i + 1) for i in range(size)})
        pairs = [("q", f"candidate_{i}") for i in range(size)]
        scores = await encoder._predict(pairs)

        all_non_finalists = list(range(0, 20))
        for a, b in zip(all_non_finalists[:-1], all_non_finalists[1:]):
            assert scores[a] > scores[b], f"Expected score[{a}] > score[{b}] by initial RRF order"

    @pytest.mark.asyncio
    async def test_the_finals_are_as_wide_as_one_call_allows(self):
        """A partitioned pool sends as much as fits to the finals, not a few per round.

        A candidate that misses the finals carries no model rank at all, and recall drops
        the recency and temporal boosts for this provider, so input order is then the only
        thing ordering it. One ranked 51st in its round still has to meet the other round's
        candidates, and it costs no extra call to let it.
        """
        size = TypeSafeCrossEncoder.MAX_OPTIONS + 20  # two rounds: 250, then 20
        # Each round is ranked in its own input order, so candidate_50 is its round's 51st.
        encoder, session = _encoder({f"c{i}": 1.0 / (i + 1) for i in range(size)})
        await encoder._predict([("q", f"candidate_{i}") for i in range(size)])

        finals = list(session.rank_requests[-1]["questions"]["rank"]["criteria"].values())
        assert len(finals) == TypeSafeCrossEncoder.MAX_OPTIONS
        assert "candidate_50" in finals

    @pytest.mark.asyncio
    async def test_candidate_packing_by_tokens_partitions_long_docs_into_multiple_groups(self):
        """When total candidate tokens exceed question budget, candidates are partitioned into groups."""
        max_question_tokens = 500
        long_doc = "word " * 60  # ~61 tokens + 7 key overhead = 68 tokens
        size = 8  # 8 docs: Group 0 has 6 docs (~446 tok), Group 1 has 2 docs (~174 tok)
        encoder, session = _encoder(
            {f"c{i}": 1.0 / (i + 1) for i in range(size)},
            max_question_tokens=max_question_tokens,
        )
        scores = await encoder._predict([("q", f"{long_doc} {i}") for i in range(size)])

        # 2 group requests + 1 finals request = 3 total
        assert len(session.rank_requests) == 3
        assert len(scores) == size

    @pytest.mark.asyncio
    async def test_cut_phase_truncation_prevents_overflow(self):
        """When shortlist docs are very long, uniform capping truncates them so State tokens stay within budget."""
        max_question_tokens = 800
        long_doc = "information about the project " * 40
        encoder, session = _encoder(
            {f"c{i}": 1.0 / (i + 1) for i in range(12)},
            cut_level=2.0,
            prune_candidates=True,
            max_question_tokens=max_question_tokens,
        )
        scores = await encoder._predict([("q", f"{long_doc} {i}") for i in range(12)])

        assert len(session.cut_requests) == 1
        cut_body = session.cut_requests[0]
        state_tokens = count_tokens(cut_body["state"])
        assert state_tokens <= max_question_tokens, f"State tokens {state_tokens} exceeded budget {max_question_tokens}"
        assert any(s > 0.0 for s in scores)

    @pytest.mark.asyncio
    async def test_finals_round_truncation_prevents_overflow(self):
        """When finalists' total tokens exceed question budget, uniform capping truncates them."""
        max_question_tokens = 500
        long_doc = "detailed context information " * 15
        size = 16
        encoder, session = _encoder(
            {f"c{i}": 1.0 / (i + 1) for i in range(size)},
            max_question_tokens=max_question_tokens,
        )
        scores = await encoder._predict([("q", f"{long_doc} {i}") for i in range(size)])

        assert len(scores) == size
        finals_request = session.rank_requests[-1]
        assert "rank" in finals_request["questions"]
        criteria = finals_request["questions"]["rank"]["criteria"]
        total_criteria_tokens = sum(count_tokens(text) for text in criteria.values())
        assert total_criteria_tokens <= max_question_tokens

    @pytest.mark.asyncio
    async def test_choice_questions_never_have_fewer_than_two_options(self):
        """Regression test for [P1]: Choice questions must NEVER have fewer than 2 options.

        Jev strictly rejects single-option Choice questions with 4xx ('criteria must map 2 or more options').
        Even when oversized documents force single-candidate groups in token packing,
        preliminary rounds for 1-candidate groups are skipped, and candidates are resolved
        in the finals where at least 2 options are present.
        """
        max_question_tokens = 500
        huge_doc = "word " * 400
        encoder, session = _encoder(
            {"c0": 0.8, "c1": 0.2},
            max_question_tokens=max_question_tokens,
        )
        scores = await encoder._predict([("q", f"{huge_doc} 1"), ("q", f"{huge_doc} 2")])
        assert len(scores) == 2

        # Every Choice question sent across all requests MUST have >= 2 criteria options
        for body in session.rank_requests:
            for q_id, q_data in body["questions"].items():
                if q_data.get("type") == "choice":
                    criteria_count = len(q_data.get("criteria", {}))
                    assert criteria_count >= 2, (
                        f"Question {q_id} in request has {criteria_count} options; TypeSafe requires at least 2 options"
                    )

    @pytest.mark.asyncio
    async def test_cut_phase_obeys_token_budget_with_overlong_query(self):
        """Regression test for [P2]: _cut must share bounded query and obey token budget.

        When query has 40k tokens and prune_candidates=True, _cut must not explode
        into an 80k token request. Both _rank and _cut must operate on the identical bounded query.
        """
        max_question_tokens = 500
        overlong_query = "who was in the room? " * 1000  # ~5,000 tokens
        encoder, session = _encoder(
            {"c0": 0.8, "c1": 0.2},
            cut_level=1.0,
            prune_candidates=True,
            max_question_tokens=max_question_tokens,
        )
        scores = await encoder._predict([(overlong_query, "doc 1"), (overlong_query, "doc 2")])
        assert len(scores) == 2

        assert len(session.rank_requests) >= 1
        assert len(session.cut_requests) == 1

        rank_state = session.rank_requests[0]["state"]
        cut_state = session.cut_requests[0]["state"]

        # Rank state and Cut prefix must use the EXACT same effective query
        assert rank_state in cut_state

        # Cut request State must strictly obey max_question_tokens
        cut_state_tokens = count_tokens(cut_state)
        assert cut_state_tokens <= max_question_tokens, (
            f"Cut state has {cut_state_tokens} tokens, exceeding budget {max_question_tokens}"
        )

    @pytest.mark.asyncio
    async def test_all_questions_strictly_obey_token_ceilings(self):
        """Invariant check: In every choice question, total tokens <= max_question_tokens."""
        max_question_tokens = 600
        doc = "sample context words " * 25
        size = 30
        encoder, session = _encoder(
            {f"c{i}": 1.0 / (i + 1) for i in range(size)},
            max_question_tokens=max_question_tokens,
        )
        scores = await encoder._predict([("q", f"{doc} {i}") for i in range(size)])
        assert len(scores) == size

        for body in session.posted:
            state_tokens = count_tokens(body["state"])
            for q_id, q_data in body.get("questions", {}).items():
                instr_tokens = count_tokens(q_data.get("instructions", ""))
                crit_tokens = sum(count_tokens(text) for text in q_data.get("criteria", {}).values())
                envelope = len(q_data.get("criteria", {})) * _OPTION_KEY_OVERHEAD
                q_tokens = instr_tokens + crit_tokens + envelope
                assert state_tokens + q_tokens <= max_question_tokens, f"Question {q_id} exceeded question budget"

    @pytest.mark.asyncio
    async def test_single_overlong_candidate_safely_pre_truncated(self):
        """A candidate document that individually exceeds question budget is pre-truncated safely."""
        max_question_tokens = 500
        long_doc = "word " * 1000  # ~1000 tokens, far exceeding 500
        encoder, session = _encoder(
            {"c0": 0.8, "c1": 0.2},
            max_question_tokens=max_question_tokens,
        )
        scores = await encoder._predict([("q", long_doc), ("q", "short doc")])
        assert len(scores) == 2
        for body in session.rank_requests:
            state_tokens = count_tokens(body["state"])
            for q_data in body["questions"].values():
                instr_tokens = count_tokens(q_data.get("instructions", ""))
                crit_tokens = sum(count_tokens(text) for text in q_data["criteria"].values())
                envelope = len(q_data["criteria"]) * _OPTION_KEY_OVERHEAD
                assert state_tokens + instr_tokens + crit_tokens + envelope <= max_question_tokens

    @pytest.mark.asyncio
    async def test_pre_truncated_candidate_carries_truncated_text_into_finals(self):
        """When an outlier document is pre-truncated in packing, the pre-truncated text
        (not the original oversized document) must be passed into the finals round.
        """
        max_question_tokens = 500
        huge_doc = "outlier document content " * 300
        normal_doc = "normal length document content " * 15
        encoder, session = _encoder(
            {"c0": 0.6, "c1": 0.4},
            max_question_tokens=max_question_tokens,
        )
        with patch.object(encoder, "_rank_once", wraps=encoder._rank_once) as mock_rank_once:
            scores = await encoder._predict([("q", huge_doc), ("q", normal_doc)])
            assert len(scores) == 2

            # The call to _rank_once must receive pre-truncated text in effective_docs
            passed_docs = mock_rank_once.call_args[0][1]
            assert len(passed_docs[0]) < len(huge_doc)

        finals_request = session.rank_requests[-1]
        criteria = finals_request["questions"]["rank"]["criteria"]
        c0_text = criteria["c0"]
        assert len(c0_text) < len(huge_doc)
        assert count_tokens(c0_text) < max_question_tokens

    @pytest.mark.asyncio
    async def test_overlong_query_defensively_truncated_without_budget_blowup(self):
        """An overlong query is defensively capped so it never manufactures overflow budget."""
        max_question_tokens = 500
        long_query = "query word " * 800  # ~800 tokens, far exceeding question budget
        encoder, session = _encoder(
            {"c0": 0.8, "c1": 0.2},
            max_question_tokens=max_question_tokens,
        )
        scores = await encoder._predict([(long_query, "doc 1"), (long_query, "doc 2")])
        assert len(scores) == 2
        for body in session.rank_requests:
            state_tokens = count_tokens(body["state"])
            assert state_tokens <= max_question_tokens

    @pytest.mark.asyncio
    async def test_finals_never_exceed_the_option_cap_when_long_docs_make_many_groups(self):
        """Long documents split the pool into many groups; the finals is still one Choice <= MAX_OPTIONS.

        Here ~3 documents fit a group, so 30 candidates make ~10 groups whose winners, at a
        fixed 12 per group, would all reach a finals capped at 10. In production the same
        happens once a pool splits into more than 250 // 12 = 20 groups.
        """
        size = 30
        encoder, session = _encoder({f"c{i}": 1.0 / (i + 1) for i in range(size)}, max_question_tokens=400)
        encoder.MAX_OPTIONS = 10
        scores = await encoder._predict([("q", "long document words " * 40 + str(i)) for i in range(size)])

        assert len(scores) == size
        assert all(len(body["questions"]["rank"]["criteria"]) <= 10 for body in session.rank_requests)
