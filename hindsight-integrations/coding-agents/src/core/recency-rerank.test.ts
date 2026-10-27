/**
 * Tests for the recency re-rank (`recency-rerank.ts`).
 *
 * ★ Why test this carefully: the function changes the ORDER of what the agent
 *   reads. Getting it wrong buries relevant memories. Every assertion below
 *   corresponds to a measured fact or a deliberate safety property.
 *
 * Run:
 *   cd fork/client-build
 *   npx vitest run ../client-features/recency-rerank/recency-rerank.test.ts
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  applyRecencyRerank,
  recencyRerankDiagnostic,
} from "./recency-rerank.js";

type Row = {
  id?: string;
  text?: string;
  mentioned_at?: string;
  occurred_start?: string;
  scores?: { final?: number; reranker?: number };
};

/** A row with a score and a record time. */
function row(id: string, final: number | undefined, mentioned: string): Row {
  return {
    id,
    text: `text-${id}`,
    mentioned_at: mentioned,
    scores: final === undefined ? undefined : { final },
  };
}

const OLD = "2026-09-20T10:00:00+00:00";
const MID = "2026-10-01T10:00:00+00:00";
const NEW = "2026-10-06T10:00:00+00:00";

beforeEach(() => {
  delete process.env.HINDSIGHT_RECENCY_RERANK;
  delete process.env.HINDSIGHT_RECENCY_SIMILAR_REL;
});

describe("gating", () => {
  it("★ is OFF by default and returns the SAME array (zero effect)", async () => {
    const rows = [row("a", 0.9, OLD), row("b", 0.9, NEW)] as never[];
    const out = applyRecencyRerank(rows);
    // Identity — not merely equal content. Off must be a true no-op.
    expect(out).toBe(rows);
    expect(out[0].id).toBe("a");
  });

  it("does nothing when enabled=false", async () => {
    process.env.HINDSIGHT_RECENCY_RERANK = "0";
    const rows = [row("a", 0.9, OLD), row("b", 0.9, NEW)] as never[];
    expect(applyRecencyRerank(rows)).toBe(rows);
  });

  it("stays silent on unset/empty/invalid values", async () => {
    for (const v of ["", "maybe", "2"]) {
      process.env.HINDSIGHT_RECENCY_RERANK = v;
      const rows = [row("a", 0.9, OLD), row("b", 0.9, NEW)] as never[];
      expect(applyRecencyRerank(rows)).toBe(rows);
    }
  });

  it("activates for each accepted truthy spelling", async () => {
    for (const v of ["1", "true", "yes", "on", "ON", "True"]) {
      process.env.HINDSIGHT_RECENCY_RERANK = v;
      const rows = [row("a", 0.9, OLD), row("b", 0.9, NEW)] as never[];
      // enabled ⇒ returns a NEW array
      expect(applyRecencyRerank(rows)).not.toBe(rows);
    }
  });
});

describe("★ relevance wins when the gap is large", () => {
  it("does NOT promote a much newer but far less relevant row", async () => {
    process.env.HINDSIGHT_RECENCY_RERANK = "1";
    // a is clearly more relevant (0.90 vs 0.10) but much older.
    const rows = [row("a", 0.9, OLD), row("b", 0.1, NEW)] as never[];
    const out = applyRecencyRerank(rows);
    expect(out.map((r: Row) => r.id)).toEqual(["a", "b"]);
  });

  it("does NOT let time reorder a moderately lower score", async () => {
    process.env.HINDSIGHT_RECENCY_RERANK = "1";
    // 0.50 vs 0.40 → relative gap 0.2 > 0.05 default ⇒ relevance decides.
    const rows = [row("a", 0.5, OLD), row("b", 0.4, NEW)] as never[];
    expect(applyRecencyRerank(rows).map((r: Row) => r.id)).toEqual(["a", "b"]);
  });
});

