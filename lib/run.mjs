import { spawn } from "node:child_process";
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { claudeSettings, engine } from "./engines.mjs";
import { closeTab, promptPane } from "./herdr.mjs";
import { Job } from "./job.mjs";
import { noteCheckText, openChecks } from "./note.mjs";
import { loadConfig, roleText } from "./project.mjs";
import { append, duration, git, now, sh } from "./util.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The detached runner: one process per job, started by spawn/continue as `orch _run <id>`. */
export async function runJob(root, id) {
	const job = new Job(root, id);
	const config = loadConfig(root);
	job.set("pid", process.pid);
	job.set("state", "running");
	job.set("started-at", now());
	const cwd = job.get("worktree");
	const role = job.get("role");

	const prepare = job.get("prepare");
	if (prepare) {
		job.log(`prepare: ${prepare}`);
		const r = sh("bash", ["-lc", prepare], { cwd, timeout: 10 * 60_000 });
		job.log(r.ok ? "prepare ok" : `prepare failed (exit ${r.code}): ${r.err.split("\n").slice(-3).join(" | ")}`);
	}

	const eng = engine(job.get("engine"));
	if (job.get("engine") === "claude") {
		writeFileSync(job.path("settings.json"), JSON.stringify(claudeSettings(config), null, 2));
	}
	const deadline = Date.now() + duration(job.get("timeout", config.timeout));
	const base = {
		job,
		config,
		model: job.get("model"),
		effort: job.get("effort"),
		system: roleText(root, role),
		settingsPath: job.path("settings.json"),
	};

	let turn = await runTurn(job, eng, { ...base, prompt: job.get("task.md"), resume: job.get("resume") }, deadline);

	// Engines without a Stop hook get the note check as one more turn in the same session.
	if (role === "worker" && !eng.noteHook && turn.ok && job.get("session-id") && !job.has("stop-requested")) {
		job.set("note-check-sent", now());
		job.log("note check sent (extra turn)");
		const check = await runTurn(job, eng, { ...base, prompt: noteCheckText(root, job.dir), resume: job.get("session-id") }, deadline);
		if (check.result?.text || check.lastText) turn = { ...check, tools: turn.tools + check.tools };
	}

	await finish(job, config, turn);
}

function runTurn(job, eng, opts, deadline) {
	const timeoutMs = Math.max(deadline - Date.now(), 1000);
	const { cmd, args, stdin } = eng.command({ ...opts, timeoutMs });
	job.log(`engine: ${job.get("engine")} ${job.get("model")}${opts.resume ? ` (resume ${opts.resume})` : ""}`);
	return new Promise((resolve) => {
		const child = spawn(cmd, args, {
			cwd: job.get("worktree"),
			detached: true,
			stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
			env: {
				...process.env,
				ORCH_JOB_DIR: job.dir,
				ORCH_JOB_ID: job.id,
				ORCH_ROLE: job.get("role"),
				ORCH_PROJECT_ROOT: job.root,
			},
		});
		job.set("engine-pid", child.pid);
		if (stdin) child.stdin.end(stdin);
		const out = { tools: 0, lastText: "", result: undefined, timedOut: false };
		createInterface({ input: child.stdout }).on("line", (line) => {
			append(job.path("session.jsonl"), line);
			let events = [];
			try {
				events = eng.parse(line);
			} catch {
				return;
			}
			for (const e of events) {
				if (e.kind === "session") job.set("session-id", e.id);
				if (e.kind === "tool") {
					out.tools++;
					job.log(`tool ${e.text}`);
				}
				if (e.kind === "text") {
					out.lastText = e.text;
					job.log(`says ${e.text.split("\n")[0].slice(0, 200)}`);
				}
				if (e.kind === "result") out.result = e;
			}
		});
		child.stderr.on("data", (d) => append(job.path("stderr"), d.toString()));
		const timer = setTimeout(() => {
			out.timedOut = true;
			job.log("timeout: stopping the engine");
			kill(child.pid, "SIGTERM");
			setTimeout(() => kill(child.pid, "SIGKILL"), 10_000).unref();
		}, timeoutMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			out.code = code;
			out.ok = code === 0 && out.result && !out.result.error && !out.timedOut;
			resolve(out);
		});
	});
}

