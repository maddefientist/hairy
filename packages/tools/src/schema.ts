import type { ZodSchema } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Thrown when a tool's Zod parameter schema cannot be converted into a valid
 * JSON Schema tool-call definition. Always names the offending tool so the
 * failure is actionable in logs/startup errors.
 */
export class ToolSchemaConversionError extends Error {
  constructor(
    public readonly toolName: string,
    cause: unknown,
  ) {
    super(
      `Failed to convert parameters schema for tool "${toolName}" to JSON Schema: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "ToolSchemaConversionError";
  }
}

/**
 * Convert a tool's Zod parameter schema into a JSON Schema object suitable for
 * an LLM tool-call definition (top-level object type, enums, arrays, nested
 * objects, defaults, optional/nullable fields, and literal unions all preserved).
 *
 * Fails closed: throws a ToolSchemaConversionError (naming the tool) instead
 * of silently substituting an empty-object schema. A tool the LLM cannot
 * validly call is worse than a startup/registration failure that names the
 * broken tool, since a silently-empty schema lets the LLM call the tool with
 * arbitrary unvalidated arguments.
 */
export const toolParametersToJsonSchema = (
  parameters: ZodSchema,
  toolName: string,
): Record<string, unknown> => {
  let convertedWithMeta: Record<string, unknown>;
  try {
    convertedWithMeta = zodToJsonSchema(parameters, {
      name: undefined,
      target: "jsonSchema7",
      $refStrategy: "none",
    }) as Record<string, unknown>;
  } catch (cause) {
    throw new ToolSchemaConversionError(toolName, cause);
  }

  // zod-to-json-schema emits a top-level $schema key we don't want on a
  // per-tool parameter schema.
  const { $schema: _schema, ...converted } = convertedWithMeta;

  if (converted.type !== "object") {
    // Tool parameter schemas must be JSON objects for function-calling APIs.
    throw new ToolSchemaConversionError(
      toolName,
      new Error(
        `top-level parameter schema must be a JSON object type, got "${String(converted.type)}"`,
      ),
    );
  }

  if (!("properties" in converted)) {
    converted.properties = {};
  }
  if (!("required" in converted)) {
    converted.required = [];
  }

  return converted;
};
