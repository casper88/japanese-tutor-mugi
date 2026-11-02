// 日語家教 (the tutor mode): its own settings and its own chat histories, in their own localStorage keys, so the chats never mix
// with anything else. The settings hold the characters (人物): up to TUTOR_CHARACTERS_MAX of them, the three built-in ones first
// (むぎ, 結衣, 悠真) and the added ones after. The active one is the one on screen and in the chat; each has its own chat history
// (tutorChatKey). Shared by the chat: the mic language (sttLang), the voices (game/tts), the speech on/off and the usage.
import type { ChatLine } from './chatTypes';
import {
  CLAUDE_MODEL_DEFAULT, DEFAULT_PROVIDERS, OPENAI_MODEL_MAX_CHARS, PERSONA_MAX_CHARS, isChatModelId, parseProviderList, personaText,
  type AiServices, type ChatModelId, type ProviderId,
} from './claudeProtocol';

export type { AiServices } from './claudeProtocol';
import { BUILTIN_CHARACTERS, BUILTIN_IDS, LEGACY_YUI_SUBTITLE, defaultPersonaOf, isBuiltinId, type BuiltinId, type TutorCharacterId } from './tutorCharacters';
import { cleanCharacterVoice, type CharacterVoice } from './characterVoice';
import { BACKDROP_IDENTITY, BUILTIN_BACKGROUNDS, cleanBackdropView, cleanBackgroundDim, cleanBackgroundId, isBuiltinBackground, newBackgroundId, type BackdropView } from './tutorScene';

/** the most backgrounds the player adds (the classroom and plain black are built in) */
export const TUTOR_BACKGROUNDS_MAX = 6;

export const TUTOR_KEY = 'mugi.tutor.v1';
/** the chat history of むぎ (character 1) keeps this key, so today's chat is hers; the others use tutorChatKey */
export const TUTOR_CHAT_KEY = 'mugi.tutor.chat.v1';
/** the chat lines kept in storage (per character) */
export const TUTOR_CHAT_KEEP = 60;
/** her name on screen and in her ⚙️ (むぎ); the player may rename her */
export const TUTOR_DEFAULT_NAME = BUILTIN_CHARACTERS.mugi.defaultName;
export const TUTOR_NAME_MAX = 8;
/** the most characters (人物): the three built-in ones and up to five added */
export const TUTOR_CHARACTERS_MAX = 8;
export const TUTOR_NEW_NAME = '新角色';
export const TUTOR_NEW_SUBTITLE = '日語家教';

/**
 * sttLang: the language the mic listens in (日 ja-JP / 中 zh-TW).
 * chatModel: the model of her chat; '' = the server's own setting (ANTHROPIC_MODEL).
 * helperModel: the model of 速查 and 小提醒 (the judge and the tip rewrite).
 * providers: the AI services in the order to try them (設定 › AI 服務): any of Claude, ChatGPT and 本地模型; never empty.
 * openaiModel: the ChatGPT model; '' = the first one the plan lists.
 * background: the background in use for all characters: 'classroom', 'black', or the id of an added one (customBackgrounds).
 * customBackgrounds: the ids of the backgrounds the player added, in tab order (at most TUTOR_BACKGROUNDS_MAX; pictures in IndexedDB).
 * backgroundOpts: each background's own dimming and pinch / drag view (game/tutorScene), kept across visits; a missing one is the default.
 * characters: the characters in tab order; activeId: the one on screen and in the chat.
 */
export type TutorSettings = {
  characters: Character[];
  activeId: TutorCharacterId;
  sttLang: 'ja-JP' | 'zh-TW';
  chatModel: '' | ChatModelId;
  helperModel: ChatModelId;
  providers: ProviderId[];
  openaiModel: string;
  background: string;
  customBackgrounds: string[];
  backgroundOpts: Record<string, BackgroundOpt>;
};

/** one background's own settings: the dimming share (null = the default of its kind) and its pinch / drag view */
export type BackgroundOpt = { dim: number | null; view: BackdropView };

/**
 * One character (人物): her name, the line under it, her personality (persona: '' = the default of her id, see defaultPersonaOf),
 * her figure view (figureView: the free zoom's view of her, kept for a picture other than the hamster's; null = the default
 * framing) and her voice (voice: null = the 設定 page's voice, see game/characterVoice).
 */
