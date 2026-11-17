/**
 * Agente de voz de Andina Motors: OpenAI GPT-Live sobre Twilio Media Streams,
 * con Twilio Agent Connect (TAC).
 *
 * Basado en getting_started/examples/gpt-live de
 * https://github.com/twilio/twilio-agent-connect-typescript
 *
 * Twilio manda el audio de la llamada a nuestro WebSocket y el provider lo
 * retransmite hacia/desde el WebSocket de GPT-Live:
 *
 * - GPT-Live es full-duplex: no hay barge-in/truncate que configurar, el
 *   modelo maneja las interrupciones solo.
 * - Las tools van por delegación a Responses (`sessionConfig.delegation`).
 * - El saludo se manda con `welcomeInstruction` (un `session.commentary.append`
 *   cuando llega `session.started`). GPT-Live no habla primero con un saludo
 *   pelado: hay que redactarlo como instrucción.
 *
 * Corre en modo relay-only: no hay Conversation Orchestrator ni lookup de
 * perfil en una llamada de Media Streams.
 *
 * Solo llamadas entrantes. Este archivo no hace llamadas salientes.
 *
 * Variables de entorno requeridas (ver .env.example):
 * - TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_API_KEY, TWILIO_API_SECRET
 * - TWILIO_PHONE_NUMBER
 * - TWILIO_VOICE_PUBLIC_DOMAIN (el dominio de ngrok, sin https://)
 * - OPENAI_API_KEY
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from 'dotenv';
import {
  TAC,
  TACConfig,
  TACServer,
  VoiceChannel,
  GPTLiveProviderConfig,
  TWILIO_AUDIO_FORMAT_FOR_GPT_LIVE,
  GPT_LIVE_SESSION_ID_METADATA_KEY,
  defineTool,
} from 'twilio-agent-connect';

config();

const LOGS_DIR = path.resolve('logs');
const HANDOFFS_FILE = path.resolve('data', 'handoffs.json');
const CONTEXT_FILE = path.resolve(process.env.COMPANY_CONTEXT_PATH ?? 'context/andina-motors.md');

// La sesión de GPT-Live se cobra mientras está abierta: tope duro por llamada.
const MAX_CALL_DURATION_MS = 5 * 60 * 1000;

// Ni el modelo ni la voz están tipados en el paquete (`defaultSessionConfig` es
// `Record<string, unknown>` y se manda a OpenAI tal cual). Los defaults son los
// únicos valores que aparecen en el ejemplo oficial; se pueden pisar por env.
const GPT_LIVE_MODEL = process.env.GPT_LIVE_MODEL ?? 'gpt-live-1';
const GPT_LIVE_VOICE = process.env.GPT_LIVE_VOICE ?? 'marin';
const DELEGATION_MODEL = process.env.GPT_LIVE_DELEGATION_MODEL ?? 'gpt-5.6-sol';

const companyContext = await readFile(CONTEXT_FILE, 'utf8').catch(() => {
  throw new Error(
    `No pude leer el contexto de la empresa en ${CONTEXT_FILE}. ` +
      'Creá ese archivo o apuntá COMPANY_CONTEXT_PATH al correcto.'
  );
});

await mkdir(LOGS_DIR, { recursive: true });
await mkdir(path.dirname(HANDOFFS_FILE), { recursive: true });

const tac = await TAC.create({ config: TACConfig.fromEnv() });

interface HandoffRequest {
  fecha: string;
  motivo: string;
}

// Las tools corren de a una por proceso en la práctica, pero dos llamadas
// simultáneas podrían pisarse al leer/escribir el JSON: se encadenan.
let handoffWrites: Promise<unknown> = Promise.resolve();

async function saveHandoff(entry: HandoffRequest): Promise<void> {
  const write = handoffWrites.then(async () => {
    const raw = await readFile(HANDOFFS_FILE, 'utf8').catch(() => '[]');
    const entries = JSON.parse(raw) as HandoffRequest[];
    entries.push(entry);
    await writeFile(HANDOFFS_FILE, JSON.stringify(entries, null, 2) + '\n');
  });
  handoffWrites = write.catch(() => undefined);
  await write;
}

// Por ahora solo registra el pedido en un JSON local; no transfiere la llamada.
const requestHandoff = defineTool(
  'request_handoff',
  'Registra el pedido del cliente de hablar con un asesor humano de Andina Motors. ' +
    'Usala cuando el cliente pida hablar con una persona o cuando su consulta no se ' +
    'pueda resolver con la información disponible.',
  {
    type: 'object',
    properties: {
      motivo: {
        type: 'string',
        description: 'Motivo del pedido, en una frase corta y en español.',
      },
    },
    required: ['motivo'],
  },
  async ({ motivo }: { motivo: string }) => {
    const startedAt = new Date();
    console.log(`[tool] request_handoff inicio ${startedAt.toISOString()} motivo="${motivo}"`);
    let ok = true;
    try {
      await saveHandoff({ fecha: startedAt.toISOString(), motivo });
      return { registrado: true, mensaje: 'Pedido registrado. Avisale que lo vas a pasar con un asesor.' };
    } catch (err) {
      ok = false;
      throw err;
    } finally {
      const endedAt = new Date();
      const durationMs = endedAt.getTime() - startedAt.getTime();
      console.log(`[tool] request_handoff fin    ${endedAt.toISOString()} (${durationMs} ms, ok=${ok})`);
      await appendFile(
        path.join(LOGS_DIR, 'tool-calls.jsonl'),
        JSON.stringify({
          tool: 'request_handoff',
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          durationMs,
          ok,
          motivo,
        }) + '\n'
      ).catch((err: unknown) => console.error('[tool] no pude escribir tool-calls.jsonl', err));
    }
  }
);

// Se manda a OpenAI tal cual, así que estas claves quedan en snake_case (la
// API de TAC es camelCase).
const DEFAULT_SESSION_CONFIG: Record<string, unknown> = {
  model: GPT_LIVE_MODEL,
  instructions:
    'Sos el asistente telefónico de Andina Motors, una concesionaria de autos. ' +
    'Hablás siempre en español rioplatense, con voseo ("vos", "tenés", "querés"), ' +
    'en tono cálido y profesional. ' +
    'Usá frases cortas: una o dos oraciones por turno. Sin markdown, emojis ni listas; ' +
    'todo lo que digas se va a escuchar en voz alta. ' +
    'Respondé únicamente con la información del contexto de la empresa que está abajo. ' +
    'Si la respuesta no está en ese contexto, decí que no tenés esa información; ' +
    'no inventes precios, stock, horarios ni condiciones, y ofrecé pasarlo con un asesor. ' +
    'Si el cliente pide hablar con una persona, o no podés resolver su consulta, ' +
    'usá la tool request_handoff con el motivo y avisale que lo vas a pasar con un asesor.' +
    '\n\n# Contexto de la empresa\n\n' +
    companyContext,
  audio: {
    // Obligatorio. Twilio Media Streams es siempre G.711 u-law a 8kHz, y el
    // provider rechaza la llamada si esto es otra cosa.
    format: TWILIO_AUDIO_FORMAT_FOR_GPT_LIVE,
    output: { voice: GPT_LIVE_VOICE },
  },
  // GPT-Live no ejecuta tools: delega cada turno que necesita una a la
  // Responses API, que es donde tienen que vivir los schemas.
  delegation: {
    type: 'responses',
    responses: {
      model: DELEGATION_MODEL,
      // Declarar la tool acá es lo que le avisa al modelo que existe.
      // Registrarla en `tools` más abajo es lo que la hace *ejecutable*.
      // Hacen falta las dos cosas.
      tools: [requestHandoff.toRealtimeFormat()],
      tool_choice: 'auto',
    },
  },
};

// Tope de duración: un timer por llamada, que corta con `endCall`.
const maxDurationTimers = new Map<string, NodeJS.Timeout>();
const callsCutByLimit = new Set<string>();

const voiceChannel: VoiceChannel = new VoiceChannel(
  tac,
  new GPTLiveProviderConfig({
    tools: [requestHandoff],
    // Redactado como instrucción, no como saludo pelado: GPT-Live no habla
    // primero si solo le pasás el texto del saludo.
    welcomeInstruction:
      'Saludá al cliente de inmediato usando exactamente el texto de abajo. No esperes ' +
      'a que hable primero. Después del saludo, hacé una pausa y escuchá.' +
      '\n\n¡Hola! Te comunicaste con Andina Motors. ¿En qué te puedo ayudar?',
    defaultSessionConfig: DEFAULT_SESSION_CONFIG,
    // Se llama una vez por llamada entrante, cuando Twilio pide el TwiML: es el
    // punto más temprano donde se conoce el CallSid. Devolver `null` deja la
    // config por defecto; acá solo se usa para arrancar el tope de duración.
    onInboundCallSessionConfig: async (req) => {
      const callSid = req.callSid;
      if (callSid !== undefined && !maxDurationTimers.has(callSid)) {
        const timer = setTimeout(() => {
          maxDurationTimers.delete(callSid);
          callsCutByLimit.add(callSid);
          console.log(`[call] ${callSid} llegó al máximo de ${MAX_CALL_DURATION_MS / 1000}s: corto.`);
          // `endCall` cuelga la llamada en Twilio y libera la sesión; al
          // cerrarse el Media Stream el provider manda `session.close`.
          void voiceChannel.endCall(callSid);
        }, MAX_CALL_DURATION_MS);
        maxDurationTimers.set(callSid, timer);
      }
      return null;
    },
  })
);

// Cuando el cliente corta, Twilio cierra el Media Stream y el provider cierra
// la sesión de GPT-Live (`session.close`) antes de llamar a este callback. Acá
// se guarda el transcript: la sesión se descarta apenas termina el callback.
tac.onConversationEnded(async ({ session }) => {
  const endedAt = new Date();
  const callSid = session.callSid ?? session.conversationId;

  const timer = maxDurationTimers.get(callSid);
  if (timer !== undefined) {
    clearTimeout(timer);
    maxDurationTimers.delete(callSid);
  }
  const cutByLimit = callsCutByLimit.delete(callSid);

  const transcript = (session.metadata.transcript ?? []) as { role: string; text: string }[];
  const gptLiveSessionId = session.metadata[GPT_LIVE_SESSION_ID_METADATA_KEY] ?? null;
  const durationSeconds = Math.round((endedAt.getTime() - session.startedAt.getTime()) / 100) / 10;

  const file = path.join(
    LOGS_DIR,
    `${session.startedAt.toISOString().replace(/[:.]/g, '-')}_${callSid}.json`
  );
  await writeFile(
    file,
    JSON.stringify(
      {
        callSid,
        gptLiveSessionId,
        startedAt: session.startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationSeconds,
        endedByMaxDuration: cutByLimit,
        transcript,
      },
      null,
      2
    ) + '\n'
  );
  console.log(
    `[call] ${callSid} terminó: ${durationSeconds}s, ${transcript.length} turnos` +
      `${cutByLimit ? ' (cortada por tope de duración)' : ''}. Transcript en ${file}`
  );
});

const server = new TACServer(tac, { voiceChannel });

await server.start();
