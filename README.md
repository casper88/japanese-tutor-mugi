**繁體中文** | [English](README.en.md)

# むぎ 日語家教 · Mugi Tutor

這是一個適合手機使用的網頁 app，讓你和倉鼠 むぎ（Mugi）一對一練日語會話。むぎ 是由 Claude 驅動的可愛卡通倉鼠家教（前端是 React 與 Vite，API 金鑰只留在電腦上的開發伺服器裡）。你用日文或中文跟她說話，她用日文回答，app 會幫你從她的話裡學習。介面與解說都是繁體中文。

> **授權：** 本專案以 [MIT 授權](LICENSE)開放原始碼。你可以自由使用、修改與再散布。**若你製作衍生作品或再散布，請保留原始的版權聲明與完整的 MIT 授權全文。** 第三方元件維持其各自的授權，見 [NOTICE.md](NOTICE.md)。

## 亮點

<p align="center"><img src="docs/img/highlights.svg" alt="亮點總覽" width="100%"></p>

- **多層快取**：聊得越久，重複的部分越不用重算。雲端用 Anthropic 提示快取，地端的語音有記憶體與硬碟兩層快取。系統提示詞與舊紀錄走 Claude 的 5 分鐘提示快取，只有最新一句要重算；本機 VOICEVOX 念過的句子再念一次，從 3.7 秒降到 19 毫秒（合成與快取命中各量 10 次取中位數，見 [0006](docs/decisions/0006-tts-cache.md)）。提示快取的細節見 [0002](docs/decisions/0002-prompt-cache.md)。
- **小提醒本**：說錯的地方自動存成中文小提醒，開口或打字練到會；本機比對不出來才請 Claude 判斷。
- **速查**：中日文都能問說法、單字、文法；回傳讀音、中文、JLPT 等級與例句，不打斷對話。
- **自帶 API 金鑰**：填自己的 Claude 金鑰就能用，金鑰只留在本機伺服器；有每日花費上限（預設 2 美元）與每分鐘次數限制。語音也能接自己的 Google／Azure 金鑰。預設每日 2 美元約可講 Haiku 5.5 5,865 句、Opus 5.5 146 句（估算）。
- **漢字讀音不漏標**：LLM 標註讀音，漏掉的由伺服器的 kuromoji 補上。
- **語音與嘴型**：本機 VOICEVOX 或雲端 Google／Azure，嘴型跟著音節動。
- **內建開話題題庫**：內建 100 句題庫，不呼叫 API 也能開新話題。
- **語音輸入（STT）**：開口就聊，也支援打字修正。說完先變成文字，送出前可改；也能連續語音對話，中文、日文都能聽。

## 設計理由

- **提示快取讓重複的回合更便宜**：系統提示詞與穩定不變的歷史紀錄都有快取點。每回合會變的提醒只附在最新一則訊息上，所以較早的訊息在每次請求之間位元組完全相同。聊天紀錄以最多 39 行的視窗送出，超過時從最近 20 行重新開始。超過一小時沒有真正的來回對話，下一次請求只送最近 5 行（小提醒不會送回去）。
- **聊天也用 JSON Schema，前端用寬鬆的部分 JSON 解析邊收邊顯示**：むぎ 的回覆是 Structured Outputs 的 JSON 物件（`segments`、`tip`、`tone`），格式由 API 保證。手機邊收邊讀這份 JSON：每段寫到哪就顯示到哪，日文段寫完就送去念。速查結果、小提醒練習的判斷、小提醒改寫同樣用 Structured Outputs（JSON Schema）保證格式。
- **漢字讀音由伺服器補上，不只靠模型**：伺服器用 kuromoji 補上漢字讀音，讀音不完全取決於模型的輸出。
- **寫成日文的小提醒會在背景改寫**：如果小提醒回來的是日文說明，會在背景送給 Claude Haiku 5.5，每則小提醒改寫一次，改成中文說明，日文只留在 `<ja>` 標籤裡。
- **語音有快取，雲端語音在額度用完前降級**：合成過的語音快取在電腦的 `.tts-cache/`，檔名是快取鍵的 SHA-256，上限 200 MB。雲端語音用量達到免費額度的 90% 時，請求會換到較便宜的免費層級，最後才改用瀏覽器語音。
- **金鑰只在伺服器端**：只有開發伺服器會讀取 `.env.local`，手機收到的只有回覆文字與音訊，沒有金鑰。
- **設計決策紀錄**：上面主要設計各自考慮過的選項、取捨與何時重新評估，都寫在 [docs/decisions/](docs/decisions/README.md)。

