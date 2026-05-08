import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

// Sandcastle entry — Max subscription mode.
//
// Auth: passes CLAUDE_CODE_OAUTH_TOKEN from the host env into the container,
// bypassing the default ANTHROPIC_API_KEY path. This works because
// claudeCode() does not validate ANTHROPIC_API_KEY presence — it just builds
// the `claude --print` command and inherits whichever auth env it finds at
// runtime. The container has no Keychain, so the env var is the only auth
// path. See the sandcastle-afk skill for full background on issue #191.
//
// Two operating modes:
//
//  1. SMOKE / DEV (default — no env overrides):
//       branchStrategy = { type: 'head' } → no commits, read-only run
//       promptFile     = ./.sandcastle/prompt.md (smoke template)
//     Source the OAuth env helper and run:
//       source scripts/claude-oauth-env.sh
//       bun run sandcastle:run
//
//  2. AFK DISPATCH (driven by /sandcastle-dispatch-wave):
//       The dispatcher sets env vars before invoking this script:
//         SANDCASTLE_ISSUE_NUMBER  e.g. "2"
//         SANDCASTLE_BRANCH        e.g. "agent/issue-2"
//         SANDCASTLE_PROMPT_FILE   e.g. "./.sandcastle/prompts/issue-2.md"
//       branchStrategy switches to { type: 'branch', branch: $BRANCH } so
//       Sandcastle creates a dedicated branch for the agent's commits and
//       a PR can be opened against it.
//
// Optional GH_TOKEN: pass through if present so the agent can `gh issue
// comment` and `gh pr create` from inside the container.

const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
if (!oauthToken) {
  console.error(
    "ERROR: CLAUDE_CODE_OAUTH_TOKEN is not set in the host environment.\n" +
      "Run: source scripts/claude-oauth-env.sh",
  );
  process.exit(1);
}

const ghToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
const agentEnv: Record<string, string> = {
  CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
};
if (ghToken) {
  agentEnv.GH_TOKEN = ghToken;
}

// Per-dispatch overrides (set by /sandcastle-dispatch-wave).
const issueNumber = process.env.SANDCASTLE_ISSUE_NUMBER;
const branchName = process.env.SANDCASTLE_BRANCH;
const promptFile =
  process.env.SANDCASTLE_PROMPT_FILE ?? "./.sandcastle/prompt.md";

const branchStrategy =
  branchName && branchName !== "head"
    ? ({ type: "branch", branch: branchName } as const)
    : ({ type: "head" } as const);

if (issueNumber) {
  console.log(
    `[sandcastle-max] AFK dispatch — issue #${issueNumber}, branch=${branchName ?? "(head)"}, prompt=${promptFile}`,
  );
} else {
  console.log(
    `[sandcastle-max] smoke / dev mode — branch=head, prompt=${promptFile}`,
  );
}

await run({
  agent: claudeCode("claude-sonnet-4-6", {
    env: agentEnv,
  }),
  sandbox: docker({
    imageName: "sandcastle-max",
  }),
  promptFile,
  branchStrategy,
});
