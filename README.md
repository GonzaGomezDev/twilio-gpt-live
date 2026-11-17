# Andina Motors: agente de voz con GPT-Live y Twilio

Agente que atiende llamadas entrantes en un número de Twilio usando GPT-Live-1
de OpenAI, con [Twilio Agent Connect](https://github.com/twilio/twilio-agent-connect-typescript)
(TAC) en TypeScript. Parte del ejemplo oficial `getting_started/examples/gpt-live`.

- Atiende en español rioplatense y saluda primero.
- Responde solo con el contexto de `context/andina-motors.md`.
- Tool `request_handoff(motivo)`: registra el pedido en `data/handoffs.json`.
- Guarda el transcript de cada llamada en `logs/`, con la duración total.
- Corta cada llamada a los 5 minutos como máximo.
- Solo llamadas entrantes: el código no hace llamadas salientes.

## Requisitos

- Node.js 22.13 o superior
- Una cuenta de Twilio con un número con capacidad de voz
- Una API key de OpenAI con acceso a GPT-Live
- [ngrok](https://ngrok.com/download)

## Correrlo en Windows con PowerShell

1. Instalá las dependencias:

   ```powershell
   npm install
   ```

2. Creá el `.env` y completalo a mano:

   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```

3. Cargá el contexto real de la empresa en `context/andina-motors.md`
   (o apuntá `COMPANY_CONTEXT_PATH` a otro archivo). El que viene en el repo es
   un marcador de posición.

4. En otra ventana de PowerShell, abrí el túnel:

   ```powershell
   ngrok http 8000
   ```

   Copiá el dominio que te da (por ejemplo `abc123.ngrok.app`) y pegalo en
   `.env` como `TWILIO_VOICE_PUBLIC_DOMAIN`, sin `https://`. En el plan gratis
   de ngrok el dominio puede cambiar al reiniciar: si cambia, actualizá el
   `.env` y el webhook del paso 6.

5. Levantá el agente:

   ```powershell
   npm run dev
   ```

   Tiene que aparecer `Server listening at http://0.0.0.0:8000` o similar.

6. En la consola de Twilio, entrá a Phone Numbers, Manage, Active numbers,
   elegí tu número y en "Voice Configuration", "A call comes in", poné:

   - Webhook: `https://TU-DOMINIO.ngrok.app/twiml`
   - Método: `HTTP POST`

7. Llamá al número desde tu teléfono. Esto consume saldo de Twilio y de OpenAI
   mientras dura la llamada.

Para cortar el agente, `Ctrl+C` en la ventana de `npm run dev`.

## Qué se guarda

| Archivo | Contenido |
| --- | --- |
| `logs/<inicio>_<CallSid>.json` | Transcript, inicio, fin, `durationSeconds`, id de sesión de GPT-Live y si la cortó el tope de 5 minutos |
| `logs/tool-calls.jsonl` | Una línea por ejecución de la tool, con hora de inicio, fin y duración |
| `data/handoffs.json` | Pedidos de handoff: `fecha` y `motivo` |

`logs/` y `data/` están en `.gitignore` porque tienen datos de llamadas.

## Costos y cierre de sesión

La sesión de GPT-Live se cobra mientras está abierta.

- Cuando el cliente corta, Twilio cierra el Media Stream y el provider de TAC
  manda `session.close` a OpenAI.
- A los 5 minutos de entrar la llamada, el agente la cuelga con
  `voiceChannel.endCall`, que dispara el mismo cierre. El tope está en
  `MAX_CALL_DURATION_MS` en `src/index.ts`.

## Modelo y voz

El paquete no tipa ni valida el modelo ni la voz: `defaultSessionConfig` es un
`Record<string, unknown>` que se manda a OpenAI tal cual. Los defaults son los
únicos valores que usa el ejemplo oficial y se pueden cambiar en `.env`:

| Variable | Default |
| --- | --- |
| `GPT_LIVE_MODEL` | `gpt-live-1` |
| `GPT_LIVE_VOICE` | `marin` |
| `GPT_LIVE_DELEGATION_MODEL` | `gpt-5.6-sol` |

## Scripts

- `npm run dev`: levanta el agente y reinicia cuando cambia el código
- `npm start`: levanta el agente sin watch
- `npm run typecheck`: chequeo de tipos