## 功能

<p align="center">
  <img src="docs/img/screen-home.png" width="200" alt="首頁：黑白介面與教室背景，講台上的倉鼠 むぎ，對話框裡是一句日文回覆與括號中的中文意思，底部是聊天列">
  <img src="docs/img/screen-characters.png" width="200" alt="其他角色：黑白介面與教室背景，悠真站在講台前，對話框裡是一句日文與括號中的中文意思">
  <img src="docs/img/screen-yui.png" width="200" alt="結衣：高中生坐在講台上，對話框裡是一句關西腔的日文與括號中的中文意思">
  <img src="docs/img/screen-history.png" width="200" alt="聊天紀錄：黑白介面，一則小提醒（含振假名），接著是 むぎ 的日文回覆與括號中的中文意思">
  <img src="docs/img/screen-tips.png" width="200" alt="小提醒本：黑白介面，列出還在練習中的小提醒（附示範、練習按鈕與打字輸入框），並顯示練習中與已學會的數量">
</p>
<p align="center">
  <img src="docs/img/screen-lookup.png" width="200" alt="速查：黑白介面，搜尋框、中日切換，以及一筆「我想去買東西」的查詢結果，含讀音、N5 標籤、中文意思與「〜たい」的文法說明">
  <img src="docs/img/screen-settings.png" width="200" alt="設定：黑白介面，捲動到 AI 服務（Claude、ChatGPT 的先後順序與使用開關）與每日預算上限">
  <img src="docs/img/screen-character.png" width="200" alt="人物：黑白介面，頂部分頁 1、2、3、＋，已選第 2 位「結衣」，下方是名字、副標與人設，背景仍是教室">
</p>
<p align="center"><sub>首頁 · 含小提醒與讀音的聊天紀錄 · 小提醒本 · 速查 · 設定 · 人物 · 其他角色（悠真、結衣；黑白介面與教室背景；截圖全部為示範資料）</sub></p>

