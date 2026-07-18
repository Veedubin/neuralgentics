/**
 * MCP server templates for the neuralgentics two-init installer.
 *
 * Two exported constants:
 *   - HOMEDIR_MCP_TEMPLATES  — global MCP servers (most disabled by default)
 *   - PROJECT_MCP_TEMPLATES  — project MCP servers (memini-ai-dev enabled)
 *
 * Every server uses `uvx` (Python) or `npx -y` (Node) — NO local paths,
 * NO hardcoded paths.
 *
 * Enabled-by-default policy:
 *   - memini-ai-dev:  PROJECT only (pgembed defaults)
 *   - videre-mcp:     HOMEDIR enabled
 *   - ssh-mcp-server: HOMEDIR disabled (Tailscale-only)
 *   - all others:     HOMEDIR disabled (user opts in)
 */

/** A single MCP server entry in the opencode.json `mcp` block. */
export interface McpServerEntry {
  type: "local";
  enabled: boolean;
  command: string[];
  env?: Record<string, string>;
  args?: string[];
}

/** The shape of the `mcp` block: server-name → server entry. */
export type McpBlock = Record<string, McpServerEntry>;

/**
 * Global (homedir) MCP server templates.
 *
 * 9 servers total:
 *   - memini-ai-dev: disabled (team DB URL) — also lives in PROJECT_MCP_TEMPLATES
 *     as the enabled pgembed instance. Kept here so `preDownloadPackages`
 *     caches the wheel for both flows.
 *   - videre-mcp:    ENABLED (vision: OCR, image description). Needs system ML deps.
 *   - all others:    disabled by default (user opts in via opencode.json).
 *
 * Removed (not published): mlflow-mcp, prefect, redis.
 */
export const HOMEDIR_MCP_TEMPLATES: McpBlock = {
  "memini-ai-dev": {
    type: "local",
    enabled: true,
    command: ["uvx", "--from", "memini-ai-dev", "memini-ai"],
    env: {
      MEMINI_DB_URL: "pgembed",
      MEMINI_VECTOR_BACKEND: "pgvector",
      MEMINI_EMBEDDING_DIM: "384",
      TRUST_ENGINE: "true",
      MEMORY_GRAPH: "true",
      KG_ENABLED: "true",
      TIERED_LOADING: "true",
      AUTO_EXTRACT: "true",
      PRECOMPRESS: "true",
      USER_MODELING: "true",
      DECAY_ENABLED: "true",
      MULTI_PEER_ENABLED: "false",
      DIALECTIC_ENABLED: "true",
      THOUGHT_CHAINS: "true",
      DB_SSLMODE: "disable",
    },
  },
  "videre-mcp": {
    type: "local",
    enabled: true,
    command: ["uvx", "videre-mcp[vision]"],
    env: {
      MEMINI_IMAGE_SEARCH_ENABLED: "true",
      MEMINI_IMAGE_DIR: "~/.neuralgentics/images",
    },
  },
  "ssh-mcp-server": {
    type: "local",
    enabled: false,
    command: ["npx", "-y", "@fangjunjie/ssh-mcp-server"],
    args: [
      '--ssh={"connections":[{"name":"default","host":"100.75.8.10","port":22,"username":"ubuntu","privateKeyPath":"~/.ssh/id_ed25519-ovh-ubuntu"}],"allowedRemotePaths":["/home/ubuntu/**","/tmp/**"]}',
    ],
  },
  markitdown: {
    type: "local",
    enabled: false,
    command: ["uvx", "markitdown-mcp"],
  },
  playwright: {
    type: "local",
    enabled: false,
    command: ["npx", "-y", "@playwright/mcp@latest"],
  },
  "github-mcp": {
    type: "local",
    enabled: false,
    command: ["npx", "-y", "@modelcontextprotocol/server-github"],
    env: {
      GITHUB_PERSONAL_ACCESS_TOKEN: "{env:GITHUB_TOKEN}",
    },
  },
  duckdb: {
    type: "local",
    enabled: false,
    command: ["uvx", "mcp-server-motherduck"],
    args: ["--db-path", ":memory:", "--read-write", "--allow-switch-databases"],
  },
  searxng: {
    type: "local",
    enabled: false,
    command: ["npx", "-y", "mcp-searxng"],
    env: {
      SEARXNG_URL: "http://localhost:8080",
    },
  },
  calculator: {
    type: "local",
    enabled: false,
    command: ["npx", "-y", "@wrtnlabs/calculator-mcp"],
  },
};

/**
 * Project-level MCP server templates.
 *
 * Only memini-ai-dev is installed at the project level, with pgembed defaults
 * (zero Docker required).
 */
export const PROJECT_MCP_TEMPLATES: McpBlock = {
  "memini-ai-dev": {
    type: "local",
    enabled: true,
    command: ["uvx", "--from", "memini-ai-dev", "memini-ai"],
    env: {
      MEMINI_DB_URL: "pgembed",
      MEMINI_VECTOR_BACKEND: "pgvector",
      MEMINI_EMBEDDING_DIM: "384",
      TRUST_ENGINE: "true",
      MEMORY_GRAPH: "true",
      KG_ENABLED: "true",
      TIERED_LOADING: "true",
      AUTO_EXTRACT: "true",
      PRECOMPRESS: "true",
      USER_MODELING: "true",
      DECAY_ENABLED: "true",
      MULTI_PEER_ENABLED: "false",
      DIALECTIC_ENABLED: "true",
      THOUGHT_CHAINS: "true",
      DB_SSLMODE: "disable",
    },
  },
};