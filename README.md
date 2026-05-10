# ST Hands-Free Voice

A **SillyTavern extension** that enables near real-time, hands-free voice conversation with AI characters.  
Talk. Listen. Reply. No keyboard required. This plugin was created by Flaxify. This just has a bug fix and a button to pause listening for voice without shutting servers down. Useful when using local Whisper.

---

## What is this?

Hands-Free Voice closes the loop between SillyTavern's built-in **Text-to-Speech (TTS)** and **Speech-to-Text (STT)** so that conversation flows naturally — the character speaks, you reply out loud, the character responds. That cycle repeats automatically without you touching the keyboard or mouse.

It works by:
1. Detecting when the character's TTS audio has **fully finished playing**
2. Opening your microphone and listening for your voice
3. Automatically stopping the recording once you pause speaking
4. Transcribing your speech via **Whisper** (OpenRouter, Groq, or a local server)
5. Sending the transcribed text as your message and triggering the character's next response

If you stay silent, the extension can also trigger the character to continue on their own after a configurable timeout.

---

## Features

- **Automatic TTS → STT sequencing** — the mic only opens after TTS has fully ended, preventing the AI from hearing itself
- **Silence-based recording cutoff** — stops recording automatically once you pause speaking, no push-to-talk needed
- **Configurable silence timeout** — set how long to wait for you to start speaking before the character auto-continues
- **Configurable speech pause tolerance** — allows natural mid-sentence pauses without cutting off early
- **Configurable max recording length** — a safety cap so the mic doesn't run indefinitely if you step away
- **Auto-generate on silence** — if you say nothing, the character continues the scene on their own
- **Optional quote wrapping** — transcribed speech can be automatically wrapped in `"quotation marks"` before sending
- **Multi-provider Whisper support** — works with OpenRouter, Groq, or any local OpenAI-compatible STT endpoint
- **Off by default** — no behaviour changes unless you explicitly enable it

---

## Requirements

This extension **requires a working TTS setup** in SillyTavern. The TTS → STT loop cannot function without TTS. Configure and test your TTS extension first — voices must be assigned, audio must play correctly — before enabling Hands-Free Voice.

Supported TTS extensions include the built-in SillyTavern TTS (OpenAI-compatible, Kokoro, etc.).

---

## Installation

**Via SillyTavern Extension Installer (recommended):**

1. Open SillyTavern
2. Go to **Extensions → Install Extension**
3. Enter the repository URL: `https://github.com/Flaxify/ST-Hands-Free-Voice`
4. Click **Install**
5. Reload SillyTavern

**Or manually:**

```bash
cd SillyTavern/data/<your-user>/extensions
git clone https://github.com/Flaxify/ST-Hands-Free-Voice
```

Then reload SillyTavern.

---

## Setup & Usage

Once installed, open **Extensions → Hands-Free Voice** in the SillyTavern sidebar.

### API Settings

| Field | Description |
|---|---|
| **API Provider** | Choose between OpenRouter, Groq, or Local / Custom |
| **API Key** | Your API key for the selected provider (OpenRouter: `sk-or-...`, Groq: `gsk_...`) |
| **Whisper Model** | The transcription model to use (e.g. `openai/whisper-large-v3-turbo`) |
| **Custom Endpoint URL** | Only shown for Local — the base URL of your local STT server (e.g. `http://localhost:8080/v1`) |

### Timing

| Field | Description |
|---|---|
| **Silence Timeout (s)** | How long to wait for you to start speaking after TTS ends before the character auto-continues. Default: 5s |
| **Speech Pause Tolerance (s)** | How long a mid-speech pause is allowed before recording stops. Default: 1.5s |
| **Max Recording Length (s)** | Hard cap on recording time — prevents the mic running indefinitely. Default: 120s |

### Formatting

| Field | Description |
|---|---|
| **Wrap speech in quotation marks** | When enabled, your transcribed text is sent as `"text"` instead of plain text |

### Enabling

Tick **Enable Hands-Free Mode** and start a conversation. When the character finishes speaking, the mic will open automatically. Speak naturally — the extension handles the rest.

---

## Disclaimer & Project History

This project is a fork of [zompiexx/ST-Hands-Free-Voice](https://github.com/zompiexx/ST-Hands-Free-Voice).

The original repository appeared unmaintained and was no longer functional with SillyTavern v1.17.0. Rather than patching it, the extension was rewritten from scratch to fit how SillyTavern actually works today. The original code is not present in this repository — it shares a name and concept, but is otherwise an independent implementation.

I am **not a developer**. This project was built as a personal passion project through iterative experimentation. As such:

- I cannot guarantee long-term maintenance or timely responses to issues
- Feature requests, bug reports, and pull requests may go unaddressed
- I cannot guarantee compatibility with future SillyTavern versions
- This extension is provided as-is, with no warranties of any kind

If you find this useful and want to take it further — please fork it. If the original maintainer returns and has concerns, I am happy to restructure the repository accordingly.
