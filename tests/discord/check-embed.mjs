#!/usr/bin/env node
// Checks a ClipLock share link the way a link-preview crawler sees it.
//
//   node tests/discord/check-embed.mjs https://clips.example.com/c/abcDEF1234
//
// This cannot prove Discord will play the video inline (only posting the link in
// Discord can; see docs/discord.md), but it catches everything that reliably prevents
// it: missing tags, non-HTTPS URLs, wrong Content-Type, no range support, an MP4
// without fast start, or different content for crawlers and browsers.

const DISCORD_UA = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

const url = process.argv[2];
if (!url) {
  console.error('usage: node check-embed.mjs <share url>');
  process.exit(2);
}

const results = [];
const check = (ok, label, detail = '', level = 'error') => results.push({ ok, label, detail, level });

function metaTags(html) {
  const tags = {};
  for (const m of html.matchAll(/<meta\s+([^>]+?)\/?>/gi)) {
    const attrs = Object.fromEntries([...m[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map((a) => [a[1].toLowerCase(), a[2]]));
    const key = attrs.property ?? attrs.name;
    if (key && attrs.content !== undefined) (tags[key] ??= []).push(attrs.content.replaceAll('&amp;', '&'));
  }
  return tags;
}

async function page(ua) {
  const res = await fetch(url, { headers: { 'User-Agent': ua }, redirect: 'follow' });
  return { status: res.status, type: res.headers.get('content-type') ?? '', html: await res.text() };
}

const bot = await page(DISCORD_UA);
const human = await page(BROWSER_UA);
check(bot.status === 200, 'page responds 200 to the Discord crawler', `got ${bot.status}`);
check(bot.type.startsWith('text/html'), 'page is HTML', bot.type);
const tags = metaTags(bot.html);
const same = JSON.stringify(tags) === JSON.stringify(metaTags(human.html));
check(same, 'crawlers and browsers receive identical metadata (no user-agent cloaking)');

const first = (k) => tags[k]?.[0];
for (const k of ['og:title', 'og:image', 'og:video', 'og:video:type', 'og:video:width', 'og:video:height', 'og:type', 'twitter:card', 'twitter:player:stream']) {
  check(!!first(k), `has ${k}`, first(k) ?? 'missing');
}
check(first('og:video:type') === 'video/mp4', 'og:video:type is video/mp4', first('og:video:type'));
check(first('twitter:card') === 'player', 'twitter:card is player', first('twitter:card'));
const video = first('og:video:secure_url') ?? first('og:video');
check(!!video && video.startsWith('https://'), 'video URL uses HTTPS (required for production share links)', video ?? '', 'warn');

if (video) {
  const head = await fetch(video, { method: 'HEAD', headers: { 'User-Agent': DISCORD_UA } });
  check(head.status === 200, 'video HEAD returns 200', String(head.status));
  check(head.headers.get('content-type') === 'video/mp4', 'video Content-Type is video/mp4', head.headers.get('content-type') ?? '');
  check(head.headers.get('accept-ranges') === 'bytes', 'video supports byte ranges', head.headers.get('accept-ranges') ?? '');
  const size = Number(head.headers.get('content-length'));
  check(size > 0, 'video Content-Length is set', String(size));
  check(size < 100 * 1024 * 1024, 'video is under 100 MB (large files are less likely to embed)', `${(size / 1048576).toFixed(1)} MB`, 'warn');
  const range = await fetch(video, { headers: { Range: 'bytes=0-1048575', 'User-Agent': DISCORD_UA } });
  const bytes = Buffer.from(await range.arrayBuffer());
  check(range.status === 206, 'range request returns 206 Partial Content', String(range.status));
  check(bytes.subarray(4, 8).toString() === 'ftyp', 'response is an MP4 file (not an HTML page)');
  const moov = bytes.indexOf('moov');
  const mdat = bytes.indexOf('mdat');
  check(moov !== -1 && (mdat === -1 || moov < mdat), 'MP4 has fast start (moov before mdat)');
}

const image = first('og:image');
if (image) {
  const res = await fetch(image, { method: 'HEAD' });
  check(res.ok && (res.headers.get('content-type') ?? '').startsWith('image/'), 'og:image is an image', `${res.status} ${res.headers.get('content-type')}`);
}

let failed = 0;
for (const r of results) {
  const mark = r.ok ? 'PASS' : r.level === 'warn' ? 'WARN' : 'FAIL';
  if (!r.ok && r.level !== 'warn') failed++;
  console.log(`${mark}  ${r.label}${r.detail && !r.ok ? ` — ${r.detail}` : ''}`);
}
console.log(failed ? `\n${failed} check(s) failed.` : '\nAll required checks passed. Now post the link in a Discord test server to confirm playback (docs/discord.md).');
process.exit(failed ? 1 : 0);
