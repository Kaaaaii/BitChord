"use strict";

// src/preload/index.ts
var import_electron = require("electron");
import_electron.contextBridge.exposeInMainWorld("__bitchord_ipc", {
  call: (request) => {
    return import_electron.ipcRenderer.invoke("bridge:call", request);
  },
  onEvent: (callback) => {
    const handler = (_e, event) => callback(event);
    import_electron.ipcRenderer.on("bridge:event", handler);
    return () => {
      import_electron.ipcRenderer.removeListener("bridge:event", handler);
    };
  },
  reportPlaybackState: (playing) => {
    import_electron.ipcRenderer.send("playback:state", { playing });
  },
  reportTrackTitle: (title) => {
    import_electron.ipcRenderer.send("playback:title", { title: String(title || "") });
  }
});
import_electron.contextBridge.exposeInMainWorld("bitchordDesktop", {
  isElectron: true,
  version: "1.0.0",
  platform: process.platform
});
var polyfillScript = `
(function() {
  window.chrome = window.chrome || {};
  window.chrome.runtime = window.chrome.runtime || {};

  const eventListeners = new Set();
  if (window.__bitchord_ipc && typeof window.__bitchord_ipc.onEvent === 'function') {
    window.__bitchord_ipc.onEvent(function(event) {
      for (const listener of eventListeners) {
        try { listener(event); } catch (e) { console.error('Bridge event error:', e); }
      }
    });
  }

  // 1. Polyfill chrome.runtime.sendMessage
  window.chrome.runtime.sendMessage = function(_extensionId, message, callback) {
    if (!window.__bitchord_ipc) return;
    window.__bitchord_ipc.call(message)
      .then(function(response) {
        if (typeof callback === 'function') callback(response);
      })
      .catch(function(err) {
        if (typeof callback === 'function') {
          callback({
            channel: 'bitchord-bridge',
            protocol: 1,
            direction: 'to-page',
            id: message && message.id ? message.id : '',
            ok: false,
            error: { code: 'internal', message: err && err.message ? err.message : String(err) }
          });
        }
      });
  };

  // 2. Polyfill chrome.runtime.connect (bitchord-events port)
  window.chrome.runtime.connect = function(_extensionId, info) {
    const portListeners = new Set();
    const disconnectListeners = new Set();

    let unsubscribe = function() {};
    if (window.__bitchord_ipc && typeof window.__bitchord_ipc.onEvent === 'function') {
      unsubscribe = window.__bitchord_ipc.onEvent(function(event) {
        for (const listener of portListeners) {
          try { listener(event); } catch (e) { console.error(e); }
        }
      });
    }

    return {
      name: (info && info.name) || 'bitchord-events',
      onMessage: {
        addListener: function(fn) { portListeners.add(fn); },
        removeListener: function(fn) { portListeners.delete(fn); },
      },
      onDisconnect: {
        addListener: function(fn) { disconnectListeners.add(fn); },
        removeListener: function(fn) { disconnectListeners.delete(fn); },
      },
      disconnect: function() {
        unsubscribe();
        portListeners.clear();
        for (const fn of disconnectListeners) {
          try { fn(); } catch (e) {}
        }
      }
    };
  };

  // 3. Polyfill window.postMessage relayBridge transport
  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (data && data.channel === 'bitchord-bridge' && data.direction === 'to-extension') {
      if (!window.__bitchord_ipc) return;
      window.__bitchord_ipc.call(data)
        .then(function(response) {
          window.postMessage(response, '*');
        })
        .catch(function(err) {
          window.postMessage({
            channel: 'bitchord-bridge',
            protocol: 1,
            direction: 'to-page',
            id: data.id,
            ok: false,
            error: { code: 'internal', message: err && err.message ? err.message : String(err) }
          }, '*');
        });
    }
  });

  // 4. Ensure all HTMLAudioElement instances are anchored to the document DOM so
  // Chromium's AudioFocusManager and MediaSessionService recognize them as active page media,
  // preventing SMTC (Windows) and MPRIS (Linux) from dropping or losing session sync.
  const OrigAudio = window.Audio;
  if (OrigAudio) {
    window.Audio = function() {
      const audio = new (Function.prototype.bind.apply(OrigAudio, [null].concat(Array.prototype.slice.call(arguments))))();
      const anchor = function() {
        try {
          const root = document.body || document.documentElement;
          if (root && !audio.isConnected) {
            audio.style.position = 'fixed';
            audio.style.width = '0px';
            audio.style.height = '0px';
            audio.style.opacity = '0';
            audio.style.pointerEvents = 'none';
            root.appendChild(audio);
          }
        } catch (e) {}
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', anchor, { once: true });
      } else {
        setTimeout(anchor, 0);
      }
      return audio;
    };
    window.Audio.prototype = OrigAudio.prototype;
  }

  // 5. Track playback state and ensure OS media player (Windows SMTC, Linux MPRIS)
  // always detects BitChord and stays responsive.
  if (navigator.mediaSession) {
    const session = navigator.mediaSession;

    // Set initial metadata so OS controls register the application immediately
    try {
      if (!session.metadata && typeof MediaMetadata !== 'undefined') {
        session.metadata = new MediaMetadata({
          title: 'BitChord',
          artist: 'BitChord Music',
          album: 'BitChord',
        });
      }
    } catch (e) {}

    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(session), 'playbackState');
    if (descriptor && descriptor.get && descriptor.set) {
      Object.defineProperty(session, 'playbackState', {
        configurable: true,
        enumerable: true,
        get: function() { return descriptor.get.call(this); },
        set: function(value) {
          descriptor.set.call(this, value);
          if (window.__bitchord_ipc) window.__bitchord_ipc.reportPlaybackState(value === 'playing');
        },
      });
    }

    // Report the current song title (from mediaSession.metadata) for the tray menu.
    const mdDescriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(session), 'metadata');
    if (mdDescriptor && mdDescriptor.get && mdDescriptor.set) {
      Object.defineProperty(session, 'metadata', {
        configurable: true,
        enumerable: true,
        get: function() { return mdDescriptor.get.call(this); },
        set: function(value) {
          mdDescriptor.set.call(this, value);
          if (window.__bitchord_ipc) {
            const title = value && value.title ? value.title : '';
            const artist = value && value.artist ? value.artist : '';
            window.__bitchord_ipc.reportTrackTitle(artist ? title + ' - ' + artist : title);
          }
        },
      });
    }

    // Media Session: keep copy of registered handlers
    const mediaHandlers = {};
    const original = session.setActionHandler.bind(session);
    session.setActionHandler = function(action, handler) {
      if (handler) mediaHandlers[action] = handler;
      else delete mediaHandlers[action];
      return original(action, handler);
    };

    // Pre-register standard actions so Windows SMTC / Linux MPRIS buttons are active immediately
    const standardActions = ['play', 'pause', 'previoustrack', 'nexttrack', 'stop', 'seekto', 'seekbackward', 'seekforward'];
    for (let i = 0; i < standardActions.length; i++) {
      const act = standardActions[i];
      try {
        original(act, function(details) {
          const handler = mediaHandlers[act];
          if (handler) {
            try { handler(details); } catch (e) { console.error('Media action error:', e); }
          } else {
            const audio = document.querySelector('audio');
            if (!audio) return;
            if (act === 'play') void audio.play();
            else if (act === 'pause' || act === 'stop') audio.pause();
            else if (act === 'seekbackward') audio.currentTime = Math.max(0, audio.currentTime - 10);
            else if (act === 'seekforward') audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + 10);
          }
        });
      } catch (e) {}
    }

    // Returns true if the page had a handler for the action or handled it directly
    window.__bitchord_mediaAction = function(action) {
      let name = action;
      if (action === 'toggle') name = session && session.playbackState === 'playing' ? 'pause' : 'play';
      else if (action === 'next') name = 'nexttrack';
      else if (action === 'prev') name = 'previoustrack';
      const handler = mediaHandlers[name];
      if (handler) {
        try { handler({ action: name }); } catch (e) { console.error('Media action error:', e); }
        return true;
      }
      const audio = document.querySelector('audio');
      if (audio) {
        if (name === 'play') { void audio.play(); return true; }
        if (name === 'pause') { audio.pause(); return true; }
      }
      return false;
    };
  }
})();
`;
try {
  import_electron.webFrame.executeJavaScript(polyfillScript);
} catch (err) {
  console.error("Failed to inject bridge polyfill:", err);
}
import_electron.ipcRenderer.on("media:action", (_event, action) => {
  void import_electron.webFrame.executeJavaScript(`window.__bitchord_mediaAction(${JSON.stringify(action)})`).then((handled) => {
    if (handled) return;
    const audio = document.querySelector("audio");
    if (!audio) return;
    if (action === "toggle") {
      if (audio.paused) void audio.play();
      else audio.pause();
    } else if (action === "play") {
      void audio.play();
    } else if (action === "pause") {
      audio.pause();
    }
  }).catch((err) => console.error("Failed to dispatch media action:", err));
});
//# sourceMappingURL=index.cjs.map