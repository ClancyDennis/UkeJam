// Checks the StrumCam CALLS-list trim (views/strumcamView.ts): adding calls past
// the cap must remove the oldest and TERMINATE.
//
// This exists because of a bug that froze the whole app. The trim was:
//
//   while (scCallsEl.querySelectorAll(".sc-call").length > 40)
//     scCallsEl.querySelector(".sc-call:last-of-type")?.remove();
//
// `:last-of-type` means "last <div> among its siblings", not "last element
// matching .sc-call". The container's last child is the #sc-calls-empty
// placeholder — also a <div>, but without .sc-call — so the selector matched
// nothing, remove() no-opped, the count never fell below 41, and the loop spun
// forever inside querySelector on the main thread. The UI froze on the 41st
// strum with the process alive and pinned at 100% CPU.
//
// The lesson pinned here: never drive a removal loop off a re-query whose
// selector might not match. Walk the matched set instead — querySelectorAll
// returns a static list, so it cannot loop.
//
// The view module can't be imported (it reaches for a real DOM and Tauri at
// module scope), so this drives the same trim logic against a minimal DOM stub,
// and separately scans the shipped source to assert it still uses the safe shape.
// Run with `pnpm verify:calltrim`. Plain node, no dependencies.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`ok   ${name}`);
    return;
  }
  failures++;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

// --- a DOM stub just big enough for the trim ---------------------------------
//
// Deliberately models the ONE detail that caused the bug: `:last-of-type`
// resolves against tag position among siblings, independently of the class
// filter, so it can select nothing even while `.sc-call` elements exist.

