import { execFileSync } from "node:child_process";

const base = process.argv[2];
if (!base || !/^[0-9a-f]{40}$/i.test(base)) {
  throw new Error("Pass the trusted 40-character base commit SHA as the first argument");
}

const output = execFileSync(
  "git",
  ["diff", "--name-status", "--find-renames", base, "HEAD", "--", "drops", "reconciliations", "notices"],
  { encoding: "utf8" },
).trim();

const violations = output
  ? output.split(/\r?\n/).filter((line) => {
      if (line.startsWith("A\t")) return false;
      const affectedPaths = line.split("\t").slice(1);
      return !affectedPaths.every((path) => /(^|\/)README\.md$/.test(path));
    })
  : [];

if (violations.length > 0) {
  console.error("Append-only evidence may be added but not modified, deleted, copied, or renamed:");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exitCode = 1;
} else {
  console.log("Append-only evidence check passed.");
}
