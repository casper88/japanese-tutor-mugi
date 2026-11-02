// The ⚙️ settings sheet parts of 日語家教 (TutorView): the sheet shell, the 聲音 section
// (mute, volumes, 朗讀回覆, the per-language voice groups), the 對話 section (the chat count and its clear) and the 用量 section.
// The view keeps its own rows (名字, 其他) and passes them in as children.
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { getAudioSettings, onAudioSettings, setAudioSettings, type AudioSettings } from '../game/audio';
import {
  CUSTOM_ACCEPT, CUSTOM_MAX_FRAMES, CUSTOM_MIN_FRAMES, CUSTOM_SHAPES, clearCustomArt, newFrameId, nextFreeShape, prepareImage,
  saveCustomArt, useArtUrls, type CustomArt, type CustomArtFrame, type CustomArtMode,
} from '../game/customArt';
import type { VisemeCode } from '../game/visemes';
import { cloudStatus, onCloudStatus, type CloudStatus } from '../game/cloudTts';
import { TUTOR_BACKGROUNDS_MAX } from '../game/tutor';
import {
  BACKGROUND_ACCEPT, backgroundRefusal, clearBackgroundPicture, prepareBackground, saveBackgroundPicture, useBackgroundUrl,
} from '../game/tutorBackground';
import { DEFAULT_SCENE, DIM_MAX, isBuiltinBackground, newBackgroundId } from '../game/tutorScene';
import { getTtsSettings, onTtsSettings, setTtsSettings, ttsAvailable, type TtsSettings } from '../game/tts';
import {
  CHAT_MODEL_CHOICES, LOCAL_LLM_URL_DEFAULT, PERSONA_MAX_CHARS, PROVIDERS_MAX, PROVIDER_IDS, PROVIDER_LABELS, chatModelLabel, clipCodePoints,
  type ChatModelId, type ProviderId,
} from '../game/claudeProtocol';
import { logoutChatGpt, startChatGptLogin, type ChatGptStatus } from '../game/openaiStatus';
import { localStatusText, type LocalStatus } from '../game/localStatus';
import { fetchBudget, fetchKeysStatus, saveBudget, saveKeys, type BudgetStatus, type FieldStatus, type KeyName, type KeysStatus } from '../game/settingsApi';
import { budgetLine } from '../game/budgetEstimate';
import { LangVoiceGroup } from './VoiceSettings';
import { UsagePanel } from './UsagePanel';
import { IconClose } from './icons';

export type VolumeKey = Exclude<keyof AudioSettings, 'muted' | 'master'>;
/** the volume rows */
export const VOLUME_ROWS: [VolumeKey, string][] = [['music', '音樂'], ['voice', '語音']];

/** the sound settings (audio, speech, cloud keys) kept live; the views fetch the cloud voice status (fetchTtsStatus) themselves */
export function useSoundSettings() {
  const [audio, setAudio] = useState<AudioSettings>(getAudioSettings);
  const [tts, setTts] = useState<TtsSettings>(getTtsSettings);
  const [cloud, setCloud] = useState<CloudStatus | null>(cloudStatus);
  useEffect(() => onAudioSettings(setAudio), []);
  useEffect(() => onTtsSettings(setTts), []);
  useEffect(() => onCloudStatus(() => setCloud(cloudStatus())), []);
  return { audio, tts, cloud };
}

/** the sheet shell: backdrop (tap = close), the head with ✕ (`title`, 設定 by default), and the scrolling body that holds the sections */
/** theme 'dark': the dark sheet tokens (tutor.css, .sheet-dark) */
export function SettingsSheet({ onClose, children, theme, title = '設定' }: {
  onClose: () => void; children: ReactNode; theme?: 'dark'; title?: string;
}) {
  return (
    <div className={theme === 'dark' ? 'sheet-backdrop sheet-dark' : 'sheet-backdrop'} onClick={onClose}>
      <section className="sheet as-settings" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="sheet-head">
          <strong>{title}</strong>
          <button className="sheet-close" onClick={onClose} aria-label="關閉"><IconClose /></button>
        </div>
        <div className="as-settings-body">{children}</div>
      </section>
    </div>
  );
}

