# Neuralgentics OpenCode Plugin

This package provides the core integration plugin for Neuralgentics, enabling extended memory capabilities and specialized agent routing within OpenCode.

## Core Features
- **OpenCode Integration**: Full contract implementation for custom plugin capabilities.
- **Memini-Core Bridge**: Connects to the Neuralgentics memory core.
- **Custom MCP Tools**: 
  - `validate_routing`: Ensures tasks are routed to the correct specialist agent.
  - `save_tool_result`: Persists significant tool outputs to memory.
  - `get_agents_md`: Retrieves the current agent persona and routing matrix.
  - `compaction_backup`: Triggers a backup before memory consolidation.

## Configuration
- **Default Port**: `8900` (used for communication with `memini-core`).

## Development

### Build
Compile the plugin for production:
```bash
npm run build
```

### Typecheck
Verify TypeScript integrity:
```bash
npm run typecheck
```
