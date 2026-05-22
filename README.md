# Neuralgentics

Neuralgentics is a specialized coding agent built on OpenCode. It is not a fork of the OpenCode repository; rather, it is a set of patches and plugins applied to the OpenCode base. To set up, download the OpenCode base, apply Neuralgentics patches, and build.

## Architecture

The system follows a layered approach to separate high-level orchestration from low-level data persistence:

**OpenCode (Base)** $\rightarrow$ **Neuralgentics Plugin (TypeScript)** $\rightarrow$ **memini-core (Python HTTP)** $\rightarrow$ **PostgreSQL/pgvector**

*   **MCP Router**: Used exclusively for interfacing with external tools. Native memory and core agent logic bypass MCP for performance and reliability.

## Components

- `neuralgentics-plugin`: TypeScript-based extension for OpenCode providing specialized agent routing and protocol enforcement.
- `memini-core`: Python server handling semantic memory, trust scoring, and knowledge graph management.
- `neuralgentics-patches`: A collection of diffs to modify the OpenCode TUI and core behavior.
- `neuralgentics-cli`: Build and installation scripts for environment setup.

## Build

To build and install the project:

```bash
./scripts/build.sh && ./scripts/install.sh
```

## Development

1.  **Backend**: Start the `memini-core` Python server in one terminal.
2.  **Frontend/Orchestrator**: Run the OpenCode base with the Neuralgentics plugin enabled in another terminal.

## License

Proprietary / See LICENSE file for details.
