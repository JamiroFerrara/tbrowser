'use strict';

/**
 * Whether a window a page is opening is an answer to the user or an ad.
 *
 * Electron hands every `window.open` to the embedding app and lets it decide;
 * Chrome asks a different question first — was a person behind it — and a page
 * opening a window off its own timer (a popunder, an ad in a background tab)
 * gets nothing. There is no "was there a gesture" flag on the request here, so
 * the gesture is remembered instead: a click or a key press the page really
 * received, recent enough that the window is the answer to it.
 */
const GESTURE_MS = 5000; // Chrome's own "transient activation" window

const lastGesture = new WeakMap();

/** Remember each press a page receives. Nothing is swallowed: the page still gets it. */
function watchGesture(webContents, now = Date.now) {
  webContents.on('input-event', (_event, input) => {
    if (
      input.type === 'mouseDown' ||
      input.type === 'keyDown' ||
      input.type === 'rawKeyDown' ||
      input.type === 'gestureTap'
    ) {
      lastGesture.set(webContents, now());
    }
  });
}

/** True when the page heard from the user a moment ago. */
function fromUser(webContents, now = Date.now) {
  return now() - (lastGesture.get(webContents) ?? 0) < GESTURE_MS;
}

module.exports = { GESTURE_MS, watchGesture, fromUser };
