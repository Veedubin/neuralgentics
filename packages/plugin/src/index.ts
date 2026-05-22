/**
 * Neuralgentics — Plugin Entry Point
 *
 * OpenCode plugin that registers hooks for:
 * 1. Compaction → memory backup via MemoryAdapter
 * 2. Tool execution → routing validation (before) + context save (after)
 * 3. System prompt → inject AGENTS.md content
 *
 * NO MCP IMPORTS. All memory communication via HTTP JSON.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MemoryAdapter } from './adapters/memory.js';
import { validateRouting } from '@neuralgentics/orchestrator';
import type { TaskType, AgentRole } from '@neuralgentics/orchestrator/types';

// ============================================================================
// Plugin Types (local — no external SDK dependency at compile time)
// ============================================================================

/** Hook context provided by OpenCode at registration time */
export interface PluginContext {
  /** Register a hook for a specific lifecycle event */
  on(event: string, handler: HookHandler): void;
  /** Plugin configuration from opencode.json */
  config?: Record<string, unknown>;
}

/** Generic hook handler */
export type HookHandler = (payload: unknown) => Promise<unknown> | unknown;

/** Compaction hook payload */
interface CompactionPayload {
  sessionId: string;
  messages: Array<{ role: string; content: string }>;
  metadata?: Record<string, unknown>;
}

/** Tool execution before payload */
interface ToolBeforePayload {
  toolName: string;
  agentName: string;
  taskType: string;
  arguments: Record<string, unknown>;
}

/** Tool execution after payload */
interface ToolAfterPayload {
  toolName: string;
  agentName: string;
  result: unknown;
  durationMs?: number;
}

/** System prompt transform payload */
interface SystemTransformPayload {
  systemPrompt: string;
  sessionId?: string;
}

// ============================================================================
// Plugin Registration
// ============================================================================

let memory: MemoryAdapter;
let agentsMdContent: string | null = null;

/**
 * Initialize and register the Neuralgentics plugin with OpenCode.
 *
 * This is the entry point called by OpenCode when loading the plugin.
 */
export async function register(ctx: PluginContext): Promise<void> {
  const baseUrl = (ctx.config?.memoryBaseUrl as string) ?? 'http://localhost:8900';
  const skillsDir = (ctx.config?.skillsDir as string) ?? resolve(process.cwd(), 'skills');

  memory = new MemoryAdapter({ baseUrl });

  // Load AGENTS.md at registration time
  const agentsMdPath = (ctx.config?.agentsMdPath as string) ?? resolve(process.cwd(), 'AGENTS.md');
  try {
    agentsMdContent = await readFile(agentsMdPath, 'utf-8');
  } catch {
    console.warn('[Neuralgentics] AGENTS.md not found at:', agentsMdPath);
  }

  // -------------------------------------------------------------------------
  // Hook 1: Compaction → backup conversation to memory
  // -------------------------------------------------------------------------
  ctx.on('experimental.session.compacting', async (payload: unknown) => {
    const { sessionId, messages } = payload as CompactionPayload;
    if (!sessionId || !messages?.length) return;

    try {
      const conversationText = messages
        .map((m) => `${m.role}: ${m.content}`)
        .join('\n');

      const memoryId = await memory.addMemory(conversationText, {
        type: 'compaction-backup',
        sessionId,
        timestamp: new Date().toISOString(),
      });

      console.log(`[Neuralgentics] Compaction backup saved: ${memoryId}`);
    } catch (err) {
      console.warn('[Neuralgentics] Compaction backup failed:', err);
    }
  });

  // -------------------------------------------------------------------------
  // Hook 2: Tool execute before → validate routing
  // -------------------------------------------------------------------------
  ctx.on('tool.execute.before', (payload: unknown) => {
    const { toolName, agentName, taskType } = payload as ToolBeforePayload;
    if (!taskType || !agentName) return payload;

    const validation = validateRouting(taskType as TaskType, agentName as AgentRole);
    if (!validation.valid && validation.violation) {
      console.warn(`[Neuralgentics] ROUTING BLOCKED: ${validation.violation}`);
      // Return modified payload or throw to block execution
      throw new Error(`Routing violation: ${validation.violation}`);
    }

    return payload;
  });

  // -------------------------------------------------------------------------
  // Hook 3: Tool execute after → save context to memory
  // -------------------------------------------------------------------------
  ctx.on('tool.execute.after', async (payload: unknown) => {
    const { agentName, result, durationMs } = payload as ToolAfterPayload;
    if (!agentName || !result) return payload;

    try {
      const summary = typeof result === 'string'
        ? result
        : JSON.stringify(result).slice(0, 2000);

      await memory.addMemory(summary, {
        type: 'tool-result',
        agent: agentName,
        durationMs: durationMs ?? 0,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.warn('[Neuralgentics] Post-tool memory save failed:', err);
    }

    return payload;
  });

  // -------------------------------------------------------------------------
  // Hook 4: System prompt transform → inject AGENTS.md
  // -------------------------------------------------------------------------
  ctx.on('experimental.chat.system.transform', (payload: unknown) => {
    const { systemPrompt } = payload as SystemTransformPayload;
    if (!agentsMdContent) return payload;

    const injected = `${systemPrompt}\n\n---\n## Project Agents (AGENTS.md)\n${agentsMdContent}`;

    const transformed = (payload as Record<string, unknown>) ?? {};
    return { ...transformed, systemPrompt: injected } as SystemTransformPayload;
  });

  console.log('[Neuralgentics] Plugin registered with hooks:');
  console.log('  - experimental.session.compacting (memory backup)');
  console.log('  - tool.execute.before (routing validation)');
  console.log('  - tool.execute.after (context save)');
  console.log('  - experimental.chat.system.transform (AGENTS.md injection)');
  console.log(`  - Memory server: ${baseUrl}`);
}

/**
 * Get the shared MemoryAdapter instance (for orchestrator access).
 */
export function getMemoryAdapter(): MemoryAdapter {
  return memory;
}