'use client';

import { useEffect, useRef, useState } from 'react';
import { Clock3, Pause, Play, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import { applicableCookingTimers, remainingCookingSeconds, type CookingSession, type CookingTimer } from '@/lib/kitchen-memory';
import type { PublicRecipe } from '@/lib/recipe-presentation';
import type { Locale } from '@/lib/recipes';
import { cookingClockLabel, formatCookingClock } from '@/lib/cooking-clock';
export { formatCookingClock } from '@/lib/cooking-clock';

export function useCookingClock(session?: CookingSession) {
  const [now, setNow] = useState(() => Date.now());
  const ticking = Boolean(session && Object.values(session.timers).some(timer => timer.endAt !== null));
  useEffect(() => {
    if (!ticking) return;
    const interval = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(interval);
  }, [ticking]);
  return now;
}
export function CookingStepTimer({ stepId, minutes, locale, timer, now, disabled, onChange }: { stepId: string; minutes: number; locale: Locale; timer?: CookingTimer; now: number; disabled: boolean; onChange: (stepId: string, timer: CookingTimer) => void }) {
  const duration = minutes * 60;
  const state = timer ?? { duration, remaining: duration, endAt: null, started: false };
  const remaining = remainingCookingSeconds(state, now);
  const running = state.endAt !== null && remaining > 0;
  const finished = state.started && remaining === 0;
  const toggle = () => {
    const seconds = remainingCookingSeconds(state, Date.now());
    onChange(stepId, running ? { ...state, endAt: null, remaining: seconds } : { duration, remaining: finished ? duration : seconds, endAt: Date.now() + (finished ? duration : seconds) * 1000, started: true });
  };
  return <div className={`step-timer no-print${finished ? ' timer-finished' : ''}`}>
    <span className="timer-clock"><Clock3 size={17} aria-hidden="true" /><span aria-label={cookingClockLabel(remaining, locale)}>{formatCookingClock(remaining)}</span></span>
    <button type="button" className="timer-toggle" disabled={disabled} onClick={toggle}>{running ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}{locale === 'pl' ? running ? 'Wstrzymaj' : finished ? 'Jeszcze raz' : 'Włącz minutnik' : running ? 'Pause' : finished ? 'Start again' : 'Start timer'}</button>
    <button type="button" className="timer-reset icon-button" disabled={disabled} aria-label={locale === 'pl' ? 'Wyzeruj minutnik' : 'Reset timer'} onClick={() => onChange(stepId, { duration, endAt: null, remaining: duration, started: false })}><RotateCcw size={16} aria-hidden="true" /></button>
    <span className="timer-status" role="status">{finished ? locale === 'pl' ? 'Czas minął — sprawdź danie.' : 'Time is up — check your dish.' : ''}</span>
  </div>;
}

type WakeSentinel = { release: () => Promise<void>; released: boolean; addEventListener: (type: 'release', callback: () => void) => void };
type WakeNavigator = Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeSentinel> } };
type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext };

