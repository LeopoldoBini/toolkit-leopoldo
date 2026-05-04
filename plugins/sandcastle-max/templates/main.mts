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
// Source the OAuth env helper before running:
//   source scripts/claude-oauth-env.sh
//   bun run sandcastle:run     # or: npx tsx .sandcastle/main.mts
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

await run({
  agent: claudeCode("claude-sonnet-4-6", {
    env: agentEnv,
  }),
  sandbox: docker({
    imageName: "sandcastle-max",
  }),
  promptFile: "./.sandcastle/prompt.md",
  // For real AFK runs use { type: 'branch', branch: 'agent/issue-N' } so the
  // agent works on a dedicated branch and Sandcastle can collect commits
  // for a PR. 'head' is fine for read-only smoke tests.
  branchStrategy: { type: "head" },
});
