import { contextBridge, ipcRenderer, webFrame } from 'electron';
import type { BridgeEvent, BridgeRequest, BridgeResponse } from '../common/types.js';

// Expose safe IPC communication bridge for the main world polyfill
contextBridge.exposeInMainWorld('__bitchord_ipc', {
  call: (request: BridgeRequest): Promise<BridgeResponse> => {
    return ipcRenderer.invoke('bridge:call', request);
  },
  onEvent: (callback: (event: BridgeEvent) => void): (() => void) => {
    const handler = (_e: any, event: BridgeEvent) => callback(event);
    ipcRenderer.on('bridge:event', handler);
    return () => {
      ipcRenderer.removeListener('bridge:event', handler);
    };
  },
  reportPlaybackState: (playing: boolean) => {
    ipcRenderer.send('playback:state', { playing });
  },
  reportTrackTitle: (title: string) => {
    ipcRenderer.send('playback:title', { title: String(title || '') });
  },
});

// Also expose explicit desktop API if the web app wants to detect Electron directly
contextBridge.exposeInMainWorld('bitchordDesktop', {
  isElectron: true,
  version: '1.0.0',
  platform: process.platform,
});

// Polyfill window.chrome.runtime directly inside the main world context
const polyfillScript = `
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

  // Track playback state for OS Taskbar and media controls. The player's audio is a
  // detached Audio element (its events never reach document, and the muted artwork
  // videos would report falsely), so follow mediaSession.playbackState, which the
  // player sets as playback starts and stops.
  if (navigator.mediaSession) {
    const session = navigator.mediaSession;
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
  }

  // Report the current song title (from mediaSession.metadata) for the tray menu.
  if (navigator.mediaSession) {
    const session = navigator.mediaSession;
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
  }

  // Media Session: the page registers its play/pause/next/previous handlers with
  // setActionHandler, which can't be read back. Keep a copy as they are registered
  // so the taskbar buttons can invoke the same handlers the OS media UI uses.
  const mediaHandlers = {};
  if (navigator.mediaSession) {
    const session = navigator.mediaSession;
    const original = session.setActionHandler.bind(session);
    session.setActionHandler = function(action, handler) {
      if (handler) mediaHandlers[action] = handler;
      else delete mediaHandlers[action];
      return original(action, handler);
    };
  }

  // Returns true if the page had a handler for the action.
  window.__bitchord_mediaAction = function(action) {
    const session = navigator.mediaSession;
    let name = action;
    if (action === 'toggle') name = session && session.playbackState === 'playing' ? 'pause' : 'play';
    else if (action === 'next') name = 'nexttrack';
    else if (action === 'prev') name = 'previoustrack';
    const handler = mediaHandlers[name];
    if (!handler) return false;
    try { handler({ action: name }); } catch (e) { console.error('Media action error:', e); }
    return true;
  };
})();
`;

try {
  webFrame.executeJavaScript(polyfillScript);
} catch (err) {
  console.error('Failed to inject bridge polyfill:', err);
}

// Media controls dispatcher from main process (taskbar thumbnail buttons, media keys)
ipcRenderer.on('media:action', (_event, action: string) => {
  void webFrame
    .executeJavaScript(`window.__bitchord_mediaAction(${JSON.stringify(action)})`)
    .then((handled: boolean) => {
      if (handled) return;
      // No Media Session handler registered yet: fall back to the audio element.
      const audio = document.querySelector<HTMLAudioElement>('audio');
      if (!audio) return;
      if (action === 'toggle') {
        if (audio.paused) void audio.play();
        else audio.pause();
      } else if (action === 'play') {
        void audio.play();
      } else if (action === 'pause') {
        audio.pause();
      }
    })
    .catch((err: unknown) => console.error('Failed to dispatch media action:', err));
});