class El {
  constructor(tag, cls = "") {
    this.tag = tag;
    this.className = cls;
    this.children = [];
    this.parent = null;
  }
  get classes() {
    return this.className.split(/\s+/).filter(Boolean);
  }
  insertBefore(node, ref) {
    node.parent = this;
    const i = ref ? this.children.indexOf(ref) : this.children.length;
    this.children.splice(i < 0 ? this.children.length : i, 0, node);
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  remove() {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
  }
  querySelectorAll(sel) {
    const cls = sel.replace(/^\./, "");
    return this.children.filter((c) => c.classes.includes(cls));
  }
  querySelector(sel) {
    // Supports ".cls" and ".cls:last-of-type" — the two shapes at issue.
    const m = sel.match(/^\.([\w-]+)(?::last-of-type)?$/);
    if (!m) throw new Error(`stub can't parse selector: ${sel}`);
    const cls = m[1];
    if (!sel.includes(":last-of-type")) {
      return this.children.find((c) => c.classes.includes(cls)) ?? null;
    }
    // The real rule: find the LAST sibling of each tag, then keep it only if it
    // also matches the class. A different-tag-but-same-class element earlier in
    // the list does NOT qualify.
    const lastOfEachTag = new Map();
    for (const c of this.children) lastOfEachTag.set(c.tag, c);
    for (const el of lastOfEachTag.values()) {
      if (el.classes.includes(cls)) return el;
    }
    return null;
  }
}

function makeList() {
  const list = new El("div", "sc-calls");
  // The placeholder that broke the old selector: same tag, different class,
  // always last because rows are inserted at the front.
  list.insertBefore(new El("div", "sc-calls-empty"), null);
  return list;
}

const KEPT = 40;

// --- the shipped (fixed) trim ------------------------------------------------
function addCallFixed(list, label) {
  const row = new El("div", "sc-call");
  row.label = label;
  list.insertBefore(row, list.firstChild);
  const rows = list.querySelectorAll(".sc-call");
  for (let i = KEPT; i < rows.length; i++) rows[i].remove();
}

// --- the old trim, kept so the test proves it was really broken --------------
function addCallOld(list, label, budget = 100000) {
  const row = new El("div", "sc-call");
  row.label = label;
  list.insertBefore(row, list.firstChild);
  let spins = 0;
  while (list.querySelectorAll(".sc-call").length > KEPT) {
    list.querySelector(".sc-call:last-of-type")?.remove();
    if (++spins > budget) return { hung: true, spins };
  }
  return { hung: false, spins };
}

// --- the stub must reproduce the bug, or it proves nothing -------------------
{
  const list = makeList();
  let result = { hung: false };
  for (let i = 1; i <= KEPT + 1 && !result.hung; i++) {
    result = addCallOld(list, `call-${i}`, 5000);
  }
  check(
    "the stub reproduces the original hang (so this test has teeth)",
    result.hung,
    "the old selector terminated in the stub — the stub is wrong, not the code"
  );
}
{
  // And it hangs at exactly the 41st call, which is why a short session looked fine.
  const list = makeList();
  let hungAt = 0;
  for (let i = 1; i <= KEPT + 5 && !hungAt; i++) {
    if (addCallOld(list, `call-${i}`, 5000).hung) hungAt = i;
  }
  check(`the hang starts on call ${KEPT + 1}, not earlier`, hungAt === KEPT + 1, `hung at ${hungAt}`);
}

// --- the fix ----------------------------------------------------------------
{
  const list = makeList();
  for (let i = 1; i <= 200; i++) addCallFixed(list, `call-${i}`);
  const rows = list.querySelectorAll(".sc-call");
  check("200 calls terminate and the list caps at the limit", rows.length === KEPT, `kept ${rows.length}`);
  check(
    "the NEWEST calls are the ones kept",
    rows[0].label === "call-200" && rows[KEPT - 1].label === `call-${200 - KEPT + 1}`,
    `${rows[0].label} … ${rows[KEPT - 1].label}`
  );
  check(
    "the placeholder is never removed by the trim",
    list.children.some((c) => c.classes.includes("sc-calls-empty")),
    "trim ate a non-.sc-call sibling"
  );
}
{
  // Below the cap nothing is dropped.
  const list = makeList();
  for (let i = 1; i <= 10; i++) addCallFixed(list, `call-${i}`);
  check("under the cap, nothing is trimmed", list.querySelectorAll(".sc-call").length === 10);
}

// --- guard the shipped source ------------------------------------------------
//
// Scans EVERY source file rather than one named path. The first version of this
// guard hardcoded main.ts; the refactor then moved the trim into
// views/strumcamView.ts, and the check kept passing while pointing at a file that
// no longer contained the code — verified vacuous by reinstating the bug and
// watching the suite stay green. A guard that silently stops guarding is worse
// than no guard, so it now cannot be outrun by moving the code.
{
  const here = dirname(fileURLToPath(import.meta.url));

  function sources(dir) {
    const out = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...sources(p));
      else if (/\.(ts|mjs|js)$/.test(e.name) && !e.name.startsWith("verify-")) out.push(p);
    }
    return out;
  }

  const files = sources(here);
  check("the guard actually found source files to scan", files.length > 5, `found ${files.length}`);

  const offenders = { selector: [], loop: [] };
  for (const f of files) {
    // Strip comments first: the fix is documented in a comment that necessarily
    // quotes the bad selector, and a naive substring search would flag that prose.
    const src = readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    const rel = f.slice(here.length + 1);
    if (src.includes(".sc-call:last-of-type")) offenders.selector.push(rel);
    if (/while\s*\(\s*scCallsEl\.querySelectorAll/.test(src)) offenders.loop.push(rel);
  }

  check(
    "no source uses :last-of-type for the calls trim",
    offenders.selector.length === 0,
    `the selector that caused the freeze is back in: ${offenders.selector.join(", ")}`
  );
  check(
    "no source drives the trim from a while-loop re-query",
    offenders.loop.length === 0,
    `a re-query loop can hang whenever its selector fails to match: ${offenders.loop.join(", ")}`
  );

  // The trim has to exist SOMEWHERE, or both checks above pass by vacuity again.
  const trimmed = files.some((f) =>
    /for\s*\(\s*let i = SC_CALLS_KEPT;/.test(readFileSync(f, "utf8"))
  );
  check("the bounded trim is present in the shipped source", trimmed, "no SC_CALLS_KEPT loop found");
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall call-trim checks passed");
