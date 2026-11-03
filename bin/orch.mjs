#!/usr/bin/env node
import * as cmd from "../lib/commands.mjs";
import { projectRoot } from "../lib/project.mjs";
import { runJob } from "../lib/run.mjs";

const BOOLEAN = new Set(["follow", "all", "active", "force", "no-tab", "no-prepare", "stale-ok", "keep-open", "dry-run", "help"]);

function parse(argv) {
	const flags = {};
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "-h") flags.help = true;
		else if (a.startsWith("--")) {
			const [k, v] = a.slice(2).split(/=(.*)/s);
			if (v !== undefined) flags[k] = v;
			else if (BOOLEAN.has(k)) flags[k] = true;
			else flags[k] = argv[++i];
		} else rest.push(a);
	}
	return { flags, rest };
}

const HELP = `orch — one coordinator, many headless agent jobs in git worktrees

Project
  orch init                                 spec/ lanes, .orch/config.json, AGENTS.md pointer
  orch manual                               print the coordinator manual
  orch ticket new "what becomes true" [--active]
  orch board                                active / planned / done tickets with their last job

Jobs
  orch spawn --label "what changes · FNNN" [--role worker|reviewer|scout|researcher|judge]
             [--engine claude|agy] [--model M] [--effort E] [--branch B] [--base REF]
             [--timeout 60m] [--prepare CMD|--no-prepare] [--no-tab] [--force] [--stale-ok]
             "instruction … Ticket: spec/features/active/FNNN-slug/ticket.md"
  orch review <id> ["extra instruction"]    fresh reviewer on the job's branch
  orch continue <id> "follow-up"            same session, worktree and branch
  orch jobs [<id>] [--all]                  running jobs and unlanded candidates, or one job
  orch log <id> [--follow]
  orch wait <id>                            block until the job ends; print its wake
  orch steer <id> "correction"              delivered after the next tool call (claude only)
  orch stop <id> ["reason"]
  orch land <id> [--keep-open]              merge into the current branch, close its tickets
  orch prune [--dry-run]                    remove worktrees of merged or read-only jobs

<id> is a job id, a unique id suffix, or a unique label.`;

const { flags, rest } = parse(process.argv.slice(2));
const [command, ...args] = rest;

try {
	if (!command || flags.help || command === "help") console.log(HELP);
	else if (command === "_run") await runJob(projectRoot(), args[0]);
	else if (command === "init") cmd.init();
	else if (command === "manual") cmd.manual();
	else if (command === "ticket" && args[0] === "new") cmd.ticketNew(args[1], flags);
	else if (command === "board") cmd.board();
	else if (command === "spawn") await cmd.spawnJob(args.join(" "), flags);
	else if (command === "review") await cmd.review(args[0], args.slice(1).join(" "), flags);
	else if (command === "continue") await cmd.continueJob(args[0], args.slice(1).join(" "), flags);
	else if (command === "jobs") cmd.jobs(args[0], flags);
	else if (command === "log") await cmd.log(args[0], flags);
	else if (command === "wait") await cmd.wait(args[0]);
	else if (command === "steer") cmd.steer(args[0], args.slice(1).join(" "));
	else if (command === "stop") await cmd.stop(args[0], args.slice(1).join(" "));
	else if (command === "land") cmd.land(args[0], flags);
	else if (command === "prune") cmd.prune(flags);
	else {
		console.error(`orch: unknown command "${command}"\n`);
		console.log(HELP);
		process.exit(1);
	}
} catch (e) {
	console.error(`orch: ${e.message}`);
	process.exit(1);
}
