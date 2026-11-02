[繁體中文](README.md) | **English**

# むぎ 日語家教 · Mugi Tutor

A phone-friendly web app for one-on-one Japanese conversation practice with むぎ (Mugi), a cute cartoon hamster tutor powered by Claude (React and Vite; your API key stays on the PC, in the dev server). You talk with her in Japanese or Chinese, she answers in Japanese, and the app helps you learn from what she says. The interface is in Traditional Chinese, and the explanations are in Chinese.

> **License:** This project is open source under the [MIT License](LICENSE). You are free to use, modify, and redistribute it. **If you create derivative works or redistribute it, please keep the original copyright notice and the full MIT license text.** Third-party components keep their own licenses; see [NOTICE.md](NOTICE.md).

## Highlights

<p align="center"><img src="docs/img/highlights.svg" alt="Highlights overview" width="100%"></p>

- **Multi-layer cache**: The longer the chat, the less repeated text is recomputed. The cloud side uses Anthropic prompt caching; the local voice cache has a memory layer and a disk layer. The system prompt and the earlier messages use Claude's 5-minute prompt cache, so only the newest message is computed again; replaying a sentence already spoken by local VOICEVOX dropped from 3.7 s to 19 ms (median of 10 runs each, synthesis vs. cache hit; see [0006](docs/decisions/0006-tts-cache.md)). Prompt-cache details are in [0002](docs/decisions/0002-prompt-cache.md).
- **Tips notebook (小提醒本)**: When something you said was wrong or unnatural, a short Chinese note is saved automatically. Practise it aloud or by typing until it sticks; Claude judges only when local matching cannot.
- **Quick lookup (速查)**: Ask about phrasing, vocabulary or grammar in Chinese or Japanese. You get the reading, the Chinese meaning, a JLPT-style level and examples, without breaking the conversation.
- **Bring your own API key**: Use your own Claude key; it stays on your local server. There is a daily spending cap (default 2 USD) and a per-minute request limit. At the default 2 USD a day you get roughly 5,865 sentences with Haiku 5.5, or about 146 with Opus 5.5 (estimates). Voice can also use your own Google or Azure keys.
- **Kanji readings are not missed**: The LLM annotates readings, and the server's kuromoji fills in whatever it misses.
- **Voice and lip-sync**: Local VOICEVOX or cloud Google / Azure, with the mouth moving along the syllables.
- **Built-in conversation starters**: A bank of 100 sentences lets Mugi open a new topic without calling the API.
- **Voice input (STT)**: Just talk, and fix it by typing if needed: what you say becomes text first, and you can edit it before sending. Continuous voice conversation works too; Chinese and Japanese are both understood.

## Design rationale

- **Prompt caching keeps repeated turns cheap**: The system prompt and the stable part of the history carry cache breakpoints. The reminder that changes every turn is attached only to the newest message, so earlier messages are byte-identical from one request to the next. The chat history is sent as a window of up to 39 lines; when it would grow past that, the window restarts from the newest 20 lines. After more than an hour without a real exchange, the next request carries only the newest 5 lines (tips are not sent back).
- **Chat replies use a JSON Schema too, read while they stream**: Mugi's reply is a JSON object (`segments`, `tip`, `tone`) written under Structured Outputs, so its format is guaranteed. The phone reads the partial JSON as it arrives: each part shows as it is written, and each Japanese segment is voiced once it is complete. Lookup results, tip practice judgments and tip rewrites use the same schema mechanism.
- **Kanji readings come from the server, not only from the model**: The server adds kanji readings with kuromoji, so readings do not depend only on the model's output.
- **A tip written in Japanese is rewritten in the background**: If a tip comes back as Japanese prose, it is sent once to Claude Haiku 5.5 in the background to be rewritten in Chinese, with the Japanese kept inside `<ja>` tags.
- **Speech is cached, and cloud voices fall back before they run out**: Synthesised speech is cached on the PC under `.tts-cache/`, with file names taken from the SHA-256 of the cache key, up to 200 MB. When a cloud voice reaches 90% of its free allowance, requests move to a cheaper tier and finally to the browser voice.
- **Keys stay on the server**: Only the dev server reads `.env.local`, and the phone receives replies and audio, never keys.
- **Decision records**: The main design choices above, with the options considered, the trade-offs and when to revisit it, are in [docs/decisions/](docs/decisions/README.md).