export type Character = {
  id: TutorCharacterId;
  name: string;
  subtitle: string;
  persona: string;
  figureView: FigureView | null;
  voice: CharacterVoice;
};

/** a saved view of her figure: a scale about her centre and an offset in px (the same model as the zoom's view) */
export type FigureView = { scale: number; x: number; y: number };
export const FIGURE_SCALE_MIN = 0.5;
export const FIGURE_SCALE_MAX = 3;
export const TUTOR_SUBTITLE_MAX = 16;
export const TUTOR_SUBTITLE_DEFAULT = BUILTIN_CHARACTERS.mugi.subtitle;

/** the default voice of a built-in character: none for むぎ (the 設定 page's), a female voice for 結衣, a male one for 悠真 */
const BUILTIN_VOICE: Record<BuiltinId, CharacterVoice> = { mugi: null, yui: { gender: 'female' }, yuma: { gender: 'male' } };

/** a built-in character as she starts (no saved view, no personality of her own, her default voice) */
export function builtinCharacter(id: BuiltinId): Character {
  const b = BUILTIN_CHARACTERS[id];
  return { id, name: b.defaultName, subtitle: b.subtitle, persona: '', figureView: null, voice: BUILTIN_VOICE[id] };
}

export const DEFAULT_TUTOR: TutorSettings = {
  characters: BUILTIN_IDS.map(builtinCharacter),
  activeId: 'mugi',
  sttLang: 'ja-JP', chatModel: '', helperModel: CLAUDE_MODEL_DEFAULT as ChatModelId, providers: [...DEFAULT_PROVIDERS], openaiModel: '',
  background: 'classroom', customBackgrounds: [], backgroundOpts: {},
};

/** a background's own settings as they are when nothing is saved: no dimming of its own, the view at its start */
export function defaultBackgroundOpt(): BackgroundOpt {
  return { dim: null, view: { ...BACKDROP_IDENTITY } };
}

/** the settings of one background (its dimming and view), the defaults when none is saved */
export function backgroundOptOf(s: TutorSettings, id: string): BackgroundOpt {
  return s.backgroundOpts[id] ?? defaultBackgroundOpt();
}

/** one background's settings changed (its id stays); the other backgrounds are untouched */
export function updateBackgroundOpt(s: TutorSettings, id: string, patch: Partial<BackgroundOpt>): TutorSettings {
  return { ...s, backgroundOpts: { ...s.backgroundOpts, [id]: { ...backgroundOptOf(s, id), ...patch } } };
}

/** adds a background (its picture is stored under this id by the caller) and makes it the one in use; null at the maximum */
export function addBackground(s: TutorSettings, id: string = newBackgroundId()): TutorSettings | null {
  if (s.customBackgrounds.length >= TUTOR_BACKGROUNDS_MAX || isBuiltinBackground(id) || s.customBackgrounds.includes(id)) return null;
  return { ...s, customBackgrounds: [...s.customBackgrounds, id], background: id, backgroundOpts: { ...s.backgroundOpts, [id]: defaultBackgroundOpt() } };
}

/**
 * Deletes an added background and its settings. The built-in ones and an unknown id change nothing. When the deleted one was in use,
 * the classroom is in use again.
 */
export function deleteBackground(s: TutorSettings, id: string): TutorSettings {
  if (isBuiltinBackground(id) || !s.customBackgrounds.includes(id)) return s;
  const { [id]: _gone, ...opts } = s.backgroundOpts;
  void _gone;
  return { ...s, customBackgrounds: s.customBackgrounds.filter((x) => x !== id), backgroundOpts: opts, background: s.background === id ? 'classroom' : s.background };
}

/** the background in use becomes this one (a built-in or an added one); an unknown id changes nothing */
export function selectBackground(s: TutorSettings, id: string): TutorSettings {
  return isBuiltinBackground(id) || s.customBackgrounds.includes(id) ? { ...s, background: id } : s;
}

