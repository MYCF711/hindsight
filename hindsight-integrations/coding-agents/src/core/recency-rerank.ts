/**
 * ★ LOCAL FORK PATCH 2026-10-07: recency re-rank for recall results.
 *
 * WHY (every point measured, each reproducible — see fork/ docs):
 *   ① The client ALREADY receives timestamps. `RecallResultRow` declares
 *      `mentioned_at?` / `occurred_start?` (L45-46), and recall returns them
 *      for 100% of rows (300/300 across 12 real queries).
 *   ② …but upstream only USES them to print a date prefix (L1044-1046).
 *      Nothing re-orders on them, so a memory recorded a week ago and one
 *      recorded yesterday arrive in whatever order the retriever produced.
 *   ③ A client-side re-rank is already precedent in this fork:
 *      `applyFanoutPenalty()` re-orders recall rows before injection.
 *   ④ The timestamps ARE separable inside the returned page — the situation
 *      that actually matters. Across 12 real queries / 300 results: unique
 *      timestamps 291/300 = 97.0%; 12/12 queries "mostly distinct"; 0/12
 *      "heavily duplicated". (Library-wide uniqueness is only 47.1%, but that
 *      is the wrong denominator: only the returned page needs to be
 *      separable. I first drew the pessimistic conclusion from the
 *      library-wide number and had to retract it —
 *      fork/时效重排可行性-反证推翻.md.)
 *   ⑤ The mechanism fixes the symptom this project is chasing: in an isolated
 *      bank a superseded approach ranked #1 in 2 of 6 probes; after recency
 *      re-rank, 0 of 6 (fork/受控实验-已废弃条目仍排第一.md).
 *
 * ⚠ THE SIDE EFFECT THIS MUST NOT IGNORE:
 *   A PURE time sort ignores relevance. Measured: the superseded row did not
 *   merely drop below the correction — it fell to LAST place. If a query asks
 *   what was done historically, burying the old row is wrong. So this is NOT a
 *   time sort: it breaks ties by time only when two rows are already
 *   comparably relevant; otherwise relevance wins.
 *
 * GATING: `HINDSIGHT_RECENCY_RERANK` — default OFF, so when it is unset the
 * recall path is behaviourally identical to upstream. The mechanism and the
 * data are established; whether the agent then BEHAVES better is not.
 */

import type { RecallResultRow } from "./hindsight";

/**
 * Default OFF — see GATING above.
 *
 * ⚠ Read at CALL time, not module load. Upstream's flags in hindsight.ts are
 * read once at module load, which suits a process-wide setting but makes the
 * behaviour untestable within one process: the first test would freeze the
 * value for every later one. Reading through these accessors lets a test
 * toggle the flag per call.
 */
export function rerankEnabled(): boolean {
  const v = process.env.HINDSIGHT_RECENCY_RERANK;
  if (v === undefined) return false;
  const s = v.trim().toLowerCase();
  if (s === "0" || s === "false" || s === "no" || s === "off" || s === "") return false;
  if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
  return false;
}

/**
 * Relevance closeness threshold: rows whose `final` scores differ by no more
 * than this RELATIVE amount count as "equally relevant", so time may break the
 * tie.
 *
 * Relative rather than absolute because score scales differ per query; an
 * absolute threshold either never fires or fires on everything.
 *
 * ★ CALIBRATED against real recall data (15 queries, 360 adjacent pairs,
 *   measured by lab/_slx/calibrate-recency-threshold.py):
 *
 *     adjacent-pair relative score gap:  p10 0.008 | p25 0.042 | p50 0.153
 *                                        p75 0.336 | p90 0.575
 *     share of pairs allowed a time tiebreak, by threshold:
 *       0.01 → 10.6%   0.02 → 15.6%   ★0.05 → 26.9%   0.10 → 41.1%
 *       0.20 → 58.1%   0.50 → 86.7%
 *
 *   So 0.05 lets time decide roughly a quarter of adjacent pairs — enough to
 *   change what the agent reads, not so much that relevance is overridden.
 *   Context: 48.6% of adjacent pairs already have "higher score but older", so
 *   there is real room for a recency rule to act.
 *
 * ⚠ Still NOT an optimum. Choosing the best value needs a downstream behaviour
 *   experiment ("does the agent stop reusing retired approaches?"), not run.
 */
export function similarRel(): number {
  const v = process.env.HINDSIGHT_RECENCY_SIMILAR_REL;
  if (v) {
    const f = Number(v);
    if (Number.isFinite(f) && f >= 0 && f <= 1) return f;
  }
  return 0.05;
}

/**
 * The row's most trustworthy timestamp.
 *
 * Prefers `mentioned_at` (when this was recorded) over `occurred_start` (when
 * the described event happened): "which memory is newer" is about RECORD time,
 * since today's note about a ten-year-old event is a NEW memory whose content
 * happens to be old. Falls back through the aliases the server uses on other
 * paths (`date` is `date ?? mentioned_at` upstream).
 */
function recallStamp(r: RecallResultRow): string {
  return String(r.mentioned_at || r.occurred_start || r.date || "");
}