describe("★ time breaks the tie when relevance is comparable", () => {
  it("promotes the newer row when scores are equal", async () => {
    process.env.HINDSIGHT_RECENCY_RERANK = "1";
    const rows = [row("old", 0.8, OLD), row("new", 0.8, NEW)] as never[];
    expect(applyRecencyRerank(rows).map((r: Row) => r.id)).toEqual(["new", "old"]);
  });

  it("promotes the newer row when the gap is within the threshold", async () => {
    process.env.HINDSIGHT_RECENCY_RERANK = "1";
    // 0.800 vs 0.795 → relative gap 0.006 < 0.05 ⇒ time decides.
    const rows = [row("old", 0.8, OLD), row("new", 0.795, NEW)] as never[];
    expect(applyRecencyRerank(rows).map((r: Row) => r.id)).toEqual(["new", "old"]);
  });

  it("keeps relevance order when the newer row is also less relevant beyond the threshold", async () => {
    process.env.HINDSIGHT_RECENCY_RERANK = "1";
    const rows = [row("old", 0.80, OLD), row("new", 0.70, NEW)] as never[];
    expect(applyRecencyRerank(rows).map((r: Row) => r.id)).toEqual(["old", "new"]);
  });

  it("honours a custom threshold", async () => {
    process.env.HINDSIGHT_RECENCY_RERANK = "1";
    process.env.HINDSIGHT_RECENCY_SIMILAR_REL = "0.5";
    // 0.8 vs 0.5 → gap 0.375 < 0.5 ⇒ now the newer one wins.
    const rows = [row("old", 0.8, OLD), row("new", 0.5, NEW)] as never[];
    expect(applyRecencyRerank(rows).map((r: Row) => r.id)).toEqual(["new", "old"]);
  });
});

describe("safety: never lose or duplicate rows", () => {
  it("preserves the multiset of rows", async () => {
    process.env.HINDSIGHT_RECENCY_RERANK = "1";
    const rows = [
      row("a", 0.5, OLD),
      row("b", 0.5, NEW),
      row("c", 0.5, MID),
      row("d", 0.9, OLD),
    ] as never[];
    const out = applyRecencyRerank(rows);
    expect(out).toHaveLength(rows.length);
    expect(new Set(out.map((r: Row) => r.id))).toEqual(
      new Set(rows.map((r: Row) => r.id)),
    );
  });

  it("does not mutate the input array", async () => {
    process.env.HINDSIGHT_RECENCY_RERANK = "1";
    const rows = [row("a", 0.8, OLD), row("b", 0.8, NEW)] as never[];
    const snapshot = rows.map((r: Row) => r.id);
    applyRecencyRerank(rows);
    expect(rows.map((r: Row) => r.id)).toEqual(snapshot);
  });

  it("is a stable no-op when every score and time is identical", async () => {
    process.env.HINDSIGHT_RECENCY_RERANK = "1";
    const rows = [row("a", 0.5, MID), row("b", 0.5, MID), row("c", 0.5, MID)] as never[];
    expect(applyRecencyRerank(rows).map((r: Row) => r.id)).toEqual(["a", "b", "c"]);
  });
});

/**
 * ★ Order-independence — the regression guard for a real bug.
 *
 *   The first implementation used a comparator mixing two criteria (score when
 *   the gap was large, time when small). Such a comparator is not a total
 *   order: three rows could mutually beat each other, so the output depended on
 *   the INPUT order. Measured: the same three rows produced THREE different
 *   orderings across the six input permutations
 *   (lab/_slx/prove-order-dependence.cjs). Since input order is just whatever
 *   the server returned, recall ordering was non-deterministic.
 *
 *   The two-pass sort (sort by score, cut into runs anchored on the run's first
 *   score, sort each run by time) makes the result a function of the row SET.
 *   These tests pin that down.
 */
