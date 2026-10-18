import { Session } from 'electron';

/**
 * Native replacement for the extension's declarativeNetRequest rules.
 * Intercepts outgoing and incoming headers to bypass CORS limits on media/API streams
 * and supply the necessary YouTube / Spotify / Discord origins.
 */
export function setupHeaderInterception(session: Session): void {
  // 1. Modify outgoing request headers (Origin, Referer, X-Origin)
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const url = details.url;
    const headers = { ...details.requestHeaders };

    // googlevideo media streams
    if (url.includes('googlevideo.com')) {
      if (url.includes('c=VISIONOS')) {
        // Direct URLs for VISIONOS must NOT carry Origin or Referer (otherwise 403)
        delete headers['Origin'];
        delete headers['origin'];
        delete headers['Referer'];
        delete headers['referer'];
      } else {
        headers['Origin'] = 'https://www.youtube.com';
        headers['Referer'] = 'https://www.youtube.com/';
      }
    }
    // YouTube Music InnerTube
    else if (url.includes('music.youtube.com/youtubei/')) {
      headers['Origin'] = 'https://music.youtube.com';
      headers['Referer'] = 'https://music.youtube.com/';
      headers['X-Origin'] = 'https://music.youtube.com';
    }
    // YouTube Web InnerTube
    else if (url.includes('www.youtube.com/youtubei/')) {
      headers['Origin'] = 'https://www.youtube.com';
      headers['Referer'] = 'https://www.youtube.com/';
      headers['X-Origin'] = 'https://www.youtube.com';
    }
    // YouTube play-reporting pings (s.youtube.com)
    else if (url.includes('s.youtube.com')) {
      headers['Origin'] = 'https://music.youtube.com';
      headers['Referer'] = 'https://music.youtube.com/';
    }
    // Spotify web player and Pathfinder API
    else if (
      url.includes('open.spotify.com') ||
      url.includes('api-partner.spotify.com') ||
      url.includes('clienttoken.spotify.com')
    ) {
      headers['Origin'] = 'https://open.spotify.com';
      headers['Referer'] = 'https://open.spotify.com/';
    }
    // Discord REST API
    else if (url.includes('discord.com/api/')) {
      headers['Origin'] = 'https://discord.com';
      headers['Referer'] = 'https://discord.com/';
    }

    callback({ requestHeaders: headers });
  });

  // 2. Modify incoming response headers (CORS headers)
  session.webRequest.onHeadersReceived((details, callback) => {
    const url = details.url;
    const responseHeaders = { ...details.responseHeaders };

    const shouldInjectCors =
      url.includes('youtube.com') ||
      url.includes('googlevideo.com') ||
      url.includes('spotify.com') ||
      url.includes('spotifycdn.com') ||
      url.includes('lrclib.net') ||
      url.includes('kuwo.cn') ||
      url.includes('netease.com') ||
      url.includes('qq.com') ||
      url.includes('kugou.com');

    if (shouldInjectCors) {
      // Strip any existing CORS/CSP headers regardless of casing
      for (const key of Object.keys(responseHeaders)) {
        const lower = key.toLowerCase();
        if (
          lower === 'access-control-allow-origin' ||
          lower === 'access-control-allow-methods' ||
          lower === 'access-control-allow-headers' ||
          lower === 'access-control-expose-headers' ||
          lower === 'access-control-allow-credentials' ||
          lower === 'x-frame-options' ||
          lower === 'content-security-policy' ||
          lower === 'content-security-policy-report-only'
        ) {
          delete responseHeaders[key];
        }
      }

      // Allow the requesting origin explicitly so credentialed and non-credentialed requests both pass
      const reqOrigin =
        (details as any).initiator ||
        (details.referrer ? new URL(details.referrer).origin : null) ||
        '*';

      responseHeaders['access-control-allow-origin'] = [reqOrigin];
      responseHeaders['access-control-allow-methods'] = ['GET, POST, PUT, DELETE, OPTIONS, HEAD'];
      responseHeaders['access-control-allow-headers'] = ['*'];
      responseHeaders['access-control-expose-headers'] = ['*'];
      responseHeaders['access-control-allow-credentials'] = ['true'];
    }

    callback({ responseHeaders });
  });
}
