/**
 * Small in-process status record, so /healthz can report more than "the HTTP
 * server answered". During deploy the useful question is whether Telegram
 * actually authorised us — a bot that serves HTTP but never connected looks
 * healthy otherwise, and that is exactly the failure worth catching.
 */

let telegram = {
  connected: false,
  mode: null,
  username: null,
  error: null,
};

export function setTelegramStatus(next) {
  telegram = { ...telegram, ...next };
}

export function getTelegramStatus() {
  return { ...telegram };
}
