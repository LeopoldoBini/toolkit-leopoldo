---
name: agent-brief
description: Write a durable agent brief for handing off work to an AFK agent — behavioral, no file paths or line numbers, with explicit acceptance criteria and out-of-scope. Use when triaging an issue to ready-for-agent, when scheduling a remote agent via /schedule, or when user says "write an agent brief", "brief para el agente", "spec para AFK".
---

# Agent Brief

A structured spec posted on an issue (or handed to a scheduled agent) when work moves to "ready-for-agent". It is the authoritative contract the AFK agent works from. The original issue body and discussion are context — the agent brief is the contract.

## Principles

### Durability over precision

The issue may sit in `ready-for-agent` for days or weeks. The codebase will change in the meantime. Write the brief so it stays useful even as files are renamed, moved, or refactored.

- **Do** describe interfaces, types, and behavioral contracts
- **Do** name specific types, function signatures, or config shapes that the agent should look for or modify
- **Don't** reference file paths — they go stale
- **Don't** reference line numbers
- **Don't** assume the current implementation structure will remain the same

### Behavioral, not procedural

Describe **what** the system should do, not **how** to implement it. The agent will explore the codebase fresh and make its own implementation decisions.

- **Good:** "The `SkillConfig` type should accept an optional `schedule` field of type `CronExpression`"
- **Bad:** "Open src/types/skill.ts and add a schedule field on line 42"
- **Good:** "When a user runs `/triage` with no arguments, they should see a summary of issues needing attention"
- **Bad:** "Add a switch statement in the main handler function"

### Complete acceptance criteria

The agent needs to know when it's done. Every agent brief must have concrete, testable acceptance criteria. Each criterion should be independently verifiable.

- **Good:** "Running `gh issue list --label needs-triage` returns issues that have been through initial classification"
- **Bad:** "Triage should work correctly"

### Explicit scope boundaries

State what is out of scope. This prevents the agent from gold-plating or making assumptions about adjacent features.

### Reality-anchored (when `.sandcastle/probes/*.schema` exists)

If the repo has `.sandcastle/resources.json` AND `.sandcastle/probes/*.schema` files cached (via `/sandcastle-probe-resources` or a previous `/sandcastle-dispatch-wave` run), the brief MUST anchor any reference to tables, columns, endpoints, queues, or storage keys to **real, verified** names.

Process:

1. Identify every concrete resource reference the brief would make (e.g. "the `users.email` column", "the `POST /orders/{id}/cancel` endpoint", "the `events.user_signup` Kafka topic", "the `s3://bucket/exports/<date>.csv` key").
2. For each reference, open the matching `.sandcastle/probes/<resource>.schema` file and verify the reference exists. The schema files are plain-text dumps (column lists, OpenAPI docs, topic lists) — grep for the exact name.
3. If a reference matches: include it in the `**Real resources:**` section verbatim.
4. If a reference does NOT match: pick the closest real name from the schema cache, but flag it with `(unverified — closest match: X; please confirm)`. Do NOT silently rename — the human decides whether the brief or the schema is wrong.
5. If `.sandcastle/probes/` does not exist: emit the section as `**Real resources:** (unverified — run /sandcastle-probe-resources to enable verification)` and continue. The dispatcher's Level 3 probe in the container will catch any mismatches at run-time as a fallback.

This section is what closes the loop between PRD intent and runtime reality. Without it, AFK agents fall back to mocks or to guessing column names.

### Single brief per issue (edit, do not duplicate)

An issue must have **exactly one** `## Agent Brief` comment at any time. The brief is the contract — multiple briefs create ambiguity about which one is "live" and break tooling that consumes them programmatically.

When the brief needs to be updated (refining acceptance criteria, adding cross-cutting decisions, fixing ambiguity surfaced during grilling):

- **Edit the existing comment in place.** Use `gh issue comment <N> --edit-last` if it was the most recent comment, or `gh api --method PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}` for an arbitrary comment by ID.
- **Do NOT add a new `## Agent Brief` comment** alongside the old one.
- If you find an issue that already has multiple `## Agent Brief` comments (legacy state), reconcile: keep the latest, delete the older ones (`gh api --method DELETE /repos/{owner}/{repo}/issues/comments/{old_id}`), then proceed with the edit.

This invariant is consumed by downstream tooling (e.g. `/sandcastle-dispatch-wave` reads the latest `## Agent Brief` comment as the contract). Two briefs == two contracts == undefined behavior.

## Template

```markdown
## Agent Brief

**Category:** bug / enhancement
**Summary:** one-line description of what needs to happen

**Current behavior:**
Describe what happens now. For bugs, this is the broken behavior.
For enhancements, this is the status quo the feature builds on.

**Desired behavior:**
Describe what should happen after the agent's work is complete.
Be specific about edge cases and error conditions.

**Key interfaces:**
- `TypeName` — what needs to change and why
- `functionName()` return type — what it currently returns vs what it should return
- Config shape — any new configuration options needed

**Real resources:**
- `<resource-name>` / `<table.column or endpoint or topic or key>` (`<type/shape verified from .sandcastle/probes/>`)
- (Omit this section if no resources are touched. Mark unverifiable refs with `(unverified — closest match: X)`.)

**Acceptance criteria:**
- [ ] Specific, testable criterion 1
- [ ] Specific, testable criterion 2
- [ ] Specific, testable criterion 3

**Out of scope:**
- Thing that should NOT be changed or addressed in this issue
- Adjacent feature that might seem related but is separate
```