/** the background settings a save holds: only for the built-in ones and the added ones that are listed; the values cleaned */
function cleanBackgroundOpts(raw: unknown, ids: readonly string[]): Record<string, BackgroundOpt> {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Record<string, BackgroundOpt> = {};
  for (const id of ids) {
    const v = o[id];
    if (!v || typeof v !== 'object') continue;
    const r = v as Record<string, unknown>;
    out[id] = { dim: cleanBackgroundDim(r.dim), view: cleanBackdropView(r.view) };
  }
  return out;
}

/** the routing of the settings, for an AI request body */
export function aiServicesOf(s: TutorSettings): AiServices {
  return { providers: [...s.providers], ...(s.openaiModel ? { openaiModel: s.openaiModel } : {}) };
}

/**
 * whether any of the chosen services can answer now: Claude has its key, ChatGPT is signed in with the plan, or the local model
 * server answers. A service missing from `ready` cannot answer.
 */
export function serviceReady(providers: readonly ProviderId[], ready: Partial<Record<ProviderId, boolean>>): boolean {
  return providers.some((p) => ready[p] === true);
}

/** the ChatGPT model a player typed or picked: trimmed, at most OPENAI_MODEL_MAX_CHARS characters; anything else is '' */
export function cleanOpenaiModel(raw: unknown): string {
  return typeof raw === 'string' ? Array.from(raw.trim()).slice(0, OPENAI_MODEL_MAX_CHARS).join('') : '';
}

/** a persona the player typed, as it is kept: cleaned, and cut to PERSONA_MAX_CHARS characters; anything else is '' */
export function cleanPersonaSetting(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return Array.from(personaText(raw)).slice(0, PERSONA_MAX_CHARS).join('');
}

/** a name the player typed: trimmed, at most TUTOR_NAME_MAX characters; an empty one falls back to the default */
export function cleanTutorName(raw: unknown, fallback: string = TUTOR_DEFAULT_NAME): string {
  const t = typeof raw === 'string' ? Array.from(raw.trim()).slice(0, TUTOR_NAME_MAX).join('') : '';
  return t || fallback;
}

/** a subtitle the player typed: control characters removed, trimmed, at most TUTOR_SUBTITLE_MAX characters; an empty one is the fallback */
export function cleanTutorSubtitle(raw: unknown, fallback: string = TUTOR_SUBTITLE_DEFAULT): string {
  const t = typeof raw === 'string' ? Array.from(raw.replace(/[\u0000-\u001F\u007F]/g, '').trim()).slice(0, TUTOR_SUBTITLE_MAX).join('').trim() : '';
  return t || fallback;
}

/** a saved figure view: finite numbers, the scale kept in FIGURE_SCALE_MIN..FIGURE_SCALE_MAX; anything else is null (no saved view) */
export function cleanFigureView(raw: unknown): FigureView | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.scale !== 'number' || !Number.isFinite(o.scale) || typeof o.x !== 'number' || !Number.isFinite(o.x)
    || typeof o.y !== 'number' || !Number.isFinite(o.y)) return null;
  return { scale: Math.min(FIGURE_SCALE_MAX, Math.max(FIGURE_SCALE_MIN, o.scale)), x: o.x, y: o.y };
}

/** the view to keep for her figure: the identity is no saved view (null), anything else is kept (cleaned) */
export function figureViewToSave(view: { scale: number; x: number; y: number }): FigureView | null {
  if (view.scale === 1 && view.x === 0 && view.y === 0) return null;
  return cleanFigureView(view);
}

/** the view her figure starts with: the saved one when the picture is kept (not the hamster's own), else the default framing */
export function figureViewStart(custom: boolean, stored: FigureView | null): { scale: number; x: number; y: number } {
  return custom && stored ? { ...stored } : { scale: 1, x: 0, y: 0 };
}

/** the personality sent with her requests: her own text, else the default of her id (むぎ's is the server's own: '') */
export function effectivePersona(c: Character): string {
  return c.persona || defaultPersonaOf(c.id);
}

/** the id of a character the player adds: a short random id, never a built-in one */
export function newCharacterId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** an id a save holds: letters, digits and '-', 1 to 32 characters; anything else is not a character */
const cleanId = (raw: unknown): string | null => (typeof raw === 'string' && /^[A-Za-z0-9-]{1,32}$/.test(raw) ? raw : null);

