import { join } from "node:path";
import { PKG, git } from "./util.mjs";

/**
 * Each engine turns a job into one headless command and parses its NDJSON stream into
 * events: { kind: "session" | "tool" | "text" | "result", ... }.
 */

function claudeCommand({ job, config, model, effort, system, prompt, resume, settingsPath }) {
	const args = ["-p", "--output-format", "stream-json", "--verbose"];
	args.push("--permission-mode", config.claude.permissionMode);
	args.push("--settings", settingsPath, "--add-dir", job.dir);
	if (model) args.push("--model", model);
	if (effort) args.push("--effort", effort);
	if (system) args.push("--append-system-prompt", system);
	if (resume) args.push("--resume", resume);
	return { cmd: process.env.ORCH_CLAUDE ?? "claude", args, stdin: prompt };
}

/** Hooks give a Claude job the steer inbox and the note check; permissions come from the project config. */
export function claudeSettings(config) {
	const hook = (file) => ({ type: "command", command: `node ${JSON.stringify(join(PKG, "hooks", file))}` });
	return {
		permissions: { allow: config.claude.allow, deny: config.claude.deny },
		hooks: {
			PostToolUse: [{ matcher: "*", hooks: [hook("steer.mjs")] }],
			Stop: [{ hooks: [hook("note-check.mjs")] }],
		},
	};
}

function parseClaude(line) {
	const e = JSON.parse(line);
	if (e.type === "system" && e.subtype === "init") return [{ kind: "session", id: e.session_id }];
	if (e.type === "assistant") {
		return (e.message?.content ?? []).flatMap((c) => {
			if (c.type === "text" && c.text.trim()) return [{ kind: "text", text: c.text }];
			if (c.type === "tool_use") return [{ kind: "tool", text: `${c.name} ${toolArg(c.input)}` }];
			return [];
		});
	}
	if (e.type === "result") {
		return [{
			kind: "result",
			text: e.result ?? "",
			error: Boolean(e.is_error) || e.subtype !== "success",
			reason: e.subtype,
			usage: { cost_usd: e.total_cost_usd, turns: e.num_turns, ...e.usage },
		}];
	}
	return [];
}

function toolArg(input = {}) {
	const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.description ?? "";
	return String(v).replace(/\s+/g, " ").slice(0, 160);
}

/**
 * Headless agy can't ask, so `agy.allow` is the whole permission story: program names, or "*"
 * for every command. `agy.sandbox` confines the terminal to the worktree, the job folder and the repository's .git,
 * and `agy.mode` (for example "accept-edits") is passed through when set.
 */
function agyCommand({ job, config, model, system, prompt, resume, timeoutMs }) {
	// Extra workspace dirs make agy unsure where to run commands, so the prompt names the worktree.
	const cwd = job.get("worktree");
	const where = `Your working directory is ${cwd}. Run every command there.`;
	const args = ["-p", `${system}\n\n${where}\n\n---\n\n${prompt}`, "--output-format", "stream-json"];
	args.push("--print-timeout", `${Math.floor(timeoutMs / 1000)}s`);
	if (config.agy.mode) args.push("--mode", config.agy.mode);
	args.push("--add-dir", job.dir);
	if (config.agy.sandbox) {
		args.push("--sandbox");
		// A worktree commits into the main checkout's .git, which the sandbox mounts read-only unless added.
		const common = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
		if (common.ok) args.push("--add-dir", common.out);
	}
	args.push("--settings", JSON.stringify({ permissions: { allow: config.agy.allow.map((p) => `command(${p})`) } }));
	if (model) args.push("--model", model);
	if (resume) args.push("--conversation", resume);
	return { cmd: process.env.ORCH_AGY ?? "agy", args };
}

function parseAgy(line) {
	const e = JSON.parse(line);
	if (e.event === "init") return [{ kind: "session", id: e.conversation_id }];
	const s = e.step_update;
	if (s?.step_type === "tool" && s.state === "ACTIVE") {
		const p = s.tool_info?.parameters ?? {};
		const arg = p.CommandLine ?? p.Path ?? p.AbsolutePath ?? p.TargetFile ?? p.Query ?? p.SearchPath ?? "";
		return [{ kind: "tool", text: `${s.tool_name} ${String(arg).replace(/\s+/g, " ").slice(0, 160)}` }];
	}
	if (e.event === "result") {
		const r = e.result;
		const denied = (r.denied_actions ?? []).map((d) => d.display_name ?? d.action);
		return [{
			kind: "result",
			text: r.response ?? "",
			error: r.status !== "SUCCESS",
			reason: r.status,
			denied,
			usage: { turns: r.num_turns, ...r.usage },
		}];
	}
	return [];
}

/** Test engine: a local script that speaks Claude's stream format. */
function fakeCommand({ prompt }) {
	return { cmd: process.execPath, args: [join(PKG, "test", "fake-engine.mjs")], stdin: prompt };
}

export const ENGINES = {
	claude: { command: claudeCommand, parse: parseClaude, steer: true, noteHook: true },
	agy: { command: agyCommand, parse: parseAgy, steer: false, noteHook: false },
	fake: { command: fakeCommand, parse: parseClaude, steer: false, noteHook: false },
};

export function engine(id) {
	const e = ENGINES[id];
	if (!e) throw new Error(`unknown engine "${id}" (claude, agy)`);
	return e;
}