- **日文會話**：むぎ 用日文回覆。每段日文後面會附上括號裡的中文意思，會顯示但不會被朗讀。漢字會自動標上讀音。
- **小提醒**：提醒會存進小提醒本。你可以開口或打字練習，app 會判斷你的回答對不對。
- **速查**：讀音、中文意思、JLPT 式級數與例句，並留下查詢紀錄。
- **開話題**：內建 100 句題庫，她可以主動開新話題，不呼叫 API。
- **語音朗讀與嘴型**：中文與日文可以分別選擇瀏覽器語音、VOICEVOX、Google 或 Azure（見[AI 服務](#ai-服務)）。
- **語音輸入**：用瀏覽器的語音辨識把話說成文字，也可以開啟連續的語音對話。
- **背景音樂**：學習時會循環播放一首背景音樂。這首曲子由作者使用 YuE2 生成，與專案其他部分一樣以 MIT 授權釋出。想換成自己的音樂就替換 `public/audio/bgm.mp3`；沒有這個檔案時不會播放，也不會報錯。
- **黑白的深色介面**，以及**自由縮放**她的圖片（雙指縮放、拖曳移動、點兩下還原）。
- **用量面板**（在設定裡）：顯示各雲端語音層級的字數與 Claude 請求次數，並附估算費用。
- **人物、圖片、背景與聲音**：左上角的「人物」有 1～3 號內建角色（むぎ、高中生結衣、大學生悠真）並可再新增（最多 8 位），每位各自有名字、人設、圖片（單張或依嘴型換圖，位置可調並記住）、聲音（男女聲或指定聲音）與聊天紀錄；背景預設是教室（角色在講台上），也能新增自己的圖（最多 6 張）或選純黑，縮放可以單獨調整背景。圖片都只存在瀏覽器裡。
- **自訂日語家教人設**：在「人物」裡改她的個性和名字（最多 400 字），例如想練關西腔、大阪腔，就寫「說話用大阪腔」；只換個性那一行，回覆格式與教學規則不變。改了之後，聊天會從新的一句重新開始。

## 架構概覽

架構圖（[`docs/img/architecture.svg`](docs/img/architecture.svg)）與亮點圖都是中文。

<p align="center"><img src="docs/img/architecture.svg" alt="系統架構圖" width="100%"></p>

手機只會連到電腦上開發伺服器的 `/api` 路由。伺服器保管金鑰，並負責所有對 Claude、ChatGPT（OpenAI）、本地模型、Google、Azure 與 VOICEVOX 的呼叫，所以傳到手機的只有回覆、音訊與頁面本身。設定、聊天紀錄、小提醒與速查紀錄存在手機（或瀏覽器）的 `localStorage`；人物與背景的圖片存在瀏覽器的 IndexedDB。

## 快速開始

需求：**Node.js 20 以上**（本專案在 Node.js 24 上測試過），再加上 **Claude（Anthropic）API 金鑰、ChatGPT 帳號，或電腦上的本地模型（例如 Ollama）** 其中至少一種（見[AI 服務](#ai-服務)）。

```bash
npm install
cp .env.example .env.local      # Windows 請用：copy .env.example .env.local
```

用文字編輯器打開 `.env.local`，填入 `ANTHROPIC_API_KEY`（只用 ChatGPT 或本地模型的話可以略過，改在電腦上的設定裡登入或開啟）。接著啟動開發伺服器：

```bash
npm run dev
```

在電腦上打開 <http://localhost:3004>。埠號是 3004，而且是固定的（伺服器不會自動換到其他埠）。

預設情況下，開發伺服器只監聽這台電腦（`127.0.0.1`）。要用手機連線，最安全的做法是 Tailscale Serve，見[用手機使用](#用手機使用)。若要從其他裝置直接打開 `http://<電腦的位址>:3004`，必須在執行 `npm run dev` 前於 shell 設定 `MUGI_LAN=1`；這會讓同一網段的所有人都能連到伺服器（見[安全性](#安全性)）。

> **注意：** 開發伺服器會用你的 API 金鑰呼叫 Claude，而且它本身沒有登入功能。不要把它開放到網路上，能連到它的人都可以花掉你的額度。

## AI 服務

Claude、ChatGPT 與本地模型至少要有一個（設定多個時，依「AI 服務」裡的順序使用，出錯自動換下一個）；語音服務都是選用。

- **Claude（至少選一）**：聊天、速查、小提醒改寫與口說判斷可以使用 Anthropic API。到 [Anthropic Console](https://console.anthropic.com/) 建立金鑰，並把它填入 `.env.local` 的 `ANTHROPIC_API_KEY`。如果你的金鑰綁定在 Workspace 上，也要設定 `ANTHROPIC_WORKSPACE_ID`。預設模型是 Haiku 5.5（`claude-haiku-5-5`），由 `src/game/claudeProtocol.ts` 的 `CLAUDE_MODEL_DEFAULT` 決定；如要改用 Opus 5.5 或其他模型，設定 `ANTHROPIC_MODEL`（Opus 單價較高，同樣的每日上限能講的句數較少）。API 用量由 Anthropic 依金鑰所屬的帳號計費，建議在 Console 設定消費上限。設定裡可以為聊天選模型（預設依伺服器設定），速查與小提醒有各自的模型，也可以自訂人設（見[功能](#功能)）。
- **ChatGPT（至少選一）**：用自己的 ChatGPT 帳號登入（OpenAI 官方 OAuth），不需要 OpenAI API 金鑰，用量算在你的 ChatGPT 方案額度，不計入每日預算上限。在電腦上開 App，到 ⚙️ 設定的「AI 服務」按「用 ChatGPT 登入」；登入資料存在電腦的使用者資料夾（`~/.mugi-tutor`，可用環境變數 `MUGI_DATA_DIR` 改位置），不會進專案資料夾，也不會傳到手機。Windows 上會加密（金鑰由 Windows 保護）；其他系統是不加密的檔案，權限只開給你的帳號。登入後可以選 ChatGPT 的模型，並把 ChatGPT 排到 Claude 前面或後面。依 OpenAI 條款，請勿分享帳號。
- **本地模型（至少選一）**：在電腦上跑免費的開源模型，不需要金鑰、不計入每日預算上限，對話也不會離開你的電腦（或家裡的網路）。支援提供 OpenAI 相容 API 的伺服器，例如 [Ollama](https://ollama.com/)、[LM Studio](https://lmstudio.ai/) 或 llama.cpp 的 `llama-server`。用 Ollama 的話：安裝後下載一個中日文都好的模型（例如 `ollama pull qwen3:8b`），在 ⚙️ 設定的「AI 服務」打開「本地模型」即可；預設連 `http://127.0.0.1:11434/v1`，用清單裡第一個模型。用其他伺服器或指定模型時，在電腦上的設定填「本地模型網址」與「模型名稱」（寫進 `.env.local` 的 `LOCAL_LLM_URL`、`LOCAL_LLM_MODEL`；伺服器需要金鑰時另外設定 `LOCAL_LLM_API_KEY`）。
  - 漢字讀音全部由伺服器的 kuromoji 標註：模型不用寫，寫了也會先被拿掉（小模型常標錯）。
  - 系統提示加上對話紀錄最多約 8K token。Ollama 的預設長度上限可能比這短，請調到 8192 以上（例如啟動 Ollama 前設定環境變數 `OLLAMA_CONTEXT_LENGTH=8192`），不然前面的規則會被截掉。
  - 會「思考」的模型（例如 Qwen3）每句都會慢一些，可以改用不思考的模型，或在伺服器上關掉思考。
  - 建議用 8B 以上的模型並有顯示卡（8B 的 4-bit 版本大約需要 6 GB 顯示記憶體）；只用 CPU 會很慢。小模型的糾錯和解說會比 Claude 弱。
- **金鑰與 ChatGPT 登入在電腦上完成**：⚙️ 設定的「AI 服務」與「金鑰」可以填入 Claude、Google 與 Azure 的金鑰，它們會寫進電腦上的 `.env.local`，畫面只顯示末四碼。ChatGPT 的「用 ChatGPT 登入」與「登出」也只能在電腦上按（用 127.0.0.1 開啟 App）。手機上金鑰與 ChatGPT 登入只能看狀態，不能改；但手機可以選模型（Claude 聊天、小提醒模型與 ChatGPT 模型）、調整 AI 服務的先後順序與開關，並修改每日預算上限（在設定的「每日預算上限」，0 代表不限）。
- **選用語音**：預設使用瀏覽器內建的語音。你可以在 ⚙️ > 聲音 中，分別為中文與日文更換語音引擎。
  - **瀏覽器內建（預設）。** 使用裝置本身的語音合成，不需要設定。
  - **VOICEVOX。** 在電腦上安裝 VOICEVOX 引擎。引擎放在專案資料夾的 `voicevox_engine/` 時不需要設定；放在別處才設定 `VOICEVOX_DIR`（引擎的資料夾）。切換開關開啟時，開發伺服器會自動啟動引擎；找不到引擎時，開關會拒絕啟動。也可以設定 `VOICEVOX_URL`（已經在執行的引擎位址，預設 `http://127.0.0.1:50021`）。這些變數是從執行 `npm run dev` 的 shell 讀取，不是從 `.env.local` 讀取。請遵守引擎與各角色聲音的使用條款，並以 `VOICEVOX:角色名` 的形式標註角色。
    - **安裝 VOICEVOX 引擎（選用）**
      1. 到 [VOICEVOX ENGINE 的 Releases](https://github.com/VOICEVOX/voicevox_engine/releases) 下載對應系統的 `.vvpp`（Windows 沒有 NVIDIA 顯卡選 `windows-cpu`；它是 ZIP 格式，可直接解壓縮）。
      2. 解壓縮到專案資料夾裡的 `voicevox_engine/`（已列在 `.gitignore`，不會被 commit）。引擎可以直接放在這個資料夾裡，或放在它的一層子資料夾裡（.vvpp 解壓縮後的資料夾）。放到其他位置也可以，但那時要設定 `VOICEVOX_DIR`（見步驟 3）。
      3. 放在專案資料夾的 `voicevox_engine/` 就不用設定，直接 `npm run dev`。放在別處才需要設定 `VOICEVOX_DIR`（啟動開發伺服器前）：PowerShell `$env:VOICEVOX_DIR = "C:\路徑\到\引擎"; npm run dev`；macOS／Linux `VOICEVOX_DIR=/路徑/到/引擎 npm run dev`。
      4. 在 ⚙️ > 聲音 開啟 VOICEVOX，伺服器就會啟動引擎。
      - 也可以用腳本自動下載、驗證 SHA-256 並解壓縮：Windows `powershell -ExecutionPolicy Bypass -File scripts/get-voicevox.ps1`，macOS／Linux `bash scripts/get-voicevox.sh`（加 `-DryRun`／`--dry-run` 只列出要下載的檔案）。腳本會把下載的檔案和同一個 GitHub release 上公布的 SHA-256 比對：這能發現下載不完整或損壞的檔案，但擋不住 release 本身被換掉（公布的雜湊也會一起換），所以它不能證明檔案來源可信。腳本預設解壓縮到 `voicevox_engine/`，完成後不用設定 `VOICEVOX_DIR`。腳本壞了的話，請照上面 1～4 步手動安裝。
      - 引擎不屬於本專案的 MIT 授權。使用前請閱讀引擎的使用條款與各角色聲音的條款，並以 `VOICEVOX:角色名` 標註角色。
  - **Google Cloud Text-to-Speech** 與 **Azure AI Speech。** 在 `.env.local` 填入 `GOOGLE_TTS_API_KEY`，或 `AZURE_SPEECH_KEY` 與 `AZURE_SPEECH_REGION`。兩者都有每月免費額度。某個語音的用量達到 90% 時，app 會自動降級：先換到較低的免費層級，再改用 Azure（Google 的請求且已設定 Azure 時），最後才用瀏覽器語音。用量可以在設定中查看。

## 用手機使用

開發伺服器只監聽這台電腦，所以手機要透過 HTTPS 位址連線。大部分功能都能用，而 iOS 的語音辨識本來就需要 HTTPS。下面的步驟以 [Tailscale](https://tailscale.com/download) serve 為例，它會給電腦一個只有你的 tailnet 能連到的 HTTPS 位址。使用你信任的其他 HTTPS 反向代理（代理到 `127.0.0.1`）也可以，做法相同。（要用 `http://<電腦的位址>:3004` 直接連線，需要 `MUGI_LAN=1`，見[安全性](#安全性)。）

1. 在電腦與手機上安裝 Tailscale，並以同一個帳號登入。
2. 啟動開發伺服器（`npm run dev`），然後在電腦上另開一個終端機執行：

   ```bash
   tailscale serve --https=443 --bg http://127.0.0.1:3004
   ```

   用 `tailscale serve status` 查看位址。要關閉時執行 `tailscale serve --https=443 off`。
3. 如果手機出現 "Blocked request" 或 "host not allowed" 的訊息，代表 Vite 不認得你打開的主機名稱。最簡單的做法是在執行 `npm run dev` 的同一個 shell 設定 `MUGI_ALLOWED_HOSTS=<你的 ts.net 名稱>`（多個用逗號分隔）；也可以依 `vite.config.ts` 裡的註解，把那個主機名稱加到 `server.allowedHosts` 與 `preview.allowedHosts`（例如 `allowedHosts: ['.example.com']`）。你自己的主機名稱不要 commit 進專案。**注意：** 以前導點開頭的名稱（例如 `.ts.net`）會允許該網域下的每一台機器，在 tailnet 裡就等於同一個 tailnet 的所有裝置。請列出電腦的確切名稱，例如 `mypc.tailnet.ts.net`。
4. 在手機上打開 HTTPS 位址。需要的話，可以在瀏覽器中選擇「加到主畫面」。

> **注意：** 開發伺服器的 `/api` 路由會消耗你的 API 金鑰。只開給自己的裝置。不要使用 Tailscale Funnel，也不要在它前面架設公開的反向代理，更不要放在共用網路上執行。

## 資料與隱私

- **金鑰留在電腦上。** API 金鑰與雲端語音的金鑰由開發伺服器從 `.env.local` 讀取，不會傳到手機。
- **聊天內容依所用服務送出**：Claude 送到 Anthropic，ChatGPT 送到 OpenAI，以取得回覆。只有當你選擇 Google 或 Azure 語音時，文字才會送到那些服務。
- **小提醒、速查紀錄、聊天紀錄與設定** 存在瀏覽器的 `localStorage`，人物與背景的圖片存在 IndexedDB，都在你使用的那台裝置上。
- **快取、用量統計與 ChatGPT 登入資料** 存在電腦上：語音快取在 `.tts-cache/`，用量統計在 `.usage/`，登入資料在 `~/.mugi-tutor/`（或 `MUGI_DATA_DIR`）。前兩者都已被 git 忽略，`.env.local` 與其他本機檔案也一樣。

## 安全性

- **預設只限本機。** `npm run dev` 只監聽 `127.0.0.1`，同一網路上的其他裝置連不到它。設定 `MUGI_LAN=1`（然後重新啟動）會改為監聽所有網路介面。這時同一網路上的人都能花掉你的 Claude 額度、使用你的語音服務，所以只在你信任的網路上使用，或改用 Tailscale Serve。
- **手機請用 Tailscale Serve**（或其他代理到 `127.0.0.1` 的 HTTPS 反向代理），做法見[用手機使用](#用手機使用)。不要使用 Tailscale Funnel 或公開的代理。
- **改設定只限受信任的連線。** 「本機」與「受信任」由連線的來源位址（socket）決定，不只看 Host 標頭：來源必須是回送位址（127.0.0.1、::1），Host 再是 localhost、127.0.0.1、`::1` 或 `server.allowedHosts` 裡的名稱（Tailscale Serve 的名稱，它從 127.0.0.1 連進伺服器）。修改每日預算只接受這樣的請求；每日上限設為 0（不限）只能在電腦上操作，手機可以設 0.01 到 100。以 IP 位址連進來的請求（`MUGI_LAN=1` 的區網連線）不論送什麼 Host，都會被拒絕（403）。寫入金鑰、登入與登出 ChatGPT 則只接受這台電腦本機（來源是回送位址、Host 為 127.0.0.1 或 localhost、沒有代理標頭）的請求，手機即使用受信任的名稱連入，也會被拒絕（403）。
- **區網配對碼。** `MUGI_LAN=1` 時，以 IP 位址連進來（不是 localhost、不是 Tailscale 名稱）的每個 `/api` 請求都必須帶 `X-Mugi-Pair` 標頭，值是伺服器啟動時在終端機印出一次的 `MUGI_LAN 配對碼：…`；沒有或不對就回 403「區網連線需要配對碼」。App 第一次遇到時會請你輸入這個配對碼，存在該瀏覽器的 localStorage，之後自動帶上。重新啟動伺服器會換一組新的配對碼。配對碼只擋區網請求，不取代上面的主機名稱規則。來源不是回送位址的請求，不論 Host 寫什麼，都必須帶配對碼，而且仍不能改設定或登入 ChatGPT。
- **拒絕跨站請求。** 每個 `/api` 路由都會拒絕瀏覽器從其他網站發出的請求：`Sec-Fetch-Site` 只接受 `same-origin` 或 `none`（或沒有這個標頭）；`Origin` 必須是 http 或 https，且主機與連接埠都與 `Host` 相同（Tailscale Serve 的 https 來源與 ts.net 主機名稱會相符）。所有 POST、PUT、DELETE 的 `Content-Type` 必須是 `application/json`（可加 `charset`）。連線的主機名稱必須是 `localhost`、`127.0.0.1`、`::1`，或列在 `vite.config.ts` 的 `server.allowedHosts` 中的名稱；IP 位址只有在 `MUGI_LAN=1` 時才接受（且要有配對碼）。連接埠必須是 1 到 65535 的數字。因此以外部名稱連到伺服器的網頁也會被拒絕。`Origin` 與 `Sec-Fetch-Site` 的檢查依賴瀏覽器會送出這些標頭；主機名稱、配對碼與 Content-Type 的檢查適用於每個請求。設定與 ChatGPT 路由在內部會再檢查一次這些瀏覽器標頭。
- **Claude 呼叫的限制。** 每分鐘最多開始 `MUGI_CHAT_PER_MINUTE` 次聊天請求（聊天、小提醒的判斷與改寫），預設 20 次（`0` 代表不限），同時最多執行兩個。`MUGI_DAILY_USD` 是每個本地日的 Claude 花費估算上限，預設 2 美元；速查也會計入。達到上限後，Claude 呼叫會回傳 429，直到隔天為止。設定 `MUGI_DAILY_USD=0` 代表不限。這是估算值（使用 `server/usage.ts` 中的價格；沒有定價的模型以價格表中最貴的價格計算；用戶端中斷或逾時的串流以回覆字數估算輸出，且一律標為估算；上游錯誤且沒有 usage 時只記錄錯誤次數），不是實際帳單；以 Anthropic Console 的 spending limit 為準。
- **速查與訊息長度。** 速查另有固定的每分鐘 20 次上限，不受 `MUGI_CHAT_PER_MINUTE` 影響。一則聊天訊息最多 1,900 字。
- **也請在 Anthropic Console 設定消費上限。** Console 的上限由 Anthropic 強制執行，不受這個伺服器影響。
- **VOICEVOX 只會從專案資料夾的 `voicevox_engine/` 或 `VOICEVOX_DIR` 指定的資料夾啟動，伺服器不會到工作資料夾或其他位置尋找引擎。**
- 各項設定的說明見 `.env.example`。

## 開源前的紅隊審查

安全設計的完整說明見 [docs/decisions/security-review.md](docs/decisions/security-review.md)。

## 開發

```bash
npm test          # 模擬，不會呼叫真實的 API
npm run build     # tsc -b && vite build
npm run dev       # 開發伺服器，埠號 3004
```

測試不會呼叫任何真實的 API，網路呼叫都以替身取代。`npm run preview` 會在埠號 4173 提供建置後的檔案。

## 聲明

本專案為獨立作品，不包含任何既有遊戲或第三方的美術、音樂或文字素材。背景音樂由作者使用 YuE2 生成。本專案與 Anthropic、OpenAI、Google、Microsoft 或 VOICEVOX 無關聯，也未獲其認可。AI 的回覆可能有錯，學習時請自行判斷，重要的內容請對照可靠的來源確認。它所使用的第三方程式庫列在 [NOTICE.md](NOTICE.md)。

## 維護狀態

這是個人專案，不保證持續維護，議題可能沒有回覆，PR 也可能不會被合併。歡迎 fork 它，依你自己的需要修改。

## 授權

程式碼、`public/characters/mugi/` 中的倉鼠美術、`public/characters/yui/` 與 `public/characters/yuma/` 的人物圖、`public/backgrounds/classroom.webp` 教室背景（作者以 ChatGPT 生成）、app 圖示與背景音樂，全部以 [MIT 授權](LICENSE)釋出。第三方元件及其授權列在 [NOTICE.md](NOTICE.md)，包括 soundtouchjs（LGPL-2.1）與 kuromoji 及其詞典。
