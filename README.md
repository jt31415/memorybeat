# MemoryBeat

A multiplayer "name that track" game. A 30-second clip plays and you type the
title into the chat, skribbl style — first one there scores the most, with
Kahoot-style decay, so an early guess is worth roughly twice a last-second one.

- **Daily challenge** — five songs, the same five for everyone, once a day, with
  a global leaderboard. Needs a Discord sign-in. See [Daily
  challenge](#daily-challenge).
- **Singleplayer** — straight into a room; pick packs or import a playlist there,
  then play ten rounds.
- **Multiplayer** — join a room with its four-letter code, or create one, share
  the link, and start the game when everyone's in. Rooms have a max player count
  and an optional password.
- **Difficulty** — a slider in the lobby, from wall-to-wall hits to the deep
  cuts of whatever pack you picked. See [Ranking and
  difficulty](#ranking-and-difficulty).
- **Answer mode** — a lobby toggle between typing the title and multiple
  choice. See [Multiple choice](#multiple-choice).

## Running it

```bash
npm install
npm run build-packs   # populate the song database (required once)
npm start             # http://localhost:3000
```

`build-packs` is not optional on a fresh clone — the database is not committed,
and with no packs in it there is nothing to play. It takes about a minute for
the decade packs.

Set `PORT` to use a different port. To play with friends over the internet,
expose that port however you normally would (a tunnel like `ngrok http 3000`
is the easy option) and share the room link.

Credentials go in `.env` (see `.env.example`); it is read by
`server/env.js` via Node's built-in `process.loadEnvFile`, so there is no
dependency and no `--env-file` flag to remember. Everything in it is optional —
the game runs, and Deezer playlist import works, with none of it set.
`LASTFM_API_KEY` improves popularity ranking during `build-packs`; the Spotify
pair enables Spotify import (see [Importing a playlist](#importing-a-playlist),
which explains why Deezer is the default); the Discord pair enables the [daily
challenge](#daily-challenge), which is switched off without them.

Strongly recommended:

```bash
npm run warm       # pre-resolve the most popular tracks in each pack
```

This is more than a speed optimisation now that packs hold ~900 songs.
Resolving a track needs a rate-limited iTunes lookup, and a game only resolves
as many as it needs (10) before starting — so **whatever you warm is
effectively your song pool.** Left to warm through play alone, a room settles
into a rotation of about `40 + rounds` songs no matter how big the pack is.
See [Ranking and difficulty](#ranking-and-difficulty) for the knobs.

## Where the music comes from

Tracks are looked up through the public [iTunes Search API], which serves a
30-second preview clip for most commercial releases. No audio is bundled with the
repo — the database holds only titles and artists, and clips are fetched at
runtime and cached in memory.

The server proxies that audio at `/a/<token>` rather than handing the client the
real URL, for two reasons: the iTunes URL would give the answer away to anyone
with devtools open, and same-origin audio is what lets the Web Audio API drive
the visualiser.

Resolved lookups are cached in `data/itunes-cache.json` so repeat games don't
re-query Apple. Apple rate-limits bursts (429, then a stretch of 403s), so
lookups run through a single throttled queue that backs off when pushed back;
if a few tracks still fail to resolve, the game quietly plays the ones that did.

[iTunes Search API]: https://performance-partners.apple.com/search-api

## Song packs

A game draws from **one or more packs**, picked by the host from the room lobby
and changeable between games. Nothing about the song pool is decided at room
creation — a new room is seated on a default pack
(`packs.defaultSelection()`, i.e. All Time) and everything after that happens in
the lobby, because a room is created *before* anyone has arrived to have an
opinion. Several packs play as a
single merged list: `packs.selectPacks()` folds them together, dropping the
songs that appear in more than one (`70s + 80s + All Time` is 2,578 songs, not
2,879) so no answer can come up twice in a game and the difficulty ranking
counts each song once. Selections are memoised and held in catalogue order, so
the same set of packs is always the same list, however it was clicked.

Packs live in a SQLite database at `data/memorybeat.db` and are generated, not
hand-written. `npm run build-packs` fills it from two public sources.

**All Time** — the flagship pack: the top 150 of each decade pack by
popularity, ~887 songs after collapsing the handful that charted either side of
a decade boundary. It is derived from the decade packs rather than fetched, and
its `perDecade` is deliberately the same 150 that `npm run warm` resolves by
default — so warming the decades warms this pack too, and it starts instantly.

**Decade packs** — one per decade since the 1970s, scraped from the Wikipedia
*Billboard Year-End Hot 100 singles of YYYY* pages. Roughly 1,000 songs each,
deduplicated across years (a song that charted in two years is one entry
holding its best position).

| Pack | Songs | Source |
| --- | --- | --- |
| All Time | ~887 | top 150 of each decade below |
| 70s | ~997 | Billboard year-end 1970–1979 |
| 80s | ~995 | Billboard year-end 1980–1989 |
| 90s | ~935 | Billboard year-end 1990–1999 |
| 00s | ~922 | Billboard year-end 2000–2009 |
| 10s | ~902 | Billboard year-end 2010–2019 |
| 20s | ~526 | Billboard year-end 2020– |

**Genre packs** — built from Last.fm tags, with several related tags merged per
pack because any single tag is noisy (`rap` contributes ~110 tracks that
`hip-hop` misses).

| Pack | Songs | Tags merged |
| --- | --- | --- |
| Pop | ~485 | pop, dance pop |
| Rap | ~409 | hip-hop, rap, hip hop |
| K-Pop | ~453 | k-pop, kpop, korean |
| Classical | ~572 | classical, baroque, romantic |
| EDM | ~919 | edm, electronic, house, trance |

Genre packs need a free [Last.fm API key]:

```bash
LASTFM_API_KEY=... npm run build-packs
```

Without a key the decade packs still build; the genre packs are skipped and the
script says so.

### Rebuilding

```bash
npm run build-packs -- --decades          # decade packs only
npm run build-packs -- --genres           # genre packs only
npm run build-packs -- --enrich           # fetch missing Last.fm listener counts
npm run build-packs -- --score            # recompute popularity from stored signals
npm run build-packs -- --decades --from 2020
```

Re-running is safe: tracks are upserted on their cache key and each pack's
membership is rewritten, so a second run repairs rather than duplicates. The
server reads packs once at startup, so **restart it after a rebuild.**

Both sources are rate-limited and retry with backoff — Wikipedia will hand out
429s if you scrape 56 pages without pausing.

[Last.fm API key]: https://www.last.fm/api/account/create

### Ranking and difficulty

Every track carries a `popularity` score from 0 to 100, so songs can be ranked
and difficulty scaled. It is derived from the best signal available:

1. **Last.fm listeners** — the number of distinct people who have ever played
   the track. This is the signal we actually want, because it measures how
   widely *known* a song is today, which is what makes it easy or hard to
   guess. (Playcount is stored too, but it mostly measures how obsessively a
   smaller group replays something.) Scored as a percentile, because listener
   counts are power-law distributed and any linear scaling pins nearly
   everything at zero.
2. **Billboard year-end position** — how big it was at the time. Needs no API
   key, so the column is meaningful before anyone runs the enrichment pass.
   Mapped directly onto 0–60 rather than percentiled: year-end rank is an
   ordinal with only 100 distinct values shared between ~5,000 tracks, so a
   percentile would hand the ~56 different #1 singles 56 different scores
   decided by nothing but sort order. Capped below the listener range because
   "was a hit in 1974" is weaker evidence of present-day recognisability than a
   live listener count.

#### The difficulty slider

The host sets difficulty in the lobby, anywhere from 0 (the songs everybody
knows) to 100 (the long tail). It is a *preference*, not a filter —
`server/difficulty.js` gives every track in the pack a weight and shuffles the
whole thing by it, so the setting moves where songs come from without ever
fencing any of them off:

| Setting | Name | What you get |
| --- | --- | --- |
| 0–12 | Chart toppers | wall-to-wall hits |
| 13–37 | Easy | big, familiar songs — **the default, 25** |
| 38–62 | Balanced | a bit of everything |
| 63–87 | Tricky | past the obvious hits |
| 88–100 | Deep cuts | the pack's long tail |

Two decisions worth knowing about:

**Every song stays possible.** Weights are a bell curve around the chosen point
(σ = 16 percentile points) *lifted off zero* — the worst-matched track in the
pack still carries 8% of an on-target one's weight. In a ten-round game that
works out at one or two songs from outside the band, and about twice that at
either end of the slider, where half the curve falls off the edge of the pack.
A hard cut would have made every game at the same setting draw from the same
slice; this way a night of "Tricky" still throws up something everyone can
shout at the screen. Measured over 2,000 simulated games on the All Time pack,
every setting reaches every decile of the pack.

**Positions are worked out within the pack, not on the raw 0–100 score.** The
packs are not comparable on that scale — All Time is by construction the top 150
of every decade, so almost nothing in it scores below 60, while a genre pack has
a long thin tail. Ranking inside the pack means the slider always spans that
pack's own range, and "Deep cuts" means the deep cuts of whatever you picked.

Two consequences at the harder end. Obscure tracks are the ones most likely to
have no usable iTunes preview, and the resolver takes the first ten candidates
it can play — so a game that cannot fill its ten from the chosen band quietly
drifts easier rather than running short. And `npm run warm` fills the cache in
popularity order, which is exactly the *easy* end, so a room that plays high on
the slider will spend a few seconds resolving tracks at "Start game". `npm run
warm -- --limit 400` or more is worth it if that is how you play.

### Multiple choice

The host can swap the round's answering method in the lobby, between games.
"Type it" is the default skribbl-style round. "Multiple choice" puts four song
titles on screen instead — the answer plus three decoys drawn from the same
packs — and the rules change with it:

- **One pick each.** The wrong card is final; there is no second try, or picking
  all four in order would always win. Speed still decides the points, on the
  same decay as a typed round.
- **Titles only on the cards.** The artist stays a mid-round hint exactly as it
  is in a typing round, and lands on the line under the clock rather than under
  the blanks. It is not sent with the cards either — on the answer's card it
  would be readable from the network tab before the hint was due.
- **No blanks.** There is no mask at all, not even server-side: the letter count
  alone would pick the answer out of four. The letter hints go with it.
- **The chat is just chat** — except for the title, which is still swallowed and
  answered with a private "no spoilers" nudge.

Decoys come from the answer's own neighbourhood in the pack rather than from the
pack at large. Packs are stored in popularity order, so a window around the
answer (±80) keeps all four cards about equally famous; line one household name
up against three obscurities and the answer is readable off the list without the
audio. A pack too small for a window just uses everything it has. Decoys are
rejected on title as well as on song identity — "Hero" by Mariah Carey and
"Hero" by Enrique Iglesias are both in the catalogue, and with no artist on the
cards they would print as the same card twice.

### Adding a pack

Add an entry to `DECADES` or `GENRES` in `scripts/build-packs.js` and re-run.
The All Time pack rebuilds itself from whatever decade packs exist, after
scoring — `--score` alone is enough to refresh it.
Titles are what players have to type, so keep them as the song is commonly
known. Bracketed extras are optional for the guesser — `Roses (Imanbek Remix)`
accepts plain `roses`.

## Importing a playlist

A room can draw from an imported playlist instead of the packs. The host pastes a
link in the lobby, beside the pack grid, and it becomes the complete song pool —
replacing the pack selection rather than joining it, since the server refuses the
mix outright.

Both halves stay on screen and either one is a click away, which is the whole
reason import lives in the lobby rather than on the front page. When it lived on
the front page, switching from a playlist to a pack was a one-way door — there
was no import box in the lobby to get back — so the pack grid had to be hidden
whenever a playlist was active. Putting both in one place deleted that
workaround instead of designing around it.

Only metadata is taken. Audio still comes from iTunes previews, exactly as it
does for the built-in packs, so an import never depends on the source's own
streaming rights: a track Deezer will not play to us is very often one Apple
will.

**Every song is equally likely, and the difficulty slider disappears.** That is
the point of the feature, not a shortcut. Difficulty ranks tracks *within* their
pack by popularity (see [The difficulty slider](#the-difficulty-slider)), and a
playlist has no meaningful internal fame ordering to rank against — asking for
its "deep cuts" would be noise dressed up as a setting. Worth knowing if you
ever reuse `weightedOrder` elsewhere: on a pool with no popularity scores it does
*not* degrade to neutral, it silently ranks by array position. `uniformOrder` in
`server/difficulty.js` exists for that case.

Imports are held in memory for 12 hours, keyed by a hash of the playlist URL, so
re-importing the same link reuses the same entry. They are deliberately never
written to the database: they are somebody's private playlist, not catalogue, and
the expensive part — the iTunes lookups — is already cached durably in
`data/itunes-cache.json`, keyed by song rather than by playlist.

### Sources

| Source | Credentials | Status |
| --- | --- | --- |
| Deezer | none | works out of the box |
| Spotify | `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET` | off unless both are set |

Deezer is the default because it needs nothing: no app registration, no secret,
no subscription. Its API also publishes `title_short`, which strips version
suffixes better than any regex we could write — "Hey Jude (Remastered 2015)"
becomes "Hey Jude" while the leading parenthetical of "(I Can't Get No)
Satisfaction" survives intact.

Spotify is implemented and switched off. Before filling in credentials, note two
limits that are not bugs and cannot be coded around:

- Spotify issues a **client id *and* a client secret**, both 32 hex characters. A
  single opaque key is not a Spotify credential and will fail with
  `invalid_client`.
- A hobby app is stuck in **development mode**, which per Spotify's quota-modes
  documentation requires the *app owner* to hold Spotify Premium. Extended quota
  mode — the way out — has been limited to organisations with 250k+ monthly
  active users since May 2025.
- Since November 2024, Spotify-owned editorial and algorithmic playlists
  (Today's Top Hits, Discover Weekly, Release Radar) return 404 to
  client-credentials apps. User-created playlists are fine.

### Adding a source

One file in `server/playlists/` exporting `match`, `fetchPlaylist`, `available`
and `unavailableReason`, plus one line in `ADAPTERS` in
`server/playlists/index.js`. Nothing downstream changes — an import is shaped
like a pack selection, so `game.js` and `difficulty.js` never learn it exists.

### Why a playlist can be rejected

A playlist is checked against iTunes *before* the room is created, and refused if
fewer than 15 songs resolve. Curated packs are 150–900 tracks and the resolver
can walk past a miss; a playlist has no tail, so a 12-track playlist cannot fill
a 10-round game if even two songs fail. Discovering that on the loading screen
produces a mysteriously short game, because `totalRounds` becomes whatever
loaded.

The reported count is a floor — "18+ of 50" — because the check stops once it has
enough. Rejections distinguish a short playlist from an unresolvable one from an
iTunes rate limit, since the three look identical in the numbers and have
opposite remedies.

## Daily challenge

Five songs from the well-known end of the All Time pack, in typing mode, played
solo — and the same five for everybody, whatever time zone they are in and
whatever time of day they play. One run each, ranked on a global leaderboard
that resets at midnight UTC.

It is switched off unless `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` are
set (see `.env.example` for how to get them). Everything else about the game
works exactly the same without them.

### Why sign in

Everywhere else in MemoryBeat a player is a random string in localStorage, which
is right for a room you were sent a link to and useless for a leaderboard:
clearing it buys another attempt, and a script can mint a thousand identities in
a second. A Discord account is not unforgeable, but it costs enough to make the
board worth reading.

Only the `identify` scope is requested — an account id, a display name, an
avatar. The access token is used once, on the callback, and thrown away; nothing
else about the account is ever read or stored. Sessions are an HMAC-signed
cookie rather than rows in a table, since a session here is four fields and is
only ever read.

### Same five songs

The choice is a seeded shuffle of the pack's best-known 300, seeded from the
UTC date — a pure function of the day, recomputable anywhere.

That is not enough on its own, because whether a chosen song is *playable* is
not deterministic: iTunes is rate limited, and a lookup that fails at 09:00 can
succeed at 21:00. So the first request of the day walks the seeded order,
settles on five it can actually serve, and writes that list to the
`daily_challenges` table. Everyone else that day reads the row. The seed decides
what gets *tried*; the frozen row decides what everyone *gets*. The server also
settles the day just after each reset, so the first player of the day does not
wear a cold lookup on the loading screen.

Set `DAILY_SALT` if you would rather the schedule not be computable from a copy
of this repository. It protects the surprise and nothing else.

### One run a day

A run is filed when it **finishes**. Abandoning one — a closed tab, a dropped
connection — writes nothing, so it can be started again; the daily page offers
to resume the room it was left in rather than replacing it. A finished run is
final, and the `(day, discord_id)` primary key is what enforces that.

The tradeoff is deliberate and worth being clear about: it lets somebody who
lost their connection have another go, at the cost of letting somebody quit a
bad first round and re-roll the same five songs. Recording at the *start*
instead would close that door and slam it on the disconnected player too.

Nothing about a run is taken from the client. The score is the same number
`game.js` has been broadcasting all along, the songs come from the frozen row,
and a daily room is bound to the Discord id in the handshake cookie — so a room
code in a URL is not a way into somebody else's run.

## How a round works

1. The server picks a track, mints a one-off audio token, and sends the title
   blanked out — `_____ ______` — so you can see its shape but not its letters.
2. Clients buffer the clip and report ready; the round starts once everyone is
   ready (or after 12s, so one slow connection can't stall the room).
3. 3-2-1, then audio plays for 30 seconds. You type guesses into the chat box.
   Points decay from 1000 to 500 across the window, and the round ends early
   once everybody has it.
4. Hints arrive as the clock runs down: the artist at 40%, then a letter of the
   title at 62% and 82%. At least a third of the title always stays hidden.
5. The answer, artwork, and updated scores are revealed for 7 seconds, with the
   clip still playing underneath — it restarts if the round used it all up —
   and fading out as the next round arrives.

### Guessing rules

Whatever you type during a round is treated as a guess first and a message
second:

- **Right** — the message never reaches the chat. Everyone just sees
  "Nischal guessed it!", and you get the title spelled out for yourself.
- **Nearly right** — a private nudge, `"blindin lights" is close!`. Naming the
  artist instead of the song gets its own hint.
- **Wrong** — it posts as a normal chat message, because watching everyone
  flail is half the fun.

Matching is forgiving about case, accents, punctuation and spacing
(`gods plan`, `Señorita`, `badguy`, `10000 hours` all land), and allows a typo
or two on longer titles — but short titles must be exact, so *Roar* never
scores *Rain*.

**Chat goes private once you're right.** After you guess correctly, your
messages only reach other players who have also got it — so "OMG it's Levels"
can't spoil the round for anyone still listening. Chat opens back up at the
reveal.

## Layout

```
server/
  index.js       HTTP routes, socket wiring, audio proxy
  game.js        room lifecycle, round loop, scoring, chat rules
  auth.js        Discord OAuth2, signed session cookies
  daily.js       the day's five songs, and the leaderboards
  difficulty.js  popularity-weighted song sampling
  guess.js       guess matching, typo tolerance, title masking
  itunes.js      track resolution, throttling, clip cache, audio tokens
  db.js          SQLite schema and connection
  packs.js       reads packs out of the database, holds imported playlists
  env.js         loads .env, if there is one
  warm.js        optional cache pre-fill
  playlists/
    index.js     adapter registry: URL in, {title, artist} out
    deezer.js    keyless, the default
    spotify.js   complete but off unless credentials are set
    titles.js    strips release furniture from catalogue titles
scripts/
  build-packs.js      populates the database, computes popularity
  sources/wikipedia.js  Billboard year-end scraper
  sources/lastfm.js     genre tags and listener counts
public/
  index.html     main menu
  room.html      lobby + game
  daily.html     daily challenge: sign-in, play button, leaderboards
  js/menu.js     front page; joins and creates rooms, configures nothing
  js/room.js     game client, and every lobby control
  js/daily.js    daily page; no socket, the game itself is an ordinary room
  js/visualizer.js  canvas visualiser
  css/style.css
```

Plain HTML/CSS/JS on the client — the only dependencies are Express and
Socket.IO. The database uses `node:sqlite`, which ships with Node 22, so it adds
no dependency and no native build step.

## Notes

- Rooms are in-memory; restarting the server clears them. A daily run in
  progress goes with them — the leaderboard row does not, since it is only
  written once the run has finished.
- An empty room is cleaned up two minutes after the last player leaves.
- If the host disconnects, the host role passes to another player in the room.
- Just start typing anywhere in the room — it focuses the guess box for you.
- Singleplayer has no chat sidebar, so it gets its own guess bar under the
  player.
