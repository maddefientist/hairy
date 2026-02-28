export type SkillStatus = "draft" | "testing" | "candidate" | "promoted" | "archived";

export interface Skill {
  id: string;
  name: string;
  description: string;
  promptFragment: string;
  status: SkillStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PromptVersion {
  id: string;
  prompt: string;
  hash: string;
  createdAt: string;
}

export interface InitiativeRule {
  id: string;
  trigger: "schedule" | "event" | "anomaly" | "silence";
  condition: string;
  action: string;
  confidence_threshold: number;
  risk_level: "low" | "medium" | "high";
  requires_approval: boolean;
  cooldown_ms: number;
}

export interface EvalScore {
  id: string;
  traceId: string;
  score: number;
  createdAt: string;
  skillId?: string;
  promptVersionId?: string;
}
