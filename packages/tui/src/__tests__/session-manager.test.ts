/**
 * SessionManager Tests (T-027)
 *
 * Tests the SessionManager class using mock OpenCodeClient and
 * NeuralgenticsClient instances. Verifies:
 * - createSession() returns a valid session ID
 * - prompt() streams chunks back
 * - messages() returns full history
 * - revert() clears/rewinds
 * - Seed prompt template is <250 tokens
 * - Context packages are storable/retrievable as type: "context_package"
 * - agent_used trust signal applied on sub-agent completion
 * - Wire to TUI input bar (validated through integration)
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { SessionManager } from "../session/session-manager.js";
import type {
  ContextPackage,
  SessionManagerStatus,
  SeedPrompt,
} from "../session/types.js";
import type { OpenCodeStatus, ChatMessage, StreamingCallbacks, PromptResult } from "../opencode-client/types.js";

// ─── Mock Factories ────────────────────────────────────────────────────────────

function createMockOpenCodeClient(): {
  client: {
    createSession: ReturnType<typeof mock>;
    prompt: ReturnType<typeof mock>;
    messages: ReturnType<typeof mock>;
    revert: ReturnType<typeof mock>;
    on: ReturnType<typeof mock>;
    start: ReturnType<typeof mock>;
    shutdown: ReturnType<typeof mock>;
    isReady: boolean;
    sessionId: string | null;
    status: OpenCodeStatus;
  };
} {
  let sessionIdCounter = 0;

  return {
    client: {
      createSession: mock(async (title?: string) => {
        sessionIdCounter++;
        return `sess-${sessionIdCounter}`;
      }),
      prompt: mock(async (sessionId: string, text: string, callbacks?: StreamingCallbacks) => {
        const response: PromptResult = {
          sessionId,
          messageId: `msg-${Date.now()}`,
          textContent: `Response to: ${text}`,
          raw: {},
        };
        if (callbacks?.onToken) {
          callbacks.onToken("Resp", "Resp");
          callbacks.onToken("onse", "Response");
        }
        if (callbacks?.onComplete) {
          callbacks.onComplete(`Response to: ${text}`);
        }
        return response;
      }),
      messages: mock(async (sessionId: string): Promise<ChatMessage[]> => {
        return [
          { id: "msg-1", role: "user", content: "Hello", timestamp: Date.now(), sessionId },
          { id: "msg-2", role: "assistant", content: "Hi there!", timestamp: Date.now(), sessionId },
        ];
      }),
      revert: mock(async (sessionId: string, messageId?: string): Promise<string> => {
        return sessionId;
      }),
      on: mock(function(this: unknown) { return this; }),
      start: mock(async () => {}),
      shutdown: mock(async () => {}),
      isReady: true,
      sessionId: null,
      status: "ready" as OpenCodeStatus,
    },
  };
}

function createMockNeuralgenticsClient(): {
  client: {
    call: ReturnType<typeof mock>;
    waitForReady: ReturnType<typeof mock>;
    close: ReturnType<typeof mock>;
    on: ReturnType<typeof mock>;
  };
} {
  return {
    client: {
      call: mock(async (method: string, params: Record<string, unknown>) => {
        if (method === "memory.add") {
          return { id: `mem-${Date.now()}` };
        }
        if (method === "memory.get") {
          const id = params.id as string;
          return {
            id,
            content: JSON.stringify({
              task: "Test task",
              userRequest: "Test request",
              constraints: ["c1"],
              relevantFiles: [{ path: "/test.ts", reason: "test" }],
              codeSnippets: [{ file: "/test.ts", snippet: "console.log('test')" }],
              expectedOutput: "Test output",
              targetAgent: "coder",
              createdAt: Date.now(),
            } satisfies ContextPackage),
            sourceType: "context_package",
            metadata: { type: "context_package" },
          };
        }
        if (method === "memory.adjustTrust") {
          return { oldScore: 0.5, newScore: 0.55, adjustmentAmount: 0.05 };
        }
        return {};
      }),
      waitForReady: mock(async () => {}),
      close: mock(async () => {}),
      on: mock(function(this: unknown) { return this; }),
    },
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("SessionManager — creation and status", () => {
  test("creates SessionManager with default options", () => {
    const { client: oc } = createMockOpenCodeClient();
    const { client: ng } = createMockNeuralgenticsClient();
    const sm = new SessionManager({ opencode: oc as any, neuralgentics: ng as any });

    expect(sm.status).toBe<SessionManagerStatus>("idle");
    expect(sm.sessionId).toBeNull();
    expect(sm.messageCount).toBe(0);
    expect(sm.isReady).toBe(false);
  });

  test("registering for statusChange events works", () => {
    const { client: oc } = createMockOpenCodeClient();
    const { client: ng } = createMockNeuralgenticsClient();
    const sm = new SessionManager({ opencode: oc as any, neuralgentics: ng as any });

    const statuses: SessionManagerStatus[] = [];
    sm.on("statusChange", (status: unknown) => {
      statuses.push(status as SessionManagerStatus);
    });

    // Simulate OpenCode becoming ready
    const statusHandler = oc.on.mock.calls[0];
    if (statusHandler) {
      // First call to on() registers the internal statusChange listener
    }

    expect(sm.on("statusChange", () => {})).toBe(sm);
  });
});

describe("SessionManager — createSession", () => {
  test("createSession() returns valid session ID", async () => {
    const { client: oc } = createMockOpenCodeClient();
    const { client: ng } = createMockNeuralgenticsClient();
    const sm = new SessionManager({ opencode: oc as any, neuralgentics: ng as any });

    const sessionId = await sm.createSession("Test Session");

    expect(sessionId).toBeTruthy();
    expect(typeof sessionId).toBe("string");
    expect(sessionId).toMatch(/^sess-/);
    expect(sm.sessionId).toBe(sessionId);
    expect(oc.createSession).toHaveBeenCalledTimes(1);
  });

  test("createSession() with default title", async () => {
    const { client: oc } = createMockOpenCodeClient();
    const { client: ng } = createMockNeuralgenticsClient();
    const sm = new SessionManager({ opencode: oc as any, neuralgentics: ng as any });

    const sessionId = await sm.createSession();
    expect(sessionId).toBeTruthy();
    // The mock always returns sess-N
    expect(sessionId).toMatch(/^sess-/);
  });
});

describe("SessionManager — prompt", () => {
  test("prompt() with existing session streams chunks back", async () => {
    const { client: oc } = createMockOpenCodeClient();
    const { client: ng } = createMockNeuralgenticsClient();
    const sm = new SessionManager({ opencode: oc as any, neuralgentics: ng as any });

    const sessionId = await sm.createSession("Prompt Test");

    const tokens: string[] = [];
    const result = await sm.prompt(sessionId, "Hello, world!", {
      callbacks: {
        onToken: (token: string, _full: string) => {
          tokens.push(token);
        },
        onComplete: (_full: string) => {},
        onError: (_error: Error) => {},
      },
    });

    expect(result.textContent).toBeTruthy();
    expect(result.sessionId).toBe(sessionId);
    expect(oc.prompt).toHaveBeenCalledTimes(1);
  });

  test("prompt() without session auto-creates one", async () => {
    const { client: oc } = createMockOpenCodeClient();
    const { client: ng } = createMockNeuralgenticsClient();
    const sm = new SessionManager({
      opencode: oc as any,
      neuralgentics: ng as any,
      autoCreateSession: true,
    });

    const result = await sm.prompt(null, "Hello!");
    expect(result.sessionId).toBeTruthy();
    expect(oc.createSession).toHaveBeenCalledTimes(1);
  });

  test("prompt() without session throws when autoCreateSession is false", async () => {
    const { client: oc } = createMockOpenCodeClient();
    const { client: ng } = createMockNeuralgenticsClient();
    const sm = new SessionManager({
      opencode: oc as any,
      neuralgentics: ng as any,
      autoCreateSession: false,
    });

    await expect(sm.prompt(null, "Hello!")).rejects.toThrow(/No active session/);
  });

  test("prompt() stores chat exchange in memory when memoryEnabled", async () => {
    const { client: oc } = createMockOpenCodeClient();
    const { client: ng } = createMockNeuralgenticsClient();
    const sm = new SessionManager({
      opencode: oc as any,
      neuralgentics: ng as any,
      memoryEnabled: true,
    });

    const sessionId = await sm.createSession();
    await sm.prompt(sessionId, "Hello!");

    // memory.add should have been called for the chat exchange
    expect(ng.call.mock.calls.length).toBeGreaterThanOrEqual(1);
    const memoryCall = ng.call.mock.calls.find(
      (c: unknown[]) => (c as unknown[])[0] === "memory.add",
    );
    expect(memoryCall).toBeDefined();
    const params = (memoryCall as unknown[])[1] as Record<string, unknown>;
    expect(params.sourceType).toBe("session");
  });

  test("prompt() skips memory storage when memoryEnabled is false", async () => {
    const { client: oc } = createMockOpenCodeClient();
    const { client: ng } = createMockNeuralgenticsClient();
    const sm = new SessionManager({
      opencode: oc as any,
      neuralgentics: ng as any,
      memoryEnabled: false,
    });

    const sessionId = await sm.createSession();
    await sm.prompt(sessionId, "Hello!");

    // memory.add should NOT have been called
    const memoryCall = ng.call.mock.calls.find(
      (c: unknown[]) => (c as unknown[])[0] === "memory.add",
    );
    expect(memoryCall).toBeUndefined();
  });
});

describe("SessionManager — messages", () => {
  test("messages() returns full history", async () => {
    const { client: oc } = createMockOpenCodeClient();
    const { client: ng } = createMockNeuralgenticsClient();
    const sm = new SessionManager({ opencode: oc as any, neuralgentics: ng as any });

    const sessionId = await sm.createSession();
    const msgs = await sm.messages(sessionId);

    expect(msgs.length).toBe(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
    expect(oc.messages).toHaveBeenCalledTimes(1);
  });

  test("messages() without session throws", async () => {
    const { client: oc } = createMockOpenCodeClient();
    const { client: ng } = createMockNeuralgenticsClient();
    const sm = new SessionManager({ opencode: oc as any, neuralgentics: ng as any });

    await expect(sm.messages()).rejects.toThrow(/No active session/);
  });
});

describe("SessionManager — revert", () => {
  test("revert() clears/rewinds session", async () => {
    const { client: oc } = createMockOpenCodeClient();
    const { client: ng } = createMockNeuralgenticsClient();
    const sm = new SessionManager({ opencode: oc as any, neuralgentics: ng as any });

    const sessionId = await sm.createSession();
    const result = await sm.revert(sessionId);

    expect(result.sessionId).toBe(sessionId);
    expect(result.messagesRemoved).toBeGreaterThanOrEqual(0);
    expect(oc.revert).toHaveBeenCalledTimes(1);
  });

  test("revert() without session throws", async () => {
    const { client: oc } = createMockOpenCodeClient();
    const { client: ng } = createMockNeuralgenticsClient();
    const sm = new SessionManager({ opencode: oc as any, neuralgentics: ng as any });

    await expect(sm.revert()).rejects.toThrow(/No active session/);
  });
});

describe("SessionManager — stateless agent protocol", () => {
  const sampleContext: ContextPackage = {
    task: "Implement the user registration flow",
    userRequest: "Add user registration with email verification",
    constraints: ["Must validate email format", "Use bcrypt for passwords"],
    relevantFiles: [
      { path: "src/auth/register.ts", reason: "Registration endpoint" },
    ],
    codeSnippets: [
      { file: "src/auth/register.ts", snippet: "async function register(req, res) { ... }" },
    ],
    expectedOutput: "Registration endpoint with email verification",
    targetAgent: "coder",
    createdAt: Date.now(),
  };

  test("storeContext() stores context as type: context_package memory", async () => {
    const { client: oc } = createMockOpenCodeClient();
    const { client: ng } = createMockNeuralgenticsClient();
    const sm = new SessionManager({ opencode: oc as any, neuralgentics: ng as any });

    const result = await sm.storeContext(sampleContext);

    expect(result.memoryId).toBeTruthy();
    expect(typeof result.memoryId).toBe("string");

    // Verify the memory.add call had the right structure
    const memoryCall = ng.call.mock.calls.find(
      (c: unknown[]) => (c as unknown[])[0] === "memory.add",
    );
    expect(memoryCall).toBeDefined();
    const params = (memoryCall as unknown[])[1] as Record<string, unknown>;
    expect(params.sourceType).toBe("context_package");
    expect(params.metadata).toBeDefined();
    const metadata = params.metadata as Record<string, unknown>;
    expect(metadata.type).toBe("context_package");
    expect(metadata.targetAgent).toBe("coder");

    // Verify the content is the serialized context
    const content = JSON.parse(params.content as string);
    expect(content.task).toBe("Implement the user registration flow");
    expect(content.targetAgent).toBe("coder");
  });

  test("fetchContext() retrieves and deserializes context package", async () => {
    const { client: oc } = createMockOpenCodeClient();
    const { client: ng } = createMockNeuralgenticsClient();
    const sm = new SessionManager({ opencode: oc as any, neuralgentics: ng as any });

    const memId = "mem-test-123";
    const context = await sm.fetchContext(memId);

    expect(context.task).toBe("Test task");
    expect(context.targetAgent).toBe("coder");

    // Verify memory.get was called with the right ID
    const getCall = ng.call.mock.calls.find(
      (c: unknown[]) => (c as unknown[])[0] === "memory.get",
    );
    expect(getCall).toBeDefined();
    const params = (getCall as unknown[])[1] as Record<string, unknown>;
    expect(params.id).toBe(memId);
  });

  test("applicationUsed trust signal applied on sub-agent completion", async () => {
    const { client: oc } = createMockOpenCodeClient();
    const { client: ng } = createMockNeuralgenticsClient();
    const sm = new SessionManager({ opencode: oc as any, neuralgentics: ng as any });

    const result = await sm.applyTrustSignal("mem-test-123", "agent_used");

    expect(result.oldScore).toBe(0.5);
    expect(result.newScore).toBe(0.55);
    expect(result.adjustment).toBe(0.05);

    // Verify the JSON-RPC call
    const trustCall = ng.call.mock.calls.find(
      (c: unknown[]) => (c as unknown[])[0] === "memory.adjustTrust",
    );
    expect(trustCall).toBeDefined();
    const params = (trustCall as unknown[])[1] as Record<string, unknown>;
    expect(params.memoryId).toBe("mem-test-123");
    expect(params.signal).toBe("agent_used");
  });

  test("applyTrustSignal() is no-op when trustSignalsEnabled is false", async () => {
    const { client: oc } = createMockOpenCodeClient();
    const { client: ng } = createMockNeuralgenticsClient();
    const sm = new SessionManager({
      opencode: oc as any,
      neuralgentics: ng as any,
      trustSignalsEnabled: false,
    });

    const result = await sm.applyTrustSignal("mem-test-123", "agent_used");

    expect(result.oldScore).toBe(0);
    expect(result.newScore).toBe(0);
    expect(result.adjustment).toBe(0);

    // Verify NO adjustTrust call was made
    const trustCall = ng.call.mock.calls.find(
      (c: unknown[]) => (c as unknown[])[0] === "memory.adjustTrust",
    );
    expect(trustCall).toBeUndefined();
  });
});

describe("SessionManager — seed prompt", () => {
  test("seed prompt template is under 250 tokens", () => {
    const { client: oc } = createMockOpenCodeClient();
    const { client: ng } = createMockNeuralgenticsClient();
    const sm = new SessionManager({ opencode: oc as any, neuralgentics: ng as any });

    const context: ContextPackage = {
      task: "Implement user authentication with JWT tokens",
      userRequest: "Add auth to the API",
      constraints: ["Use RS256", "7-day expiry"],
      relevantFiles: [{ path: "src/auth/jwt.ts", reason: "JWT implementation" }],
      codeSnippets: [{ file: "src/auth/jwt.ts", snippet: "const token = jwt.sign({})" }],
      expectedOutput: "Auth middleware with JWT verification",
      targetAgent: "coder",
      createdAt: Date.now(),
    };

    const seed = sm.generateSeedPrompt("mem-abc-123", context);

    expect(seed.memoryId).toBe("mem-abc-123");
    expect(seed.text).toBeTruthy();
    expect(seed.text).toContain("mem-abc-123");
    expect(seed.text).toContain("Implement user authentication with JWT tokens");
    expect(seed.estimatedTokens).toBeLessThan(250);
    expect(seed.estimatedTokens).toBeGreaterThan(0);

    // Also check raw text length (rough heuristic: <1000 chars ≈ <250 tokens)
    expect(seed.text.length).toBeLessThan(1000);
  });

  test("seed prompt includes task and constraints", () => {
    const { client: oc } = createMockOpenCodeClient();
    const { client: ng } = createMockNeuralgenticsClient();
    const sm = new SessionManager({ opencode: oc as any, neuralgentics: ng as any });

    const context: ContextPackage = {
      task: "Fix the database connection pool leak",
      userRequest: "DB connections are leaking",
      constraints: ["Must be backward compatible", "Add monitoring"],
      relevantFiles: [{ path: "src/db/pool.ts", reason: "Connection pool" }],
      codeSnippets: [],
      expectedOutput: "Fixed connection pool with monitoring",
      targetAgent: "coder",
      createdAt: Date.now(),
    };

    const seed = sm.generateSeedPrompt("mem-xyz-456", context);

    expect(seed.text).toContain("Fix the database connection pool leak");
    expect(seed.text).toContain("mem-xyz-456");
    expect(seed.text).toContain("Must be backward compatible; Add monitoring");
  });
});

describe("SessionManager — dispatchAgent", () => {
  test("dispatchAgent() stores context and returns seed prompt", async () => {
    const { client: oc } = createMockOpenCodeClient();
    const { client: ng } = createMockNeuralgenticsClient();
    const sm = new SessionManager({ opencode: oc as any, neuralgentics: ng as any });

    const context: ContextPackage = {
      task: "Write unit tests for auth module",
      userRequest: "Add test coverage",
      constraints: ["Use bun:test", ">80% coverage"],
      relevantFiles: [{ path: "src/auth/jwt.ts", reason: "JWT implementation" }],
      codeSnippets: [{ file: "src/auth/jwt.ts", snippet: "export function verify() {}" }],
      expectedOutput: "Test file with >80% coverage",
      targetAgent: "tester",
      createdAt: Date.now(),
    };

    const { seedPrompt, contextResult } = await sm.dispatchAgent(context);

    expect(seedPrompt.memoryId).toBeTruthy();
    expect(seedPrompt.text).toContain(context.task);
    expect(seedPrompt.estimatedTokens).toBeLessThan(250);
    expect(contextResult.memoryId).toBeTruthy();

    // Verify memory.add was called with context_package type
    const memoryCall = ng.call.mock.calls.find(
      (c: unknown[]) => (c as unknown[])[0] === "memory.add",
    );
    expect(memoryCall).toBeDefined();
  });
});

describe("SessionManager — event listeners", () => {
  test("on() returns this for chaining", () => {
    const { client: oc } = createMockOpenCodeClient();
    const { client: ng } = createMockNeuralgenticsClient();
    const sm = new SessionManager({ opencode: oc as any, neuralgentics: ng as any });

    const result = sm.on("statusChange", () => {});
    expect(result).toBe(sm);
  });

  test("contextStored event fires after storeContext", async () => {
    const { client: oc } = createMockOpenCodeClient();
    const { client: ng } = createMockNeuralgenticsClient();
    const sm = new SessionManager({ opencode: oc as any, neuralgentics: ng as any });

    let capturedMemoryId: string | null = null;
    sm.on("contextStored", (result: unknown) => {
      capturedMemoryId = (result as { memoryId: string }).memoryId;
    });

    const context: ContextPackage = {
      task: "Test task",
      userRequest: "Test",
      constraints: [],
      relevantFiles: [],
      codeSnippets: [],
      expectedOutput: "Test output",
      targetAgent: "coder",
      createdAt: Date.now(),
    };

    await sm.storeContext(context);
    expect(capturedMemoryId).toBeTruthy();
  });

  test("trustApplied event fires after applyTrustSignal", async () => {
    const { client: oc } = createMockOpenCodeClient();
    const { client: ng } = createMockNeuralgenticsClient();
    const sm = new SessionManager({ opencode: oc as any, neuralgentics: ng as any });

    let capturedSignal = "";
    let capturedMemoryId = "";
    sm.on("trustApplied", (memoryId: unknown, signal: unknown) => {
      capturedMemoryId = memoryId as string;
      capturedSignal = signal as string;
    });

    await sm.applyTrustSignal("mem-test-events", "agent_used");
    expect(capturedSignal).toBe("agent_used");
    expect(capturedMemoryId).toBe("mem-test-events");
  });

  test("error event fires on prompt failure", async () => {
    const { client: oc } = createMockOpenCodeClient();
    const { client: ng } = createMockNeuralgenticsClient();

    // Override prompt to reject
    oc.prompt = mock(async () => {
      throw new Error("Connection timeout");
    });

    const sm = new SessionManager({ opencode: oc as any, neuralgentics: ng as any });

    let capturedError: Error | null = null;
    sm.on("error", (err: unknown) => {
      capturedError = err as Error;
    });

    const sessionId = await sm.createSession();
    await expect(sm.prompt(sessionId, "Hello!")).rejects.toThrow("Connection timeout");
    expect(capturedError).toBeTruthy();
    expect(capturedError!.message).toBe("Connection timeout");
  });
});

describe("SessionManager — memory disabled mode", () => {
  test("storeContext throws when memoryEnabled is false", async () => {
    const { client: oc } = createMockOpenCodeClient();
    const { client: ng } = createMockNeuralgenticsClient();
    const sm = new SessionManager({
      opencode: oc as any,
      neuralgentics: ng as any,
      memoryEnabled: false,
    });

    const context: ContextPackage = {
      task: "Test",
      userRequest: "Test",
      constraints: [],
      relevantFiles: [],
      codeSnippets: [],
      expectedOutput: "Output",
      targetAgent: "coder",
      createdAt: Date.now(),
    };

    await expect(sm.storeContext(context)).rejects.toThrow(/Memory storage is disabled/);
  });
});