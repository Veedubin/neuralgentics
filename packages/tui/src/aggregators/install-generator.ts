/**
 * Install Command Generator — T-035 (P1-c-ext).
 *
 * Generates install commands per Addendum 2 §5.1.
 * Per-aggregator command templates for MCP config, npx, bun, cp, etc.
 */

import type { AggregatorResult, AggregatorSource, MCPConfig, InstallType } from "./types.js";
import { INSTALL_SIMPLICITY } from "./types.js";

/**
 * Generate an install command for an aggregator result.
 * Returns a human-readable command string and the type of install.
 */
export function generateInstallCommand(result: AggregatorResult): {
  command: string;
  type: InstallType;
  mcpConfig?: MCPConfig;
} {
  const type = getInstallType(result.source, result.installCommand);
  const command = formatInstallCommand(result, type);
  const mcpConfig = type === "npx_mcp" ? generateMCPConfig(result) : undefined;

  return { command, type, mcpConfig };
}

/**
 * Determine the install type based on source and install command.
 */
export function getInstallType(source: AggregatorSource, installCommand: string): InstallType {
  // MCP servers use npx -y
  if (source === "official_mcp_registry") {
    return "npx_mcp";
  }

  // Orchestra Research uses npx skill install
  if (source === "orchestra_research") {
    return "npx_skill";
  }

  // Internal skills use cp
  if (source === "internal_skills_directory") {
    return "copy_skill";
  }

  // Package managers by install command prefix
  if (installCommand.startsWith("bun add")) return "bun_add";
  if (installCommand.startsWith("npm install")) return "npm_install";
  if (installCommand.startsWith("uv add")) return "uv_add";
  if (installCommand.startsWith("go install")) return "go_install";

  // Default to npx_mcp for unknown sources
  return "npx_mcp";
}

/**
 * Format the install command string for display.
 */
function formatInstallCommand(result: AggregatorResult, type: InstallType): string {
  switch (type) {
    case "npx_mcp": {
      const config = generateMCPConfig(result);
      return [
        `Add to .opencode/opencode.json:`,
        ``,
        `{`,
        `  "mcpServers": {`,
        `    "${config.name}": {`,
        `      "command": "${config.command}",`,
        `      "args": ${JSON.stringify(config.args)}`,
        `    }`,
        `  }`,
        `}`,
      ].join("\n");
    }
    case "npx_skill":
      return result.installCommand;
    case "copy_skill":
      return result.installCommand;
    case "bun_add":
      return result.installCommand;
    case "npm_install":
      return result.installCommand;
    case "uv_add":
      return result.installCommand;
    case "go_install":
      return result.installCommand;
  }
}

/**
 * Generate an MCP config block for opencode.json.
 * Per Addendum 2 §5.1: Official MCP Registry uses this format.
 */
export function generateMCPConfig(result: AggregatorResult): MCPConfig {
  // Extract server name from install command or result name
  let packageName = result.installCommand;
  let serverName = result.name.toLowerCase().replace(/[^a-z0-9]/g, "-");

  // If install command is just a package name like "@context7/mcp"
  if (!packageName.includes(" ")) {
    serverName = packageName.replace("@", "").replace("/", "-");
  }

  // Parse npx args from install command
  const args: string[] = ["-y"];
  if (result.installCommand.startsWith("npx")) {
    // Already in npx format
    const parts = result.installCommand.split(/\s+/);
    if (parts.length >= 2) {
      serverName = parts[1]!.replace("@", "").replace("/", "-");
    }
  } else if (result.installCommand.startsWith("@")) {
    // Scoped package like @context7/mcp
    args.push(result.installCommand);
  } else {
    args.push(result.installCommand);
  }

  return {
    name: serverName,
    command: "npx",
    args,
  };
}

/**
 * Get the install simplicity score for a result.
 * Used in match score computation per Addendum 2 §3.3.
 */
export function getInstallSimplicity(result: AggregatorResult): number {
  const type = getInstallType(result.source, result.installCommand);
  return INSTALL_SIMPLICITY[type];
}

/**
 * Format a user-facing description of the install step.
 * Per Addendum 2 §3.4: shows Tier label, description, command, and trust.
 */
export function formatResultDescription(result: AggregatorResult): string {
  const { command, mcpConfig } = generateInstallCommand(result);
  const star = "\u2605";
  const emptyStar = "\u2606";
  const tierStars = star.repeat(result.trustTier) + emptyStar.repeat(4 - result.trustTier);
  const tierLabel = result.trustTier === 1 ? "Highly Trusted"
    : result.trustTier === 2 ? "Community Vetted"
    : result.trustTier === 3 ? "Use With Caution"
    : "Build New";
  const src = sourceLabel(result.source);

  const lines: string[] = [];
  lines.push("(Tier " + result.trustTier + " " + tierStars + ") -- " + result.name + " (" + src + ")");
  lines.push('   "' + result.description + '"');
  lines.push("   Install: " + command);
  lines.push("   Trust: Tier " + result.trustTier + " (" + tierLabel + ")");
  lines.push("   Match score: " + (result.matchScore * 100).toFixed(0) + "%");

  if (mcpConfig) {
    lines.push("   Config: " + JSON.stringify(mcpConfig));
  }

  return lines.join("\n");
}

/** Get a human-readable source label. */
function sourceLabel(source: AggregatorSource): string {
  const labels: Record<AggregatorSource, string> = {
    official_mcp_registry: "Official MCP Registry",
    orchestra_research: "Orchestra Research",
    internal_skills_directory: "Internal Skills",
  };
  return labels[source];
}