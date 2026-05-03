---
name: to-prd
description: Turn the current conversation context into a PRD without re-interviewing the user. Synthesizes what's already been discussed and proposes module-level structure before publishing. Use when user says "write a PRD", "armá un PRD", "convertí esto en PRD", or wants to formalize current context into a product spec.
---

# To PRD

Take the current conversation context and codebase understanding and produce a PRD. Do **NOT** interview the user — just synthesize what you already know.

## Process

### 1. Gather context

Explore the repo to understand the current state of the codebase, if you haven't already. Use the project's `CONTEXT.md` vocabulary throughout the PRD, and respect any ADRs in the area you're touching.

### 2. Sketch the modules

Sketch out the major modules you will need to build or modify to complete the implementation. Actively look for opportunities to extract **deep modules** (small interface, deep implementation, rarely changes) — see the `/deep-modules` skill if available.

Check with the user that these modules match their expectations. Check with the user which modules they want tests written for.

### 3. Write the PRD

Use the template below. If the project has an issue tracker (GitHub, Linear, ClickUp, etc.) and the user wants it published, do so — otherwise output the PRD inline. If publishing, apply a `needs-triage` label so it enters the normal triage flow (see `/triage`).

<prd-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories. Each user story should be in the format of:

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

This list of user stories should be extremely extensive and cover all aspects of the feature.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Do NOT include specific file paths or code snippets. They may end up being outdated very quickly.

## Testing Decisions

A list of testing decisions that were made. Include:

- A description of what makes a good test (only test external behavior, not implementation details)
- Which modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Out of Scope

A description of the things that are out of scope for this PRD.

## Further Notes

Any further notes about the feature.

</prd-template>