/** 聲音: mute, the volume rows (`volumes`, default both), 朗讀回覆, and the 中文 / 日文 voice groups */
export function SoundSection({ audio, tts, cloud, volumes = VOLUME_ROWS.map(([k]) => k) }: {
  audio: AudioSettings; tts: TtsSettings; cloud: CloudStatus | null; volumes?: VolumeKey[];
}) {
  return (
    <>
      <h3>聲音</h3>
      <label className="as-row"><span>靜音</span><input type="checkbox" checked={audio.muted} onChange={(e) => setAudioSettings({ muted: e.target.checked })} /></label>
      {VOLUME_ROWS.filter(([k]) => volumes.includes(k)).map(([k, label]) => (
        <label key={k} className="as-row"><span>{label}</span>
          <input className="slider" type="range" min={0} max={1} step={0.05} value={audio[k]}
            style={{ '--f': audio[k] } as React.CSSProperties} onChange={(e) => setAudioSettings({ [k]: parseFloat(e.target.value) })} />
        </label>
      ))}
      <label className="as-row"><span>朗讀回覆<small>她的回覆用語音念出來（嘴巴會跟著動）</small></span>
        <input type="checkbox" checked={tts.on} disabled={!ttsAvailable()} onChange={(e) => setTtsSettings({ on: e.target.checked })} /></label>
      <div className="as-lang-note">{cloud === null ? <small>雲端語音檢查中…</small> : (!cloud.azure || !cloud.google) && <small>Azure／Google 需要在 .env.local 填金鑰</small>}</div>
      <LangVoiceGroup title="中文" lang="zh" tts={tts} cloud={cloud} />
      <LangVoiceGroup title="日文" lang="ja" tts={tts} cloud={cloud} />
      <div className="as-lang-note"><small>語速與音調在本機套用，雲端語音一律以原速合成（快取不會因調整而重算）。</small></div>
    </>
  );
}

/** 對話: `children` (the view's own rows, e.g. 對話引擎) come first, then the chat count with its 清除 */
export function ChatDataSection({ count, onClear, children }: { count: number; onClear: () => void; children?: ReactNode }) {
  return (
    <>
      <h3>對話</h3>
      {children}
      <div className="as-row"><span>對話紀錄<small>{count} 則</small></span>
        <button className="as-small" disabled={!count} onClick={onClear}>清除</button></div>
    </>
  );
}

/** 用量: this month's speech and Claude usage (UsagePanel) */
export function UsageSection() {
  return (
    <>
      <h3>用量</h3>
      <UsagePanel />
    </>
  );
}

/**
 * Claude 模型: the Claude model of her chat (chatModel: '' = the server's own, shown with its name from `serverModel`) and the
 * Claude model of 速查 and 小提醒 (helperModel). `serverModel` null = the server's status is not read yet. theme 'dark': the dark sheet.
 */
export function ModelSection({ chatModel, helperModel, serverModel, onChange, theme }: {
  chatModel: '' | ChatModelId; helperModel: ChatModelId; serverModel: string | null;
  onChange: (patch: { chatModel?: '' | ChatModelId; helperModel?: ChatModelId }) => void; theme?: 'dark';
}) {
  const serverLabel = serverModel === null ? '讀取中…' : chatModelLabel(serverModel) || '未知';
  return (
    <div className={theme === 'dark' ? 'as-models as-dark' : 'as-models'}>
      <h3>Claude 模型</h3>
      <div className="as-model-group">聊天</div>
      <label className="as-row"><span>{`依伺服器設定（目前：${serverLabel}）`}</span>
        <input type="radio" name="chat-model" checked={chatModel === ''} onChange={() => onChange({ chatModel: '' })} /></label>
      {CHAT_MODEL_CHOICES.map((m) => (
        <label key={m.id} className="as-row"><span>{m.label}<small>{m.note}</small></span>
          <input type="radio" name="chat-model" value={m.id} checked={chatModel === m.id} onChange={() => onChange({ chatModel: m.id })} /></label>
      ))}
      <div className="as-model-group">速查與小提醒</div>
      {CHAT_MODEL_CHOICES.map((m) => (
        <label key={m.id} className="as-row"><span>{m.label}<small>{m.note}</small></span>
          <input type="radio" name="helper-model" value={m.id} checked={helperModel === m.id} onChange={() => onChange({ helperModel: m.id })} /></label>
      ))}
      <div className="as-lang-note"><small>換模型後第一句會重新建立提示快取，之後照常省錢。每日花費上限照常有效（MUGI_DAILY_USD）。費用以 Anthropic Console 為準。</small></div>
    </div>
  );
}

/** the services the settings list, in the order the player keeps them (a service that is off is listed after the ones on) */
const SERVICE_IDS: readonly ProviderId[] = PROVIDER_IDS;

/** whether this page is opened on the PC itself (127.0.0.1, localhost or [::1]): the keys and the ChatGPT sign-in are set only there (the server checks the same) */
export function isLocalPc(): boolean {
  if (typeof window === 'undefined') return false;
  return ['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname);
}

/** the keys status of a settings group: read once when the group opens; `set` takes the server's new status after a save */
export function useKeysStatus(): [KeysStatus | null, (s: KeysStatus) => void] {
  const [keys, setKeys] = useState<KeysStatus | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchKeysStatus().then((s) => { if (alive && s) setKeys(s); });
    return () => { alive = false; };
  }, []);
  return [keys, setKeys];
}

/** the status line of one key: 未設定 (or `unset`), or 已設定 with the last four characters (a region shows its name) */
export function keyStatusText(status: FieldStatus | null, unset = '未設定'): string {
  if (status === null) return '讀取中…';
  if (!status.set) return unset;
  if (status.value) return `已設定（${status.value}）`;
  return status.last4 ? `已設定（末四碼 ${status.last4}）` : '已設定';
}