/** one character as a save holds it; a missing field gets its default. The built-in ones default to their own name and voice. */
function cleanCharacter(raw: unknown, id: string): Character {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const builtin = isBuiltinId(id) ? id : null;
  const base = builtin ? BUILTIN_CHARACTERS[builtin] : null;
  // 結衣's old default subtitle (a university student) becomes the new default; anything the player typed is kept
  const subtitle = cleanTutorSubtitle(o.subtitle, base?.subtitle ?? TUTOR_NEW_SUBTITLE);
  return {
    id,
    name: cleanTutorName(o.name, base?.defaultName ?? TUTOR_NEW_NAME),
    subtitle: builtin === 'yui' && subtitle === LEGACY_YUI_SUBTITLE ? base?.subtitle ?? subtitle : subtitle,
    persona: cleanPersonaSetting(o.persona),
    figureView: cleanFigureView(o.figureView),
    voice: 'voice' in o ? cleanCharacterVoice(o.voice) : (builtin ? BUILTIN_VOICE[builtin] : null),
  };
}

/** the characters of a save: the three built-in ones always (added back when missing), then the added ones, at most the maximum */
function cleanCharacters(raw: unknown): Character[] {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const added: Character[] = [];
  const byId = new Map<string, unknown>();
  for (const item of list) {
    const id = cleanId((item as Record<string, unknown> | null)?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    byId.set(id, item);
    if (!isBuiltinId(id)) added.push(cleanCharacter(item, id));
  }
  const builtins = BUILTIN_IDS.map((id) => (byId.has(id) ? cleanCharacter(byId.get(id), id) : builtinCharacter(id)));
  return [...builtins, ...added].slice(0, TUTOR_CHARACTERS_MAX);
}

/** the character on screen: the active one, else the first (a save never leaves it without one) */
export function activeCharacter(s: TutorSettings): Character {
  return s.characters.find((c) => c.id === s.activeId) ?? s.characters[0];
}

/** an older save has the one-tutor fields at the top (name, subtitle, persona, figureView): they become character 1 */
function legacyCharacters(o: Record<string, unknown>): Character[] {
  const mugi: Character = {
    id: 'mugi',
    name: cleanTutorName(o.name),
    subtitle: cleanTutorSubtitle(o.subtitle),
    persona: cleanPersonaSetting(o.persona),
    figureView: cleanFigureView(o.figureView),
    voice: null,
  };
  return [mugi, builtinCharacter('yui'), builtinCharacter('yuma')];
}

/**
 * Any saved value as the settings: the characters (or, in an older save, the top-level fields as character 1), the other fields
 * cleaned, and the defaults for anything missing or not in the list. Never throws.
 */
export function migrateTutor(raw: unknown): TutorSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const characters = Array.isArray(o.characters) ? cleanCharacters(o.characters) : cleanCharacters(legacyCharacters(o));
  const activeId = typeof o.activeId === 'string' && characters.some((c) => c.id === o.activeId) ? o.activeId : characters[0].id;
  // backgrounds: the added ids (unique, not built-in, at most the maximum); an older save's 'custom' is the added background 'custom'
  const listed = Array.isArray(o.customBackgrounds) ? o.customBackgrounds : [];
  let added: string[] = [];
  for (const id of listed) {
    if (typeof id === 'string' && /^[A-Za-z0-9-]{1,32}$/.test(id) && !isBuiltinBackground(id) && !added.includes(id)) added.push(id);
  }
  const oldBackground = typeof o.background === 'string' ? o.background : 'classroom';
  if (oldBackground === 'custom' && !added.includes('custom')) added = ['custom', ...added];
  added = added.slice(0, TUTOR_BACKGROUNDS_MAX);
  const background = cleanBackgroundId(o.background, added);
  // an older save kept one dimming and one view for its background: they belong to the background it had (the old 'custom' included)
  const opts = cleanBackgroundOpts(o.backgroundOpts, [...BUILTIN_BACKGROUNDS, ...added]);
  if (!('backgroundOpts' in o) && ('backgroundDim' in o || 'backgroundView' in o)) {
    const old = oldBackground === 'custom' ? 'custom' : cleanBackgroundId(oldBackground, added);
    opts[old] = { dim: cleanBackgroundDim(o.backgroundDim), view: cleanBackdropView(o.backgroundView) };
  }
  return {
    characters,
    activeId,
    sttLang: o.sttLang === 'zh-TW' ? 'zh-TW' : 'ja-JP',
    chatModel: isChatModelId(o.chatModel) ? o.chatModel : '',
    helperModel: isChatModelId(o.helperModel) ? o.helperModel : DEFAULT_TUTOR.helperModel,
    providers: parseProviderList(o.providers) ?? [...DEFAULT_PROVIDERS],
    openaiModel: cleanOpenaiModel(o.openaiModel),
    background,
    customBackgrounds: added,
    backgroundOpts: opts,
  };
}

