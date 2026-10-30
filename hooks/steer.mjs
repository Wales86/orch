// PostToolUse hook for Claude jobs: deliver queued steers between tool calls,
// and keep the first version of the task note.
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.ORCH_JOB_DIR;
if (!dir) process.exit(0);

const note = join(dir, "note.md");
if (existsSync(note) && !existsSync(join(dir, "note.first.md"))) copyFileSync(note, join(dir, "note.first.md"));

const inbox = join(dir, "steer", "inbox");
const names = existsSync(inbox) ? readdirSync(inbox).filter((n) => !n.startsWith(".")).sort() : [];
if (!names.length) process.exit(0);

const steers = [];
for (const name of names) {
	try {
		steers.push(readFileSync(join(inbox, name), "utf8").trim());
		renameSync(join(inbox, name), join(dir, "steer", "delivered", name));
	} catch {
		// Another hook run claimed it.
	}
}
if (!steers.length) process.exit(0);

const text = `Steer from the coordinator (a correction to the current slice, not a new charter):\n${steers.join("\n\n")}\n\nIf this changes an end check or the easy-to-miss rule in your task note, keep the old line, add "Changed: <new requirement>. Reason: steer" under it, and put it back under Not proven yet.`;
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } }));
