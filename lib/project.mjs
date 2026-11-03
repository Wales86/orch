import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PKG, git, read } from "./util.mjs";

export const DEFAULT_CONFIG = {
	roles: {
		worker: { engine: "claude", model: "sonnet", effort: "high" },
		reviewer: { engine: "agy", model: "gemini-4-argon-high" },
		scout: { engine: "agy", model: "gemini-3.8-flash-medium" },
		researcher: { engine: "claude", model: "opus", effort: "high" },
		judge: { engine: "claude", model: "opus", effort: "high" },
	},
	timeout: "60m",
	maxRunning: 3,
	upstream: "",
	prepare: "",
	claude: {
		permissionMode: "auto",
		allow: [],
		deny: ["Read(**/.env)", "Read(**/.env.*)"],
	},
	agy: {
		allow: ["git", "ls", "cat", "head", "tail", "wc", "rg", "grep", "find", "diff"],
	},
	herdr: { jobTabs: true, closeTabOnFinish: true },
};

/** The main checkout of the repository that holds cwd, even when cwd is a job worktree. */
export function projectRoot(cwd = process.cwd()) {
	const common = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
	if (!common.ok) throw new Error(`not inside a Git repository: ${cwd}`);
	const root = common.out.replace(/\/\.git$/, "");
	if (!existsSync(join(root, ".git"))) throw new Error(`cannot find the main checkout for ${cwd}`);
	return root;
}

export function orchDir(root) {
	return join(root, ".orch");
}

export function jobsDir(root) {
	const dir = join(root, ".orch", "jobs");
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function worktreesDir(root) {
	return join(root, ".orch", "worktrees");
}

export function loadConfig(root) {
	const raw = read(join(root, ".orch", "config.json"));
	const user = raw ? JSON.parse(raw) : {};
	return {
		...DEFAULT_CONFIG,
		...user,
		roles: { ...DEFAULT_CONFIG.roles, ...user.roles },
		claude: { ...DEFAULT_CONFIG.claude, ...user.claude },
		agy: { ...DEFAULT_CONFIG.agy, ...user.agy },
		herdr: { ...DEFAULT_CONFIG.herdr, ...user.herdr },
	};
}

/** A project file at .orch/roles/<role>.md replaces the package default. */
export function rolePath(root, role) {
	const own = join(root, ".orch", "roles", `${role}.md`);
	if (existsSync(own)) return own;
	const pkg = join(PKG, "roles", `${role}.md`);
	if (existsSync(pkg)) return pkg;
	throw new Error(`unknown role "${role}" (no ${own} and no package role)`);
}

export function roleText(root, role) {
	return read(rolePath(root, role));
}

export const LANES = ["planned", "active", "done", "dropped"];

/** Every ticket folder: { number, lane, path }. done/ and dropped/ hold month folders. */
export function tickets(root) {
	const found = [];
	const base = join(root, "spec", "features");
	const scan = (dir, lane) => {
		if (!existsSync(dir)) return;
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (!statSync(path).isDirectory()) continue;
			const m = /^F(\d{3,})-/.exec(name);
			if (m) found.push({ number: `F${m[1]}`, lane, name, path });
			else if (/^\d{4}-\d{2}$/.test(name)) scan(path, lane);
		}
	};
	for (const lane of LANES) scan(join(base, lane), lane);
	return found;
}

export function ticketFile(root, number) {
	const t = tickets(root).find((x) => x.number === number);
	return t ? join(t.path, "ticket.md") : undefined;
}
