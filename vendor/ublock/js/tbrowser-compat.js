// Electron compatibility shims for uBlock Origin's background page.
//
// uBO is a Manifest V2 extension: it blocks requests from chrome.webRequest
// blocking listeners, which Electron does implement. What Electron does not
// implement is a handful of side APIs uBO touches while it boots (badge,
// menus, privacy settings, window and navigation events), plus the `browser`
// namespace that uBO prefers over `chrome` when it exists. Every stub below is
// inert; the filtering path itself is untouched.
//
// Loaded from background.html before uBO's own scripts.

(function ( ) {
    const noopEvent = ( ) => ({
        addListener() { },
        removeListener() { },
        hasListener() { return false; },
    });
    const lastFn = args => {
        for ( let i = args.length - 1; i >= 0; i-- ) {
            if ( typeof args[i] === 'function' ) { return args[i]; }
        }
    };
    const define = (name, value) => {
        if ( typeof chrome[name] === 'undefined' ) { chrome[name] = value; }
    };

    // Electron ships a partial `browser` namespace (dom, extension, i18n,
    // management, permissions, runtime, storage, tabs). uBO's vapi.js adopts it
    // as `chrome` when it is an object, which would drop every API missing from
    // it — webRequest and webRequestBlocking included. Point both names at the
    // full `chrome` object first.
    try { self.browser = self.chrome; } catch ( _ ) { }

    define('browserAction', {
        setBadgeBackgroundColor: (...a) => { lastFn(a)?.(); },
        setBadgeText: (...a) => { lastFn(a)?.(); },
        setIcon: (...a) => { lastFn(a)?.(); },
        setTitle: (...a) => { lastFn(a)?.(); },
        setPopup: (...a) => { lastFn(a)?.(); },
        getPopup: (...a) => { lastFn(a)?.(''); },
        enable: (...a) => { lastFn(a)?.(); },
        disable: (...a) => { lastFn(a)?.(); },
        onClicked: noopEvent(),
    });
    define('pageAction', chrome.browserAction);

    define('contextMenus', {
        create: (...a) => { lastFn(a)?.(); return 1; },
        update: (...a) => { lastFn(a)?.(); },
        remove: (...a) => { lastFn(a)?.(); },
        removeAll: (...a) => { lastFn(a)?.(); },
        onClicked: noopEvent(),
    });

    const privacySetting = value => ({
        get: (details, ...a) => { lastFn(a)?.({ value }); },
        set: (...a) => { lastFn(a)?.(); },
        clear: (...a) => { lastFn(a)?.(); },
        onChange: noopEvent(),
    });
    define('privacy', {
        network: {
            networkPredictionEnabled: privacySetting(true),
            webRTCIPHandlingPolicy: privacySetting('default'),
        },
        websites: {
            hyperlinkAuditingEnabled: privacySetting(true),
        },
        services: {},
    });

    define('webNavigation', {
        onBeforeNavigate: noopEvent(),
        onCommitted: noopEvent(),
        onDOMContentLoaded: noopEvent(),
        onCompleted: noopEvent(),
        onErrorOccurred: noopEvent(),
        onHistoryStateUpdated: noopEvent(),
        onReferenceFragmentUpdated: noopEvent(),
        onCreatedNavigationTarget: noopEvent(),
        getAllFrames: (...a) => {
            lastFn(a)?.([{ frameId: 0, tabId: 1, url: '', parentFrameId: -1 }]);
        },
        getFrame: (...a) => {
            lastFn(a)?.({ frameId: 0, tabId: 1, url: '', parentFrameId: -1 });
        },
    });

    const win = ( ) => ({ id: 1, focused: true, type: 'normal', state: 'normal', tabs: [] });
    define('windows', {
        WINDOW_ID_NONE: -1,
        WINDOW_ID_CURRENT: -2,
        get: (...a) => { lastFn(a)?.(win()); },
        getCurrent: (...a) => { lastFn(a)?.(win()); },
        getLastFocused: (...a) => { lastFn(a)?.(win()); },
        getAll: (...a) => { lastFn(a)?.([win()]); },
        create: (...a) => { lastFn(a)?.(win()); },
        update: (...a) => { lastFn(a)?.(win()); },
        remove: (...a) => { lastFn(a)?.(); },
        onFocusChanged: noopEvent(),
        onCreated: noopEvent(),
        onRemoved: noopEvent(),
        onBoundsChanged: noopEvent(),
    });

    define('omnibox', {
        setDefaultSuggestion() { },
        onInputStarted: noopEvent(),
        onInputChanged: noopEvent(),
        onInputEntered: noopEvent(),
    });

    define('downloads', {
        download: (...a) => { lastFn(a)?.(1); },
        onCreated: noopEvent(),
    });

    if ( chrome.storage && chrome.storage.session === undefined ) {
        chrome.storage.session = chrome.storage.local;
    }
    if ( chrome.extension && chrome.extension.inIncognitoContext === undefined ) {
        chrome.extension.inIncognitoContext = false;
    }
})();
