import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const log = (message: string): void => {
  stdout.write(`${message}\n`);
};

const fail = (message: string): never => {
  throw new Error(message);
};

const readOptionalFile = async (path: string): Promise<string | undefined> => {
  try {
    const content = await readFile(path, "utf8");
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
};

const requirePositiveIntEnv = (name: string): number => {
  const raw = process.env[name];
  if (!raw) {
    return fail(`${name} is required`);
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fail(`${name} must be a positive integer`);
  }

  return parsed;
};

const requireStringEnv = (name: string): string => {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fail(`${name} is required`);
  }
  return raw.trim();
};

const main = async (): Promise<void> => {
  const apiId = requirePositiveIntEnv("TELEGRAM_API_ID");
  const apiHash = requireStringEnv("TELEGRAM_API_HASH");

  const sessionFile = resolve(
    process.cwd(),
    process.env.TELEGRAM_SESSION_FILE?.trim() || "./data/telegram/session.txt",
  );

  const envSession = process.env.TELEGRAM_SESSION?.trim();
  const fileSession = await readOptionalFile(sessionFile);
  const initialSession = envSession && envSession.length > 0 ? envSession : (fileSession ?? "");

  const client = new TelegramClient(new StringSession(initialSession), apiId, apiHash, {
    connectionRetries: 5,
  });

  const rl = createInterface({ input: stdin, output: stdout });

  const ask = async (prompt: string): Promise<string> => {
    const answer = await rl.question(prompt);
    return answer.trim();
  };

  const envPhone = process.env.TELEGRAM_PHONE_NUMBER?.trim();
  const envPhoneCode = process.env.TELEGRAM_PHONE_CODE?.trim();
  const envPassword = process.env.TELEGRAM_2FA_PASSWORD?.trim();

  log("Connecting to Telegram...");

  await client.start({
    phoneNumber: async () =>
      envPhone && envPhone.length > 0 ? envPhone : ask("Phone number (+15551234567): "),
    phoneCode: async () =>
      envPhoneCode && envPhoneCode.length > 0 ? envPhoneCode : ask("Telegram login code: "),
    password: async () =>
      envPassword !== undefined ? envPassword : ask("2FA password (press Enter if not set): "),
    onError: (err: unknown) => {
      throw err;
    },
  });

  const saved = client.session.save();
  if (typeof saved !== "string" || saved.length === 0) {
    fail("Failed to produce a Telegram session string");
  }

  await mkdir(dirname(sessionFile), { recursive: true });
  await writeFile(sessionFile, `${saved}\n`, { mode: 0o600 });

  log(`Telegram session saved to ${sessionFile}`);

  await client.disconnect();
  rl.close();
};

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : "Unknown error";
  process.stderr.write(`telegram-session failed: ${message}\n`);
  process.exit(1);
});
