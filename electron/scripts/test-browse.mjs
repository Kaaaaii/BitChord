import { app, session } from 'electron';
import crypto from 'node:crypto';
import path from 'node:path';

const userDataPath = path.join(process.env.APPDATA, 'bitchord-desktop');
app.setPath('userData', userDataPath);

app.whenReady().then(async () => {
  const s = session.defaultSession;
  const cookies = await s.cookies.get({ url: 'https://music.youtube.com' });
  console.log('Found cookies:', cookies.length);
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  
  const signingCookie = cookies.find((c) => ['SAPISID', '__Secure-3PAPISID', '__Secure-1PAPISID'].includes(c.name));
  console.log('Signing cookie found:', signingCookie?.name);
  if (!signingCookie) {
    console.log('No signing cookie found');
    app.quit();
    return;
  }

  const origin = 'https://music.youtube.com';
  const timestamp = Math.floor(Date.now() / 1000);
  const hash = crypto.createHash('sha1').update(`${timestamp} ${signingCookie.value} ${origin}`).digest('hex');
  const sapisidHash = `SAPISIDHASH ${timestamp}_${hash}`;

  // Test browse endpoint
  const url = 'https://music.youtube.com/youtubei/v1/browse?prettyPrint=false';
  const headers = {
    'Authorization': sapisidHash,
    'Cookie': cookieHeader,
    'Origin': origin,
    'Referer': `${origin}/`,
    'X-Origin': origin,
    'X-Goog-AuthUser': '0',
    'Content-Type': 'application/json',
    'X-Youtube-Client-Name': '67',
    'X-Youtube-Client-Version': '1.20251006.03.00',
  };
  const body = JSON.stringify({
    context: {
      client: { clientName: 'WEB_REMIX', clientVersion: '1.20251006.03.00', hl: 'en', gl: 'US' },
      user: {},
    },
    browseId: 'FEmusic_home',
  });

  const res = await fetch(url, { method: 'POST', headers, body });
  console.log('Browse response status:', res.status);
  const resText = await res.text();
  console.log('Browse response length:', resText.length);
  if (!res.ok) {
    console.log('Browse error body:', resText);
  } else {
    console.log('Browse success! Preview:', resText.slice(0, 200));
  }

  app.quit();
});
