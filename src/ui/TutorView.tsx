// 日語家教 (the tutor mode): a pure Japanese chat with a 2D portrait of the active character (人物: むぎ the hamster, 結衣, 悠真, or one
// the player added). The replies come from Claude in teacher mode (game/claudeBrain askClaude); the chat, the 小提醒 and the notebook,
// 速查, the mic and the voice loop are the shared pieces. Settings live under their own key (game/tutor.ts); each character has its
// own chat history and picture, and her voice (game/characterVoice) is handed to the speech queue.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatLine } from '../game/chatTypes';
import { replayText } from '../game/replay';
import { nextPocketTopic } from '../game/pocketTopics';
import { cloudVoiceList, fetchTtsStatus } from '../game/cloudTts';
import { claudeStatus, markIdleReset, markPersonaReset, markWindowReset, personaKey, reviseTip, replaceTipLine, timeOfDayText, topicSent, TIP_REVISE_TIMEOUT_MS, userChatLine, type ClaudeContext, type ClaudeStatus } from '../game/claudeBrain';
import { fallbackChain, replyWithFallback } from '../game/chatBrain';
import { addTip, updateTip } from '../game/tipsBook';
import {
  activeCharacter, addBackground, addCharacter, aiServicesOf, backgroundOptOf, cleanTutorSubtitle, clearTutorChat, deleteBackground, deleteCharacter,
  effectivePersona, figureViewStart, figureViewToSave, selectBackground, updateBackgroundOpt,
  loadTutor, loadTutorChat, renameTutor, selectCharacter, serviceReady, updateCharacter, writeTutor, writeTutorChat,
  FIGURE_SCALE_MAX, FIGURE_SCALE_MIN, TUTOR_CHARACTERS_MAX, TUTOR_CHAT_KEEP, TUTOR_NAME_MAX, TUTOR_NEW_SUBTITLE, TUTOR_SUBTITLE_MAX,
  type Character, type TutorSettings,
} from '../game/tutor';
import { fetchChatGptStatus, takeChatGptReturn, type ChatGptStatus } from '../game/openaiStatus';
import { fetchLocalStatus, type LocalStatus } from '../game/localStatus';
import { CHAT_INPUT_MAX_CHARS, clipCodePoints } from '../game/claudeProtocol';
import { BUILTIN_CHARACTERS, anchorOf, defaultPersonaOf, isBuiltinId } from '../game/tutorCharacters';
import { speakPlanFor, type CharacterVoice } from '../game/characterVoice';
import { parseTutorArt, type TutorArt } from '../game/tutorFace';
import { setSpeakerVoice, speakReply, startSpeakingReplies, stopSpeaking, unlockSpeech } from '../game/tts';
import { readZoomOn, toggleZoom, writeZoomOn, type ZoomState } from '../game/tutorZoom';
import { DEFAULT_SCENE, dimOf, type BackdropView, type ZoomTarget } from '../game/tutorScene';
import { loadBackgroundPicture, useBackgroundUrl } from '../game/tutorBackground';
import { playMusic, stopMusic } from '../game/audio';
import { LookupSheet } from './LookupSheet';
import { TipsSheet } from './TipsSheet';
import { AiServiceSection, BackgroundSection, BudgetSection, ChatDataSection, CloudKeysSection, CustomArtSection, FigureSection, ModelSection, PersonaSection, SettingsSheet, SoundSection, UsageSection, useSoundSettings } from './SettingsSections';
import { loadCustomArt, clearCustomArt, customPortraitOf, filePortrait, useArtUrls, type CustomArt, type CustomPortrait } from '../game/customArt';
import { LookupButton, TipsButton, useTipStat } from './StudyButtons';
import { rubyNodes } from './Furigana';
import { joinDictation } from './dictation';
import { useIOSKeyboard } from './useIOSKeyboard';
import { useDictationScroll } from './useDictationScroll';
import { speechNoteText, useSpeechInput } from './useSpeechInput';
import { ChatBar } from './ChatBar';
import { IconGear, IconPerson } from './icons';
import { useVoiceChat, type VoicePhase } from './useVoiceChat';
import { TutorPortrait, preloadTutorArt, tutorArtDir } from './TutorPortrait';
import { TutorBackdrop } from './TutorBackdrop';
import './assistant.css';
import './tutor.css';