/**
 * One key (or a plain setting such as the region) in Settings: a box that never shows the stored value (password type, no
 * autocomplete), 儲存 (sets it) and 清除 (removes it), and the status line. `onSaved` gets the server's new keys status.
 */
export function KeyField({ label, field, status, onSaved, plain = false, placeholder, unset, localPc = isLocalPc() }: {
  label: string; field: KeyName; status: FieldStatus | null; onSaved: (s: KeysStatus) => void; plain?: boolean; placeholder?: string;
  /** the status line when nothing is set (default 未設定) */
  unset?: string;
  /** on the PC: the box and its buttons; from a phone: the status line only (the server refuses key writes from anywhere else) */
  localPc?: boolean;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const write = async (patch: Partial<Record<KeyName, string | null>>) => {
    setBusy(true);
    setNote('');
    const r = await saveKeys(patch);
    setBusy(false);
    if (r.ok) {
      setValue('');
      onSaved(r.status);
    } else {
      setNote(r.message);
    }
  };
  const saveValue = () => write(({ [field]: value.trim() }) as Partial<Record<KeyName, string | null>>);
  const clearValue = () => write(({ [field]: null }) as Partial<Record<KeyName, string | null>>);
  if (!localPc) {
    return (
      <div className="as-key">
        <div className="as-row"><span>{label}<small>{keyStatusText(status, unset)}</small></span></div>
      </div>
    );
  }
  return (
    <div className="as-key">
      <div className="as-row">
        <span>{label}<small>{keyStatusText(status, unset)}</small></span>
        <input className="as-key-input" type={plain ? 'text' : 'password'} autoComplete="off" autoCapitalize="off" spellCheck={false}
          value={value} placeholder={placeholder} aria-label={label} onChange={(e) => setValue(e.currentTarget.value)} />
        <button className="as-small" disabled={busy || !value.trim()} onClick={() => void saveValue()}>儲存</button>
        <button className="as-small" disabled={busy || !status?.set} onClick={() => void clearValue()}>清除</button>
      </div>
      {note && <div className="as-lang-note" role="alert"><small>{note}</small></div>}
    </div>
  );
}

/** the Claude key and the optional workspace id, under the Claude row of AI 服務 */
function AnthropicKeys({ onSaved, localPc = isLocalPc() }: { onSaved?: () => void; localPc?: boolean }) {
  const [keys, setKeys] = useKeysStatus();
  const changed = (s: KeysStatus) => { setKeys(s); onSaved?.(); };
  return (
    <div className="as-ai-chatgpt">
      <KeyField label="Claude 金鑰" field="anthropicKey" status={keys?.anthropicKey ?? null} onSaved={changed} localPc={localPc} />
      <KeyField label="工作區 ID（選填）" field="anthropicWorkspace" plain status={keys?.anthropicWorkspace ?? null} onSaved={changed} localPc={localPc} />
      {!localPc && <div className="as-lang-note"><small>金鑰只能在電腦上設定（在電腦上用 127.0.0.1 開啟 App）</small></div>}
    </div>
  );
}

/**
 * The local model's address and model name, under the 本地模型 row of AI 服務 (written to the PC's .env.local; a phone sees only
 * the status), the models its server lists, and 重新偵測 (asks the server again, after Ollama or LM Studio was started).
 */
function LocalFields({ local, onSaved, onRefresh, localPc = isLocalPc() }: {
  local: LocalStatus | null; onSaved?: () => void; onRefresh?: () => void; localPc?: boolean;
}) {
  const [keys, setKeys] = useKeysStatus();
  const changed = (s: KeysStatus) => { setKeys(s); onSaved?.(); };
  const models = local?.models ?? [];
  return (
    <div className="as-ai-chatgpt">
      <KeyField label="本地模型網址" field="localUrl" plain placeholder={LOCAL_LLM_URL_DEFAULT} unset={`未設定（用 Ollama 的 ${LOCAL_LLM_URL_DEFAULT}）`}
        status={keys?.localUrl ?? null} onSaved={changed} localPc={localPc} />
      <KeyField label="模型名稱（選填）" field="localModel" plain placeholder="例如 qwen3:8b" unset="未設定（用清單裡的第一個）"
        status={keys?.localModel ?? null} onSaved={changed} localPc={localPc} />
      {models.length > 0 && <div className="as-lang-note"><small>可用模型：{models.join('、')}</small></div>}
      {onRefresh && <button className="as-small" onClick={onRefresh}>重新偵測</button>}
      {!localPc && <div className="as-lang-note"><small>網址和模型名稱只能在電腦上設定（在電腦上用 127.0.0.1 開啟 App）</small></div>}
    </div>
  );
}

/**
 * 金鑰: the cloud voice keys (Google, Azure and the Azure region), in the voice part of the settings. `onSaved` runs after a save
 * (the view re-reads the TTS status, so the new key is used at once).
 */
export function CloudKeysSection({ onSaved, localPc = isLocalPc() }: { onSaved?: () => void; localPc?: boolean }) {
  const [keys, setKeys] = useKeysStatus();
  const changed = (s: KeysStatus) => { setKeys(s); onSaved?.(); };
  return (
    <>
      <h3>金鑰</h3>
      <KeyField label="Google 語音金鑰" field="googleKey" status={keys?.googleKey ?? null} onSaved={changed} localPc={localPc} />
      <KeyField label="Azure 語音金鑰" field="azureKey" status={keys?.azureKey ?? null} onSaved={changed} localPc={localPc} />
      <KeyField label="Azure 區域" field="azureRegion" plain placeholder="例如 eastasia" status={keys?.azureRegion ?? null} onSaved={changed} localPc={localPc} />
      {!localPc && <div className="as-lang-note"><small>金鑰只能在電腦上設定（在電腦上用 127.0.0.1 開啟 App）</small></div>}
      <div className="as-lang-note"><small>金鑰會寫進電腦上的 .env.local，畫面只顯示末四碼。</small></div>
    </>
  );
}

/**
 * AI 服務: the services 日語家教 may use, in the order to try them (the order is sent with every AI request). Each row has an
 * on/off switch (at least one stays on) and 上移／下移. Claude needs its key (a box in its row, written to the PC's .env.local; a
 * phone sees only the status). ChatGPT signs in and out with its buttons on the PC only; a phone sees the status and picks the model.
 * 本地模型 needs a server on the PC (Ollama, LM Studio…); its address and model are set on the PC, like the keys.
 * `claudeOk` / `chatgpt` / `local`: null until read. theme 'dark': the dark sheet.
 */
export function AiServiceSection({
  providers, openaiModel, claudeOk, chatgpt, local = null, onChange, onRefresh, onRefreshLocal, onKeysSaved, localPc = isLocalPc(), theme,
}: {
  providers: ProviderId[]; openaiModel: string; claudeOk: boolean | null; chatgpt: ChatGptStatus | null;
  /** the local model server's status (game/localStatus) */
  local?: LocalStatus | null;
  onChange: (patch: { providers?: ProviderId[]; openaiModel?: string }) => void;
  /** re-reads the ChatGPT status (after a sign-in or sign-out) */
  onRefresh: () => void;
  /** re-reads the local model status (重新偵測) */
  onRefreshLocal?: () => void;
  /** a key was saved: the view re-reads the Claude status (the server rereads .env.local on every request) */
  onKeysSaved?: () => void;
  /** on the PC: the key boxes and the ChatGPT buttons; from a phone: the status only (see isLocalPc) */
  localPc?: boolean; theme?: 'dark';
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const rows = [...providers, ...SERVICE_IDS.filter((id) => !providers.includes(id))];

  const toggle = (id: ProviderId, on: boolean) => {
    if (on && !providers.includes(id) && providers.length < PROVIDERS_MAX) onChange({ providers: [...providers, id] });
    else if (!on && providers.includes(id) && providers.length > 1) onChange({ providers: providers.filter((p) => p !== id) });
  };
  const move = (id: ProviderId, dir: -1 | 1) => {
    const i = providers.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= providers.length) return;
    const next = [...providers];
    [next[i], next[j]] = [next[j], next[i]];
    onChange({ providers: next });
  };

  const login = async () => {
    setBusy(true);
    setNote('');
    const r = await startChatGptLogin();
    if (!r.ok) {
      setNote(r.message);
      setBusy(false);
      return;
    }
    // the consent page; it sends the browser back to this PC's 127.0.0.1 and then to the home page
    window.location.href = r.url;
  };
  const logout = async () => {
    setBusy(true);
    setNote('');
    const warning = await logoutChatGpt();
    setNote(warning);
    setBusy(false);
    onRefresh();
  };

  const claudeText = claudeOk === null ? '讀取中…' : claudeOk ? '已設定金鑰' : '未設定金鑰（在電腦的 .env.local 填 ANTHROPIC_API_KEY）';
  const chatgptText = chatgpt === null ? '讀取中…'
    : !chatgpt.signedIn ? '未登入'
      : chatgpt.planEnabled ? `已登入${chatgpt.email ? `（${chatgpt.email}）` : ''}` : '已登入，但沒有 ChatGPT 方案的使用權，請重新登入';
  const statusText = (id: ProviderId) => (id === 'anthropic' ? claudeText : id === 'openai' ? chatgptText : localStatusText(local));
  const models = chatgpt?.models ?? [];
  const selectedModel = models.some((m) => m.slug === openaiModel) ? openaiModel : (models[0]?.slug ?? '');

  return (
    <div className={theme === 'dark' ? 'as-ai-sec as-dark' : 'as-ai-sec'}>
      <h3>AI 服務</h3>
      <ul className="as-ai-list">
        {rows.map((id) => {
          const on = providers.includes(id);
          const i = providers.indexOf(id);
          const label = PROVIDER_LABELS[id];
          const lastOn = on && providers.length === 1;
          return (
            <li key={id} className="as-ai-item">
              <div className="as-row">
                <span>{label}<small>{statusText(id)}</small></span>
                <label className="as-ai-switch"><span>使用</span>
                  <input type="checkbox" role="switch" aria-label={`${label} 使用`} checked={on} disabled={lastOn}
                    onChange={(e) => toggle(id, e.currentTarget.checked)} /></label>
                <button className="as-small" aria-label={`${label} 上移`} disabled={!on || i <= 0} onClick={() => move(id, -1)}>上移</button>
                <button className="as-small" aria-label={`${label} 下移`} disabled={!on || i < 0 || i >= providers.length - 1} onClick={() => move(id, 1)}>下移</button>
              </div>
              {id === 'anthropic' && <AnthropicKeys onSaved={onKeysSaved} localPc={localPc} />}
              {id === 'local' && <LocalFields local={local} onSaved={onKeysSaved} onRefresh={onRefreshLocal} localPc={localPc} />}
              {id === 'openai' && (
                <div className="as-ai-chatgpt">
                  {!localPc && chatgpt !== null && <small className="as-ai-hint">ChatGPT 只能在電腦上登入或登出</small>}
                  {localPc && chatgpt !== null && !chatgpt.signedIn && (
                    <button className="as-small" disabled={busy} onClick={() => void login()}>用 ChatGPT 登入</button>
                  )}
                  {localPc && chatgpt?.signedIn && (
                    <button className="as-small" disabled={busy} onClick={() => void logout()}>登出</button>
                  )}
                  {chatgpt?.signedIn && models.length > 0 && (
                    <label className="as-ai-model"><span>ChatGPT 模型</span>
                      <select aria-label="ChatGPT 模型" value={selectedModel} disabled={busy}
                        onChange={(e) => onChange({ openaiModel: e.currentTarget.value })}>
                        {models.map((m) => <option key={m.slug} value={m.slug}>{m.label}</option>)}
                      </select></label>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {note && <div className="as-lang-note" role="status"><small>{note}</small></div>}
      <div className="as-lang-note"><small>ChatGPT 使用你自己方案的額度，不需要 OpenAI API 金鑰；登入資料加密存在電腦的使用者資料夾，不會傳到手機。依 OpenAI 條款，請勿分享帳號。</small></div>
      <div className="as-lang-note"><small>本地模型在電腦上執行（例如 Ollama、LM Studio），不花 Claude 的預算，漢字讀音由系統自動標註。小模型的糾錯和解說會比雲端模型弱。</small></div>
      <div className="as-lang-note"><small>金鑰會寫進電腦上的 .env.local，畫面只顯示末四碼。</small></div>
    </div>
  );
}

/**
 * 每日預算上限: the Claude spending cap (MUGI_DAILY_USD) in USD. 0 = no cap (server/usage.ts). The line under the box says how many
 * sentences the budget buys on Haiku 5.5 and Opus 5.5 (an estimate, budgetEstimate.ts).
 */
export function BudgetSection() {
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  useEffect(() => {
    let alive = true;
    void fetchBudget().then((b) => {
      if (!alive || !b) return;
      setBudget(b);
      setDraft(String(b.usd));
    });
    return () => { alive = false; };
  }, []);
  const parsed = draft.trim() === '' ? NaN : Number(draft);
  const valid = Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 && Math.abs(parsed * 100 - Math.round(parsed * 100)) < 1e-9;
  const save = async () => {
    setBusy(true);
    setNote('');
    const r = await saveBudget(parsed);
    setBusy(false);
    if (r.ok) {
      setBudget(r.budget);
      setDraft(String(r.budget.usd));
      setNote('已儲存');
    } else {
      setNote(r.message);
    }
  };
  return (
    <>
      <h3>每日預算上限</h3>
      <label className="as-row"><span>每天最多花（美元）<small>0 = 不設上限；預設 2</small></span>
        <input className="as-budget-input" type="number" min={0} max={100} step={0.5} value={draft} aria-label="每日預算（美元）"
          onChange={(e) => setDraft(e.currentTarget.value)} /></label>
      <div className="as-row"><span><small>{budget ? `今天已用約 $${budget.spentTodayUsd.toFixed(2)}` : '讀取中…'}</small></span>
        <button className="as-small" disabled={busy || !valid} onClick={() => void save()}>儲存</button></div>
      <div className="as-lang-note" role="status"><small>{valid ? budgetLine(parsed) : '請輸入 0 到 100 之間、最多兩位小數的金額'}</small></div>
      {note && <div className="as-lang-note"><small>{note}</small></div>}
      <div className="as-lang-note"><small>金額是估算值（依本 App 的用量與價目表）；費用以 Anthropic Console 為準。</small></div>
    </>
  );
}

/**
 * 人設: her personality text, the 個性 line of her system prompt. Empty = the default (`defaultPersona`, shown as the
 * placeholder). theme 'dark': the dark sheet.
 */
export function PersonaSection({ persona, defaultPersona, onChange, theme }: {
  persona: string; defaultPersona: string; onChange: (persona: string) => void; theme?: 'dark';
}) {
  // the box starts with her default personality written out, so it can be edited in place (a placeholder cannot be);
  // the default text itself, or an empty box, is stored as '' (= the default), so a later change of the default reaches her.
  // The draft is not reset from the stored value while typing: clearing the box keeps it empty instead of refilling it.
  const [draft, setDraft] = useState(persona || defaultPersona);
  // the default arrives from the server after the sheet opens: fill it in when the box is still empty
  useEffect(() => { if (!persona) setDraft((d) => (d ? d : defaultPersona)); }, [defaultPersona]); // eslint-disable-line react-hooks/exhaustive-deps
  // the limit counts code points, as the server does (a textarea's maxLength would count an emoji as two)
  const change = (raw: string) => {
    const text = clipCodePoints(raw, PERSONA_MAX_CHARS);
    setDraft(text);
    onChange(text.trim() === defaultPersona.trim() ? '' : text);
  };
  return (
    <div className={theme === 'dark' ? 'as-persona-sec as-dark' : 'as-persona-sec'}>
      <h3>人設</h3>
      <textarea className="as-persona" value={draft} placeholder={defaultPersona} rows={6}
        onChange={(e) => change(e.target.value)} aria-label="人設" />
      <div className="as-persona-foot">
        <small>剩 {PERSONA_MAX_CHARS - [...draft].length} 字</small>
        <button className="as-small" disabled={!persona} onClick={() => { setDraft(defaultPersona); onChange(''); }}>恢復預設</button>
      </div>
      <div className="as-lang-note"><small>人設只影響她的個性與說話方式；回覆格式、教學規則不會被改掉。換了人設，她會像重新認識你一樣從頭聊起，舊對話還留在畫面上。（快取也由新對話開始重設）</small></div>
    </div>
  );
}

/**
 * 人物位置: a custom picture's place on the lectern is set with the free zoom (角色) and kept; this row says how and resets it.
 * Shown only with a custom picture (the caller decides). theme 'dark': the dark sheet.
 */
export function FigureSection({ onReset, theme }: { onReset: () => void; theme?: 'dark' }) {
  return (
    <div className={theme === 'dark' ? 'as-figure-sec as-dark' : 'as-figure-sec'}>
      <h3>人物位置</h3>
      <div className="as-lang-note"><small>用左上角的放大鏡、選『角色』拖曳或縮放來調整；點兩下還原</small></div>
      <div className="as-persona-foot">
        <button className="as-small" onClick={onReset}>重設位置</button>
      </div>
    </div>
  );
}

/** the choices of 人設圖片: the hamster, one picture, or frames (one per mouth shape) */
type ArtChoice = 'default' | CustomArtMode;
const ART_CHOICES: [ArtChoice, string][] = [['default', '預設倉鼠'], ['single', '單張圖'], ['frames', '序列圖']];

/**
 * 人設圖片: a character's own picture in place of her built-in one (game/customArt, one record per character id). 單張圖 bobs while
 * she speaks; 序列圖 has 2–6 frames, each shown for one mouth shape. `art` is the saved picture (null = her built-in picture, named
 * by `defaultLabel`); `onChange` gets the new one once it is stored, and a failed save shows its message here. theme 'dark': the dark sheet.
 */
export function CustomArtSection({ art, onChange, theme, characterId = 'mugi', defaultLabel = '預設倉鼠' }: {
  art: CustomArt | null; onChange: (art: CustomArt | null) => void; theme?: 'dark'; characterId?: string; defaultLabel?: string;
}) {
  const choices = ART_CHOICES.map(([c, l]): [ArtChoice, string] => [c, c === 'default' ? defaultLabel : l]);
  const [choice, setChoice] = useState<ArtChoice>(art ? art.mode : 'default');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const pickFor = useRef<'single' | 'add'>('single');
  const urls = useArtUrls(art);
  const frames = art?.frames ?? [];
  // a picture that arrives after the sheet opened (the view loads it on mount) sets the choice
  useEffect(() => { if (art) setChoice(art.mode); }, [art]);

  // stores the picture (or clears it); the view takes the new one only when it is stored
  const store = async (next: CustomArt | null) => {
    setBusy(true);
    setError('');
    try {
      if (next) await saveCustomArt(next, characterId); else await clearCustomArt(characterId);
      onChange(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : '無法儲存圖片');
    } finally {
      setBusy(false);
    }
  };

  const choose = (c: ArtChoice) => {
    setChoice(c);
    setError('');
    if (c === 'default') { if (art) void store(null); return; }
    if (!art || art.mode === c) return;
    // switching between the two modes keeps the first picture (as the frame of the mode it turns into)
    const first = frames.slice(0, 1);
    void store(c === 'single'
      ? { mode: 'single', frames: first.map((f) => ({ ...f, viseme: null })) }
      : { mode: 'frames', frames: first.map((f) => ({ ...f, viseme: 'a' as VisemeCode })) });
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    input.value = ''; // the same file can be picked again
    if (!file) return;
    setBusy(true);
    setError('');
    let blob: Blob;
    try {
      blob = await prepareImage(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : '讀不到這張圖');
      setBusy(false);
      return;
    }
    setBusy(false);
    const id = newFrameId();
    if (pickFor.current === 'add') {
      const shape = nextFreeShape(frames);
      if (!shape || frames.length >= CUSTOM_MAX_FRAMES) return;
      void store({ mode: 'frames', frames: [...frames, { id, viseme: shape, blob }] });
    } else {
      void store({ mode: 'single', frames: [{ id, viseme: null, blob }] });
    }
  };

  const pick = (mode: 'single' | 'add') => { pickFor.current = mode; fileRef.current?.click(); };
  const setShape = (id: string, viseme: VisemeCode) => {
    void store({ mode: 'frames', frames: frames.map((f: CustomArtFrame) => (f.id === id ? { ...f, viseme } : f)) });
  };
  const remove = (id: string) => {
    const rest = frames.filter((f) => f.id !== id);
    void store(rest.length ? { mode: 'frames', frames: rest } : null);
  };

  const single = art?.mode === 'single' ? art.frames[0] : null;
  return (
    <div className={theme === 'dark' ? 'as-custom-sec as-dark' : 'as-custom-sec'}>
      <h3>人設圖片</h3>
      <div className="as-row as-stack">
        <div className="as-seg" role="radiogroup" aria-label="人設圖片的形式">
          {choices.map(([c, label]) => (
            <button key={c} type="button" role="radio" aria-checked={choice === c} className={choice === c ? 'on' : undefined}
              disabled={busy} onClick={() => choose(c)}>{label}</button>
          ))}
        </div>
      </div>
      {choice === 'single' && (
        <div className="as-row">
          <span>她的圖片<small>{single ? '已選一張圖' : `還沒選圖，目前是${defaultLabel}`}</small></span>
          {single && <img className="as-custom-thumb" src={urls[single.id]} alt="" />}
          <button className="as-small" disabled={busy} onClick={() => pick('single')}>選擇圖片</button>
        </div>
      )}
      {choice === 'frames' && (
        <>
          <ul className="as-custom-list">
            {frames.map((f) => (
              <li key={f.id} className="as-custom-frame">
                <img className="as-custom-thumb" src={urls[f.id]} alt="" />
                <select className="as-custom-shape" aria-label="嘴型" value={f.viseme ?? 'a'} disabled={busy}
                  onChange={(e) => setShape(f.id, e.currentTarget.value as VisemeCode)}>
                  {CUSTOM_SHAPES.map((s) => (
                    <option key={s} value={s} disabled={frames.some((o) => o.id !== f.id && o.viseme === s)}>{s}</option>
                  ))}
                </select>
                <button className="as-small" disabled={busy} onClick={() => remove(f.id)}>移除</button>
              </li>
            ))}
          </ul>
          <div className="as-row">
            <span>{`${frames.length} / ${CUSTOM_MAX_FRAMES} 張`}
              {frames.length < CUSTOM_MIN_FRAMES && <small>至少兩張才能用序列圖</small>}</span>
            <button className="as-small" disabled={busy || frames.length >= CUSTOM_MAX_FRAMES} onClick={() => pick('add')}>新增一張</button>
          </div>
        </>
      )}
      {error && <div className="as-lang-note as-custom-err" role="alert"><small>{error}</small></div>}
      <div className="as-custom-foot">
        <button className="as-small" disabled={!art || busy} onClick={() => { setChoice('default'); void store(null); }}>恢復預設</button>
      </div>
      <div className="as-lang-note"><small>圖片只存在這台裝置的瀏覽器裡，不會上傳。請使用你有權使用的圖片。序列圖：講話時依嘴型 a／e／i／o／u 換圖，沒說話時用 m；缺的母音用 a。</small></div>
      <input ref={fileRef} type="file" accept={CUSTOM_ACCEPT} hidden onChange={onFile} aria-label="選擇圖片" />
    </div>
  );
}

/**
 * 背景: the backgrounds all characters share. 教室 and 純黑 are built in; the ones the player adds (up to TUTOR_BACKGROUNDS_MAX) are
 * pictures kept in IndexedDB (game/tutorBackground), one per id. The tabs show each as a thumbnail, the one in use is lit; ＋ picks a
 * picture (PNG, JPEG or WebP; an SVG is refused) and makes it the one in use. An added one has 刪除這張背景. 背景變暗 is the dimming of the
 * one in use (none for 純黑). `active` is the background in use; every change goes out through its callback. theme 'dark': the dark sheet.
 */
export function BackgroundSection({ active, added, pictures, dim, onSelect, onAdded, onDeleted, onDim, theme }: {
  active: string;
  /** the ids the player added, in tab order */
  added: string[];
  /** each added background's picture (null while it is read or when it cannot be read) */
  pictures: Record<string, Blob | null>;
  dim: number;
  onSelect: (id: string) => void;
  onAdded: (id: string, picture: Blob) => void;
  onDeleted: (id: string) => void;
  onDim: (dim: number) => void;
  theme?: 'dark';
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const full = added.length >= TUTOR_BACKGROUNDS_MAX;
  const isAdded = !isBuiltinBackground(active);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    input.value = ''; // the same file can be picked again
    if (!file) return;
    // refused before it is read: an SVG, another type, or a file too large
    const refused = backgroundRefusal(file);
    if (refused) { setError(refused); return; }
    setBusy(true);
    setError('');
    try {
      const blob = await prepareBackground(file);
      const id = newBackgroundId();
      await saveBackgroundPicture(blob, id);
      onAdded(id, blob);
    } catch (err) {
      setError(err instanceof Error ? err.message : '讀不到這張圖');
    } finally {
      setBusy(false);
    }
  };

  /** 刪除這張背景: the player confirms; the picture is removed, and the classroom is in use again when it was the one in use */
  const remove = async (id: string) => {
    if (!window.confirm('刪除這張背景？')) return;
    setBusy(true);
    setError('');
    try {
      await clearBackgroundPicture(id);
      onDeleted(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : '無法清除背景圖');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={theme === 'dark' ? 'as-custom-sec as-bg-sec as-dark' : 'as-custom-sec as-bg-sec'}>
      <h3>背景圖片</h3>
      <div className="char-tabs bg-tabs" role="radiogroup" aria-label="背景">
        <BgTab label="教室" on={active === 'classroom'} disabled={busy} onClick={() => onSelect('classroom')}>
          <img className="bg-thumb" src={`${import.meta.env.BASE_URL}${DEFAULT_SCENE.file}`} alt="" draggable={false} />
        </BgTab>
        <BgTab label="純黑" on={active === 'black'} disabled={busy} onClick={() => onSelect('black')}>
          <span className="bg-thumb bg-thumb-black" />
        </BgTab>
        {added.map((id, i) => (
          <BgTab key={id} label={`自訂 ${i + 1}`} on={active === id} disabled={busy} onClick={() => onSelect(id)}>
            <BgThumb picture={pictures[id] ?? null} />
          </BgTab>
        ))}
        <button type="button" aria-label="新增背景" title="新增背景（PNG、JPG、WebP，最多 6 張）" disabled={busy || full}
          onClick={() => fileRef.current?.click()}>＋</button>
      </div>
      {isAdded && (
        <div className="as-custom-foot">
          <button className="as-small danger" disabled={busy} onClick={() => void remove(active)}>刪除這張背景</button>
        </div>
      )}
      {active !== 'black' && (
        <label className="as-row as-bg-dim">
          <span>背景變暗<small>{`${dim}%`}</small></span>
          <input type="range" min={0} max={DIM_MAX} step={5} value={dim} aria-label="背景變暗"
            onChange={(e) => onDim(Number(e.currentTarget.value))} />
        </label>
      )}
      {error && <div className="as-lang-note as-custom-err" role="alert"><small>{error}</small></div>}
      <div className="as-lang-note"><small>預設是教室，角色站在講台上（結衣坐在上面，悠真站在前面）；其他背景角色站在畫面下方。自訂背景只存在這台裝置的瀏覽器裡，不會上傳。只收 PNG、JPG、WebP；最多 6 張。</small></div>
      <input ref={fileRef} type="file" accept={BACKGROUND_ACCEPT} hidden onChange={onFile} aria-label="選擇背景圖片" />
    </div>
  );
}

/** one background tab: the thumbnail and its name; the one in use is lit (aria-checked) */
function BgTab({ label, on, disabled, onClick, children }: {
  label: string; on: boolean; disabled: boolean; onClick: () => void; children: ReactNode;
}) {
  return (
    <button type="button" role="radio" aria-checked={on} aria-label={label} title={label} disabled={disabled} onClick={onClick}
      className={on ? 'bg-tab on' : 'bg-tab'}>
      {children}
      <span className="bg-tab-label">{label}</span>
    </button>
  );
}

/** an added background's thumbnail (its picture read from an object URL) */
function BgThumb({ picture }: { picture: Blob | null }) {
  const url = useBackgroundUrl(picture);
  return url ? <img className="bg-thumb" src={url} alt="" draggable={false} /> : <span className="bg-thumb bg-thumb-black" />;
}
