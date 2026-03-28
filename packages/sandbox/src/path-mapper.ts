import { resolve } from "node:path";
import type { PathMapping } from "./types.js";

/**
 * Maps virtual paths (what the agent sees) to physical paths (real filesystem)
 * and enforces that no path escapes its sandbox boundary.
 */
export class PathMapper {
  private readonly mappings: ReadonlyArray<PathMapping>;

  constructor(mappings: PathMapping[]) {
    // Normalize: resolve physical paths, strip trailing slashes from virtual
    this.mappings = mappings.map((m) => ({
      virtual: m.virtual.replace(/\/+$/, ""),
      physical: resolve(m.physical),
    }));
  }

  /**
   * Convert a virtual path to its physical equivalent.
   * Throws if the virtual path does not match any mapping or escapes the sandbox.
   */
  toPhysical(virtualPath: string): string {
    const normalized = virtualPath.replace(/\/+$/, "");

    for (const mapping of this.mappings) {
      if (normalized === mapping.virtual || normalized.startsWith(`${mapping.virtual}/`)) {
        const relative = normalized.slice(mapping.virtual.length);
        const physical = resolve(mapping.physical, `.${relative}`);

        // Guard against path traversal: resolved path must stay within mapping root
        if (!this.isWithin(mapping.physical, physical)) {
          throw new PathTraversalError(
            `path traversal blocked: '${virtualPath}' resolves outside sandbox boundary`,
          );
        }

        return physical;
      }
    }

    const knownPrefixes = this.mappings.map((m) => m.virtual).join(", ");
    throw new UnknownVirtualPathError(
      `unknown virtual path: '${virtualPath}' does not match any mapping (known: ${knownPrefixes})`,
    );
  }

  /**
   * Convert a physical path back to its virtual equivalent.
   * Returns null if the physical path is not within any mapping.
   */
  toVirtual(physicalPath: string): string | null {
    const resolved = resolve(physicalPath);

    for (const mapping of this.mappings) {
      if (this.isWithin(mapping.physical, resolved)) {
        const relative = resolved.slice(mapping.physical.length);
        return `${mapping.virtual}${relative}`;
      }
    }

    return null;
  }

  /**
   * Check whether a physical path falls within any allowed mapping.
   */
  isAllowed(physicalPath: string): boolean {
    const resolved = resolve(physicalPath);

    for (const mapping of this.mappings) {
      if (this.isWithin(mapping.physical, resolved)) {
        return true;
      }
    }

    return false;
  }

  private isWithin(base: string, target: string): boolean {
    const normalizedBase = resolve(base);
    const normalizedTarget = resolve(target);
    return normalizedTarget === normalizedBase || normalizedTarget.startsWith(`${normalizedBase}/`);
  }
}

export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathTraversalError";
  }
}

export class UnknownVirtualPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownVirtualPathError";
  }
}
