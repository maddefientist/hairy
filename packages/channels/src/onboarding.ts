import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HairyClawLogger as Logger } from "@hairyclaw/observability";

export interface UserProfile {
  jid: string;
  name: string;
  onboarded: boolean;
  onboardStep: number;
  preferences: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface OnboardingManager {
  isOnboarded(jid: string): Promise<boolean>;
  getProfile(jid: string): Promise<UserProfile | null>;
  getOrCreateProfile(jid: string, pushName: string): Promise<UserProfile>;
  advanceStep(jid: string): Promise<UserProfile>;
  completeOnboarding(jid: string, prefs?: Record<string, string>): Promise<UserProfile>;
  updateProfile(
    jid: string,
    updates: Partial<Pick<UserProfile, "name" | "preferences">>,
  ): Promise<UserProfile>;
  getOnboardingPrompt(profile: UserProfile, userMessage: string, channel?: string): string | null;
}

const buildOnboardSteps = (agentName: string, channel: string) => [
  // Step 0: first contact — intro
  {
    prompt: (name: string) =>
      `This is a brand-new user named "${name}" messaging for the first time. Give them a warm, casual introduction. Tell them:\n- Your name is ${agentName}\n- You're their personal assistant on ${channel}\n- You can help with anything: web searches, research, planning, writing, problem-solving, automations, recommendations, and more\n- You have real-time web search (SearXNG), file tools, memory that persists across conversations, and the ability to learn their preferences\n- Ask what they'd like to be called and what kind of things they'd most want help with\nKeep it short and natural — this is ${channel}, not an email. No bullet-point walls. 2-3 short paragraphs max.`,
  },
  // Step 1: learn preferences from their response
  {
    prompt: (_name: string, userMsg: string) =>
      `The user just responded to your intro with: "${userMsg}"\nAcknowledge what they said, use whatever name they gave (or their push name if they didn't correct it). Based on their response, summarize what you've learned about them so far. Tell them you'll remember this. Let them know they can just message you anytime about anything — no special commands needed. After this message, use the hive_ingest tool to store their preferences/name for long-term memory. Also use the identity_evolve tool or write tool to update your knowledge.md with what you learned about this user. End naturally — you're ready to help with whatever they need.`,
  },
];

export const createOnboardingManager = (opts: {
  dataDir: string;
  logger: Logger;
  agentName?: string;
}): OnboardingManager => {
  const profilesDir = join(opts.dataDir, "users");

  const profilePath = (jid: string): string =>
    join(profilesDir, `${jid.replace(/[^a-zA-Z0-9]/g, "_")}.json`);

  const loadProfile = async (jid: string): Promise<UserProfile | null> => {
    try {
      const raw = await readFile(profilePath(jid), "utf8");
      return JSON.parse(raw) as UserProfile;
    } catch {
      return null;
    }
  };

  const saveProfile = async (profile: UserProfile): Promise<void> => {
    await mkdir(profilesDir, { recursive: true });
    await writeFile(profilePath(profile.jid), JSON.stringify(profile, null, 2), "utf8");
  };

  return {
    async isOnboarded(jid) {
      const profile = await loadProfile(jid);
      return profile?.onboarded ?? false;
    },

    async getProfile(jid) {
      return loadProfile(jid);
    },

    async getOrCreateProfile(jid, pushName) {
      const existing = await loadProfile(jid);
      if (existing) return existing;

      const profile: UserProfile = {
        jid,
        name: pushName || jid.split("@")[0],
        onboarded: false,
        onboardStep: 0,
        preferences: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await saveProfile(profile);
      opts.logger.info({ jid, name: profile.name }, "new user profile created");
      return profile;
    },

    async advanceStep(jid) {
      const profile = await loadProfile(jid);
      if (!profile) throw new Error(`No profile for ${jid}`);
      // 2 onboarding steps: intro (0) + learn preferences (1)
      profile.onboardStep = Math.min(profile.onboardStep + 1, 1);
      profile.updatedAt = new Date().toISOString();
      await saveProfile(profile);
      return profile;
    },

    async completeOnboarding(jid, prefs) {
      const profile = await loadProfile(jid);
      if (!profile) throw new Error(`No profile for ${jid}`);
      profile.onboarded = true;
      if (prefs) Object.assign(profile.preferences, prefs);
      profile.updatedAt = new Date().toISOString();
      await saveProfile(profile);
      opts.logger.info({ jid, name: profile.name }, "user onboarding complete");
      return profile;
    },

    async updateProfile(jid, updates) {
      const profile = await loadProfile(jid);
      if (!profile) throw new Error(`No profile for ${jid}`);
      if (updates.name) profile.name = updates.name;
      if (updates.preferences) Object.assign(profile.preferences, updates.preferences);
      profile.updatedAt = new Date().toISOString();
      await saveProfile(profile);
      return profile;
    },

    getOnboardingPrompt(profile, userMessage, channel) {
      if (profile.onboarded) return null;
      const steps = buildOnboardSteps(opts.agentName ?? "HairyClaw", channel ?? "chat");
      const step = steps[profile.onboardStep];
      if (!step) return null;
      return step.prompt(profile.name, userMessage);
    },
  };
};
