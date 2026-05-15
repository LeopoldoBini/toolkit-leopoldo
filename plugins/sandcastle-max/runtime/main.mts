import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const repoRoot = process.cwd();
const configPath = resolve(repoRoot, ".sandcastle/config.json");

if (!existsSync(configPath)) {
  console.error(
    `ERROR: ${configPath} not found.\n` +
      `Run /sandcastle-init in this repo first to scaffold .sandcastle/.`,
  );
  process.exit(1);
}

type SandcastleConfig = {
  imageName: string;
  runtimes?: string[];
  versions?: Record<string, string>;
  promptFile?: string;
  dockerfile?: string;
  model?: string;
};

const config: SandcastleConfig = JSON.parse(readFileSync(configPath, "utf-8"));

if (!config.imageName) {
  console.error(
    `ERROR: ${configPath} is missing required field "imageName".`,
  );
  process.exit(1);
}

const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
if (!oauthToken) {
  console.error(
    "ERROR: CLAUDE_CODE_OAUTH_TOKEN is not set.\n" +
      "Slash commands (/sandcastle-build, /sandcastle-run) extract this from\n" +
      "the macOS Keychain or .sandcastle/.env — invoke them instead of calling\n" +
      "main.mts directly.",
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

const issueNumber = process.env.SANDCASTLE_ISSUE_NUMBER;
const branchName = process.env.SANDCASTLE_BRANCH;
const baseBranch = process.env.SANDCASTLE_BASE_BRANCH;
const promptFile =
  process.env.SANDCASTLE_PROMPT_FILE ??
  config.promptFile ??
  "./.sandcastle/prompt.md";

const branchStrategy =
  branchName && branchName !== "head"
    ? ({ type: "branch", branch: branchName } as const)
    : ({ type: "head" } as const);

const model =
  process.env.SANDCASTLE_MODEL ?? config.model ?? "claude-opus-4-7";

if (issueNumber) {
  console.log(
    `[sandcastle-max] AFK dispatch — issue #${issueNumber}, ` +
      `branch=${branchName ?? "(head)"}, base=${baseBranch ?? "(host HEAD)"}, ` +
      `prompt=${promptFile}, image=${config.imageName}`,
  );
} else {
  console.log(
    `[sandcastle-max] smoke / dev mode — branch=head, ` +
      `prompt=${promptFile}, image=${config.imageName}`,
  );
}

console.log(`[sandcastle-max] model=${model} (default Opus 4.7)`);
if (config.runtimes?.length) {
  console.log(`[sandcastle-max] runtimes=${config.runtimes.join(", ")}`);
}

await run({
  agent: claudeCode(model, {
    env: agentEnv,
  }),
  sandbox: docker({
    imageName: config.imageName,
  }),
  promptFile,
  branchStrategy,
});
