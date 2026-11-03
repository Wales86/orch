import { spawn } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { engine } from "./engines.mjs";
import { inHerdr, openJobTab } from "./herdr.mjs";
import { allJobs, findJob, newJob } from "./job.mjs";
import { NOTE_FORMAT, reminders } from "./note.mjs";
import { kill, wakeText } from "./run.mjs";
import { loadConfig, projectRoot, rolePath, tickets, worktreesDir } from "./project.mjs";
import { ORCH_BIN, PKG, alive, fail, git, mustGit, now, read, slug, today, write } from "./util.mjs";

const WRITE_ROLES = new Set(["worker"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- setup ----------

export function init() {
	const root = projectRoot();
	const made = [];
	const ensure = (rel, from) => {
		const path = join(root, rel);
		if (existsSync(path)) return;
		mkdirSync(dirname(path), { recursive: true });
		write(path, from ? read(join(PKG, "templates", from)) : "");
		made.push(rel);
	};
	for (const lane of ["planned", "active", "done", "dropped"]) ensure(`spec/features/${lane}/.gitkeep`);
	ensure("spec/features/_template/ticket.md", "ticket.md");
	ensure("spec/features/_template/outcome.md", "outcome.md");
	ensure("spec/vision.md", "vision.md");
	ensure("spec/build.md", "build.md");
	ensure(".orch/config.json", "config.json");
	ensure(".orch/reminders.md", "reminders.md");
	ensure(".orch/.gitignore", "orch.gitignore");

	// One pointer in the agent instructions file; the manual itself stays in the package.
	let agentsFile = ["AGENTS.md", "CLAUDE.md"].map((f) => join(root, f)).find((f) => existsSync(f)) ?? join(root, "AGENTS.md");
	if (lstatSync(agentsFile, { throwIfNoEntry: false })?.isSymbolicLink()) agentsFile = resolve(dirname(agentsFile), readlinkSync(agentsFile));
	const text = read(agentsFile);
	if (!text.includes("<!-- orch -->")) {
		write(agentsFile, `${text.trimEnd()}${text ? "\n\n" : ""}${read(join(PKG, "templates", "agents-section.md")).trim()}\n`);
		made.push(`${relative(root, agentsFile)} (orch section)`);
	}
	console.log(made.length ? `created:\n  ${made.join("\n  ")}` : "already initialized");
	console.log("next: fill spec/vision.md and .orch/config.json (prepare, permissions), commit them, then start a coordinator.");
}

export function manual() {
	const root = projectRoot();
	process.stdout.write(read(rolePath(root, "coordinator")));
}

// ---------- tickets and board ----------

export function ticketNew(title, flags) {
	if (!title) fail('usage: orch ticket new "what becomes true" [--active]');
	const root = projectRoot();
	const max = Math.max(0, ...tickets(root).map((t) => Number(t.number.slice(1))));
	const number = `F${String(max + 1).padStart(3, "0")}`;
	const lane = flags.active ? "active" : "planned";
	const dir = join(root, "spec", "features", lane, `${number}-${slug(title, 40)}`);
	mkdirSync(dir, { recursive: true });
	const tpl = read(join(root, "spec", "features", "_template", "ticket.md")) || read(join(PKG, "templates", "ticket.md"));
	write(join(dir, "ticket.md"), tpl.replace("YYYY-MM-DD", today()).replace("FNNN · What becomes true", `${number} · ${title}`));
	console.log(relative(root, join(dir, "ticket.md")));
}

export function board() {
	const root = projectRoot();
	const jobs = allJobs(root);
	const title = (t) => (read(join(t.path, "ticket.md")).match(/^#\s+(.+)$/m)?.[1] ?? t.name).trim();
	const lastJob = (number) => jobs.filter((j) => new RegExp(`\\b${number}\\b`).test(j.label)).at(-1);
	const all = tickets(root);
	const section = (name, list, withJob) => {
		console.log(`${name}`);
		if (!list.length) console.log("  (none)");
		for (const t of list) {
			const j = withJob && lastJob(t.number);
			console.log(`  ${title(t)}${j ? `  [${j.liveState}: ${j.id}]` : ""}`);
		}
	};
	section("NOW (active)", all.filter((t) => t.lane === "active"), true);
	section("NEXT (planned)", all.filter((t) => t.lane === "planned"), false);
	section("DONE (last 5)", all.filter((t) => t.lane === "done").sort((a, b) => a.path.localeCompare(b.path)).slice(-5), false);
}

// ---------- spawn, continue, review ----------

export async function spawnJob(task, flags, extra = {}) {
	const root = projectRoot();
	const config = loadConfig(root);
	if (flags["task-file"]) task = flags["task-file"] === "-" ? readFileSync(0, "utf8") : read(resolve(flags["task-file"]));
	if (!task?.trim()) fail('usage: orch spawn [--role R] --label "what changes · FNNN" "instruction"');
	const role = flags.role ?? "worker";
	rolePath(root, role);
	const route = config.roles[role] ?? config.roles.worker;
	const engineId = flags.engine ?? route.engine;
	engine(engineId);

	const running = allJobs(root).filter((j) => ["running", "starting"].includes(j.liveState));
	if (running.length >= config.maxRunning && !flags.force) {
		fail(`${running.length} jobs already run (maxRunning ${config.maxRunning}): ${running.map((j) => j.id).join(", ")}. Wait for one, or pass --force.`);
	}
	const newBranch = WRITE_ROLES.has(role) && !flags.branch && !extra.worktree;
	if (newBranch && config.upstream && !flags["stale-ok"]) checkUpstream(root, config.upstream, flags.base ?? "HEAD");
	checkTicketPointer(root, task);
	if (!git(root, "rev-parse", "--verify", "HEAD").ok) fail("the repository needs a first commit before a job can start");

	const label = flags.label ?? task.trim().split("\n")[0].slice(0, 60);
	const job = newJob(root, label);
	job.set("role", role);
	job.set("engine", engineId);
	// A route's model belongs to its engine; another engine starts from its own default.
	const sameEngine = engineId === route.engine;
	job.set("model", flags.model ?? (sameEngine ? route.model : "") ?? "");
	job.set("effort", flags.effort ?? (sameEngine ? route.effort : "") ?? "");
	job.set("timeout", flags.timeout ?? config.timeout);
	if (extra.parent) job.set("parent", extra.parent);
	if (extra.resume) job.set("resume", extra.resume);
	if (inHerdr() && process.env.HERDR_PANE_ID) job.set("origin-pane", process.env.HERDR_PANE_ID);

	try {
		const fresh = setupWorktree(root, job, role, flags, extra);
		const prepare = flags.prepare ?? config.prepare;
		if (fresh && prepare && !flags["no-prepare"]) job.set("prepare", prepare);
	} catch (e) {
		job.set("state", "failed");
		job.set("stop-reason", `setup: ${e.message}`);
		fail(`setup failed for ${job.id}: ${e.message}`);
	}

	job.set("task.md", taskWithFooter(root, job, role, task.trim(), extra));
	job.set("origin-task.md", task.trim());

	if (inHerdr() && config.herdr.jobTabs && !flags["no-tab"]) {
		const tab = openJobTab(`${label} · ${role}`, job.get("worktree"), `node ${JSON.stringify(ORCH_BIN)} log ${job.id} --follow`);
		if (tab?.tab) job.set("herdr-tab", tab.tab);
		else if (tab?.error) job.log(`herdr tab not opened: ${tab.error}`);
	}

	const out = openSync(job.path("runner.out"), "a");
	spawn(process.execPath, [ORCH_BIN, "_run", job.id], { cwd: root, detached: true, stdio: ["ignore", out, out] }).unref();
	for (let i = 0; i < 50 && !job.has("pid"); i++) await sleep(100);

	console.log(`started ${role} on ${engineId}/${job.get("model")}: ${label}`);
	console.log(`worktree ${job.get("worktree")}${job.get("branch") ? ` · branch ${job.get("branch")}` : " · detached"}`);
	console.log(job.get("origin-pane") ? `wake: herdr pane ${job.get("origin-pane")}` : `wake: none outside herdr; run \`orch wait ${job.id}\` in the background`);
	console.log(job.id);
	return job;
}

function checkTicketPointer(root, task) {
	for (const m of task.matchAll(/Ticket:\s*(\S+?)[.,;)]*(?:\s|$)/g)) {
		const path = m[1];
		if (!existsSync(join(root, path))) fail(`Ticket: ${path} does not exist`);
		const tracked = git(root, "ls-files", "--error-unmatch", path).ok;
		const dirty = git(root, "status", "--porcelain", "--", path).out;
		if (!tracked || dirty) fail(`commit ${path} first, so the job's worktree sees it`);
	}
}

/** A new branch must contain all of `upstream` (e.g. "origin/master"), or the job starts on stale code. */
function checkUpstream(root, upstream, ref) {
	const [remote, ...rest] = upstream.split("/");
	if (rest.length && git(root, "remote").out.split("\n").includes(remote)) {
		const f = git(root, "fetch", "-q", remote, rest.join("/"));
		if (!f.ok) fail(`git fetch ${remote} ${rest.join("/")}: ${f.err}. Fix the remote, or pass --stale-ok.`);
	}
	const behind = git(root, "rev-list", "--count", `${ref}..${upstream}`);
	if (!behind.ok) fail(`cannot compare ${ref} with upstream ${upstream}: ${behind.err}`);
	if (behind.out !== "0") fail(`${ref} is ${behind.out} commit(s) behind ${upstream}. Merge it first (git merge ${upstream}), or pass --stale-ok.`);
}

/** Returns true when it created a new worktree (so prepare should run). */
function setupWorktree(root, job, role, flags, extra) {
	mkdirSync(worktreesDir(root), { recursive: true });
	if (extra.worktree) {
		job.set("worktree", extra.worktree);
		if (extra.branch) {
			job.set("branch", extra.branch);
			job.set("base", mustGit(extra.worktree, "rev-parse", "HEAD"));
		}
		return false;
	}
	const wt = join(worktreesDir(root), job.id);
	if (!WRITE_ROLES.has(role)) {
		const ref = flags.branch ?? flags.base ?? "HEAD";
		mustGit(root, "worktree", "add", "--detach", wt, ref);
		job.set("worktree", wt);
		job.set("candidate", mustGit(wt, "rev-parse", "HEAD"));
		return true;
	}
	if (flags.branch) {
		const holder = worktreeHolding(root, flags.branch);
		const busy = holder && allJobs(root).find((j) => j.get("worktree") === holder && !j.terminal);
		if (busy) throw new Error(`branch ${flags.branch} is in use by running job ${busy.id}`);
		if (!holder) mustGit(root, "worktree", "add", wt, flags.branch);
		job.set("worktree", holder ?? wt);
		job.set("branch", flags.branch);
		job.set("base", mustGit(holder ?? wt, "rev-parse", "HEAD"));
		return !holder;
	}
	const branch = `orch/${job.id}`;
	mustGit(root, "worktree", "add", "-b", branch, wt, flags.base ?? "HEAD");
	job.set("worktree", wt);
	job.set("branch", branch);
	job.set("base", mustGit(wt, "rev-parse", "HEAD"));
	return true;
}

function worktreeHolding(root, branch) {
	const list = mustGit(root, "worktree", "list", "--porcelain").split("\n\n");
	for (const block of list) {
		const path = block.match(/^worktree (.+)$/m)?.[1];
		if (block.includes(`branch refs/heads/${branch}`) && path !== root) return path;
	}
	return undefined;
}

function taskWithFooter(root, job, role, task, extra) {
	const lines = [task, "", "---", `Job: ${job.id} · role ${role} · worktree ${job.get("worktree")}`];
	if (job.get("branch")) lines.push(`Branch: ${job.get("branch")} (commit here; never switch branches)`);
	if (job.get("candidate")) lines.push(`Candidate commit: ${job.get("candidate")}`);
	if (role === "worker" && !extra.resume) {
		lines.push(`Task note: write it to ${job.path("note.md")} before your first edit, and keep it true.`, "", NOTE_FORMAT);
	}
	if (role === "worker" && extra.resume) {
		lines.push(`Task note: ${job.path("note.md")} (copied from the parent job). Read it against this new task; reuse earlier evidence only after you confirm it still applies.`);
	}
	const rem = reminders(root);
	if (rem && role === "worker") lines.push("", `Project reminders (binding):\n${rem}`);
	return lines.join("\n");
}

export async function continueJob(key, task, flags) {
	const root = projectRoot();
	const parent = findJob(root, key);
	if (!parent.terminal) fail(`${parent.id} is ${parent.liveState}; steer it instead`);
	if (!parent.get("session-id")) fail(`${parent.id} has no session id to continue`);
	if (!existsSync(parent.get("worktree"))) fail(`worktree ${parent.get("worktree")} is gone; start a new job with --branch ${parent.get("branch")}`);
	if (flags.engine && flags.engine !== parent.get("engine")) fail("continue keeps the parent's engine");
	const job = await spawnJob(task, {
		...flags,
		role: parent.get("role"),
		engine: parent.get("engine"),
		model: flags.model ?? parent.get("model"),
		effort: flags.effort ?? parent.get("effort"),
		label: flags.label ?? `${parent.label} cont`,
	}, { parent: parent.id, resume: parent.get("session-id"), worktree: parent.get("worktree"), branch: parent.get("branch") });
	if (parent.has("note.md")) cpSync(parent.path("note.md"), job.path("note.md"));
	if (parent.has("note.first.md")) cpSync(parent.path("note.first.md"), job.path("note.first.md"));
}

export async function review(key, extraText, flags) {
	const root = projectRoot();
	const target = findJob(root, key);
	if (!target.get("branch")) fail(`${target.id} has no branch to review`);
	const ticket = target.get("origin-task.md").match(/Ticket:\s*(\S+?)[.,;)]*(?:\s|$)/)?.[1];
	const n = allJobs(root).filter((j) => j.get("role") === "reviewer" && j.get("review-of") === target.get("branch")).length + 1;
	const task = [
		`Review the candidate on branch ${target.get("branch")}${ticket ? ` against Ticket: ${ticket}` : ""}.`,
		`Diff to review: git diff ${target.get("base")}...HEAD`,
		target.get("open-checks") ? `The worker left these checks open:\n${target.get("open-checks")}` : "",
		extraText ?? "",
	].filter(Boolean).join("\n");
	const job = await spawnJob(task, { ...flags, role: "reviewer", branch: target.get("branch"), label: flags.label ?? `${target.label} review ${n}` });
	job.set("review-of", target.get("branch"));
}

// ---------- inspect ----------

export function jobs(key, flags) {
	const root = projectRoot();
	if (key) return jobDetail(findJob(root, key));
	const head = git(root, "rev-parse", "HEAD").out;
	const rows = allJobs(root).filter((j) => {
		if (flags.all || !j.terminal) return true;
		if (j.get("branch") && j.get("state") !== "stopped") return git(root, "rev-list", "--count", `${head}..${j.get("branch")}`).out > "0";
		return Date.now() - Date.parse(j.get("finished-at") || j.get("created-at")) < 24 * 3600_000;
	});
	if (!rows.length) return console.log("no running jobs, no unlanded candidates, nothing from the last 24h (orch jobs --all)");
	for (const j of rows) {
		const open = j.get("open-checks").split("\n").filter(Boolean).length;
		const commits = j.get("commits").split("\n").filter(Boolean).length;
		const age = Math.round((Date.now() - Date.parse(j.get("created-at"))) / 60000);
		const pulse = j.terminal ? "" : ` · ${lastPulse(j)}`;
		console.log(`${j.liveState.toUpperCase().padEnd(8)} ${String(age).padStart(4)}m  ${`${j.get("role")}/${j.get("engine")}`.padEnd(16)} ${j.label}  ${j.id}${commits ? ` · ${commits} commits` : ""}${open ? ` · ${open} open checks` : ""}${pulse}`);
	}
}

function lastPulse(job) {
	const last = read(job.path("log")).trim().split("\n").at(-1) ?? "";
	return last.slice(0, 100);
}

function jobDetail(job) {
	const fields = ["label", "role", "engine", "model", "effort", "worktree", "branch", "base", "candidate", "parent", "session-id", "origin-pane", "herdr-tab", "created-at", "started-at", "finished-at", "stop-reason", "tools", "wake"];
	console.log(`${job.id}: ${job.liveState}`);
	for (const f of fields) if (job.get(f)) console.log(`  ${f}: ${job.get(f)}`);
	if (job.get("usage.json")) console.log(`  usage: ${job.get("usage.json")}`);
	if (job.get("commits")) console.log(`  commits:\n    ${job.get("commits").split("\n").join("\n    ")}`);
	if (job.get("open-checks")) console.log(`  open checks:\n    ${job.get("open-checks").split("\n").join("\n    ")}`);
	console.log(`  files: ${job.dir}`);
	console.log(`  log (last 15):\n    ${read(job.path("log")).trim().split("\n").slice(-15).join("\n    ")}`);
	if (job.terminal) console.log(`  final message: ${job.path("result")}`);
}

export async function log(key, flags) {
	const root = projectRoot();
	const job = findJob(root, key);
	if (!flags.follow) return process.stdout.write(read(job.path("log")));
	console.log(`orch · ${job.label} · ${job.get("role")} on ${job.get("engine")}/${job.get("model")}\n${job.id}\n`);
	let shown = 0;
	for (;;) {
		const text = read(job.path("log"));
		if (text.length > shown) {
			process.stdout.write(text.slice(shown));
			shown = text.length;
		}
		if (job.terminal) break;
		await sleep(1000);
	}
	console.log(`\n${job.liveState.toUpperCase()} — final message: ${job.path("result")}`);
}

export async function wait(key) {
	const root = projectRoot();
	const job = findJob(root, key);
	while (!job.terminal || (job.liveState !== "lost" && !job.has("wake.txt"))) await sleep(2000);
	console.log(job.has("wake.txt") ? job.get("wake.txt") : `${job.liveState.toUpperCase()} · ${job.label} (${job.id}): the runner is gone; read ${job.dir}`);
	process.exit(job.get("state") === "done" ? 0 : 1);
}

// ---------- control ----------

export function steer(key, text) {
	const root = projectRoot();
	const job = findJob(root, key);
	if (job.terminal) fail(`${job.id} is ${job.liveState}; a steer to a finished job is a continue`);
	if (!engine(job.get("engine")).steer) fail(`engine ${job.get("engine")} has no steer channel; stop the job and continue it with the correction`);
	if (!text?.trim()) fail('usage: orch steer <id> "correction"');
	const inbox = job.path(join("steer", "inbox"));
	const seq = String(Date.now());
	write(join(inbox, `.${seq}`), text.trim());
	renameSync(join(inbox, `.${seq}`), join(inbox, seq));
	job.log(`steer queued: ${text.trim().split("\n")[0].slice(0, 150)}`);
	console.log(`queued for ${job.id}; it arrives after the worker's next tool call`);
}

export async function stop(key, reason) {
	const root = projectRoot();
	const job = findJob(root, key);
	if (job.terminal) return console.log(`${job.id} already ${job.liveState}`);
	job.set("stop-requested", reason || "stopped by coordinator");
	const enginePid = Number(job.get("engine-pid"));
	if (enginePid) kill(enginePid, "SIGTERM");
	for (let i = 0; i < 20 && !job.terminal; i++) await sleep(500);
	if (!job.terminal && enginePid) kill(enginePid, "SIGKILL");
	for (let i = 0; i < 20 && !job.terminal; i++) await sleep(500);
	if (!job.terminal) {
		kill(Number(job.get("pid")), "SIGKILL");
		job.set("state", "stopped");
		job.set("finished-at", now());
	}
	console.log(`${job.id}: ${job.liveState}`);
}

// ---------- land and prune ----------

export function land(key, flags) {
	const root = projectRoot();
	const job = findJob(root, key);
	if (job.get("state") !== "done") fail(`${job.id} is ${job.liveState}; only a done job lands`);
	const branch = job.get("branch");
	if (!branch) fail(`${job.id} has no branch`);
	if (git(root, "status", "--porcelain", "--untracked-files=no").out) fail("the main checkout has uncommitted changes; commit or stash them first");
	const current = mustGit(root, "branch", "--show-current");
	const merge = git(root, "merge", "--no-ff", "--no-edit", "-m", `Land ${job.label} (${job.id})`, branch);
	if (!merge.ok) {
		git(root, "merge", "--abort");
		fail(`merge of ${branch} into ${current} failed and was aborted: ${merge.err || merge.out}`);
	}
	console.log(`merged ${branch} into ${current}`);

	if (!flags["keep-open"]) {
		const numbers = new Set([...`${job.label}\n${job.get("origin-task.md")}`.matchAll(/\bF\d{3,}\b/g)].map((m) => m[0]));
		const month = today().slice(0, 7);
		const moved = [];
		for (const t of tickets(root).filter((x) => x.lane === "active" && numbers.has(x.number))) {
			const target = join(root, "spec", "features", "done", month, basename(t.path));
			mkdirSync(dirname(target), { recursive: true });
			mustGit(root, "mv", t.path, target);
			const file = join(target, "ticket.md");
			write(file, read(file).replace(/^(---\n[\s\S]*?)\n---/, `$1\nlanded: ${today()}\n---`));
			git(root, "add", file);
			moved.push(t.number);
		}
		if (moved.length) {
			mustGit(root, "commit", "-m", `Close ${moved.join(", ")}: landed by ${job.id}`);
			console.log(`closed ${moved.join(", ")} → spec/features/done/${month}/`);
		}
	}
	const users = allJobs(root).filter((j) => j.get("branch") === branch && !j.terminal);
	if (users.length) return console.log(`kept ${branch}: still used by ${users.map((j) => j.id).join(", ")}`);
	removeWorktree(root, job.get("worktree"));
	git(root, "branch", "-d", branch);
	job.set("landed-at", now());
	console.log(`removed worktree and branch ${branch}`);
}

function removeWorktree(root, wt) {
	if (wt && existsSync(wt)) {
		const r = git(root, "worktree", "remove", "--force", wt);
		if (!r.ok) rmSync(wt, { recursive: true, force: true });
	}
	git(root, "worktree", "prune");
}

export function prune(flags) {
	const root = projectRoot();
	const head = git(root, "rev-parse", "HEAD").out;
	const live = new Set(allJobs(root).filter((j) => !j.terminal).map((j) => j.get("worktree")));
	for (const j of allJobs(root)) {
		const wt = j.get("worktree");
		if (!j.terminal || !wt || !existsSync(wt) || live.has(wt)) continue;
		const branch = j.get("branch");
		let why;
		if (!branch) why = `finished ${j.get("role")} (read-only worktree)`;
		else if (git(root, "merge-base", "--is-ancestor", branch, head).ok) why = `${branch} is merged`;
		if (!why) continue;
		console.log(`${flags["dry-run"] ? "would prune" : "pruned"} ${wt} (job ${j.id}): ${why}`);
		if (!flags["dry-run"]) {
			removeWorktree(root, wt);
			if (branch) git(root, "branch", "-d", branch);
		}
	}
}
