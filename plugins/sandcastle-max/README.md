# sandcastle-max

Run [@ai-hero/sandcastle](https://github.com/mattpocock/sandcastle) (AFK Claude Code agents in Docker) using your **Claude Max subscription** via `CLAUDE_CODE_OAUTH_TOKEN` instead of paying for `ANTHROPIC_API_KEY` tokens.

Workaround for Sandcastle [issue #191](https://github.com/mattpocock/sandcastle/issues/191) (subscription auth — marked **wontfix** by the maintainer).

## What you get

- **`/sandcastle-init`** — slash command that scaffolds `.sandcastle/` in any repo: Dockerfile (with chmod 1777 fix + Claude installer state cleanup), OAuth-aware `main.mts`, prompt template, `.env.example`, plus `scripts/claude-oauth-env.sh` (Keychain → env), package.json scripts (`sandcastle:build`, `sandcastle:run`), and `.gitignore` updates.
- **Skill `sandcastle-afk`** — full troubleshooting guide. Documents the three non-obvious gotchas (interactive init wizard with no override, UID mismatch between agent install and runtime user, owner-only `.claude.json` that hangs `claude --print` silently).

## Usage

In any repo where you want AFK execution:

```
/sandcastle-init
```

Then:

```bash
claude setup-token              # one-time, populates macOS Keychain
source scripts/claude-oauth-env.sh
bun run sandcastle:build        # 1-3 min first time
bun run sandcastle:run          # runs the smoke prompt
```

If smoke completes with `<promise>COMPLETE</promise>`, you're set. For real AFK execution, edit `.sandcastle/prompt.md` with the agent brief, change `branchStrategy` in `main.mts` from `'head'` to `{ type: 'branch', branch: 'agent/issue-N' }`, and pass `GH_TOKEN` so the agent can `gh issue comment` and `gh pr create`.

## Why this exists

- Claude Max 20x ($200/mo) has 5h-window quotas. AFK runs through Sandcastle default (API key) bypass that and bill per token instead — a 30-60min brief can cost $5-50.
- Wiring `CLAUDE_CODE_OAUTH_TOKEN` makes AFK runs consume from the same subscription pool as your interactive sessions. No extra billing.
- The Sandcastle maintainer chose not to support this in core (issue #191 wontfix). The workaround is non-obvious enough to deserve a packaged solution.

## Limitations

- **macOS-only** for the Keychain helper. On Linux/server, paste the OAuth token directly into `.sandcastle/.env` or wire your own secret store.
- **5h-window quota applies.** If you run 4-6 AFK containers in parallel, they share the same Max window. Throttle accordingly or fall back to API key for sustained parallel workloads.
- Sandcastle still hardcodes `--user $HOST_UID:$HOST_GID` and `HOME=/home/agent` — the Dockerfile is shaped around those constraints. If Sandcastle changes that, the Dockerfile may need adjustment.

## Files in this plugin

```
sandcastle-max/
├── plugin.json
├── README.md                        ← this file
├── commands/
│   └── sandcastle-init.md           ← /sandcastle-init slash command
├── skills/
│   └── sandcastle-afk/
│       └── SKILL.md                 ← troubleshooting + architecture
├── templates/
│   ├── Dockerfile                   ← fixed (chmod 1777 + .claude.json cleanup)
│   ├── main.mts                     ← OAuth env wiring + GH_TOKEN passthrough
│   ├── prompt.md                    ← smoke test placeholder
│   └── env.example                  ← CLAUDE_CODE_OAUTH_TOKEN + GH_TOKEN
└── scripts/
    └── claude-oauth-env.sh          ← Keychain → CLAUDE_CODE_OAUTH_TOKEN, no leak
```

## Related plugins in this marketplace

- **engineering-workflow** — pipeline that produces the agent briefs you would feed to Sandcastle. `/agent-brief` writes the contract; this plugin runs the contract.
