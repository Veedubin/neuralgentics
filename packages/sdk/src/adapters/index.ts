/**
 * Boomerang SDK — Adapters Index
 *
 * Re-exports all adapter modules for convenient importing.
 */

export { MemoryAdapter } from './memory.js';
export type { Memory, Relationship } from './memory.js';

export {
  getAgentConfig,
  checkRouting,
  buildTaskPlan,
  getAllAgentConfigs,
  getRoutingMatrix,
  resolveAgent,
  validateRouting,
  getRoutingRule,
} from './routing.js';

export { HooksAdapter } from './hooks.js';
export type { ToolDefinition, HooksAdapterConfig } from './hooks.js';