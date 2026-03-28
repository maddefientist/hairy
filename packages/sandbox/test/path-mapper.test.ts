import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PathMapper, PathTraversalError, UnknownVirtualPathError } from "../src/path-mapper.js";

describe("PathMapper", () => {
  const baseDir = "/tmp/sandbox-test";
  const mapper = new PathMapper([
    { virtual: "/workspace", physical: `${baseDir}/workspace` },
    { virtual: "/uploads", physical: `${baseDir}/uploads` },
    { virtual: "/outputs", physical: `${baseDir}/outputs` },
  ]);

  it("maps virtual to physical for root of mapping", () => {
    expect(mapper.toPhysical("/workspace")).toBe(resolve(`${baseDir}/workspace`));
    expect(mapper.toPhysical("/uploads")).toBe(resolve(`${baseDir}/uploads`));
    expect(mapper.toPhysical("/outputs")).toBe(resolve(`${baseDir}/outputs`));
  });

  it("maps virtual to physical for nested paths", () => {
    expect(mapper.toPhysical("/workspace/src/index.ts")).toBe(
      resolve(`${baseDir}/workspace/src/index.ts`),
    );
    expect(mapper.toPhysical("/uploads/image.png")).toBe(resolve(`${baseDir}/uploads/image.png`));
  });

  it("maps physical back to virtual", () => {
    const physical = resolve(`${baseDir}/workspace/src/index.ts`);
    expect(mapper.toVirtual(physical)).toBe("/workspace/src/index.ts");
  });

  it("returns null for physical paths outside any mapping", () => {
    expect(mapper.toVirtual("/etc/passwd")).toBeNull();
    expect(mapper.toVirtual("/tmp/other/file.txt")).toBeNull();
  });

  it("throws PathTraversalError on directory traversal", () => {
    expect(() => mapper.toPhysical("/workspace/../../etc/passwd")).toThrow(PathTraversalError);
    expect(() => mapper.toPhysical("/workspace/../../../etc/shadow")).toThrow(PathTraversalError);
    expect(() => mapper.toPhysical("/uploads/../workspace/../../../root")).toThrow(
      PathTraversalError,
    );
  });

  it("throws UnknownVirtualPathError for unknown virtual paths", () => {
    expect(() => mapper.toPhysical("/unknown/file.txt")).toThrow(UnknownVirtualPathError);
    expect(() => mapper.toPhysical("/etc/passwd")).toThrow(UnknownVirtualPathError);
    expect(() => mapper.toPhysical("relative/path")).toThrow(UnknownVirtualPathError);
  });

  it("handles multiple mappings correctly", () => {
    expect(mapper.toPhysical("/workspace/a.txt")).toBe(resolve(`${baseDir}/workspace/a.txt`));
    expect(mapper.toPhysical("/uploads/b.txt")).toBe(resolve(`${baseDir}/uploads/b.txt`));
    expect(mapper.toPhysical("/outputs/c.txt")).toBe(resolve(`${baseDir}/outputs/c.txt`));
  });

  it("normalizes trailing slashes on virtual paths", () => {
    expect(mapper.toPhysical("/workspace/")).toBe(resolve(`${baseDir}/workspace`));
    expect(mapper.toPhysical("/uploads/")).toBe(resolve(`${baseDir}/uploads`));
  });

  it("isAllowed returns true for paths within mappings", () => {
    expect(mapper.isAllowed(resolve(`${baseDir}/workspace/file.txt`))).toBe(true);
    expect(mapper.isAllowed(resolve(`${baseDir}/uploads/image.png`))).toBe(true);
  });

  it("isAllowed returns false for paths outside mappings", () => {
    expect(mapper.isAllowed("/etc/passwd")).toBe(false);
    expect(mapper.isAllowed("/tmp/other")).toBe(false);
  });

  it("handles virtual paths that are substrings of other mappings", () => {
    // "/workspace-extra" should NOT match "/workspace"
    const mapperSingle = new PathMapper([
      { virtual: "/workspace", physical: `${baseDir}/workspace` },
    ]);
    expect(() => mapperSingle.toPhysical("/workspace-extra/file.txt")).toThrow(
      UnknownVirtualPathError,
    );
  });
});
