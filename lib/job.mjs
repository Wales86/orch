import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { jobsDir } from "./project.mjs";
import { alive, append, now, readTrim, slug, write } from "./util.mjs";

/**
 * A job is a folder of plain files under .orch/jobs/<id>/. The files are the truth;
 * every display and wake is a view of them.
 */
export class Job {
	constructor(root, id) {
		this.root = root;
		this.id = id;
		this.dir = join(jobsDir(root), id);
	}

	get(name, fallback = "") {
		return readTrim(join(this.dir, name), fallback);
	}

	set(name, value) {
		write(join(this.dir, name), String(value));
	}

	has(name) {
		return existsSync(join(this.dir, name));
	}

	path(name) {
		return join(this.dir, name);
	}

	log(line) {
		append(this.path("log"), `${now().slice(11, 19)} ${line}`);
	}

	get state() {
		return this.get("state", "starting");
	}

	get label() {
		return this.get("label", this.id);
	}

	/** A running state whose runner is gone is reported as "lost". */
	get liveState() {
		const state = this.state;
		if ((state === "running" || state === "starting") && !alive(Number(this.get("pid")))) {
			return this.has("pid") ? "lost" : state;
		}
		return state;
	}

	get terminal() {
		return ["done", "failed", "stopped", "lost"].includes(this.liveState);
	}
}

export function newJob(root, label) {
	const id = `${slug(label, 28) || "job"}-${randomBytes(2).toString("hex")}`;
	const job = new Job(root, id);
	const tmp = join(jobsDir(root), `.${id}`);
	mkdirSync(join(tmp, "steer", "inbox"), { recursive: true });
	mkdirSync(join(tmp, "steer", "delivered"), { recursive: true });
	renameSync(tmp, job.dir);
	job.set("label", label);
	job.set("created-at", now());
	job.set("state", "starting");
	return job;
}

export function allJobs(root) {
	return readdirSync(jobsDir(root))
		.filter((n) => !n.startsWith("."))
		.map((id) => new Job(root, id))
		.sort((a, b) => a.get("created-at").localeCompare(b.get("created-at")));
}

/** Find a job by full id, unique id prefix or suffix, or unique label. */
export function findJob(root, key) {
	if (!key) throw new Error("name a job: an id, a unique id prefix or suffix, or a label");
	const jobs = allJobs(root);
	const exact = jobs.find((j) => j.id === key || j.label === key);
	if (exact) return exact;
	const matches = jobs.filter((j) => j.id.endsWith(key) || j.id.startsWith(key));
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) throw new Error(`"${key}" matches ${matches.length} jobs: ${matches.map((j) => j.id).join(", ")}`);
	throw new Error(`no job matches "${key}"`);
}