const VOICE_LABEL: Record<VoicePhase, string> = { off: '', listening: '聆聽中…', thinking: '思考中…', speaking: '說話中…' };
const LEVEL_NOTE_MS = 4000;
const HAMSTER = BUILTIN_CHARACTERS.mugi;
/** the chat role every character uses (the persona text carries the personality, server/prompts.ts) */
const CHAT_ROLE = HAMSTER.role;

/** the voice choices of 聲音 for the gender defaults (the engine's own voice of that gender) */
const GENDER_LABEL = { female: '女聲', male: '男聲' } as const;

/** the 聲音 row's value of a voice: 跟隨設定頁, a gender (the engine's own voice of it), or one listed voice */
function voiceValueOf(v: CharacterVoice): string {
  if (!v) return '';
  if (v.ja) return `voice:${v.ja}`;
  return `auto:${v.gender ?? 'female'}`;
}

/** 日語家教 screen: the whole app (there is no menu to go back to). */
export default function TutorView() {
  const [settings, setSettings] = useState<TutorSettings>(loadTutor);
  const active: Character = activeCharacter(settings);
  const activeId = active.id;
  const name = active.name;
  const builtin = isBuiltinId(activeId) ? BUILTIN_CHARACTERS[activeId] : null;
  // the chat on screen is the active character's; chatOwner is the character it belongs to (its history is written under that id)
  const [chat, setChat] = useState<ChatLine[]>(() => loadTutorChat(settings.activeId));
  const [chatOwner, setChatOwner] = useState<string>(settings.activeId);
  const chatRef = useRef(chat);
  chatRef.current = chat;
  // her art (tutor.json, see game/tutorFace.ts): the hamster's mouth overlays; without it there are none
  const [art, setArt] = useState<TutorArt | null>(null);
  // the pictures the player chose (人設圖片, game/customArt), one record per character id; a missing one is her built-in picture
  const [arts, setArts] = useState<Record<string, CustomArt | null>>({});
  const customArt = arts[activeId] ?? null;
  const customUrls = useArtUrls(customArt);
  const customPicture = useMemo(() => customPortraitOf(customArt, customUrls), [customArt, customUrls]);
  // 結衣 and 悠真 have built-in pictures (open and closed); むぎ's are the overlays; an added character with none is a silhouette
  const builtinPicture = useMemo<CustomPortrait | null>(() => {
    if (!builtin || builtin.picture === 'hamster') return null;
    const dir = tutorArtDir(builtin.artDir);
    return filePortrait(dir + builtin.picture.open, dir + builtin.picture.closed);
  }, [builtin]);
  const picture = customPicture ?? builtinPicture;
  // a character keeps her saved view when her picture is not the hamster's own (or the player chose one for her)
  const keepsView = activeId !== 'mugi' || customArt !== null;
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  // ChatGPT's sign-in (game/openaiStatus): null until read
  const [chatgpt, setChatgpt] = useState<ChatGptStatus | null>(null);
  const refreshChatGpt = useCallback(() => { void fetchChatGptStatus().then((s) => { if (s) setChatgpt(s); }); }, []);
  // the local model server on the PC (game/localStatus): null until read
  const [local, setLocal] = useState<LocalStatus | null>(null);
  const refreshLocal = useCallback(() => { void fetchLocalStatus().then((s) => { if (s) setLocal(s); }); }, []);
  // a key was saved in Settings: the server rereads .env.local on each request, so the Claude and speech status are read again now
  const keysSaved = useCallback(() => { void claudeStatus().then(setClaude); void fetchTtsStatus(); refreshLocal(); }, [refreshLocal]);
  const [streamText, setStreamText] = useState(''); // her reply while it is still being written
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const [chatOpen, setChatOpen] = useState(false);
  const [sheet, setSheet] = useState<null | 'character' | 'settings' | 'tips' | 'lookup'>(null);
  const [note, setNote] = useState('');
  // 自由縮放 (free zoom / pan of the figure): the toggle is kept for the session; the view is never kept (it resets on leaving)
  const [zoom, setZoom] = useState<ZoomState>(() => ({ on: readZoomOn(), view: { scale: 1, x: 0, y: 0 }, dragging: false }));
  const toggleFreeZoom = () => { const z = toggleZoom(zoom); writeZoomOn(z.on); setZoom(z); };
  // 背景 (all characters share it): the one in use is the classroom, plain black, or an added one (its picture is read from IndexedDB,
  // one per id). Each has its own dimming and view. What the free zoom moves (角色 or 背景) is zoomTarget.
  const [bgPictures, setBgPictures] = useState<Record<string, Blob | null>>({});
  const [zoomTarget, setZoomTarget] = useState<ZoomTarget>('figure');
  const [bgDragging, setBgDragging] = useState(false);
  const bgId = settings.background;
  const added = bgId !== 'classroom' && bgId !== 'black';
  const bgUrl = useBackgroundUrl(added ? bgPictures[bgId] ?? null : null);
  const bgOpt = backgroundOptOf(settings, bgId);
  const bgView: BackdropView = bgOpt.view;
  const classroom = bgId === 'classroom';
  const classroomUrl = `${import.meta.env.BASE_URL}${DEFAULT_SCENE.file}`;
  // a background is shown: the classroom, or an added one once its picture is read (black and a picture not yet read show none)
  const showBg = classroom || (added && bgUrl !== null);
  const onBackdrop = zoom.on && showBg && zoomTarget === 'backdrop';
  const figureZoom: ZoomState = { ...zoom, on: zoom.on && !onBackdrop };
  const dim = dimOf(added, bgOpt.dim);
  /** the background view moves (pinch / drag); it is kept with that background in the settings and written when a gesture ends */
  const putBgView = (v: BackdropView, dragging: boolean) => { setBgDragging(dragging); setSettings((s) => updateBackgroundOpt(s, s.background, { view: v })); };
  const { audio, tts, cloud } = useSoundSettings();
  const tipStat = useTipStat();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const keyboard = useIOSKeyboard(rootRef, inputRef);
  const markDictated = useDictationScroll(inputRef, input); // dictation: the field follows the end of the recognised text
  const historyRef = useRef<HTMLUListElement>(null);
  const inputFocused = useRef(false);
  const dictBase = useRef('');
  const dictDiscard = useRef(false);

  // the hamster's art (tutor.json, written by hand next to her body picture)
  useEffect(() => {
    let live = true;
    const dir = tutorArtDir(HAMSTER.artDir);
    fetch(`${dir}tutor.json`).then((r) => (r.ok ? r.json() : null)).then((j) => {
      const a = parseTutorArt(j);
      if (!a) return;
      preloadTutorArt(a, dir);
      if (live) setArt(a);
    }).catch(() => {});
    return () => { live = false; };
  }, []);
  // each character's own picture, if one is stored on this device (game/customArt; a failed read means her built-in picture)
  const loadingArt = useRef(new Set<string>());
  useEffect(() => {
    for (const c of settings.characters) {
      if (loadingArt.current.has(c.id)) continue;
      loadingArt.current.add(c.id);
      void loadCustomArt(c.id).then((a) => setArts((m) => ({ ...m, [c.id]: a })));
    }
  }, [settings.characters]);
  // her figure's free-zoom view (角色): kept per character. When she (or her picture) changes, her view starts from her saved one; the
  // first save after that restore is skipped, so the restored view is not written over with the old one before it has been applied.
  const skipFigureSave = useRef(false);
  useEffect(() => {
    setZoom((z) => ({ ...z, view: figureViewStart(keepsView, active.figureView), dragging: false }));
    skipFigureSave.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, keepsView]);
  useEffect(() => {
    if (skipFigureSave.current) { skipFigureSave.current = false; return; }
    if (!keepsView || zoom.dragging) return;
    const saved = figureViewToSave(zoom.view);
    const cur = active.figureView;
    const same = saved === null ? cur === null : cur !== null && cur.scale === saved.scale && cur.x === saved.x && cur.y === saved.y;
    if (!same) patchActive({ figureView: saved });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom.view, zoom.dragging, activeId, keepsView]);
  // her replies are voiced through the reply bus while she is on screen (game/tts)
  useEffect(() => startSpeakingReplies(), []);
  useEffect(() => () => stopSpeaking(), []);
  // her voice (人物 › 聲音): the speech queue speaks her Japanese lines with it; the 設定 page's voice when none is chosen
  const jaEngine = tts.ja.engine;
  useEffect(() => {
    setSpeakerVoice(speakPlanFor(active.voice, jaEngine, (e) => cloudVoiceList(e, 'ja')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.voice, jaEngine, cloud]);
  useEffect(() => () => setSpeakerVoice(null), []);
  // the background music (the tutor's own track, public/audio/bgm.mp3; silent when the file is missing)
  useEffect(() => { playMusic(); return () => stopMusic(); }, []);
  useEffect(() => { void claudeStatus().then(setClaude); }, []);
  // back from the ChatGPT sign-in (/?chatgpt=ok): the status is read again, and the marker leaves the address bar
  useEffect(() => { takeChatGptReturn(); refreshChatGpt(); }, [refreshChatGpt]);
  // the local model is asked for when the page opens and each time it comes back into view (Ollama may have been started since)
  useEffect(() => {
    refreshLocal();
    const onVisible = () => { if (document.visibilityState === 'visible') refreshLocal(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refreshLocal]);
  useEffect(() => { void fetchTtsStatus(); }, []);
  useEffect(() => { writeTutorChat(chat, chatOwner); }, [chat, chatOwner]);
  // the added backgrounds' pictures, each read once from this device (a failed read means none)
  const loadingBg = useRef(new Set<string>());
  useEffect(() => {
    for (const id of settings.customBackgrounds) {
      if (loadingBg.current.has(id)) continue;
      loadingBg.current.add(id);
      void loadBackgroundPicture(id).then((p) => setBgPictures((m) => ({ ...m, [id]: p })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.customBackgrounds]);
  // the background view is written once a gesture has ended (not on every move)
  useEffect(() => { if (!bgDragging) writeTutor(settings); }, [bgDragging, bgId, bgView.scale, bgView.x, bgView.y]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const el = historyRef.current; if (el) el.scrollTop = el.scrollHeight; }, [chatOpen, chat.length, streamText]);
  useEffect(() => { if (!note) return; const id = setTimeout(() => setNote(''), LEVEL_NOTE_MS); return () => clearTimeout(id); }, [note]);

  const sttLang = settings.sttLang;
  // a reply can come from any chosen service that is ready (Claude with its key, ChatGPT signed in with the plan, the local model answering)
  const ready = serviceReady(settings.providers, {
    anthropic: !!claude?.ok, openai: !!chatgpt?.signedIn && !!chatgpt.planEnabled, local: !!local?.ok,
  });
  // her personality as it is sent, and the key that covers it with her name (a change of either starts the request window over)
  const persona = effectivePersona(active);

  // ---------- chat ----------
  const send = useCallback(async (raw: string) => {
    unlockSpeech(); // iOS: speech only starts inside a user gesture (the send / enter tap is one)
    const text = raw.trim();
    if (!text || busy || !ready) return;
    const now = new Date();
    const ctx: ClaudeContext = { timeOfDay: timeOfDayText(now.getHours(), now.getMinutes()) };
    const key = personaKey(persona, name);
    const mine = { ...userChatLine(text, ctx, 'teacher', Date.now()), pk: key };
    const history = markWindowReset(markPersonaReset([...markIdleReset(chatRef.current, Date.now()), mine].slice(-TUTOR_CHAT_KEEP), key));
    setChat(history);
    setBusy(true);
    setStreamText('');
    try {
      // her chain is Claude alone (she teaches, and only Claude can); a failure goes to the note below
      const { reply: c } = await replyWithFallback(fallbackChain(), { history, situation: ctx, mode: 'teacher', role: CHAT_ROLE, onDelta: (t) => setStreamText(t) });
      setStreamText('');
      const tipT = Date.now();
      const tipEntry = c.tip ? addTip({ text: c.tip, targets: c.tipJa ?? [], said: text, role: CHAT_ROLE }) : null;
      // her line keeps the reply as it is sent back to Claude (its JSON, tip left out: sent)
      const her: ChatLine = { from: 'her', text: c.text, t: Date.now(), sent: c.sent, pk: key };
      const tipLine: ChatLine[] = c.tip ? [{ from: 'her', text: c.tip, t: tipT, tip: true, pk: key }] : [];
      setChat((cur) => [...cur, her, ...tipLine].slice(-TUTOR_CHAT_KEEP));
      // a tip with Japanese prose is shown as it is, then rewritten in the background
      if (c.tip && c.tipRewrite && c.tipRaw) {
        const oldText = c.tip, entryId = tipEntry?.id;
        void reviseTip(c.tipRaw, TIP_REVISE_TIMEOUT_MS, settings.helperModel, aiServicesOf(settings)).then((fixed) => {
          if (!fixed) return;
          setChat((cur) => replaceTipLine(cur, tipT, oldText, fixed.text));
          if (entryId) updateTip(entryId, { text: fixed.text, targets: fixed.targets });
        });
      }
    } catch (e) {
      setStreamText('');
      setNote(`${name}暫時不能回話：${e instanceof Error ? e.message : '未知錯誤'}`);
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, ready, name, persona, settings.helperModel, settings.providers, settings.openaiModel]);

  const sendRef = useRef(send);
  sendRef.current = send;
  const voice = useVoiceChat({ send: (t) => sendRef.current(t), lang: sttLang });
  const mic = useSpeechInput({
    onPartial: (t) => { if (!dictDiscard.current) { const v = clipCodePoints(joinDictation(dictBase.current, t), CHAT_INPUT_MAX_CHARS); markDictated(v); setInput(v); } },
    onFinal: (t) => { if (dictDiscard.current) return; dictBase.current = clipCodePoints(joinDictation(dictBase.current, t), CHAT_INPUT_MAX_CHARS); markDictated(dictBase.current); setInput(dictBase.current); },
    onEnd: () => { dictDiscard.current = false; },
    onError: (code) => { setNote(speechNoteText(code)); },
  }, { lang: sttLang, dictation: true });

  // the notebook / lookup / settings take the voice chat and the mic off: they would fight over the microphone
  const stopMic = () => { if (voice.active) voice.stop(); if (mic.listening) mic.stop(); };

  const submit = () => {
    if (mic.listening) { dictDiscard.current = true; mic.stop(); }
    const t = input;
    dictBase.current = '';
    setInput('');
    void send(t);
  };

  /** tap her bubble / line: she says it again (her Japanese only; tips are never said) */
  const replay = (line: ChatLine) => {
    const text = replayText({ from: line.from, text: line.text, tip: line.tip });
    if (text === null || !tts.on) return;
    stopSpeaking();
    speakReply(text);
  };

  /** 換她開話題: a Japanese pocket topic (game/pocketTopics, no API). Claude later sees the Japanese in <ja> with its Chinese (`sent`) */
  const openTopic = () => {
    stopSpeaking();
    const t = nextPocketTopic();
    const key = personaKey(persona, name);
    const line: ChatLine = { from: 'her', text: `${t.ja}（${t.jaZh}）`, t: Date.now(), sent: topicSent(t.ja, t.jaZh), topic: true, pk: key };
    setChat((cur) => markPersonaReset([...cur, line], key).slice(-TUTOR_CHAT_KEEP));
    const spoken = replayText({ from: line.from, text: line.text });
    if (spoken !== null && tts.on) speakReply(spoken);
  };

  const lastHer = useMemo(() => [...chat].reverse().find((c) => c.from === 'her' && !c.tip), [chat]);
  const bubble = streamText || lastHer?.text || '';

  // her figure as it is drawn: on the classroom's lectern (in its own layer, on the scene's default box), else at the stage's bottom
  const portrait = (
    <TutorPortrait art={art} artDir={active.id === 'mugi' ? HAMSTER.artDir : (builtin?.artDir ?? '')} label={name} custom={picture}
      placeholder={!picture && !builtin}
      zoom={{ state: figureZoom, set: setZoom, range: keepsView ? { minScale: FIGURE_SCALE_MIN, maxScale: FIGURE_SCALE_MAX } : undefined }}
      anchor={classroom ? anchorOf(activeId) : null} />
  );

  /** the settings are kept and written (writeTutor cleans them on save) */
  const commit = (next: TutorSettings) => {
    setSettings(next);
    writeTutor(next);
  };
  const setName = (raw: string) => {
    setSettings(renameTutor(raw, settings));
  };
  /** the model and personality settings: kept with the other settings */
  const setPrefs = (patch: Partial<TutorSettings>) => commit({ ...settings, ...patch });
  /** one field (or more) of the active character */
  const patchActive = (patch: Partial<Omit<Character, 'id'>>) => commit(updateCharacter(settings, activeId, patch));
  const clearChat = () => { clearTutorChat(activeId); setChat([]); };
  /** the 人物 sheet's own reset: her figure goes back to the default framing, and the saved view is removed */
  const resetFigure = () => {
    setZoom((z) => ({ ...z, view: { scale: 1, x: 0, y: 0 }, dragging: false }));
    patchActive({ figureView: null });
  };
  /** switches the active character: her chat (its own history) comes on screen; nothing is sent while a reply is being written */
  const pickCharacter = (id: string) => {
    if (busy || id === activeId) return;
    writeTutorChat(chatRef.current, chatOwner);
    setStreamText('');
    setChat(loadTutorChat(id));
    setChatOwner(id);
    commit(selectCharacter(settings, id));
  };
  /** adds a character (up to TUTOR_CHARACTERS_MAX) and makes it the active one, with an empty chat */
  const addChar = () => {
    const next = addCharacter(settings);
    if (!next || busy) return;
    writeTutorChat(chatRef.current, chatOwner);
    setStreamText('');
    setChat([]);
    setChatOwner(next.activeId);
    commit(next);
  };
  /** deletes an added character after the player confirms: her chat, her picture and her view go with her */
  const deleteChar = () => {
    if (isBuiltinId(activeId) || busy) return;
    if (!window.confirm(`刪除「${name}」？她的對話和圖片也會一起刪除。`)) return;
    const next = deleteCharacter(settings, activeId);
    clearTutorChat(activeId);
    void clearCustomArt(activeId).catch(() => {});
    setArts((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== activeId)));
    setChat(loadTutorChat(next.activeId));
    setChatOwner(next.activeId);
    commit(next);
  };
  /** the 聲音 row: follow the 設定 page, a gender's voice of the engine, or one voice the engine lists */
  const setVoiceValue = (value: string) => {
    if (value === '') { patchActive({ voice: null }); return; }
    if (value.startsWith('auto:')) { patchActive({ voice: { gender: value.slice(5) === 'male' ? 'male' : 'female' } }); return; }
    if (value.startsWith('voice:') && jaEngine !== 'browser') {
      patchActive({ voice: { engine: jaEngine, ja: value.slice(6), gender: active.voice?.gender ?? 'female' } });
    }
  };
  /** a background was added (its picture is stored by the section): it is the one in use */
  const onBgAdded = (id: string, picture: Blob) => {
    setBgPictures((m) => ({ ...m, [id]: picture }));
    const next = addBackground(settings, id);
    if (next) commit(next);
  };
  /** an added background was deleted (its picture was removed by the section) */
  const onBgDeleted = (id: string) => {
    setBgPictures((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== id)));
    commit(deleteBackground(settings, id));
  };
  const openSheet = (s: 'character' | 'settings' | 'tips' | 'lookup') => {
    stopMic();
    // the settings show the sign-in as it is now
    if (s === 'settings') { refreshChatGpt(); refreshLocal(); }
    setSheet(s);
  };

  // the 聲音 choices: the 設定 page's engine's Japanese voices (none for the device voice)
  const voiceOptions = jaEngine === 'browser' ? [] : cloudVoiceList(jaEngine, 'ja');
  const defaultPersona = activeId === 'mugi' ? claude?.personas?.Mugi ?? '' : defaultPersonaOf(activeId);
  const subtitleFallback = builtin?.subtitle ?? TUTOR_NEW_SUBTITLE;
  const artDefaultLabel = activeId === 'mugi' ? '預設倉鼠' : builtin ? '內建圖片' : '預設剪影';

  return (
    <div className="tutor" ref={rootRef}>
      {/* the background is the whole screen (behind the top bar, the notch and the chat bar): the scene is covered against the
          full viewport, so she stays on the lectern. Her figure is drawn in its own layer on the scene's default box, so a
          background zoom moves the picture only. */}
        {classroom && (
          <TutorBackdrop src={classroomUrl} anchored dim={dim} view={bgView} dragging={bgDragging} gestures={onBackdrop} onView={putBgView}
            figure={portrait} />
        )}
        {!classroom && showBg && bgUrl && (
          <TutorBackdrop src={bgUrl} anchored={false} dim={dim} view={bgView} dragging={bgDragging} gestures={onBackdrop} onView={putBgView} />
        )}
      <header className="tutor-top">
        <div className="tutor-switcher">
          <div className="tutor-title"><strong>{name}</strong><span>{active.subtitle}</span></div>
        </div>
        <div className="tutor-tools">
          <button className="as-icon" aria-label="設定" onClick={() => openSheet('settings')}><IconGear /></button>
          <LookupButton ready={ready} onClick={() => openSheet('lookup')} />
          <TipsButton open={tipStat.open} onClick={() => openSheet('tips')} />
        </div>
      </header>

      {/* top left: 人物 (her sheet), then the free zoom (自由縮放); under them, while the zoom is on with a background, the 角色｜背景 target */}
      <div className="tutor-zoom-tools">
        <div className="tutor-zoom-row">
          <button className="as-icon" aria-label="人物" title="人物（角色、名字、人設、人設圖片、聲音、背景）" onClick={() => openSheet('character')}><IconPerson /></button>
          <button className={zoom.on ? 'as-icon as-orbit-btn on' : 'as-icon as-orbit-btn'} title="自由縮放／平移（雙指縮放、拖曳移動，點兩下還原）"
            aria-label="自由縮放" aria-pressed={zoom.on} onClick={toggleFreeZoom}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5L21 21" /><path d="M10.5 7.5v6" /><path d="M7.5 10.5h6" />
            </svg>
          </button>
        </div>
        {zoom.on && showBg && (
          <div className="as-seg tutor-target" role="radiogroup" aria-label="縮放的對象">
            <button type="button" role="radio" aria-checked={zoomTarget === 'figure'} className={zoomTarget === 'figure' ? 'on' : undefined}
              onClick={() => setZoomTarget('figure')}>角色</button>
            <button type="button" role="radio" aria-checked={zoomTarget === 'backdrop'} className={zoomTarget === 'backdrop' ? 'on' : undefined}
              onClick={() => setZoomTarget('backdrop')}>背景</button>
          </div>
        )}
      </div>

      <div className={zoom.on ? 'tutor-stage zoomed' : 'tutor-stage'}>
        {!classroom && portrait}
        {bubble && !chatOpen && (
          <div className="tutor-bubble" onClick={lastHer && !streamText ? () => replay(lastHer) : undefined}>
            <b>{name}</b><span className="tutor-bubble-text">{rubyNodes(bubble)}</span>
          </div>
        )}
      </div>

      <section className="chat-dock">
        <ChatBar
          inputRef={inputRef} value={input}
          onChange={(v) => { const t = clipCodePoints(v, CHAT_INPUT_MAX_CHARS); dictBase.current = t; setInput(t); }}
          maxChars={CHAT_INPUT_MAX_CHARS}
          placeholder={ready ? `和${name}練習…` : '需要金鑰'}
          ghostHint={`和${name}練習…`}
          disabled={!ready}
          onFocus={() => { keyboard.onFocus(); inputFocused.current = true; setChatOpen(true); }}
          onBlur={() => { inputFocused.current = false; keyboard.onBlur(); }}
          onSubmit={() => submit()}
          sendDisabled={busy || !ready}
          chatOpen={chatOpen} onToggleChat={setChatOpen}
          historyRef={historyRef}
          history={<>
            {chat.length === 0 && <li className="as-hint">跟{name}練習日語吧～ 用日文或中文說都可以。</li>}
            {chat.map((c, i) => c.tip
              ? <li key={`${c.t}-${i}`} className="her tip"><span className="as-tip-label">小提醒</span>{rubyNodes(c.text)}</li>
              : <li key={`${c.t}-${i}`} className={c.from} onClick={c.from === 'her' ? () => replay(c) : undefined}>{rubyNodes(c.text)}</li>)}
            {streamText && <li className="her">{rubyNodes(streamText)}</li>}
          </>}
          notes={[
            !ready && claude !== null && '需要 AI 服務：請到設定的「AI 服務」設定 Claude 金鑰、登入 ChatGPT，或啟動本地模型',
            note || voice.note || (mic.listening ? `聆聽中…（${sttLang === 'ja-JP' ? '日文' : '中文'}）` : ''),
          ]}
          pill={voice.active ? { phase: voice.phase, label: VOICE_LABEL[voice.phase], onStop: voice.stop } : undefined}
          stt={{
            lang: sttLang, title: '語音辨識的語言',
            onToggle: () => { const next = sttLang === 'ja-JP' ? 'zh-TW' : 'ja-JP'; setPrefs({ sttLang: next as TutorSettings['sttLang'] }); },
          }}
          voice={{ active: voice.active, disabled: !voice.supported || !ready, onToggle: () => { if (ready) voice.toggle(); } }}
          mic={{
            listening: mic.listening, supported: mic.supported,
            onToggle: () => { if (mic.listening) mic.stop(); else { dictBase.current = input; dictDiscard.current = false; voice.stop(); mic.start(); } },
          }}
          onOpenTopic={openTopic}
        />
      </section>

      {/* 人物: the characters (tabs), the active one's name, personality, picture and voice, then the background all of them share */}
      {sheet === 'character' && (
        <SettingsSheet theme="dark" title="人物" onClose={() => setSheet(null)}>
          <div className="char-tabs" role="tablist" aria-label="角色">
            {settings.characters.map((c, i) => (
              <button key={c.id} type="button" role="tab" aria-selected={c.id === activeId} title={c.name} disabled={busy}
                onClick={() => pickCharacter(c.id)}>{i + 1}</button>
            ))}
            <button type="button" aria-label="新增角色" title="新增角色" disabled={busy || settings.characters.length >= TUTOR_CHARACTERS_MAX}
              onClick={addChar}>＋</button>
          </div>
          <h3>名字</h3>
          <label className="as-row"><span>角色名字<small>最多 8 個字</small></span>
            {/* 8 characters counted as code points (a maxLength would count an emoji as two): typing past it is cut */}
            <input className="tutor-name" key={`${activeId}:${name}`} defaultValue={name}
              onInput={(e) => { const t = clipCodePoints(e.currentTarget.value, TUTOR_NAME_MAX); if (t !== e.currentTarget.value) e.currentTarget.value = t; }}
              onBlur={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} aria-label="名字" />
          </label>
          <label className="as-row"><span>副標<small>顯示在名字底下，最多 16 個字</small></span>
            <input className="tutor-name" key={`${activeId}:${active.subtitle}`} defaultValue={active.subtitle} maxLength={TUTOR_SUBTITLE_MAX}
              onBlur={(e) => patchActive({ subtitle: cleanTutorSubtitle(e.currentTarget.value, subtitleFallback) })}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} aria-label="副標" />
          </label>
          <PersonaSection key={`persona:${activeId}`} theme="dark" persona={active.persona} defaultPersona={defaultPersona}
            onChange={(p) => patchActive({ persona: p })} />
          <CustomArtSection key={`art:${activeId}`} theme="dark" art={customArt} characterId={activeId} defaultLabel={artDefaultLabel}
            onChange={(a) => setArts((m) => ({ ...m, [activeId]: a }))} />
          <h3>聲音</h3>
          <label className="as-row"><span>這個角色的聲音<small>{jaEngine === 'browser' ? '設定頁是手機內建語音，沒有可選的聲音' : `設定頁的日文引擎：${jaEngine}`}</small></span>
            <select aria-label="聲音" value={voiceValueOf(active.voice)} onChange={(e) => setVoiceValue(e.currentTarget.value)}>
              <option value="">跟隨設定頁</option>
              <option value="auto:female">女聲（依設定頁的引擎自動選）</option>
              <option value="auto:male">男聲（依設定頁的引擎自動選）</option>
              {voiceOptions.map((v) => <option key={v.id} value={`voice:${v.id}`}>{v.label}</option>)}
            </select>
          </label>
          {jaEngine === 'browser' && <div className="as-lang-note as-voice-note"><small>男聲在內建語音上會把音調降低一些（{GENDER_LABEL.male}）。</small></div>}
          {(keepsView) && <FigureSection theme="dark" onReset={resetFigure} />}
          {!isBuiltinId(activeId) && (
            <div className="as-char-del">
              <button className="as-small danger" disabled={busy} onClick={deleteChar}>刪除這個角色</button>
            </div>
          )}
          <h3 className="tutor-divider">背景（所有角色共用）</h3>
          <BackgroundSection theme="dark" active={bgId} added={settings.customBackgrounds} pictures={bgPictures} dim={dim}
            onSelect={(id) => commit(selectBackground(settings, id))} onAdded={onBgAdded} onDeleted={onBgDeleted}
            onDim={(v) => commit(updateBackgroundOpt(settings, bgId, { dim: v }))} />
        </SettingsSheet>
      )}
      {sheet === 'settings' && (
        <SettingsSheet theme="dark" onClose={() => setSheet(null)}>
          {/* the shared 聲音 section; 日語家教 has no sound effects, so its volume rows are 音樂 and 語音 */}
          <SoundSection audio={audio} tts={tts} cloud={cloud} volumes={['music', 'voice']} />
          <CloudKeysSection onSaved={keysSaved} />
          <AiServiceSection theme="dark" providers={settings.providers} openaiModel={settings.openaiModel}
            claudeOk={claude === null ? null : claude.ok} chatgpt={chatgpt} local={local} onChange={(patch) => setPrefs(patch)} onRefresh={refreshChatGpt}
            onRefreshLocal={refreshLocal} onKeysSaved={keysSaved} />
          <BudgetSection />
          <ModelSection theme="dark" chatModel={settings.chatModel} helperModel={settings.helperModel}
            serverModel={claude === null ? null : claude.model} onChange={(patch) => setPrefs(patch)} />
          <ChatDataSection count={chat.length} onClear={clearChat} />
          <UsageSection />
        </SettingsSheet>
      )}
      {sheet === 'tips' && <TipsSheet theme="dark" onClose={() => setSheet(null)} />}
      {sheet === 'lookup' && <LookupSheet theme="dark" onClose={() => setSheet(null)} ready={ready} />}
    </div>
  );
}
