import { describe, test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Load package.json synchronously to avoid dynamic import issues
const pkgPath = join(import.meta.dir, "../../package.json")
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))

describe("@neuralgentics/tui setup verification", () => {
  test("package.json has correct name and version", () => {
    expect(pkg.name).toBe("@neuralgentics/tui")
    expect(pkg.version).toBe("0.1.3")
  })

  test("package.json has no blessed dependency", () => {
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
    for (const key of Object.keys(allDeps)) {
      expect(key.toLowerCase()).not.toContain("blessed")
    }
  })

  test("@opentui/core is a dependency", () => {
    expect(pkg.dependencies["@opentui/core"]).toBeDefined()
  })

  test("Zig binary is available in PATH", async () => {
    const proc = Bun.spawn(["zig", "version"])
    await proc.exited
    expect(proc.exitCode).toBe(0)
  })

  test("Bun version meets minimum requirement", () => {
    const [major, minor] = Bun.version.split(".").map(Number)
    expect(major).toBeGreaterThan(0)
    // Bun >= 1.3.0 required
    expect(major * 100 + minor).toBeGreaterThanOrEqual(103)
  })
})