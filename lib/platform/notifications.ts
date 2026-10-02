/**
 * Web-native platform shims — browser Notifications + Vibration.
 *
 * Relay is a web-only messenger: it ships no native (Tauri/Capacitor)
 * clients, so all platform integration is exactly what the browser exposes.
 * Every function here is a silent no-op in the environment it doesn't apply
 * to, so callers can invoke them unconditionally.
 *
 * Notification permission itself is managed by the browser and surfaced via
 * lib/settings/relay-settings.ts (requestNotificationPermission / getNotificationPermission);
 * this module only *sends*.
 */

/** Light haptic tap for Settings' "Vibration" toggle. No-op where unsupported. */
export function vibrate(duration = 10): void {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(duration);
  } catch {
    /* non-fatal */
  }
}

/** Show a desktop/browser notification. Silent no-op unless permission granted. */
export function sendNotification(title: string, body: string): void {
  if (typeof window === 'undefined') return;
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, icon: '/icon-192x192.png', silent: false });
  } catch {
    /* non-fatal */
  }
}
