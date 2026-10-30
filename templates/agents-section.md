<!-- orch -->
## Orchestration (orch)

This project runs agent jobs with `orch` (headless workers and reviewers in Git worktrees under `.orch/`).
A session the owner asks to coordinate reads the manual first: run `orch manual`.
Jobs never edit `spec/build.md` or ticket status; the coordinator does. Job records in `.orch/jobs/` are the truth.
