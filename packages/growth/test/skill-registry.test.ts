import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SkillRegistry } from "../src/skill-registry.js";

const tmpDir = () => join(tmpdir(), `hairy-skills-${randomUUID()}`);

describe("SkillRegistry", () => {
  it("creates a skill in draft status", async () => {
    const reg = new SkillRegistry({ dataDir: tmpDir() });
    const skill = await reg.create({
      name: "Test Skill",
      description: "A skill for testing",
      promptFragment: "Always respond in a test-friendly way.",
    });

    expect(skill.status).toBe("draft");
    expect(skill.name).toBe("Test Skill");
    expect(skill.id).toBeTruthy();
  });

  it("retrieves a created skill by id", async () => {
    const reg = new SkillRegistry({ dataDir: tmpDir() });
    const created = await reg.create({
      name: "Retrieval Skill",
      description: "desc",
      promptFragment: "fragment",
    });

    const found = await reg.get(created.id);
    expect(found).not.toBeNull();
    expect(found?.name).toBe("Retrieval Skill");
  });

  it("returns null for nonexistent skill", async () => {
    const reg = new SkillRegistry({ dataDir: tmpDir() });
    const found = await reg.get("nonexistent-id");
    expect(found).toBeNull();
  });

  it("lists all skills, optionally filtered by status", async () => {
    const reg = new SkillRegistry({ dataDir: tmpDir() });
    const s1 = await reg.create({ name: "A", description: "", promptFragment: "" });
    const s2 = await reg.create({ name: "B", description: "", promptFragment: "" });

    // promote s1 to testing
    await reg.promote(s1.id);

    const all = await reg.list();
    expect(all.length).toBe(2);

    const drafts = await reg.list("draft");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.name).toBe("B");

    const testing = await reg.list("testing");
    expect(testing).toHaveLength(1);
    expect(testing[0]?.name).toBe("A");
  });

  it("promotes skill through the full lifecycle", async () => {
    const reg = new SkillRegistry({ dataDir: tmpDir() });
    const skill = await reg.create({ name: "Lifecycle", description: "", promptFragment: "" });

    expect(skill.status).toBe("draft");

    await reg.promote(skill.id);
    expect((await reg.get(skill.id))?.status).toBe("testing");

    await reg.promote(skill.id);
    expect((await reg.get(skill.id))?.status).toBe("candidate");

    await reg.promote(skill.id);
    expect((await reg.get(skill.id))?.status).toBe("promoted");

    // Promoted stays promoted
    await reg.promote(skill.id);
    expect((await reg.get(skill.id))?.status).toBe("promoted");
  });

  it("archives a skill", async () => {
    const reg = new SkillRegistry({ dataDir: tmpDir() });
    const skill = await reg.create({ name: "ToArchive", description: "", promptFragment: "" });

    const ok = await reg.archive(skill.id);
    expect(ok).toBe(true);
    expect((await reg.get(skill.id))?.status).toBe("archived");
  });

  it("returns false when promoting nonexistent skill", async () => {
    const reg = new SkillRegistry({ dataDir: tmpDir() });
    const result = await reg.promote("bad-id");
    expect(result).toBe(false);
  });

  it("getPromptFragments returns only promoted fragments", async () => {
    const reg = new SkillRegistry({ dataDir: tmpDir() });
    const s1 = await reg.create({ name: "A", description: "", promptFragment: "fragment-a" });
    const s2 = await reg.create({ name: "B", description: "", promptFragment: "fragment-b" });

    // Promote s1 all the way
    await reg.promote(s1.id); // draft → testing
    await reg.promote(s1.id); // testing → candidate
    await reg.promote(s1.id); // candidate → promoted

    const fragments = await reg.getPromptFragments();
    expect(fragments).toContain("fragment-a");
    expect(fragments).not.toContain("fragment-b");
  });
});