describe("★ determinism: output must not depend on input order", () => {
  const T_OLD = "2026-09-29T01:00:00+00:00";
  const T_MID = "2026-09-30T02:00:00+00:00";
  const T_NEW = "2026-10-04T03:00:00+00:00";

  /** The cycle-prone triple: each score within 5% of the anchor, times reversed. */
  function cycleRows(): Row[] {
    return [
      { id: "A", text: "A", mentioned_at: T_OLD, scores: { final: 0.9 } },
      { id: "B", text: "B", mentioned_at: T_NEW, scores: { final: 0.82 } },
      { id: "C", text: "C", mentioned_at: T_MID, scores: { final: 0.86 } },
    ];
  }

  function permutations<T>(arr: T[]): T[][] {
    if (arr.length <= 1) return [arr];
    const out: T[][] = [];
    arr.forEach((x, i) => {
      const rest = arr.slice(0, i).concat(arr.slice(i + 1));
      for (const p of permutations(rest)) out.push([x, ...p]);
    });
    return out;
  }

  it("★★ the same 3 rows give ONE ordering across all 6 input permutations", async () => {
    process.env.HINDSIGHT_RECENCY_RERANK = "1";
    const results = new Set<string>();
    for (const p of permutations(cycleRows())) {
      const out = applyRecencyRerank(p.map((r) => ({ ...r })) as never[]);
      results.add(out.map((r: Row) => r.id).join(","));
    }
    expect([...results]).toHaveLength(1);
  });

  it("★ stays deterministic on a larger, cycle-prone set (40 permutations)", async () => {
    process.env.HINDSIGHT_RECENCY_RERANK = "1";
    const base: Row[] = [
      { id: "a", text: "", mentioned_at: T_OLD, scores: { final: 0.9 } },
      { id: "b", text: "", mentioned_at: T_NEW, scores: { final: 0.82 } },
      { id: "c", text: "", mentioned_at: T_MID, scores: { final: 0.86 } },
      { id: "d", text: "", mentioned_at: T_OLD, scores: { final: 0.4 } },
      { id: "e", text: "", mentioned_at: T_NEW, scores: { final: 0.86 } },
    ];
    const first = applyRecencyRerank(base.map((r) => ({ ...r })) as never[])
      .map((r: Row) => r.id)
      .join(",");
    for (const p of permutations(base).slice(0, 40)) {
      const out = applyRecencyRerank(p.map((r) => ({ ...r })) as never[])
        .map((r: Row) => r.id)
        .join(",");
      expect(out).toBe(first);
    }
  });

  it("★ still honours the contract: inside a run, newest first", async () => {
    process.env.HINDSIGHT_RECENCY_RERANK = "1";
    const out = applyRecencyRerank(cycleRows() as never[]);
    // ⚠ Scores sorted desc = A(0.90) C(0.86) B(0.82).
    //    Cut against the anchor 0.90: A (.000) and C (.044) are in the run;
    //    B (.089) opens a new one. So run1 = [A,C] → by time C(09-30) before
    //    A(09-29); run2 = [B]. Expected: C,A,B — NOT B,C,A (all three are not
    //    in one run, which an earlier version of this test wrongly assumed).
    expect(out.map((r: Row) => r.id)).toEqual(["C", "A", "B"]);
  });

  it("★ clearly-less-relevant rows stay below the run regardless of time", async () => {
    process.env.HINDSIGHT_RECENCY_RERANK = "1";
    const rows: Row[] = [
      { id: "relOld", text: "", mentioned_at: T_OLD, scores: { final: 0.9 } },
      { id: "farNew", text: "", mentioned_at: T_NEW, scores: { final: 0.2 } },
    ];
    expect(applyRecencyRerank(rows as never[]).map((r: Row) => r.id))
      .toEqual(["relOld", "farNew"]);
  });

  it("★ the run boundary is measured against the ANCHOR, not the neighbour", async () => {
    process.env.HINDSIGHT_RECENCY_RERANK = "1";
    // 0.90 → 0.86: gap vs anchor .044 ≤ .05 ⇒ same run
    // 0.82:        gap vs anchor .089 >  .05 ⇒ new run, even though it is
    //              within 5% of its neighbour 0.86. Neighbour-chaining is what
    //              made the old comparator non-transitive.
    const rows: Row[] = [
      { id: "x", text: "", mentioned_at: T_NEW, scores: { final: 0.82 } },
      { id: "y", text: "", mentioned_at: T_OLD, scores: { final: 0.9 } },
      { id: "z", text: "", mentioned_at: T_MID, scores: { final: 0.86 } },
    ];
    // run1 = [0.90(y), 0.86(z)] ⇒ by time, z(MID) before y(OLD)
    // run2 = [0.82(x)]
    expect(applyRecencyRerank(rows as never[]).map((r: Row) => r.id))
      .toEqual(["z", "y", "x"]);
  });
});


