// Cliente LLM único, OpenAI-compatible, parametrizado por LLM_BASE_URL / LLM_API_KEY.
// Default: AI Gateway de TrueFoundry (virtual key emitida por Persona B).
// Cambiar de modelo = cambiar el string `model`.
// Fallback en vivo: apuntar LLM_BASE_URL a un proveedor directo (solo llmComplete:
// los prompts del registry son exclusivos del gateway de TrueFoundry).

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletion {
  choices?: { message?: { content?: string } }[];
}

async function chat(body: Record<string, unknown>): Promise<string> {
  const base = process.env.LLM_BASE_URL;
  const key = process.env.LLM_API_KEY;
  if (!base || !key) {
    throw new Error("LLM_BASE_URL/LLM_API_KEY not configured");
  }

  const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`LLM ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as ChatCompletion;
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM returned no content");
  return content.trim();
}

export async function llmComplete(
  model: string,
  prompt: string,
  opts: { system?: string; temperature?: number } = {},
): Promise<string> {
  const messages: LlmMessage[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: prompt });
  return chat({ model, messages, temperature: opts.temperature ?? 0.2 });
}

interface AnthropicMessageResponse {
  content?: { type: string; text?: string }[];
}

/** True when a direct Anthropic key is configured. */
export function anthropicConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Direct Anthropic Messages API call (plain fetch, no SDK).
 * Model from ANTHROPIC_MODEL (default "claude-sonnet-5-5"); 20s timeout.
 */
export async function anthropicComplete(
  prompt: string,
  opts: { system?: string; model?: string; maxTokens?: number; temperature?: number } = {},
): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not configured");
  const model = opts.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      // Llaves sin workspace (sk-ant-usr-…) exigen el id del workspace.
      ...(process.env.ANTHROPIC_WORKSPACE_ID
        ? { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID }
        : {}),
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 3000,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.system ? { system: opts.system } : {}),
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as AnthropicMessageResponse;
  const text = (data.content ?? [])
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new Error("Anthropic returned no text content");
  return text;
}

// Ejecuta un prompt guardado en el Prompt Registry de TrueFoundry: el gateway
// renderiza la plantilla server-side sustituyendo {{variables}}. El prompt ya
// no vive en este repo; se edita y versiona en el UI (ML Repos -> Prompts).
export async function llmPromptComplete(
  promptVersionFqn: string,
  variables: Record<string, string>,
  opts: { model?: string; temperature?: number } = {},
): Promise<string> {
  return chat({
    ...(opts.model ? { model: opts.model } : {}),
    messages: [],
    prompt_version_fqn: promptVersionFqn,
    prompt_variables: variables,
    temperature: opts.temperature ?? 0.2,
  });
}
