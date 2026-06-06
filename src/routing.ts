import type { AIProvider } from "./providers/types.js";

export type RouteTarget = "conversational" | "task" | "query";

const ROUTE_SYSTEM = [
  "Classify user messages into exactly one category.",
  "",
  "Categories:",
  '- "task" — user wants code created, built, fixed, modified, implemented, refactored, or changed.',
  '- "query" — user asks a technical question or seeks information (no code change requested).',
  '- "conversational" — greeting, small talk, acknowledgment, thanks, or non-technical chat.',
  "",
  "Reply with ONLY the category name. No explanation, no punctuation.",
].join("\n");

/** Use a lightweight flash model to semantically route the user's message.
 *  Returns the routing target — conversational messages skip the Target/Modify flow. */
export async function classifyIntent(
  provider: AIProvider,
  message: string,
): Promise<RouteTarget> {
  try {
    const resp = await provider.chat({
      model: "deepseek-v4-flash",
      messages: [
        { role: "system", content: ROUTE_SYSTEM },
        { role: "user", content: message },
      ],
      max_tokens: 10,
      temperature: 0,
    });

    const raw = resp.choices[0]?.message?.content?.trim().toLowerCase() ?? "";

    if (raw.includes("task")) return "task";
    if (raw.includes("query")) return "query";
    return "conversational";
  } catch {
    // If routing model is unavailable, default to "task" so real work isn't blocked.
    return "task";
  }
}
