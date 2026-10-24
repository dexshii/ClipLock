# Discord playback

Goal: a ClipLock link pasted into Discord shows a video that plays **inside Discord**.

This page records how ClipLock approaches that, what has been verified, and what has
not. Nothing here claims more than was actually tested.

## What ClipLock serves

Every uploaded clip has two shareable URLs on the server's public origin:

| Link | Example | What it returns |
| --- | --- | --- |
| Clip page | `https://clips.example.com/c/abc123DEF0` | HTML page with player + link-preview metadata |
| Direct video | `https://clips.example.com/media/abc123DEF0.mp4` | The MP4 bytes themselves (never an HTML page or redirect page) |

The desktop app offers **Copy** (clip page) and **Copy direct video link (.mp4)** in the
Share panel. The direct link is offered for public and unlisted clips only.

### Media format

The worker re-encodes every upload (the original is never served):

- MP4 container, `moov` atom first (fast start)
- H.264 High profile, `yuv420p`, ≤ 1440p, ≤ 60 fps, max ≈ 14 Mbit/s; plus a 720p rendition for larger sources
- AAC-LC stereo 48 kHz, 160 kbit/s

### Media delivery (`GET`/`HEAD /media/...`)

- `Content-Type: video/mp4`, `Content-Length`, `Accept-Ranges: bytes`
- Single byte ranges → `206 Partial Content` with `Content-Range`; unsatisfiable → `416`
- `ETag`, `Last-Modified`, `Cache-Control: public, max-age=86400` (private: `private`)
- `Access-Control-Allow-Origin: *`, `Cross-Origin-Resource-Policy: cross-origin`
- Unlisted/private responses carry `X-Robots-Tag: noindex, nofollow`
- Private clips only with a short-lived HMAC-signed URL; otherwise `404` (indistinguishable from a missing clip)

### Clip page metadata

The same tags are served to every client. There is **no user-agent sniffing** and no
crawler-specific content.

```html
<meta property="og:type" content="video.other">
<meta property="og:title" content="…">
<meta property="og:description" content="VALORANT · 0:30 · by Ace — watch on ClipLock">
<meta property="og:url" content="https://…/c/ID">
<meta property="og:site_name" content="ClipLock">
<meta property="og:image" content="https://…/media/ID.jpg">          (+ :secure_url, :type, :width, :height)
<meta property="og:video" content="https://…/media/ID.mp4">
<meta property="og:video:secure_url" content="https://…/media/ID.mp4">
<meta property="og:video:type" content="video/mp4">
<meta property="og:video:width" content="1920">
<meta property="og:video:height" content="1080">
<meta name="twitter:card" content="player">
<meta name="twitter:player" content="https://…/embed/ID">
<meta name="twitter:player:stream" content="https://…/media/ID.mp4">
<meta name="twitter:player:stream:content_type" content="video/mp4">
<meta name="twitter:player:width" content="1920">
<meta name="twitter:player:height" content="1080">
<link rel="alternate" type="application/json+oembed" href="https://…/oembed?url=…">
```

Why both Open Graph and a Twitter player card: Discord does not publish its embed
rules. Community reports (for example
[MediaCMS discussion #1183](https://github.com/mediacms-io/mediacms/discussions/1183))
found Discord showed only a thumbnail for `og:video` until a `twitter:card` of type
`player` with a stream URL was added. Projects such as FixTweet/FxEmbed also embed the raw
MP4 for this reason. Discord is known to play **direct links to MP4 files** inline,
which is why the direct link exists as the fallback that does not depend on page
metadata at all.

## Options evaluated

| Option | Status |
| --- | --- |
| Open Graph video tags on the clip page | Implemented |
| Twitter player card (`player`, stream URL) | Implemented |
| Direct public MP4 URL | Implemented (`/media/ID.mp4`) |
| oEmbed (provider/author attribution) | Implemented (`/oembed`) |
| Discord Components V2 media gallery | Not applicable to link previews: components are attached to messages sent by bots/webhooks. Could back a future "Share to Discord" (webhook/bot) feature; not implemented. |
| Serving different content to `Discordbot` | Rejected: crawler deception |

## What has been verified

Automated, in this repository:

- Worker output is H.264 High / `yuv420p` / AAC with fast start (`services/worker/test/pipeline.test.ts`)
- Media endpoints: 200, 206 ranges, suffix ranges, 416, HEAD with real `Content-Length`, private signing, download permission (`pipeline.test.ts`)
- Clip page metadata contents (`apps/web/lib/clip-meta.test.ts`)
- Crawler view of a live deployment: `node tests/discord/check-embed.mjs <share url>` checks tags, identical crawler/browser metadata, HTTPS, MP4 type, ranges, fast start and the thumbnail. It passed against a local deployment (HTTP, so the HTTPS check only warned).

## What has NOT been verified yet

**Discord itself has not been tested.** The ClipLock development environment had no
public HTTPS deployment or Discord access. Until the table below is filled in from real
messages, Discord playback must be treated as unverified, and the Discord feature is
**not complete**.

### Manual test protocol

1. Deploy a server with a public HTTPS origin (see `docs/self-hosting.md`).
2. Run `node tests/discord/check-embed.mjs https://YOUR-HOST/c/ID` — every check must pass.
3. In a private test server, post, as separate messages:
   - a fresh **clip page** link (unlisted), a **direct MP4** link, a **public** clip, a **private** clip page link,
   - a link to a clip that is then **deleted**, and a ~90 MB clip.
4. Record for each client:

| Case | Desktop app | Browser (discord.com) | Android | iOS |
| --- | --- | --- | --- | --- |
| Clip page link — preview shown | | | | |
| Clip page link — plays inline | | | | |
| Direct MP4 link — plays inline | | | | |
| Private clip — no title/thumbnail leaked | | | | |
| Deleted clip — no stale playable video | | | | |
| ~90 MB clip | | | | |

Notes on cache behaviour: Discord caches link previews. Re-test edits with a new URL
(e.g. a different clip) rather than reposting the same link.