## Examples

### Good agent brief (bug)

```markdown
## Agent Brief

**Category:** bug
**Summary:** Skill description truncation drops mid-word, producing broken output

**Current behavior:**
When a skill description exceeds 1024 characters, it is truncated at exactly
1024 characters regardless of word boundaries. This produces descriptions
that end mid-word (e.g. "Use when the user wants to confi").

**Desired behavior:**
Truncation should break at the last word boundary before 1024 characters
and append "..." to indicate truncation.

**Key interfaces:**
- The `SkillMetadata` type's `description` field — no type change needed,
  but the validation/processing logic that populates it needs to respect
  word boundaries
- Any function that reads SKILL.md frontmatter and extracts the description

**Real resources:**
- (none — this is a pure-code change, no DB/HTTP/queue resources touched)

**Acceptance criteria:**
- [ ] Descriptions under 1024 chars are unchanged
- [ ] Descriptions over 1024 chars are truncated at the last word boundary
      before 1024 chars
- [ ] Truncated descriptions end with "..."
- [ ] The total length including "..." does not exceed 1024 chars

**Out of scope:**
- Changing the 1024 char limit itself
- Multi-line description support
```

### Good agent brief (touches real resources)

```markdown
## Agent Brief

**Category:** enhancement
**Summary:** Persist user email changes through the auth-api to the main DB

**Current behavior:**
The `User.updateEmail()` method exists in code but does not persist —
calls are no-ops because the auth-api endpoint is unwired.

**Desired behavior:**
Calling `User.updateEmail(newEmail)` should:
1. Validate the new email against RFC 5322
2. Call the auth-api to update the canonical record
3. Reflect the change in the main DB (eventually consistent via auth-api webhook)

**Key interfaces:**
- `User.updateEmail(email: string) → Promise<void>` — returns when auth-api confirms
- Validation: reuse the `EmailValidator` already in the codebase (do not reimplement)

**Real resources:**
- `auth-api` / `POST /v1/users/{id}/email` (request: `{email: string}`, returns 204 on success, 422 on invalid)
- `main-db` / `users.email` (verified varchar(255), not null, unique index)
- `main-db` / `users.email_updated_at` (verified timestamptz, nullable)

**Acceptance criteria:**
- [ ] `User.updateEmail("foo@bar.com")` hits the real auth-api endpoint
- [ ] Test exercises the real `main-db.users.email` column (no mock)
- [ ] After webhook consumption, `users.email` reflects the new value AND `users.email_updated_at` is set to NOW()
- [ ] Invalid emails (per RFC 5322) reject with the auth-api's 422 error mapped to a domain error

**Out of scope:**
- Email verification flow (separate ticket)
- Changing the auth-api's request/response shape
```

### Good agent brief (enhancement)

```markdown
## Agent Brief

**Category:** enhancement
**Summary:** Add `.out-of-scope/` directory support for tracking rejected feature requests

**Current behavior:**
When a feature request is rejected, the issue is closed with a `wontfix` label
and a comment. There is no persistent record of the decision or reasoning.
Future similar requests require the maintainer to recall or search for the
prior discussion.

**Desired behavior:**
Rejected feature requests should be documented in `.out-of-scope/<concept>.md`
files that capture the decision, reasoning, and links to all issues that
requested the feature. When triaging new issues, these files should be
checked for matches.

**Key interfaces:**
- Markdown file format in `.out-of-scope/` — each file should have a
  `# Concept Name` heading, a `**Decision:**` line, a `**Reason:**` line,
  and a `**Prior requests:**` list with issue links
- The triage workflow should read all `.out-of-scope/*.md` files early
  and match incoming issues against them by concept similarity

**Acceptance criteria:**
- [ ] Closing a feature as wontfix creates/updates a file in `.out-of-scope/`
- [ ] The file includes the decision, reasoning, and link to the closed issue
- [ ] If a matching `.out-of-scope/` file already exists, the new issue is
      appended to its "Prior requests" list rather than creating a duplicate
- [ ] During triage, existing `.out-of-scope/` files are checked and surfaced
      when a new issue matches a prior rejection

**Out of scope:**
- Automated matching (human confirms the match)
- Reopening previously rejected features
- Bug reports (only enhancement rejections go to `.out-of-scope/`)
```

### Bad agent brief

```markdown
## Agent Brief

**Summary:** Fix the triage bug

**What to do:**
The triage thing is broken. Look at the main file and fix it.
The function around line 150 has the issue.

**Files to change:**
- src/triage/handler.ts (line 150)
- src/types.ts (line 42)
```

This is bad because:
- No category
- Vague description ("the triage thing is broken")
- References file paths and line numbers that will go stale
- No acceptance criteria
- No scope boundaries
- No description of current vs desired behavior
