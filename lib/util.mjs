import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ORCH_BIN = join(PKG, "bin", "orch.mjs");

export function sh(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
	return { ok: r.status === 0, code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() || r.error?.message || "" };
}

export function git(cwd, ...args) {
	return sh("git", ["-C", cwd, ...args]);
}

export function mustGit(cwd, ...args) {
	const r = git(cwd, ...args);
	if (!r.ok) throw new Error(`git ${args.join(" ")}: ${r.err}`);
	return r.out;
}

export function read(path, fallback = "") {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return fallback;
	}
}

export function readTrim(path, fallback = "") {
	return read(path, fallback).trim();
}

export function write(path, text) {
	writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
}

export function append(path, text) {
	appendFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
}

export function now() {
	return new Date().toISOString();
}

export function today() {
	return new Date().toLocaleDateString("sv-SE");
}

export function slug(text, max = 32) {
	return text
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, max)
		.replace(/-+$/, "");
}

/** "90s", "20m", "2h" → milliseconds. */
export function duration(text) {
	const m = /^(\d+)(s|m|h)$/.exec(String(text).trim());
	if (!m) throw new Error(`bad duration "${text}" (use 90s, 20m, 2h)`);
	return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2]];
}

export function alive(pid) {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function fail(message) {
	console.error(`orch: ${message}`);
	process.exit(1);
}

export function exists(path) {
	return existsSync(path);
}
