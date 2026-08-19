import { MEMORY_TYPES } from "@hairyclaw/memory";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolSchemaConversionError, toolParametersToJsonSchema } from "../src/schema.js";

describe("toolParametersToJsonSchema", () => {
  it("produces a top-level object schema with properties and required", () => {
    const schema = z.object({
      name: z.string(),
      age: z.number().optional(),
    });

    const json = toolParametersToJsonSchema(schema, "test");
    expect(json.type).toBe("object");
    expect(json.properties).toMatchObject({
      name: { type: "string" },
      age: { type: "number" },
    });
    expect(json.required).toEqual(["name"]);
  });

  it("preserves enums", () => {
    const schema = z.object({ action: z.enum(["set", "list", "cancel"]) });
    const json = toolParametersToJsonSchema(schema, "test") as {
      properties: { action: { enum: string[] } };
    };
    expect(json.properties.action.enum).toEqual(["set", "list", "cancel"]);
  });

  it("preserves array item types", () => {
    const schema = z.object({ tags: z.array(z.string().min(1).max(64)).max(20).optional() });
    const json = toolParametersToJsonSchema(schema, "test") as {
      properties: { tags: { type: string; items: { type: string } } };
    };
    expect(json.properties.tags.type).toBe("array");
    expect(json.properties.tags.items.type).toBe("string");
  });

  it("preserves defaults", () => {
    const schema = z.object({ mode: z.string().default("readable") });
    const json = toolParametersToJsonSchema(schema, "test") as {
      properties: { mode: { default?: string } };
    };
    expect(json.properties.mode.default).toBe("readable");
  });

  it("preserves optional fields as not-required rather than dropping type info", () => {
    const schema = z.object({ url: z.string().optional() });
    const json = toolParametersToJsonSchema(schema, "test") as {
      properties: { url: { type: string } };
      required: string[];
    };
    expect(json.properties.url.type).toBe("string");
    expect(json.required).toEqual([]);
  });

  it("preserves nullable values", () => {
    const schema = z.object({ score: z.number().nullable() });
    const json = toolParametersToJsonSchema(schema, "test") as {
      properties: { score: { type: string[] | string } };
    };
    // zod-to-json-schema (jsonSchema7 target) encodes nullable as a type union
    const type = json.properties.score.type;
    const types = Array.isArray(type) ? type : [type];
    expect(types).toContain("number");
    expect(types).toContain("null");
  });

  it("preserves nested objects", () => {
    const schema = z.object({
      location: z.object({
        lat: z.number(),
        lng: z.number(),
      }),
    });
    const json = toolParametersToJsonSchema(schema, "test") as {
      properties: { location: { type: string; properties: Record<string, unknown> } };
    };
    expect(json.properties.location.type).toBe("object");
    expect(Object.keys(json.properties.location.properties)).toEqual(["lat", "lng"]);
  });

  it("preserves literal unions", () => {
    const schema = z.object({ kind: z.union([z.literal("a"), z.literal("b"), z.literal("c")]) });
    const json = toolParametersToJsonSchema(schema, "test") as {
      properties: { kind: { enum: string[] } };
    };
    expect(json.properties.kind.enum.sort()).toEqual(["a", "b", "c"]);
  });

  it("converts the real memory_ingest schema (enum, arrays, optionals) correctly", () => {
    const memoryIngestSchema = z.object({
      content: z.string().min(1).max(20000),
      tags: z.array(z.string().min(1).max(64)).max(20).optional(),
      memory_type: z.enum(MEMORY_TYPES).optional(),
      extraction_source: z.string().max(256).optional(),
    });

    const json = toolParametersToJsonSchema(memoryIngestSchema, "memory_ingest") as {
      type: string;
      properties: Record<string, { type?: string; enum?: string[] }>;
      required: string[];
    };

    expect(json.type).toBe("object");
    expect(json.properties.content.type).toBe("string");
    expect(json.properties.tags.type).toBe("array");
    expect(json.properties.memory_type.enum).toEqual([...MEMORY_TYPES]);
    expect(json.required).toEqual(["content"]);
  });

  it("converts the browser tool action schema (enum discriminator)", () => {
    const browserActionSchema = z.object({
      action: z.enum(["navigate", "screenshot", "click", "type", "evaluate"]),
      url: z.string().optional(),
      selector: z.string().optional(),
      text: z.string().optional(),
      script: z.string().optional(),
    });

    const json = toolParametersToJsonSchema(browserActionSchema, "browser") as {
      properties: { action: { enum: string[] } };
      required: string[];
    };
    expect(json.properties.action.enum).toEqual([
      "navigate",
      "screenshot",
      "click",
      "type",
      "evaluate",
    ]);
    expect(json.required).toEqual(["action"]);
  });

  it("converts the reminder tool schema (multiple optional describe()d fields)", () => {
    const reminderInputSchema = z.object({
      action: z.enum(["set", "list", "cancel"]),
      message: z.string().optional(),
      time: z.string().optional(),
      recurring: z.boolean().optional(),
      id: z.string().optional(),
    });

    const json = toolParametersToJsonSchema(reminderInputSchema, "reminder") as {
      properties: Record<string, { type?: string }>;
      required: string[];
    };
    expect(json.properties.recurring.type).toBe("boolean");
    expect(json.required).toEqual(["action"]);
  });

  it("converts the web_fetch schema (url format, coerced number)", () => {
    const fetchInputSchema = z.object({
      url: z.string().url(),
      mode: z.enum(["readable", "raw", "markdown"]).optional(),
      maxLength: z.coerce.number().int().positive().max(100_000).optional(),
    });

    const json = toolParametersToJsonSchema(fetchInputSchema, "web-fetch") as {
      properties: { url: { type: string }; mode: { enum: string[] } };
      required: string[];
    };
    expect(json.properties.url.type).toBe("string");
    expect(json.properties.mode.enum).toEqual(["readable", "raw", "markdown"]);
    expect(json.required).toEqual(["url"]);
  });

  it("converts the chain tool schema (enum + bounded string)", () => {
    const chainArgsSchema = z.object({
      chain: z.enum(["build", "design", "document", "implement", "qlt"]),
      task: z.string().min(1).max(20_000),
    });

    const json = toolParametersToJsonSchema(chainArgsSchema, "run_chain") as {
      properties: { chain: { enum: string[] }; task: { type: string } };
      required: string[];
    };
    expect(json.properties.chain.enum).toEqual(["build", "design", "document", "implement", "qlt"]);
    expect(json.properties.task.type).toBe("string");
    expect(json.required.sort()).toEqual(["chain", "task"]);
  });

  it("fails closed with an actionable error naming the tool instead of silently falling back on a non-object top-level schema", () => {
    expect(() => toolParametersToJsonSchema(z.string(), "weird")).toThrow(
      ToolSchemaConversionError,
    );
    expect(() => toolParametersToJsonSchema(z.string(), "weird")).toThrow(/weird/);
  });

  it("fails closed with an actionable error naming the tool when the underlying converter throws", () => {
    const throwing = {
      _def: {},
      parse: () => {
        throw new Error("not a real zod schema");
      },
    } as unknown as z.ZodSchema;

    expect(() => toolParametersToJsonSchema(throwing, "broken_tool")).toThrow(
      ToolSchemaConversionError,
    );
    expect(() => toolParametersToJsonSchema(throwing, "broken_tool")).toThrow(/broken_tool/);
  });
});
