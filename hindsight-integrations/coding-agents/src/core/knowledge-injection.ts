export interface PageRef {
  id: string;
  title: string;
}

/** Defensive parse of HindsightClient.listPages() ({items:[{id,name}]}, flattened from the
 *  knowledge-base tree). The ids are knowledge-base node ids — the same id space the agent passes
 *  back to hindsight_read_knowledge_page. */
export function parsePageList(raw: unknown): PageRef[] {
  const items = (raw as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  const out: PageRef[] = [];
  for (const it of items) {
    const id = (it as { id?: unknown })?.id;
    const name = (it as { name?: unknown })?.name;
    if (typeof id === "string" && typeof name === "string") out.push({ id, title: name });
  }
  return out;
}

const EMPTY_STATE =
  "No knowledge pages yet — Hindsight is still learning this repo; they'll appear as it processes.";

/**
 * What the agent is told EXISTS, without listing it.
 *
 * A full roster of titles and ids reads as an index, and an index makes search
 * pointless: measured over 40 real Claude Code turns against a prefilled bank, every single
 * retrieval was `hindsight_read_knowledge_page` called with an id copied from this
 * block — 0 searches at 3 pages, and still 0 at 12. The model was right: searching to
 * locate one of a dozen titles already in its context buys nothing.
 *
 * It is the wrong trade anyway. A title says what a page is ABOUT; the search
 * returns the passage that bears on THIS turn, ranked, across pages whose titles
 * give no hint. Naming the count and the way in, rather than the contents, is what
 * makes the first call a search.
 */
function indexLine(pages: PageRef[]): string {
  const count =
    pages.length === 1 ? "1 knowledge page covers" : `${pages.length} knowledge pages cover`;
  return (
    `${count} this repository — architecture, conventions, past decisions and ` +
    "in-flight initiatives. They are deliberately NOT listed here: call " +
    "hindsight_search_knowledge_pages(query) to find the ones that bear on the current turn, then " +
    "hindsight_read_knowledge_page(<id>) on anything the results show is worth reading in full."
  );
}

/**
 * When-to-call guide for the FULL Hindsight tool suite. Shared by the SessionStart preamble and the
 * periodic refresh so the agent is told — repeatedly — not just that the tools exist but the moment
 * to reach for each one. Registering the tools isn't enough; the trigger for each has to be in
 * context. (Omits hindsight_diagnose — pure troubleshooting, no workflow trigger.)
 */
const TOOL_GUIDE =
  "- hindsight_search_knowledge_pages(query) — FIRST STOP, and the way IN to everything below. " +
  "The code shows what is true today but not what was decided or why; memory shows what was decided " +
  "back then but not whether it still holds — each alone misleads. Search BEFORE you act when:\n" +
  "    • the user reports a bug or a wrong response (the intended behaviour may already be decided);\n" +
  "    • you are about to write or change a test (how it asserts is a convention, not a preference);\n" +
  "    • you are implementing something new, or two parts have to fit together;\n" +
  "    • the user asks why something is the way it is, or what is left to do;\n" +
  "    • you are about to commit, and need to know what the change was supposed to honour.\n" +
  "  It ranks pages by relevance; what it returns is a past record, not a live reading — check a claim " +
  "against the code before relying on it.\n" +
  "  CREDITING IS NOT OPTIONAL AND NOT A JUDGEMENT CALL: if anything it returned reached your reply — " +
  "quoted, paraphrased, or merely confirming what you were about to say — open that part with " +
  '"> 🧠 **From Hindsight memory (<page>)** — <the specific facts you drew on>". Rewriting a snippet ' +
  "in your own words does not make it yours. A search that found nothing useful needs no mention.\n" +
  "- hindsight_list_knowledge_pages / hindsight_read_knowledge_page — BEFORE substantial work, read the " +
  "relevant pages instead of re-deriving this repo's conventions and past decisions from the code; " +
  "follow any [[page:<id>]] links.\n" +
  "- hindsight_reflect(query) — when those pages are too shallow and you need the WHY: deep reasoning " +
  'over the full memory (slower; credit with "> 🧠 **From Hindsight memory** — <summary>").\n' +
  "- hindsight_capture_initiative(title, summary) — right after the user approves a plan or finishes " +
  "brainstorming a new capability, and BEFORE you write any code, record it as a tracked page; call it " +
  "AGAIN with relates_to_page_id set to that page whenever the goal, scope, or rationale materially " +
  "changes mid-work, so the page tracks the current plan. Skip bug fixes, chores and trivial " +
  "course-corrections.\n" +
  "- hindsight_ingest_document(title, content) — save an external document or durable notes worth " +
  "remembering (not the current conversation — it is captured automatically at session end).\n" +
  // ★ FORK PATCH 2026-10-08 (tag discovery, v457): the tag LISTING tool.
  //   Without this line the agent has the tool registered but no reason to reach for it —
  //   every sibling tag tool takes a tag as INPUT (hindsight_read_memory_chain says so
  //   outright), so a family whose name a recall never surfaced is unreachable.
  //   That is exactly the per-session story-tag case, where the name is a uuid.
  "- hindsight_list_tags(prefix) — the tags that EXIST in this bank, with counts. Use it to find " +
  "a family you cannot name (a tag a recall never surfaced is otherwise unreachable), then read " +
  "it with hindsight_read_memory_chain. Pass a prefix (e.g. 'story:') to narrow.\n" +
  // ★ FORK PATCH 2026-10-08 (self-check tools, v458/v459): the two tools an agent needs when
  //   MEMORY ITSELF looks broken. Neither is part of the normal workflow (sync is automatic;
  //   diagnose is for when something looks off). v459 measured the three additions this session
  //   at +792 chars against TOOL_GUIDE's 2259 (the post-plan-B value) — this trim gives some back.
  "- hindsight_sync_status() — still ingesting? (automatic; nothing to run).\n" +
  "- hindsight_diagnose() — safe runtime diagnostics; use when memory, hooks or config appear " +
  "NOT to work, instead of concluding the bank is empty.";

const PAGES_FIRST_ON_GOALS =
  "- The user just set a NEW task or goal → search the knowledge pages FIRST with " +
  "hindsight_search_knowledge_pages. No synthesis is injected automatically in this configuration; " +
  "call hindsight_reflect only when those pages are too shallow and deeper reasoning is needed.\n";
export interface ToolGuideOpts {
  /** Add the new-goal pull trigger (no automatic synthesis: cfg.autoInject !== "reflect"). It used to send
   *  the agent straight to hindsight_reflect; it now goes to the knowledge pages first and keeps
   *  reflect for what they don't cover. The field name is unchanged so call sites stay stable. */
  reflectOnNewGoals?: boolean;
  /** cfg.toolGuideExtra: the team's own guidance, added after ours rather than replacing it. */
  extra?: string;
}

function toolGuide(opts?: ToolGuideOpts): string {
  const extra = opts?.extra?.trim();
  return (
    (opts?.reflectOnNewGoals ? PAGES_FIRST_ON_GOALS : "") + TOOL_GUIDE + (extra ? `\n${extra}` : "")
  );
}

/** SessionStart: teach the whole tool suite + when to use each, and list what pages exist. Empty-state aware. */
export function buildKnowledgePreamble(pages: PageRef[], opts?: ToolGuideOpts): string {
  const body = pages.length ? indexLine(pages) : EMPTY_STATE;
  return (
    "<hindsight_knowledge>\n" +
    "This repository has a Hindsight memory + knowledge base (curated, continuously-updated pages plus the raw " +
    "memory behind them). The tools below are registered, but you must actually CALL them at the right moments:\n" +
    `${toolGuide(opts)}\n` +
    "ALSO your correction tool: when you verify a Hindsight memory is wrong or stale, ingest a " +
    '"Correction: <topic>" doc stating what memory claimed, what is true now, and the evidence — ' +
    "newer facts supersede older ones.\n" +
    `${body}\n` +
    "This tool guide and the page list are re-injected for you periodically as things change.\n" +
    "</hindsight_knowledge>"
  );
}

/**
 * Periodic UserPromptSubmit refresh. ALWAYS emits (never undefined) so the full tool guide keeps
 * re-appearing in context even on a fresh repo with no pages yet — precisely when the agent is
 * building its first features. The page roster is included only when pages exist; the reminder of
 * which tools exist and WHEN to call each is unconditional.
 */
export function buildRosterRefresh(pages: PageRef[], opts?: ToolGuideOpts): string {
  const rosterBlock = pages.length ? `${indexLine(pages)}\n` : "";
  return (
    "<hindsight_knowledge_refresh>\n" +
    rosterBlock +
    "Reminder — this repo's Hindsight tools are available; call them at the right moments:\n" +
    `${toolGuide(opts)}\n` +
    "</hindsight_knowledge_refresh>"
  );
}
