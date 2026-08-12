import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const arguments_ = process.argv.slice(2);
if (arguments_[0] === "--") arguments_.shift();
const [base, ...unexpectedArguments] = arguments_;
if (!base || unexpectedArguments.length > 0 || !/^[0-9a-f]{40}$/i.test(base)) {
  throw new Error("Pass the trusted 40-character base commit SHA as the first argument");
}

const output = execFileSync(
  "git",
  [
    "diff",
    "--name-status",
    "--find-renames",
    base,
    "HEAD",
    "--",
    "drops",
    "reconciliations",
    "notices",
    "rules",
    "schemas",
  ],
  { encoding: "utf8" },
).trim();

function validAddition(path) {
  if (/^(drops|reconciliations)\/.+\.json$/.test(path)) return true;
  if (/^notices\/.+\.(md|json)$/.test(path)) return true;
  if (/^rules\/.+\.md$/.test(path)) return true;
  if (/^schemas\/.+\.json$/.test(path)) return true;
  return /(^|\/)README\.md$/.test(path);
}

const violations = output
  ? output.split(/\r?\n/).filter((line) => {
      if (line.startsWith("A\t")) return !validAddition(line.slice(2));
      const affectedPaths = line.split("\t").slice(1);
      return !affectedPaths.every(
        (path) => /(^|\/)README\.md$/.test(path) || path === "rules/HASHES.md",
      );
    })
  : [];

function hashRows(markdown) {
  return new Map(
    [...markdown.matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)].map(
      (match) => [match[1], match[2]],
    ),
  );
}

try {
  const previous = hashRows(
    execFileSync("git", ["show", `${base}:rules/HASHES.md`], { encoding: "utf8" }),
  );
  const current = hashRows(readFileSync("rules/HASHES.md", "utf8"));
  for (const [name, digest] of previous) {
    if (current.get(name) !== digest) {
      violations.push(`M\trules/HASHES.md (${name} was removed or changed)`);
    }
  }
} catch (error) {
  violations.push(`M\trules/HASHES.md (${error instanceof Error ? error.message : "unreadable"})`);
}

if (violations.length > 0) {
  console.error("Published evidence, rules, and schemas may be added but not rewritten:");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exitCode = 1;
} else {
  console.log("Append-only evidence check passed.");
}
