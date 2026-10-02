/**
 * Minimal localStorage-backed setting helpers.
 * Keys are prefixed `relay:setting:<name>`.
 */

export type BoolishSettingKey =
  | 'notifications'
  | 'sound'
  | 'vibration'
  | 'online-status'
  | 'typing-indicators';

export const SETTING_KEY = (name: string) => `relay:setting:${name}`;

export function getBoolSetting(name: BoolishSettingKey, defaultValue = false): boolean {
  if (typeof window === 'undefined') return defaultValue;
  try {
    const raw = localStorage.getItem(SETTING_KEY(name));
    if (raw == null) return defaultValue;
    return raw === '1' || raw === 'true';
  } catch {
    return defaultValue;
  }
}

export function setBoolSetting(name: BoolishSettingKey, value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(SETTING_KEY(name), value ? '1' : '0');
  } catch {
    /* quota exceeded, etc. */
  }
}

// ─── Notifications ───
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'denied';
  if (Notification.permission === 'granted' || Notification.permission === 'denied') {
    return Notification.permission;
  }
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

export function getNotificationPermission(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

// ─── Sound ───
let _audioCtx: AudioContext | null = null;
function getAudioCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (_audioCtx) return _audioCtx;
  try {
    const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return null;
    _audioCtx = new Ctor();
    return _audioCtx;
  } catch {
    return null;
  }
}

/** Short sine beep, 600Hz @ 80ms, gain 0.1 — no assets. */
export function playMessageBeep(): void {
  if (!getBoolSetting('sound', false)) return;
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 600;
    gain.gain.value = 0.1;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
  } catch {
    /* non-fatal */
  }
}
