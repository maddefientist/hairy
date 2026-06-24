import nodemailer from "nodemailer";
import { z } from "zod";
import type { Tool, ToolContext } from "../types.js";

export interface SmtpCfg {
  host: string;
  port: number;
  user: string;
  password: string;
}

export interface EmailSendDeps {
  smtp: SmtpCfg;
  fromAddress: string;
  transportFactory?: typeof nodemailer.createTransport;
}

const sendSchema = z.object({
  action: z.enum(["send", "reply", "unsubscribe"]),
  to: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  inReplyTo: z.string().optional(),
  references: z.string().optional(),
  listUnsubscribeUrl: z.string().optional(),
});

export const createEmailSendTool = (deps: EmailSendDeps): Tool => ({
  name: "corra_email_send",
  description:
    "Send, reply to, or unsubscribe from email AS Corra (her own address). action=send|reply|unsubscribe. reply sets In-Reply-To/References; unsubscribe hits an http(s) List-Unsubscribe URL.",
  parameters: sendSchema,
  timeout_ms: 30_000,
  async execute(args, ctx: ToolContext) {
    const input = sendSchema.parse(args);

    if (input.action === "unsubscribe") {
      const raw = input.listUnsubscribeUrl?.replace(/^<|>$/g, "");
      if (!raw) return { content: JSON.stringify({ error: "listUnsubscribeUrl required" }), isError: true };
      if (raw.startsWith("http")) {
        const resp = await fetch(raw, { method: "POST" }).catch(() => fetch(raw));
        return { content: JSON.stringify({ unsubscribed: true, status: resp.status }) };
      }
      return { content: JSON.stringify({ error: "non-http unsubscribe not supported", url: raw }), isError: true };
    }

    const factory = deps.transportFactory ?? nodemailer.createTransport;
    const transport = factory({
      host: deps.smtp.host,
      port: deps.smtp.port,
      secure: deps.smtp.port === 465,
      auth: { user: deps.smtp.user, pass: deps.smtp.password },
    });

    const mail: Record<string, unknown> = {
      from: deps.fromAddress,
      to: input.to,
      subject: input.subject ?? "(no subject)",
      text: input.body ?? "",
    };
    if (input.action === "reply") {
      if (input.inReplyTo) mail.inReplyTo = input.inReplyTo;
      if (input.references) mail.references = input.references;
    }

    const result = (await transport.sendMail(mail)) as { messageId?: string };
    ctx.logger.info({ action: input.action, to: input.to }, "corra email sent");
    return { content: JSON.stringify({ sent: true, messageId: result.messageId }) };
  },
});
