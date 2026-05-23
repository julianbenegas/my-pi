---
name: piralph
description: Execute a larger plan by delegating sequential chunks to subthreads, reviewing each chunk, looping on feedback until accepted, then committing before moving to the next chunk. Use when the user wants a big piece of work completed through subthreads with parent-agent review and git safety.
---

# piralph

Use this skill for large implementation plans that should be executed by subthreads one chunk at a time, with the parent agent acting as planner, reviewer, validator, and git gatekeeper.

## Core flow

1. Start by summarizing the full intended flow to the user.
2. Break the work into sequential chunks. The plan can be informal; it does not need to be a written TODO list.
3. For each chunk, create or continue exactly one subthread.
4. Give the subthread a clear implementation prompt, including:
   - the current chunk goal
   - relevant plan/doc paths
   - constraints and non-goals
   - validation commands it should run
   - instruction not to commit
5. Review the subthread's work in the parent session.
6. Give concrete feedback to the same subthread and repeat until the parent is satisfied.
7. Run parent-side validation.
8. Stage, commit, and push the accepted chunk.
9. Move to the next chunk without stopping for permission unless there is a git/safety problem or the user explicitly asked for checkpoints.
10. Continue until the full plan is complete.

## User communication

At the start, tell the user:

- what chunks you plan to run
- that you will use one subthread at a time
- that each chunk will be reviewed and validated before commit
- that you will stop and ask if git state becomes weird or unsafe
- that otherwise you will keep going until the plan is done

After each chunk, briefly report:

- what landed
- validation results
- commit hash
- next chunk starting

Keep updates concise. Do not ask for confirmation between chunks unless required by the git safety rules below.

## Subthread prompting requirements

Each subthread prompt must clearly state what to implement. Include links/paths to relevant plan docs when available, for example:

```txt
Implement chunk 2 of the plan in packages/foo/docs/PLAN.md.
Focus only on mutation rejection browser E2E.
Do not implement version reset yet.
Run pnpm --filter foo test:e2e and pnpm --filter foo typecheck.
Do not commit.
```

Subthreads should return:

- files changed
- behavior implemented
- validation commands and results
- known limitations or follow-up suggestions

## Review loop

The parent agent must review the diff, not just trust the subthread report.

Use normal review tools:

- `git diff`
- targeted file reads
- tests/typechecks/lint
- manual/browser checks when relevant

If work is incomplete or too broad, continue the same subthread with feedback:

```txt
You implemented X, but Y is missing and Z is too broad.
Please adjust by ...
Run ... again.
```

Loop until the parent's acceptance criteria pass.

## Commit rules

After each accepted chunk:

1. Ensure working tree contains only the intended chunk changes.
2. Run required validation.
3. Stage the chunk.
4. Commit with a clear message.
5. Push.
6. Report commit hash.

Do not let subthreads commit unless the user explicitly asked for that. The parent owns git.

## Git safety rules

Stop and ask the user before doing anything else if any of these happen:

- current branch is not what you expect
- uncommitted changes exist that are not from the current chunk
- merge/rebase/cherry-pick/conflict state appears
- push is rejected
- remote branch diverges
- subthread changed files outside the requested scope in a way that may be destructive
- validation requires deleting/resetting state the user may care about
- you are unsure whether to include a file in the commit

Do not paper over git weirdness. Do not force push. Do not reset/clean unknown files without explicit user approval.

## Validation discipline

Use the repository's normal validation commands and any chunk-specific commands. Prefer focused validation for the package touched, plus parent-level lint/format if required by the project.

If validation cannot run, report why and stop if the missing validation is critical to the chunk.

## What counts as done

The full plan is done only when:

- every planned chunk has been implemented
- parent review accepted each chunk
- validation passed or explicitly documented
- each chunk was committed and pushed
- final summary is given to the user

Do not stop after the first successful subthread unless the plan only had one chunk.