## Features

<p align="center">
  <img src="docs/img/screen-home.png" width="200" alt="Home: black-and-white UI on the classroom background, Mugi the hamster on the lectern with a Japanese reply in a speech bubble and its Chinese meaning in brackets">
  <img src="docs/img/screen-characters.png" width="200" alt="Other tutors: black-and-white UI on the classroom background, Yuma standing in front of the lectern with a Japanese line in a speech bubble and its Chinese meaning in brackets">
  <img src="docs/img/screen-yui.png" width="200" alt="Yui: the high-school tutor sitting on the lectern, with a Kansai-dialect Japanese line and its Chinese meaning in the speech bubble">
  <img src="docs/img/screen-history.png" width="200" alt="Chat history: black-and-white UI, a 小提醒 tip with a furigana reading, followed by Mugi's Japanese replies and their Chinese meanings">
  <img src="docs/img/screen-tips.png" width="200" alt="Tips notebook: black-and-white UI with a tip still being practised, its example buttons and typing box, and the counts of tips in practice and learned">
</p>
<p align="center">
  <img src="docs/img/screen-lookup.png" width="200" alt="Quick lookup: black-and-white UI with a search box, a Chinese/Japanese switch, and a saved result for 「我想去買東西」 with its reading, N5 badge, meaning and the 〜たい grammar note">
  <img src="docs/img/screen-settings.png" width="200" alt="Settings: black-and-white UI scrolled to AI services (Claude and ChatGPT, in the order they are tried) and the daily budget cap">
  <img src="docs/img/screen-character.png" width="200" alt="Characters sheet: black-and-white UI with tabs 1, 2, 3 and ＋, tab 2 (結衣) selected, showing her name, subtitle and personality over the classroom background">
</p>
<p align="center"><sub>Home · Chat history with tips and readings · Tips notebook · Quick lookup · Settings · Characters · Other tutors (Yuma, Yui; black-and-white UI on the classroom background; all screenshots use demo data)</sub></p>

- **Japanese conversation**: Mugi replies in Japanese. Each Japanese phrase is followed by a short Chinese meaning in brackets, which is shown but not spoken. Kanji get their readings automatically.
- **Small tips (小提醒)**: Tips are saved in a notebook. You can practise a tip out loud or by typing, and the app judges your answer.
- **Quick lookup (速查)**: Reading, Chinese meaning, a JLPT-style level and examples, kept in a history.
- **Conversation starters**: Mugi can open a new topic from a built-in bank of 100 sentences, without calling the API.
- **Spoken replies with lip-sync**: Choose the browser's voice, VOICEVOX, Google or Azure for Chinese and Japanese separately (see [AI services](#ai-services)).
- **Voice input**: Speak to type, using the browser's speech recognition, or turn on continuous voice conversation.
- **Background music**: A looping track plays while you study. It is a track generated by the author with YuE2 and is MIT licensed like the rest of the project. Replace `public/audio/bgm.mp3` to use your own; if the file is missing, there is no music and no error.
- **Black-and-white dark interface** and **free zoom and pan** of her picture (pinch, drag, double-tap to reset).
- **Usage panel** in the settings: characters spoken per cloud voice tier and Claude requests, with cost estimates.
- **Characters, pictures, backgrounds and voices**: the 人物 button (top left) holds three built-in tutors (むぎ the hamster, 結衣 a high-school student, 悠真 a university student) and up to 8 in all; each has her own name, persona, picture (one picture or frames that follow the mouth, with a position you can set and keep), voice (female, male or a chosen voice) and chat history. The background is a classroom by default (characters on the lectern); add up to 6 pictures of your own or choose plain black, and zoom the background on its own. Pictures stay in the browser only.
- **Your own tutor persona**: change her personality and name on the 人物 page (up to 400 characters) — for example, to practise Kansai or Osaka dialect, write 「說話用大阪腔」. Only the personality line changes; the reply format and teaching rules stay. After a change, the chat starts again from the next line.

## Architecture overview

The architecture diagram ([`docs/img/architecture.svg`](docs/img/architecture.svg)) and the highlight images are in Chinese.

