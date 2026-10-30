import { join } from "node:path";
import { read } from "./util.mjs";

export const NOTE_FORMAT = `Task note format (about six lines, plain technical English, no colored markers):
Done means:
- <what must be true>. Shown by: <command or observation that proves it>
- (two to four end checks)
Easy to miss: "<the one task rule the quickest way to finish could skip>". Shown by: <proof>
Not proven yet: <short names of the checks and the rule that still lack evidence>
When a check is proven, keep it and add "Seen: <where the evidence is>" (a pointer, not the output).
When a steer changes a check, keep the old line, add "Changed: <new requirement>. Reason: <what changed it>" and put it back under Not proven yet.`;

export function reminders(root) {
	return read(join(root, ".orch", "reminders.md")).trim();
}

/** The check a worker answers once before it may finish. */
export function noteCheckText(root, jobDir) {
	const note = read(join(jobDir, "note.md")).trim();
	const first = read(join(jobDir, "note.first.md")).trim();
	const rem = reminders(root);
	const parts = ["Before you finish: the note check."];
	parts.push(note ? `Your task note now:\n${note}` : "You wrote no task note. Reconstruct the end checks and the easy-to-miss rule from the task.");
	if (first && first !== note) parts.push(`Your note at the start:\n${first}`);
	if (rem) parts.push(`Project reminders (binding):\n${rem}`);
	parts.push(`Commit any finished work first. Then end with your final report, and in it a section headed "Note check" with one line per item:
- <check>: proven | not proven | changed | dropped. <evidence in backticks: a command you ran in this session, or a file> or <the gap>
- <easy-to-miss rule>: followed | broken | not proven. <evidence or gap>${rem ? "\n- each binding reminder: followed | broken | not proven. <evidence or gap>" : ""}
Mark a check proven only when you saw its evidence in this session.`);
	return parts.join("\n\n");
}

/** Lines of the final "Note check" that stay open; a missing section is one open item. */
export function openChecks(result) {
	const at = result.search(/^#{0,4}\s*\**Note check\**\s*:?\s*$/im);
	if (at < 0) return ["no Note check section in the final message"];
	const lines = result.slice(at).split("\n").slice(1);
	const open = [];
	for (const line of lines) {
		if (/^#{1,4}\s/.test(line)) break;
		if (/^\s*[-*]\s/.test(line) && /:\s*\**(not proven|broken|changed|dropped)\b/i.test(line)) open.push(line.trim());
	}
	return open;
}
