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

type DockerCustomization = {
  // Linux capabilities to add to the container, e.g. ["NET_ADMIN"] for Netbird.
  // Translated to --cap-add flags via SANDCASTLE_EXTRA_CAPS (bundled patch).
  capAdd?: string[];
  // Host devices to expose, e.g. ["/dev/net/tun"] for Netbird tun device.
  // Translated to --device flags via SANDCASTLE_EXTRA_DEVICES (bundled patch).
  devices?: string[];
  // Path inside the container to execute as root after create, before the
  // agent starts. Typical use: bring up a VPN peer so the agent has
  // network access to private resources during its dev loop. Translated to
  // SANDCASTLE_POST_CREATE_HOOK (bundled patch).
  postCreateHook?: string;
};

type SandcastleConfig = {
  imageName: string;
  runtimes?: string[];
  versions?: Record<string, string>;
  promptFile?: string;
  dockerfile?: string;
  model?: string;
  docker?: DockerCustomization;
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

// Propagate env_required vars declared in .sandcastle/resources.json into the
// container so the agent can re-run connectivity_probe / schema_introspect from
// inside (Level 2 + Level 3 probes). Without this, the container has no
// credentials for the user's databases / APIs / queues and mocks become the
// only path forward.
const resourcesPath = resolve(repoRoot, ".sandcastle/resources.json");
if (existsSync(resourcesPath)) {
  try {
    const resourcesDoc = JSON.parse(readFileSync(resourcesPath, "utf-8"));
    const resources = Array.isArray(resourcesDoc.resources)
      ? resourcesDoc.resources
      : [];
    const propagated: string[] = [];
    for (const r of resources) {
      const envList: string[] = Array.isArray(r.env_required)
        ? r.env_required
        : [];
      for (const ev of envList) {
        const val = process.env[ev];
        if (val !== undefined && agentEnv[ev] === undefined) {
          agentEnv[ev] = val;
          propagated.push(ev);
        }
      }
    }
    if (propagated.length > 0) {
      console.log(
        `[sandcastle-max] propagated ${propagated.length} resource env var(s) to container: ${propagated.join(", ")}`,
      );
    }
  } catch (err) {
    console.warn(
      `[sandcastle-max] WARNING: could not parse .sandcastle/resources.json (${(err as Error).message}). Resource env vars NOT propagated — agent will fail Level 2 probes.`,
    );
  }
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

// Translate config.docker to SANDCASTLE_EXTRA_* env vars that the bundled
// @ai-hero/sandcastle patch reads when assembling the `docker run` command.
// Set on process.env (the Node orchestrator), NOT agentEnv (container).
const dockerCfg = config.docker;
if (dockerCfg) {
  if (Array.isArray(dockerCfg.capAdd) && dockerCfg.capAdd.length > 0) {
    process.env.SANDCASTLE_EXTRA_CAPS = dockerCfg.capAdd.join(",");
  }
  if (Array.isArray(dockerCfg.devices) && dockerCfg.devices.length > 0) {
    process.env.SANDCASTLE_EXTRA_DEVICES = dockerCfg.devices.join(",");
  }
  if (
    typeof dockerCfg.postCreateHook === "string" &&
    dockerCfg.postCreateHook.length > 0
  ) {
    process.env.SANDCASTLE_POST_CREATE_HOOK = dockerCfg.postCreateHook;
  }
  const summary = [
    dockerCfg.capAdd?.length ? `caps=${dockerCfg.capAdd.join(",")}` : null,
    dockerCfg.devices?.length
      ? `devices=${dockerCfg.devices.join(",")}`
      : null,
    dockerCfg.postCreateHook
      ? `post-create=${dockerCfg.postCreateHook}`
      : null,
  ]
    .filter(Boolean)
    .join(" ");
  if (summary) {
    console.log(`[sandcastle-max] docker customization: ${summary}`);
  }
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
