// Stop hook for Claude jobs: the first stop of a worker gets the note check and continues;
// the next stop ends the job.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { noteCheckText } from "../lib/note.mjs";
import { append, now, write } from "../lib/util.mjs";

const dir = process.env.ORCH_JOB_DIR;
if (!dir || process.env.ORCH_ROLE !== "worker" || existsSync(join(dir, "note-check-sent"))) process.exit(0);

write(join(dir, "note-check-sent"), now());
append(join(dir, "log"), `${now().slice(11, 19)} note check sent (stop hook)`);
process.stdout.write(JSON.stringify({ decision: "block", reason: noteCheckText(process.env.ORCH_PROJECT_ROOT ?? "", dir) }));