export function kill(pid, signal) {
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {}
	}
}

async function finish(job, config, turn) {
	const role = job.get("role");
	const result = turn.result?.text || turn.lastText || "";
	job.set("result", result || "(no final message)");
	if (turn.result?.usage) job.set("usage.json", JSON.stringify(turn.result.usage));
	if (turn.result?.denied?.length) job.log(`denied by engine permissions: ${turn.result.denied.join(", ")}`);

	let state = "done";
	let reason = turn.result?.reason ?? "";
	if (job.has("stop-requested")) [state, reason] = ["stopped", job.get("stop-requested")];
	else if (turn.timedOut) [state, reason] = ["failed", "timeout"];
	else if (!turn.result) [state, reason] = ["failed", `engine exited ${turn.code} without a result`];
	else if (turn.result.error || turn.code !== 0) [state, reason] = ["failed", `${turn.result.reason} (exit ${turn.code})`];

	const branch = job.get("branch");
	if (branch && job.get("base")) {
		const log = git(job.get("worktree"), "log", "--oneline", `${job.get("base")}..HEAD`);
		job.set("commits", log.out);
	}
	if (role === "worker" && state === "done") {
		const open = openChecks(result);
		if (open.length) job.set("open-checks", open.join("\n"));
		else if (job.has("open-checks")) job.set("open-checks", "");
	}
	if (existsSync(job.path("note.md")) && !existsSync(job.path("note.first.md"))) copyFileSync(job.path("note.md"), job.path("note.first.md"));
	job.set("tools", turn.tools);
	job.set("stop-reason", reason);
	job.set("finished-at", now());
	job.set("state", state);
	job.log(`${state}${reason ? `: ${reason}` : ""}`);

	if (job.get("herdr-tab") && config.herdr.closeTabOnFinish) {
		await sleep(3000);
		job.log(`herdr tab close: ${closeTab(job.get("herdr-tab"))}`);
	}
	await wake(job);
}

export function wakeText(job) {
	const commits = job.get("commits").split("\n").filter(Boolean);
	const open = job.get("open-checks").split("\n").filter(Boolean);
	const mins = Math.round((Date.parse(job.get("finished-at")) - Date.parse(job.get("started-at"))) / 60000);
	const result = job.get("result");
	const head = [
		`[orch] ${job.get("state").toUpperCase()} · ${job.label} (${job.id})`,
		`role ${job.get("role")} · ${job.get("engine")}/${job.get("model")} · ${mins} min · ${job.get("tools")} tools${job.get("branch") ? ` · branch ${job.get("branch")} · ${commits.length} commits` : ""}`,
	];
	if (job.get("stop-reason") && job.get("state") !== "done") head.push(`reason: ${job.get("stop-reason")}`);
	if (open.length) head.push(`open checks (${open.length}):\n${open.join("\n")}`);
	const max = 6000;
	head.push(`final message (${job.path("result")}):\n${result.length > max ? `${result.slice(0, max)}\n… cut; read the file for the rest` : result}`);
	head.push(`next: orch jobs ${job.id}${job.get("branch") ? ` · git diff HEAD...${job.get("branch")} · orch review ${job.id} · orch land ${job.id} (after the owner says yes)` : ""}`);
	return head.join("\n");
}

/** One wake per job. Retry only a refusal that happened before Herdr sent input. */
async function wake(job) {
	const text = wakeText(job);
	job.set("wake.txt", text);
	const pane = job.get("origin-pane");
	if (!pane) {
		job.set("wake", "no origin pane; the coordinator reads it with orch wait or orch jobs");
		return;
	}
	for (let attempt = 1; attempt <= 10; attempt++) {
		const r = promptPane(pane, text);
		if (r.sent) return job.set("wake", `delivered to ${pane} at ${now()}`);
		if (!r.refused) return job.set("wake", `may have reached ${pane}; not resent: ${r.error}`);
		job.log(`wake refused (attempt ${attempt}): ${r.error}`);
		await sleep(30_000);
	}
	job.set("wake", `not sent to ${pane} after 10 attempts`);
}