describe("degenerate inputs must not crash or guess", () => {
  it("handles the empty list", async () => {
    process.env.HINDSIGHT_RECENCY_RERANK = "1";
    expect(applyRecencyRerank([])).toEqual([]);
  });

  it("handles a single row", async () => {
    process.env.HINDSIGHT_RECENCY_RERANK = "1";
    const rows = [row("only", 0.5, OLD)] as never[];
    expect(applyRecencyRerank(rows).map((r: Row) => r.id)).toEqual(["only"]);
  });

  it("keeps order when no row carries a timestamp", async () => {
    process.env.HINDSIGHT_RECENCY_RERANK = "1";
    const rows = [
      { id: "a", scores: { final: 0.5 } },
      { id: "b", scores: { final: 0.5 } },
    ] as never[];
    expect(applyRecencyRerank(rows).map((r: Row) => r.id)).toEqual(["a", "b"]);
  });

  it("keeps order when no row carries a score", async () => {
    process.env.HINDSIGHT_RECENCY_RERANK = "1";
    const rows = [
      { id: "a", mentioned_at: OLD },
      { id: "b", mentioned_at: NEW },
    ] as never[];
    // No scores at all ⇒ time alone decides.
    expect(applyRecencyRerank(rows).map((r: Row) => r.id)).toEqual(["b", "a"]);
  });

  it("falls back to occurred_start when mentioned_at is absent", async () => {
    process.env.HINDSIGHT_RECENCY_RERANK = "1";
    const rows = [
      { id: "old", occurred_start: OLD, scores: { final: 0.5 } },
      { id: "new", occurred_start: NEW, scores: { final: 0.5 } },
    ] as never[];
    expect(applyRecencyRerank(rows).map((r: Row) => r.id)).toEqual(["new", "old"]);
  });

  it("falls back to reranker when final is absent", async () => {
    process.env.HINDSIGHT_RECENCY_RERANK = "1";
    const rows = [
      { id: "old", mentioned_at: OLD, scores: { reranker: 0.5 } },
      { id: "new", mentioned_at: NEW, scores: { reranker: 0.5 } },
    ] as never[];
    expect(applyRecencyRerank(rows).map((r: Row) => r.id)).toEqual(["new", "old"]);
  });

  it("tolerates a non-numeric score", async () => {
    process.env.HINDSIGHT_RECENCY_RERANK = "1";
    const rows = [
      { id: "a", mentioned_at: OLD, scores: { final: NaN } },
      { id: "b", mentioned_at: NEW, scores: { final: NaN } },
    ] as never[];
    // No usable score ⇒ time decides; must not throw.
    expect(applyRecencyRerank(rows).map((r: Row) => r.id)).toEqual(["b", "a"]);
  });
});

describe("diagnostic reports movement without claiming improvement", () => {
  it("counts moved rows and max shift", async () => {
    process.env.HINDSIGHT_RECENCY_RERANK = "1";
    const before = [row("a", 0.5, OLD), row("b", 0.5, NEW), row("c", 0.5, MID)] as never[];
    const after = applyRecencyRerank(before);
    const d = recencyRerankDiagnostic(before, after);
    expect(d.rows).toBe(3);
    // All three share one score, so time alone orders them ⇒ the oldest moves.
    expect(d.moved).toBeGreaterThan(0);
    expect(d.maxShift).toBeGreaterThan(0);
    expect(d.similarRel).toBe(0.05);
    // It must NOT expose a "better" verdict.
    expect(Object.keys(d)).not.toContain("improved");
  });

  it("reports zero movement when the order is unchanged", async () => {
    process.env.HINDSIGHT_RECENCY_RERANK = "1";
    const before = [row("a", 0.9, OLD), row("b", 0.1, NEW)] as never[];
    const after = applyRecencyRerank(before);
    expect(recencyRerankDiagnostic(before, after).moved).toBe(0);
  });
});