export function KitchenAssist({ recipe, locale, session, mode, now }: { recipe: PublicRecipe; locale: Locale; session?: CookingSession; mode: boolean; now: number }) {
  const pl = locale === 'pl';
  const [sound, setSound] = useState(false);
  const [soundStatus, setSoundStatus] = useState('');
  const [keepAwake, setKeepAwake] = useState(false);
  const [wakeStatus, setWakeStatus] = useState<'off' | 'on' | 'unavailable'>('off');
  const audio = useRef<AudioContext | null>(null);
  const announced = useRef(new Set<string>());
  const usableTimers = session ? applicableCookingTimers(recipe, session.timers) : {};
  const enableSound = async () => {
    if (sound) { setSound(false); return; }
    try {
      const Audio = window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
      if (!Audio) throw new Error('Unavailable');
      audio.current ??= new Audio();
      await audio.current.resume();
      if (session) for (const [stepId, timer] of Object.entries(usableTimers)) {
        if (timer.endAt !== null && remainingCookingSeconds(timer, now) === 0) announced.current.add(`${session.id}:${stepId}:${timer.endAt}`);
      }
      setSound(true); setSoundStatus('');
    } catch { setSoundStatus(pl ? 'Dźwięk jest niedostępny. Minutnik nadal pokaże komunikat.' : 'Sound is unavailable. The timer will still show an alert.'); }
  };
  useEffect(() => () => { void audio.current?.close(); }, []);
  useEffect(() => {
    if (!session || !sound) return;
    for (const [stepId, timer] of Object.entries(applicableCookingTimers(recipe, session.timers))) {
      if (!timer.started || timer.endAt === null || remainingCookingSeconds(timer, now) > 0) continue;
      const key = `${session.id}:${stepId}:${timer.endAt}`;
      if (announced.current.has(key)) continue;
      announced.current.add(key);
      const context = audio.current;
      if (!context || context.state !== 'running') continue;
      const oscillator = context.createOscillator();
      const volume = context.createGain();
      oscillator.type = 'sine'; oscillator.frequency.value = 740;
      volume.gain.setValueAtTime(0.18, context.currentTime);
      volume.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.8);
      oscillator.connect(volume); volume.connect(context.destination);
      oscillator.start(); oscillator.stop(context.currentTime + 0.8);
    }
  }, [session, recipe, now, sound]);
  useEffect(() => {
    if (!mode || !keepAwake) return;
    let cancelled = false;
    let sentinel: WakeSentinel | null = null;
    const acquire = async () => {
      if (document.visibilityState !== 'visible' || (sentinel && !sentinel.released)) return;
      try {
        const lock = (navigator as WakeNavigator).wakeLock;
        if (!lock) throw new Error('Unavailable');
        const requested = await lock.request('screen');
        if (cancelled) { void requested.release(); return; }
        sentinel = requested; setWakeStatus('on');
        requested.addEventListener('release', () => { if (!cancelled) setWakeStatus('off'); });
      } catch { if (!cancelled) setWakeStatus('unavailable'); }
    };
    void acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => { cancelled = true; document.removeEventListener('visibilitychange', acquire); void sentinel?.release().catch(() => {}); };
  }, [mode, keepAwake]);
  const timers = session ? Object.entries(usableTimers).filter(([, timer]) => timer.started) : [];
  if (!mode && !timers.length) return null;
  return <div className="kitchen-assist no-print">
    {timers.length > 0 && <div className="kitchen-active-timers" aria-label={pl ? 'Twoje minutniki' : 'Your timers'}>{timers.map(([stepId, timer]) => {
      const seconds = remainingCookingSeconds(timer, now);
      return <a key={stepId} href={`#step-${encodeURIComponent(stepId)}`} className={seconds === 0 ? 'is-finished' : ''}><Clock3 size={15} aria-hidden="true" /><span>{recipe.steps.find(step => step.id === stepId)?.title[locale] ?? stepId}</span><strong>{formatCookingClock(seconds)}</strong>{seconds === 0 ? <small>{pl ? 'Sprawdź danie' : 'Check your dish'}</small> : timer.endAt === null ? <small>{pl ? 'Wstrzymany' : 'Paused'}</small> : null}</a>;
    })}</div>}
    {mode && <><div className="kitchen-device-controls"><button type="button" aria-pressed={sound} onClick={enableSound}>{sound ? <Volume2 size={17} aria-hidden="true" /> : <VolumeX size={17} aria-hidden="true" />}{pl ? sound ? 'Sygnał dźwiękowy włączony' : 'Włącz sygnał minutnika' : sound ? 'Timer sound on' : 'Enable timer sound'}</button><label><input type="checkbox" checked={keepAwake} onChange={event => { setKeepAwake(event.target.checked); if (!event.target.checked) setWakeStatus('off'); }} />{pl ? 'Nie wygaszaj ekranu' : 'Keep screen awake'}</label></div><p className="kitchen-device-status" role="status">{soundStatus || (keepAwake && wakeStatus === 'unavailable' ? pl ? 'Przeglądarka nie pozwala utrzymać ekranu. Możesz zmienić czas wygaszania w ustawieniach urządzenia.' : 'Your browser cannot keep the screen awake. You can adjust the device’s screen timeout.' : keepAwake && wakeStatus === 'on' ? pl ? 'Ekran pozostanie aktywny w tym trybie.' : 'The screen will stay awake in this mode.' : keepAwake && wakeStatus === 'off' ? pl ? 'Utrzymanie ekranu zostało wstrzymane przez urządzenie.' : 'The device paused the screen wake lock.' : sound ? pl ? 'Sygnał działa, gdy ta strona jest otwarta. To nie jest alarm systemowy.' : 'Sound works while this page is open. It is not a system alarm.' : '')}</p></>}
  </div>;
}