<p align="center"><img src="docs/img/architecture.svg" alt="System architecture diagram" width="100%"></p>

The phone talks only to the `/api` routes of the dev server on your PC. The server holds the keys and makes every call to Claude, ChatGPT (OpenAI), the local model, Google, Azure and VOICEVOX, so the only things that reach the phone are replies, audio and the page itself. Settings, chat history, tips and lookups are stored in the phone's (or browser's) `localStorage`; character and background pictures are kept in the browser's IndexedDB.

## Quick start

Requires **Node.js 20 or newer** (tested with Node.js 24) and at least one of an **Anthropic (Claude) API key**, a **ChatGPT account** or a **local model on the PC** such as Ollama (see [AI services](#ai-services)).

```bash
npm install
cp .env.example .env.local      # Windows: copy .env.example .env.local
```

Open `.env.local` in a text editor and set `ANTHROPIC_API_KEY` (skip this if you use only ChatGPT or a local model; sign in or turn it on from the settings on the PC instead). Then start the development server:

```bash
npm run dev
```

Open <http://localhost:3004> on the PC. The port is 3004 and is strict (the server will not switch to another port).

By default the dev server listens on this PC only (`127.0.0.1`). To use it from a phone, the safest way is Tailscale Serve, described in [Using from your phone](#using-from-your-phone). Opening `http://<your-PC-address>:3004` from another device works only if you set `MUGI_LAN=1` in the shell before `npm run dev`, and that exposes the server to everyone on the same network (see [Security](#security)).

> **Warning:** the dev server uses your API key to call Claude, and it has no login of its own. Do not expose it to the internet. Anyone who can reach it can spend your credits.

## AI services

You need at least one of Claude, ChatGPT and a local model (with more than one, they are used in the order set under 「AI 服務」, and an error moves to the next one). The voice services are optional.

- **Claude (pick at least one)**: Chat, the 速查 lookup, the 小提醒 rewrite and the speaking check can use the Anthropic API. Create a key in the [Anthropic Console](https://console.anthropic.com/) and put it in `.env.local` as `ANTHROPIC_API_KEY`. If your key is scoped to a workspace, also set `ANTHROPIC_WORKSPACE_ID`. The default model is Haiku 5.5 (`claude-haiku-5-5`), set by `CLAUDE_MODEL_DEFAULT` in `src/game/claudeProtocol.ts`; set `ANTHROPIC_MODEL` to use Opus 5.5 or another model (Opus costs more per token, so the same daily cap buys fewer sentences). Anthropic bills API usage to the account that owns the key, so set a spending limit in the Console. In the settings you can pick the chat model (by default the server's own), choose a separate model for 速查 and 小提醒, and write your own persona (see [Features](#features)).
- **ChatGPT (pick at least one)**: sign in with your own ChatGPT account (OpenAI's official OAuth). No OpenAI API key is needed; usage counts against your ChatGPT plan, not the daily budget. Open the app on the PC and press 「用 ChatGPT 登入」 under 「AI 服務」 in ⚙️ Settings. The sign-in data is kept in your user folder on the PC (`~/.mugi-tutor`, or the folder named by `MUGI_DATA_DIR`), never in the project folder and never sent to the phone. On Windows it is encrypted (the key is protected by Windows); on other systems it is a plain file readable only by your account. After signing in you can pick the ChatGPT model and put ChatGPT before or after Claude. Under OpenAI's terms, don't share your account.
- **Local model (pick at least one)**: run a free open model on the PC. No key is needed, it does not count against the daily budget, and the chat never leaves your PC (or your home network). Any server with an OpenAI-compatible API works, such as [Ollama](https://ollama.com/), [LM Studio](https://lmstudio.ai/) or llama.cpp's `llama-server`. With Ollama: install it, download a model that is good at Chinese and Japanese (for example `ollama pull qwen3:8b`), and turn on 「本地模型」 under 「AI 服務」 in ⚙️ Settings. By default it connects to `http://127.0.0.1:11434/v1` and uses the first model in the list. For another server or a specific model, fill in 「本地模型網址」 and 「模型名稱」 in the settings on the PC (written to `.env.local` as `LOCAL_LLM_URL` and `LOCAL_LLM_MODEL`; set `LOCAL_LLM_API_KEY` too if the server needs a key).
  - All kanji readings come from the server's kuromoji: the model is asked not to write them, and any it writes are removed first (small models often get them wrong).
  - The system prompt and the chat history take up to about 8K tokens. Ollama's default context may be shorter: raise it to 8192 or more (for example set `OLLAMA_CONTEXT_LENGTH=8192` before starting Ollama), or the rules at the start get cut off.
  - Models that "think" first (such as Qwen3) are slower on every line; use a model without thinking, or turn thinking off in the server.
  - A model of 8B or more with a graphics card is recommended (the 4-bit 8B models need about 6 GB of video memory); on the CPU alone it is slow. Small models are weaker than Claude at correcting mistakes and explaining them.
- **Keys and the ChatGPT sign-in are done on the PC**: the 「AI 服務」 and 「金鑰」 sections of ⚙️ Settings take the Claude, Google and Azure keys. They are written to `.env.local` on the PC, and only the last four characters are shown. ChatGPT is signed in and out only on the PC (open the app at 127.0.0.1, with the 「用 ChatGPT 登入」 and 「登出」 buttons). On the phone the keys and the ChatGPT sign-in are read-only, but the phone can still pick the models (Claude chat, helper and ChatGPT), change the order and the on/off of the AI services, and change the daily budget under 「每日預算上限」 (0 means no cap).
- **Optional voices**: Spoken replies use the browser voice by default. You can change the engine for Chinese and Japanese separately in ⚙️ > 聲音 (Settings > Voice).
  - **Browser (default).** Uses the device's own speech synthesis. Nothing to configure.
  - **VOICEVOX.** Install the VOICEVOX engine on the PC. Put the engine in the project's `voicevox_engine/` folder and no setting is needed. Set `VOICEVOX_DIR` (the engine folder) only when the engine is somewhere else; when the switch is on, the dev server starts the engine, and if none is found the switch refuses to start it. Or set `VOICEVOX_URL` (the address of an engine that is already running; default `http://127.0.0.1:50021`). These variables are read from the shell that runs `npm run dev`, not from `.env.local`. Follow the terms of use of the engine and of each voice character, and credit the character as `VOICEVOX:<character name>`.
    - **Installing the VOICEVOX engine (optional)**
      1. Download the `.vvpp` for your system from the [VOICEVOX ENGINE Releases](https://github.com/VOICEVOX/voicevox_engine/releases) page. On Windows without an NVIDIA GPU, pick `windows-cpu`. It is a ZIP file and can be extracted directly.
      2. Extract it into `voicevox_engine/` in the project folder (already listed in `.gitignore`, so it is never committed). The engine may sit directly in that folder or in one sub-folder of it (the folder an archive unpacks to). Anywhere else works too, but then set `VOICEVOX_DIR` (step 3).
      3. In the project's `voicevox_engine/` folder no setting is needed: just run `npm run dev`. Elsewhere, set `VOICEVOX_DIR` before starting the dev server: PowerShell `$env:VOICEVOX_DIR = "C:\path\to\engine"; npm run dev`; macOS／Linux `VOICEVOX_DIR=/path/to/engine npm run dev`.
      4. Turn VOICEVOX on in ⚙️ > Voice (Settings > Voice), and the server starts the engine.
      - You can also let a script download the engine, verify its SHA-256 and unpack it: Windows `powershell -ExecutionPolicy Bypass -File scripts/get-voicevox.ps1`, macOS／Linux `bash scripts/get-voicevox.sh` (add `-DryRun` / `--dry-run` to only list the files it would download). The script checks each download against the SHA-256 published with the same GitHub release: this catches a broken or incomplete download, but not a replaced release, because the published hash would be replaced along with the file, so it does not prove where the file came from. The script unpacks to `voicevox_engine/`, so no `VOICEVOX_DIR` setting is needed afterwards. If a script breaks, follow steps 1–4 above by hand.
      - The engine is not covered by this project's MIT licence. Read the engine's terms of use and each voice character's terms before you use it, and credit characters as `VOICEVOX:<character name>`.
  - **Google Cloud Text-to-Speech** and **Azure AI Speech.** Fill in `GOOGLE_TTS_API_KEY`, or `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION`, in `.env.local`. Both have a monthly free allowance. When a voice reaches 90% of its allowance, the app switches to a cheaper free tier, then to Azure (for Google requests, when Azure is configured), and finally to the browser voice. Usage is shown in the settings.

## Using from your phone

The dev server listens on this PC only, so a phone reaches it through an HTTPS address. Most features work there, and iOS speech recognition needs HTTPS anyway. The steps below use [Tailscale](https://tailscale.com/download) serve, which gives the PC an HTTPS address that is reachable only within your own tailnet. Any other HTTPS reverse proxy to `127.0.0.1` that you trust works the same way. (Direct access at `http://<PC address>:3004` needs `MUGI_LAN=1`, see [Security](#security).)

1. Install Tailscale on the PC and on the phone, and sign in with the same account.
2. Start the dev server (`npm run dev`), then in a second terminal on the PC run:

   ```bash
   tailscale serve --https=443 --bg http://127.0.0.1:3004
   ```

   Check the address with `tailscale serve status`. To turn it off, run `tailscale serve --https=443 off`.
3. If the phone shows a "Blocked request" or "host not allowed" message, Vite does not recognise the name you opened. The simplest fix: in the same shell that runs `npm run dev`, set `MUGI_ALLOWED_HOSTS=<your ts.net name>` (separate several names with commas). Or add that host to `server.allowedHosts` and `preview.allowedHosts` in `vite.config.ts`, as the comment in that file shows (for example `allowedHosts: ['.example.com']`). Keep your own hostname out of commits. **Note:** a leading-dot entry such as `.ts.net` admits every machine under that domain, which on a tailnet means every device in it; list the exact machine name instead, for example `mypc.tailnet.ts.net`.
4. Open the HTTPS address on the phone. Optionally, choose "Add to Home Screen" in the browser.

> **Warning:** the dev server's `/api` routes spend your API key. Only open it to your own devices. Do not use Tailscale Funnel or any public reverse proxy in front of it, and do not run it on a shared network.

## Data & privacy

- **Keys stay on the PC.** The API key and the cloud voice keys are read by the dev server from `.env.local` and are never sent to the phone.
- **Chat messages go to the service you use** to get replies: Anthropic for Claude, OpenAI for ChatGPT. Text goes to Google or Azure only when you choose those voices.
- **Tips, the lookup history, chat history and settings** are stored in the browser's `localStorage`, and character and background pictures in its IndexedDB, all on the device you use.
- **Caches, usage counts and the ChatGPT sign-in** are stored on the PC: the speech cache in `.tts-cache/`, the usage counts in `.usage/`, and the sign-in in `~/.mugi-tutor/` (or `MUGI_DATA_DIR`). The first two are git-ignored, and so are `.env.local` and the other local files.

## Security

- **Local only by default.** `npm run dev` listens on `127.0.0.1`, so nothing else on your network can reach it. Setting `MUGI_LAN=1` (then restarting) listens on all interfaces. Anyone on that network can then spend your Claude credits and use your speech services, so use it only on a network you trust, or prefer Tailscale Serve.
- **Phones: use Tailscale Serve** (or another HTTPS reverse proxy to `127.0.0.1`), as in [Using from your phone](#using-from-your-phone). Do not use Tailscale Funnel or a public proxy.
- **Changing settings is limited to trusted connections.** "This PC" and "trusted" are decided by the connection's address (the socket), not only by the Host header: the request must come from a loopback address (127.0.0.1 or ::1), and its Host must be localhost, 127.0.0.1, `::1` or a name in `server.allowedHosts` (the Tailscale Serve name; Tailscale Serve connects from 127.0.0.1). Changing the daily budget is accepted only for such requests; a daily cap of 0 (no cap) can be set only from this PC, while a phone may set any value from 0.01 to 100. A request that reaches the server from an IP address (a LAN connection with `MUGI_LAN=1`) is refused with 403 whatever Host it sends. Writing the keys, and signing ChatGPT in or out, is accepted only from this PC (a loopback connection, Host 127.0.0.1 or localhost, and no proxy header): even a trusted name such as the Tailscale one is refused with 403.
- **LAN pairing code.** With `MUGI_LAN=1`, each `/api` request that comes in by IP address (not localhost, not a Tailscale name) must carry the `X-Mugi-Pair` header, set to the `MUGI_LAN 配對碼：…` code the server prints once at startup. Without it, or with a wrong code, the server returns 403 「區網連線需要配對碼」 (LAN connections need a pairing code). The app asks for the code the first time, keeps it in the browser's `localStorage` and sends it after that. Restarting the server makes a new code. The code guards only LAN requests and does not replace the host-name rules above. A request whose connection is not from a loopback address needs the code whatever Host it sends, and it still cannot change settings or sign ChatGPT in or out.
- **Cross-site requests are refused.** Every `/api` route refuses requests that a browser sends from another site: `Sec-Fetch-Site` must be `same-origin` or `none` (or absent). `Origin` must be http or https, with the same host and port as `Host` (the Tailscale Serve https origin matches the ts.net host name). Every POST, PUT and DELETE must have `Content-Type: application/json` (a `charset` may be added). The Host name must be `localhost`, `127.0.0.1`, `::1` or a name listed in `server.allowedHosts` in `vite.config.ts`; an IP address is accepted only with `MUGI_LAN=1` (and a pairing code). The port must be a number from 1 to 65535. So a page that reaches the server under a foreign name is refused too. The `Origin` and `Sec-Fetch-Site` checks rely on the browser sending those headers; the Host, pairing-code and Content-Type checks apply to every request. The settings and ChatGPT routes check these browser headers once more inside.
- **Limits on Claude calls.** At most `MUGI_CHAT_PER_MINUTE` chat requests (chat, 小提醒 checks and rewrites) start per minute, default 20 (`0` means no limit), and two run at once. `MUGI_DAILY_USD` caps the estimated Claude cost per local day, default 2 USD; the 速查 lookup counts toward it too. Once the cap is reached, Claude calls return 429 until the next day. Set `MUGI_DAILY_USD=0` for no cap. The figure is an estimate (it uses the prices in `server/usage.ts`; a model with no price is charged at the highest price in that table, a stream the player leaves or that times out is charged its output by reply length and marked as an estimate, and an upstream error with no usage is only counted as an error), and it is not your bill: the spend limit in the Anthropic Console is the authoritative one.
- **Quick lookup and message length.** Quick lookup (速查) has its own fixed limit of 20 per minute, not changed by `MUGI_CHAT_PER_MINUTE`. A chat message is capped at 1,900 characters.
- **Set a spend limit in the Anthropic Console as well.** The Console limit is enforced by Anthropic, whatever this server does.
- **VOICEVOX starts only from the project's `voicevox_engine/` folder or the folder `VOICEVOX_DIR` names.** The server never looks for the engine in the working folder or anywhere else.
- The settings are described in `.env.example`.

## Pre-release red-team review

For the full security design, see [docs/decisions/security-review.md](docs/decisions/security-review.md).

## Development

```bash
npm test          # mocked: no real API calls
npm run build     # tsc -b && vite build
npm run dev       # development server on port 3004
```

The tests do not call any real API: network calls are stubbed. `npm run preview` serves the built files on port 4173.

## Disclaimer

This is an independent project. It does not include any artwork, music or text from any existing game or third party. The background track was generated by the author with YuE2. It is not affiliated with or endorsed by Anthropic, OpenAI, Google, Microsoft or VOICEVOX. AI replies can be wrong, so please use your own judgment when you study with them and check anything important against a reliable source. The third-party libraries it uses are listed in [NOTICE.md](NOTICE.md).

## Maintenance status

This is a personal project. There is no guarantee of ongoing maintenance, and issues may not get replies or PRs be merged. Feel free to fork it and adapt it to your own needs.

## License

The code, the hamster character art in `public/characters/mugi/`, the pictures of Yui and Yuma in `public/characters/yui/` and `public/characters/yuma/`, the classroom background `public/backgrounds/classroom.webp` (generated by the author with ChatGPT), the app icons and the background music are all released under the [MIT License](LICENSE). Third-party components and their licenses (including soundtouchjs under LGPL-2.1 and kuromoji with its dictionary) are listed in [NOTICE.md](NOTICE.md).
