import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Skill, SkillStatus } from "./types.js";

interface SkillRegistryOptions {
  dataDir: string;
}

export class SkillRegistry {
  private readonly baseDir: string;

  constructor(private readonly opts: SkillRegistryOptions) {
    this.baseDir = join(this.opts.dataDir, "skills");
  }

  async create(input: Omit<Skill, "id" | "status" | "createdAt" | "updatedAt">): Promise<Skill> {
    const now = new Date().toISOString();
    const skill: Skill = {
      id: randomUUID(),
      status: "draft",
      createdAt: now,
      updatedAt: now,
      ...input,
    };

    await this.save(skill);
    return skill;
  }

  async promote(id: string): Promise<boolean> {
    const skill = await this.get(id);
    if (!skill) {
      return false;
    }

    const nextState: Record<SkillStatus, SkillStatus> = {
      draft: "testing",
      testing: "candidate",
      candidate: "promoted",
      promoted: "promoted",
      archived: "archived",
    };

    skill.status = nextState[skill.status];
    skill.updatedAt = new Date().toISOString();
    await this.save(skill);
    return true;
  }

  async archive(id: string): Promise<boolean> {
    const skill = await this.get(id);
    if (!skill) {
      return false;
    }

    skill.status = "archived";
    skill.updatedAt = new Date().toISOString();
    await this.save(skill);
    return true;
  }

  async list(status?: SkillStatus): Promise<Skill[]> {
    await mkdir(this.baseDir, { recursive: true });
    const entries = await readdir(this.baseDir, { withFileTypes: true });

    const skills: Skill[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const skill = await this.get(entry.name);
      if (!skill) {
        continue;
      }
      if (!status || skill.status === status) {
        skills.push(skill);
      }
    }

    return skills;
  }

  async get(id: string): Promise<Skill | null> {
    try {
      const path = join(this.baseDir, id, "skill.json");
      const raw = await readFile(path, "utf8");
      return JSON.parse(raw) as Skill;
    } catch {
      return null;
    }
  }

  async getPromptFragments(): Promise<string[]> {
    const promoted = await this.list("promoted");
    return promoted.map((skill) => skill.promptFragment);
  }

  private async save(skill: Skill): Promise<void> {
    const dir = join(this.baseDir, skill.id);
    await mkdir(dir, { recursive: true });

    await writeFile(join(dir, "SKILL.md"), `# ${skill.name}\n\n${skill.description}\n`, "utf8");
    await writeFile(join(dir, "skill.json"), JSON.stringify(skill, null, 2), "utf8");
  }
}