export function loadTutor(): TutorSettings {
  try {
    const t = localStorage.getItem(TUTOR_KEY);
    return t ? migrateTutor(JSON.parse(t)) : migrateTutor(null);
  } catch {
    return migrateTutor(null);
  }
}

export function writeTutor(s: TutorSettings) {
  try { localStorage.setItem(TUTOR_KEY, JSON.stringify(migrateTutor(s))); } catch { /* private mode: the name lasts this visit */ }
}

/** rename the active character: the cleaned name is saved with the other settings and returned */
export function renameTutor(raw: string, settings: TutorSettings): TutorSettings {
  const next = updateCharacter(settings, activeCharacter(settings).id, { name: cleanTutorName(raw) });
  writeTutor(next);
  return next;
}

/** changes one character's fields (the id stays); an unknown id changes nothing */
export function updateCharacter(s: TutorSettings, id: string, patch: Partial<Omit<Character, 'id'>>): TutorSettings {
  return { ...s, characters: s.characters.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
}

/** the active character becomes the one with this id (an unknown id changes nothing) */
export function selectCharacter(s: TutorSettings, id: string): TutorSettings {
  return s.characters.some((c) => c.id === id) ? { ...s, activeId: id } : s;
}

/** adds a character (name 新角色, the neutral personality, the 設定 page's voice) and makes it the active one; null at the maximum */
export function addCharacter(s: TutorSettings, id: string = newCharacterId()): TutorSettings | null {
  if (s.characters.length >= TUTOR_CHARACTERS_MAX || s.characters.some((c) => c.id === id)) return null;
  const c: Character = { id, name: TUTOR_NEW_NAME, subtitle: TUTOR_NEW_SUBTITLE, persona: '', figureView: null, voice: null };
  return { ...s, characters: [...s.characters, c], activeId: id };
}

/**
 * Deletes an added character. The built-in ones (むぎ, 結衣, 悠真) and an unknown id change nothing. When the deleted one was the
 * active one, the first character becomes the active one.
 */
export function deleteCharacter(s: TutorSettings, id: string): TutorSettings {
  if (isBuiltinId(id) || !s.characters.some((c) => c.id === id)) return s;
  const characters = s.characters.filter((c) => c.id !== id);
  return { ...s, characters, activeId: s.activeId === id ? characters[0].id : s.activeId };
}

/** the storage key of a character's chat history: むぎ keeps today's key, the others have their own */
export function tutorChatKey(id: string = 'mugi'): string {
  return id === 'mugi' ? TUTOR_CHAT_KEY : `${TUTOR_CHAT_KEY}.${id}`;
}

/** her chat history (her lines and the player's, tips included); a broken or missing value is an empty chat */
export function loadTutorChat(id: string = 'mugi'): ChatLine[] {
  try {
    const t = localStorage.getItem(tutorChatKey(id));
    if (!t) return [];
    const v = JSON.parse(t);
    return Array.isArray(v) ? (v as ChatLine[]).filter((l) => l && (l.from === 'me' || l.from === 'her') && typeof l.text === 'string').slice(-TUTOR_CHAT_KEEP) : [];
  } catch {
    return [];
  }
}

export function writeTutorChat(lines: ChatLine[], id: string = 'mugi') {
  try { localStorage.setItem(tutorChatKey(id), JSON.stringify(lines.slice(-TUTOR_CHAT_KEEP))); } catch { /* private mode */ }
}

export function clearTutorChat(id: string = 'mugi') {
  try { localStorage.removeItem(tutorChatKey(id)); } catch { /* ignore */ }
}