/** The fused score recall sorted on; `reranker` is the stage before it. */
function recallScore(r: RecallResultRow): number | null {
  const v = r.scores?.final ?? r.scores?.reranker;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Re-order recall rows so a NEWER memory outranks an OLDER one only when they
 * are comparably relevant. Returns a new array; never mutates the input.
 *
 * When the flag is off this returns the input array unchanged (the same
 * reference), so the call site can stay unconditional and pay nothing.
 *
 * ★ HOW (and why it is a two-pass sort, not a comparator):
 *
 *   The first implementation used a single comparator
 *     better(a,b) = gap(a,b) > rel ? (a.score > b.score) : (a.time > b.time)
 *   and ran an insertion sort with it. That comparator is NOT a total order:
 *   it mixes two criteria, so three rows can mutually beat each other.
 *   Proven by exhaustive search over score/time triples
 *   (lab/_slx/prove-nontransitive2.cjs: score set [0.90, 0.86, 0.82] yields
 *   cycles) and by consequence: the same three rows produce THREE different
 *   orderings depending on input order (lab/_slx/prove-order-dependence.cjs).
 *   Since input order is whatever the server returned, that made the output
 *   non-deterministic — a genuine correctness bug, not a tuning issue.
 *
 *   The fix makes the ordering a deterministic function of the row SET:
 *     1. sort by score descending (stable) — a total order on one key
 *     2. walk that array and cut it into runs that are "comparably relevant":
 *        each run extends while a row's score stays within `rel` OF THE RUN'S
 *        FIRST row (not of its neighbour — neighbour-chaining is exactly what
 *        made the old comparator non-transitive)
 *     3. sort each run by timestamp descending (stable)
 *
 *   Because the runs are cut from the score-sorted array, and each run's
 *   membership is decided against a single anchor score, the result no longer
 *   depends on the incoming order.
 */
export function applyRecencyRerank(rows: RecallResultRow[]): RecallResultRow[] {
  if (!rerankEnabled() || rows.length < 2) return rows;

  const rel = similarRel();

  // 1 — total order by score. Rows without a usable score sort last, keeping
  //     their relative order (a stable sort preserves it).
  const byScore = rows.slice().sort((a, b) => {
    const sa = recallScore(a);
    const sb = recallScore(b);
    if (sa === null && sb === null) return 0;
    if (sa === null) return 1;
    if (sb === null) return -1;
    return sb - sa;
  });

  // 2 + 3 — cut into comparably-relevant runs, then order each run by recency.
  const out: RecallResultRow[] = [];
  const scoreless: RecallResultRow[] = [];
  let i = 0;
  while (i < byScore.length) {
    const anchor = recallScore(byScore[i]);
    // No score means "not comparable with anything scored" — hold it aside and
    // order it by time alone at the end. Time is a single key, so that stays
    // deterministic; leaving these in arrival order would be arbitrary.
    // (Measured: every real recall row carries scores, so this is defensive.)
    if (anchor === null) {
      scoreless.push(byScore[i]);
      i++;
      continue;
    }
    let j = i + 1;
    while (j < byScore.length) {
      const s = recallScore(byScore[j]);
      if (s === null) break;
      const denom = Math.max(Math.abs(anchor), Math.abs(s), 1e-9);
      if (Math.abs(anchor - s) / denom > rel) break;
      j++;
    }
    const run = byScore.slice(i, j);
    // Stable by timestamp descending: rows with equal (or absent) timestamps
    // keep the score order established above.
    run.sort((a, b) => {
      const ta = recallStamp(a);
      const tb = recallStamp(b);
      if (!ta || !tb || ta === tb) return 0;
      return tb < ta ? -1 : 1;
    });
    out.push(...run);
    i = j;
  }
  scoreless.sort((a, b) => {
    const ta = recallStamp(a);
    const tb = recallStamp(b);
    if (!ta || !tb || ta === tb) return 0;
    return tb < ta ? -1 : 1;
  });
  return out.concat(scoreless);
}

/**
 * Observable effect of a re-rank, for the `__recencyRerank` diagnostic field.
 *
 * ⚠ Deliberately reports only what moved — it does NOT claim the order got
 *   better. That needs a downstream experiment, and asserting it here would be
 *   the kind of unfounded claim this project keeps getting bitten by.
 */
export function recencyRerankDiagnostic(
  before: RecallResultRow[],
  after: RecallResultRow[],
): { rows: number; moved: number; maxShift: number; similarRel: number } {
  const key = (r: RecallResultRow) => String(r.id || "");
  const pos = new Map<string, number>();
  before.forEach((r, i) => pos.set(key(r), i));
  let moved = 0;
  let maxShift = 0;
  after.forEach((r, i) => {
    const j = pos.get(key(r));
    if (j === undefined) return;
    if (j !== i) {
      moved++;
      maxShift = Math.max(maxShift, Math.abs(i - j));
    }
  });
  return { rows: after.length, moved, maxShift, similarRel: similarRel() };
}
