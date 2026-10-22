import { Composio } from '@composio/core';
import type { Alert, PostAlert } from '@farmavigia/shared';

// === Contrato B → A: postAlert ===
// Publica una alerta vía Composio. Enruta por alert.channel:
//   - 'slack' (canal activo): SLACK_SEND_MESSAGE
//   - 'gmail' (listo, pendiente de destrabar OAuth de Google): GMAIL_SEND_EMAIL
// Plan B en vivo: si DRY_RUN=true o Composio falla, imprime en consola y sigue.
// Nota: el env se lee de forma perezosa (dentro de las funciones) porque este
// módulo se importa antes de que el consumidor cargue dotenv.

const dryRun = () => process.env.DRY_RUN === 'true';
const userId = () => process.env.COMPOSIO_USER_ID || 'default';
const slackChannel = () => process.env.COMPOSIO_SLACK_CHANNEL || '';
const gmailTo = () => process.env.COMPOSIO_GMAIL_TO || '';

let _composio: Composio | null = null;
function composio(): Composio {
  if (!_composio) {
    const apiKey = process.env.COMPOSIO_API_KEY;
    // Sin key, el SDK mata el proceso entero (TS-SDK::NO_API_KEY + exit 1);
    // lanzar antes lo convierte en el fallback normal de postAlert.
    if (!apiKey) throw new Error('COMPOSIO_API_KEY no configurado');
    _composio = new Composio({ apiKey });
  }
  return _composio;
}

interface ExecResult {
  data: Record<string, unknown>;
  error: string | null;
  successful: boolean;
}

function renderConsole(alert: Alert): void {
  const prov = alert.provenance.map((p) => `  - ${p.url}`).join('\n');
  console.log(
    `\n📣 [postAlert:${alert.channel}] ${alert.title}\n${alert.body}\n` +
      (prov ? `Fuentes:\n${prov}\n` : ''),
  );
}

async function sendSlack(alert: Alert): Promise<ExecResult> {
  const channel = slackChannel();
  if (!channel) throw new Error('COMPOSIO_SLACK_CHANNEL no configurado');
  const text =
    `*${alert.title}*\n${alert.body}` +
    (alert.provenance.length
      ? `\n\nSources:\n${alert.provenance.map((p) => `• ${p.url}`).join('\n')}`
      : '');
  // El cuerpo va en markdown_text (no existe 'text'/'message' en este tool).
  // No mandar fallback_text: solo es válido junto con 'blocks'.
  return composio().tools.execute('SLACK_SEND_MESSAGE', {
    userId: userId(),
    arguments: { channel, markdown_text: text },
  }) as Promise<ExecResult>;
}

async function sendGmail(alert: Alert): Promise<ExecResult> {
  const to = gmailTo();
  if (!to) throw new Error('COMPOSIO_GMAIL_TO no configurado');
  const body =
    `${alert.body}\n\n` +
    (alert.provenance.length
      ? `Sources:\n${alert.provenance.map((p) => p.url).join('\n')}`
      : '');
  return composio().tools.execute('GMAIL_SEND_EMAIL', {
    userId: userId(),
    arguments: { recipient_email: to, subject: alert.title, body },
  }) as Promise<ExecResult>;
}

// Intenta extraer un id útil del payload sin romper si el shape cambia.
function extractRef(res: ExecResult, channel: string): string {
  const d = res?.data ?? {};
  const id =
    (d.ts as string) ||
    (d.id as string) ||
    (d.messageId as string) ||
    (d.threadId as string);
  return id ? `${channel}:${id}` : `${channel}:ok`;
}

export const postAlert: PostAlert = async (alert: Alert) => {
  if (dryRun()) {
    renderConsole(alert);
    return { ok: true, ref: `dry-run:${alert.channel}` };
  }
  try {
    const res =
      alert.channel === 'gmail' ? await sendGmail(alert) : await sendSlack(alert);
    if (res.successful === false) {
      console.error(`[postAlert] Composio respondió error:`, res.error);
      renderConsole(alert);
      return { ok: false, ref: `error:${res.error ?? 'unknown'}` };
    }
    return { ok: true, ref: extractRef(res, alert.channel) };
  } catch (err) {
    // Fallback en vivo: nunca tumbar la demo por una integración externa.
    console.error(`[postAlert] Composio falló, fallback a consola:`, err);
    renderConsole(alert);
    return { ok: false, ref: `error:${String((err as Error)?.message ?? err)}` };
  }
};

export default postAlert;
