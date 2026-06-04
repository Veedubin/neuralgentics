/**
 * OpenCode SDK Client Tests (T-023)
 *
 * Tests the OpenCodeClient class without spawning a real OpenCode server.
 * Uses mock sockets and TCP responses to simulate server state.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import {
  OpenCodeClient,
  PortConflictError,
  OpenCodeStartError,
  type OpenCodeStatus,
} from "../opencode-client/index.js";

/**
 * Test helper: create a TCP server that simulates an OpenCode port-conflict
 * by immediately closing connections (mimicking "address already in use").
 */
function createPortConflictServer(port: number): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((socket: Socket) => {
      socket.destroy();
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

/** Test helper: close a server */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("OpenCodeClient — port conflict detection", () => {
  let conflictServer: Server | null = null;

  afterEach(async () => {
    if (conflictServer) await closeServer(conflictServer);
    conflictServer = null;
  });

  test("PortConflictError extends Error", () => {
    const err = new PortConflictError(4096);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PortConflictError");
    expect(err.port).toBe(4096);
  });

  test("OpenCodeStartError extends Error", () => {
    const err = new OpenCodeStartError("test");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("OpenCodeStartError");
  });

  test("PortConflictError has descriptive message with port", () => {
    const err = new PortConflictError(4096);
    expect(err.message).toContain("4096");
  });
});

describe("OpenCodeClient — status state machine", () => {
  test("initial status is offline (no autoStart)", () => {
    const client = new OpenCodeClient({ port: 4096, autoStart: false });
    expect(client.status).toBe<OpenCodeStatus>("offline");
  });

  test("isDegraded is false when offline", () => {
    const client = new OpenCodeClient({ port: 4096, autoStart: false });
    expect(client.isDegraded).toBe(false);
  });

  test("isReady is false when offline", () => {
    const client = new OpenCodeClient({ port: 4096, autoStart: false });
    expect(client.isReady).toBe(false);
  });
});

describe("OpenCodeClient — shutdown", () => {
  test("shutdown() on a never-started client is a no-op", async () => {
    const client = new OpenCodeClient({ port: 4096, autoStart: false });
    // Should not throw
    await client.shutdown();
    expect(client.status).toBe<OpenCodeStatus>("offline");
  });

  test("registerShutdownHandlers() does not throw", () => {
    const client = new OpenCodeClient({ port: 4096, autoStart: false });
    // Should not throw
    expect(() => client.registerShutdownHandlers()).not.toThrow();
  });
});

describe("OpenCodeClient — event subscription", () => {
  test("on() returns this for chaining", () => {
    const client = new OpenCodeClient({ port: 4096, autoStart: false });
    const result = client.on("statusChange", () => {});
    expect(result).toBe(client);
  });
});
