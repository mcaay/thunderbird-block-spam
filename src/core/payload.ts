// The only text an AI access point ever receives about a message.

export const BODY_LIMIT = 20000;
export const MAX_BODY_MESSAGE_SIZE = 5 * 1024 * 1024;

export interface PayloadInput {
  /** Effective sender, or the forwarding mailbox when the original sender was not found. */
  from: string;
  replyTo: string | null;
  to: readonly string[];
  subject: string;
  /** Epoch milliseconds, 0 when unknown. */
  date: number;
  body: string;
}

export function buildPayload(input: PayloadInput): string {
  const lines = [`From: ${oneLine(input.from)}`];
  if (input.replyTo !== null && input.replyTo.trim() !== "") {
    lines.push(`Reply-To: ${oneLine(input.replyTo)}`);
  }
  lines.push(`To: ${oneLine(input.to.join(", "))}`);
  lines.push(`Subject: ${oneLine(input.subject)}`);
  lines.push(`Date: ${input.date > 0 ? new Date(input.date).toISOString() : ""}`);
  return `${lines.join("\n")}\n\n${truncateBody(input.body)}`;
}

/** First 20,000 characters, never ending in half of a surrogate pair. */
export function truncateBody(body: string): string {
  if (body.length <= BODY_LIMIT) {
    return body;
  }
  const cut = body.slice(0, BODY_LIMIT);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim();
}

/** Built-in sample email scored by the Test button of an access point. */
export const SAMPLE_PAYLOAD = buildPayload({
  from: "growth@rankboost-agency.example",
  replyTo: null,
  to: ["office@example.org"],
  subject: "Quick question about your website traffic",
  date: Date.UTC(2026, 0, 15, 9, 30),
  body: [
    "Hi there,",
    "",
    "I came across your website and noticed it is not ranking on the first page of Google",
    "for your main keywords. We are an SEO and link-building agency that has helped more",
    "than 300 companies triple their organic traffic in 90 days.",
    "",
    "Can I send you a free audit and our pricing? We also offer lead generation and",
    "outsourced web development at very competitive rates.",
    "",
    "Best regards,",
    "Mike",
    "Senior Growth Consultant",
  ].join("\n"),
});
