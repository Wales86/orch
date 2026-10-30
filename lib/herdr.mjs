import { sh } from "./util.mjs";

export function inHerdr() {
	return process.env.HERDR_ENV === "1";
}

function herdr(...args) {
	return sh(process.env.ORCH_HERDR ?? "herdr", args, { timeout: 60_000 });
}

/** A background tab that tails the job log. Returns { tab, pane } or undefined. */
export function openJobTab(label, cwd, command) {
	const r = herdr("tab", "create", "--cwd", cwd, "--label", label, "--no-focus");
	if (!r.ok) return { error: r.err };
	try {
		const res = JSON.parse(r.out).result;
		const tab = res.tab.tab_id;
		const pane = res.root_pane.pane_id;
		herdr("pane", "run", pane, command);
		return { tab, pane };
	} catch (e) {
		return { error: `unexpected herdr reply: ${e.message}` };
	}
}

export function closeTab(tab) {
	const r = herdr("tab", "close", tab);
	return r.ok ? "closed" : r.err;
}

/**
 * Submit a wake to the coordinator pane. Herdr refuses before sending when the agent is
 * blocked; any other failure may have reached the pane, so the caller never resends it.
 */
export function promptPane(pane, text) {
	const r = herdr("agent", "prompt", pane, text, "--timeout", "20000");
	if (r.ok) return { sent: true };
	const refused = /agent_blocked|not_found|no agent|unknown pane/i.test(r.err);
	return { sent: false, refused, error: r.err.split("\n")[0] };
}
