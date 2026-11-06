const { app, BaseWindow } = require('electron');
const koffi = require('../node_modules/koffi');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);

const user32 = koffi.load('user32.dll');
const getLong = user32.func('intptr_t GetWindowLongPtrW(uintptr_t hWnd, int nIndex)');
const isVisible = user32.func('bool IsWindowVisible(uintptr_t hWnd)');
const getOwner = user32.func('uintptr_t GetWindow(uintptr_t hWnd, uint nCmd)');
const getRect = user32.func('bool GetWindowRect(uintptr_t hWnd, _Out_ int *rect)');
const getAncestor = user32.func('uintptr_t GetAncestor(uintptr_t hWnd, uint gaFlags)');

function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
}

function styles(win) {
  const h = hwndOf(win);
  const rect = new Int32Array(4);
  getRect(h, rect);
  return {
    hwnd: h.toString(16),
    style: getLong(h, -16).toString(16),
    ex: getLong(h, -20).toString(16),
    visible: isVisible(h),
    owner: getOwner(h, 4).toString(16),
    root: getAncestor(h, 2).toString(16),
    rect: Array.from(rect),
  };
}

async function probe(label, opts) {
  const win = new BaseWindow({ width: 600, height: 400, show: false, ...opts });
  win.show();
  win.focus();
  for (let i = 0; i < 6; i += 1) {
    await sleep(500);
    console.log(`PROBE ${label} ${i} ${JSON.stringify(win.getBounds())} ${JSON.stringify(styles(win))}`);
  }
  win.destroy();
  await sleep(500);
}

const probes = [
  ['transparent', { frame: false, transparent: true, backgroundColor: '#00000000' }],
  ['opaque', { frame: false, backgroundColor: '#1b1b1b' }],
  ['plain', {}],
];

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  for (const [label, opts] of probes) {
    if (only && only !== label) continue;
    await probe(label, opts);
  }
  app.exit(0);
});
