// A page's step back and forward. Vimium runs in a world of its own inside the
// document and cannot reach the browser process, so it asks for the step with a
// DOM event: `H` and `L` become the browser's back and forward instead of the
// page's own `history.go`, which reloads. The window answers by showing the
// page it kept loaded, so the step costs a swap rather than a load.
const { ipcRenderer } = require('electron');

document.addEventListener('tbrowser-step', (event) => {
  // A string, not an object: an isolated world cannot read a `detail` it did
  // not build, and Vimium's side is a different world from this one.
  const delta = Number(event.detail);
  if (Number.isFinite(delta) && delta !== 0) ipcRenderer.send('page:step', delta);
});

// Vimium's yy. Electron gives a page's own `navigator.clipboard.writeText` no
// user gesture and no guaranteed focus, so the copy is the window's; this is
// the same one event out of the isolated world as the step above. The body is
// the address the page itself has, which the window checks before copying, so
// a page cannot put a string of its choosing on the clipboard.
document.addEventListener('tbrowser-copy', (event) => {
  ipcRenderer.send('page:copy-url', typeof event.detail === 'string' ? event.detail : '');
});
