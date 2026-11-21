/** One noun for the unit of work: "AI task" (the owner's decision of 17 Nov; not reopened here).
 *
 *  The word "job" is what the code and the API call a task. It must never reach a person's eyes: not in a title, a sentence, a button, a
 *  placeholder, an error, an empty state, a widget description or an export. This reads every user-visible string in the interface
 *  (JSX text and string literals that contain words; single tokens such as the field name "job" or a path such as "/jobs" are code) and fails on
 *  the old word. Ordinary English that happens to contain it ("does the job") and the unrelated "job role" are allowed by name. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const SKIP = [/\.test\.tsx?$/, /[\\/]mocks[\\/]/, /generated\.ts$/, /[\\/]test[\\/]/, /\.d\.ts$/];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(tsx?|mjs)$/.test(name) && !SKIP.some((re) => re.test(full)) ? [full] : [];
  });
}

/** Source with comments removed, so a developer's note about jobs is not mistaken for text on screen. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\"'`])\/\/[^\n]*/g, "$1");
}

function visibleStrings(src: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  for (const m of code.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  for (const m of code.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)) out.push(m[1]);
  return out
    .filter((s) => !/[;]|=>|&&|\|\||===|!==/.test(s)) // code that happens to sit between a "<" and a ">"
    .map((s) => s.replace(/\$\{[^}]*\}/g, "X").replace(/\s+/g, " ").trim()) // a variable inside ${} is code, not text
    .filter((s) => /\s/.test(s));
}

const ALLOWED = [/\bjob roles?\b/i, /\b(?:do|does|did|doing|done) the job\b/i, /\bjob title\b/i, /\bwith a job such as\b/i];
const OLD_WORD = /\bjobs?\b/i;

export function offenders(src: string): string[] {
  return visibleStrings(src).filter((s) => {
    const cleaned = ALLOWED.reduce((acc, re) => acc.replace(re, ""), s);
    return OLD_WORD.test(cleaned) && !/[_/{}=<>]|\bjob_id\b|\bjob\b\s*[:=]/.test(cleaned.split(" ")[0]);
  });
}

describe("the old word for an AI task never reaches a person", () => {
  it("finds the old word in text and ignores code", () => {
    expect(offenders('const a = <p>All jobs</p>;')).toEqual(["All jobs"]);
    expect(offenders('const a = "Every run of this job";')).toEqual(["Every run of this job"]);
    expect(offenders("const a = `Create a job named ${x}`;")).toEqual(["Create a job named X"]);
    expect(offenders("const a = `See ${job} now`;")).toEqual([]); // the variable is code
    expect(offenders('const a = "job";')).toEqual([]); // a field name
    expect(offenders('const a = "/jobs/" + name;')).toEqual([]); // a path
    expect(offenders("// this job is a comment\nconst a = 1;")).toEqual([]);
    expect(offenders('const a = "Your job role (optional)";')).toEqual([]); // a different thing: what kind of work a person does
    expect(offenders('const a = "the cheapest model that still does the job";')).toEqual([]);
  });

  it("does not call a trial a re-test either: one name for the feature, as the menus do", () => {
    const found: Record<string, string[]> = {};
    for (const file of files(ROOT)) {
      const bad = visibleStrings(readFileSync(file, "utf8")).filter((s) => /re-?tests?/i.test(s));
      if (bad.length) found[relative(ROOT, file)] = bad;
    }
    expect(found).toEqual({});
  });

  it("reads every file in the interface and finds none", () => {
    const found: Record<string, string[]> = {};
    for (const file of files(ROOT)) {
      const bad = offenders(readFileSync(file, "utf8"));
      if (bad.length) found[relative(ROOT, file)] = bad;
    }
    expect(found).toEqual({});
  });
});
