// Stand-in engine for tests: speaks Claude's stream-json, makes one commit, writes a task note.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const task = readFileSync(0, "utf8");
const say = (e) => console.log(JSON.stringify(e));
const session = `fake-${process.pid}`;
say({ type: "system", subtype: "init", session_id: session });

if (task.includes("Before you finish: the note check.")) {
	const result = "Report: fake work committed.\n\n## Note check\n- fake.txt exists: proven. `test -f fake.txt`\n- second check: not proven. no test ran\n- easy-to-miss rule: followed. `git log -1`";
	say({ type: "result", subtype: "success", is_error: false, result, session_id: session, num_turns: 1 });
	process.exit(0);
}

const dir = process.env.ORCH_JOB_DIR;
if (process.env.ORCH_ROLE === "worker") {
	writeFileSync(join(dir, "note.md"), "Done means:\n- fake.txt exists. Shown by: test -f fake.txt\nEasy to miss: \"one commit\". Shown by: git log\nNot proven yet: all\n");
	say({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "echo fake > fake.txt && git commit" } }] } });
	writeFileSync("fake.txt", `${process.env.ORCH_JOB_ID}\n`);
	execSync('git add fake.txt && git -c user.name=fake -c user.email=fake@local commit -qm "fake: add fake.txt"');
	say({ type: "result", subtype: "success", is_error: false, result: "Report: fake work committed.", session_id: session, num_turns: 2 });
} else {
	const head = execSync("git rev-parse HEAD").toString().trim();
	say({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git rev-parse HEAD" } }] } });
	say({ type: "result", subtype: "success", is_error: false, result: `PASS ${head}\nfake review: no findings`, session_id: session, num_turns: 1 });
}
