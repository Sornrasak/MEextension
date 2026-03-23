# Handler Notes

> **IMPORTANT**: Read this file before working on any handler.
> Update it after making changes or discovering new information.
> Log what was tried and failed so future sessions don't repeat mistakes.

---

## takecomic

- **Status**: Working
- **Type**: API-based
- **Test URL**: https://takecomic.jp/episodes/4a68a7464bf1f (1話, free)
- **Series URL**: https://takecomic.jp/series/8e32550d65684
- **Last tested**: 2026-02-14
- **What works**:
  - API fetch via `/api/book/contentsInfo?comici-viewer-id=...`
  - 4x4 tile descrambling using canvas
  - ZIP output via JSZip + file-saver
  - CLI extraction via Puppeteer (20s for 10 pages, 1441x2048 each)
  - Verification passes: all pages valid PNGs, no artifacts or seams
- **Known issues**:
  - CSP blocks Puppeteer-injected fetch to `viewer.takecomic.jp` -- fixed with `page.setBypassCSP(true)` in `cli/puppeteer-runner.ts`. Chrome extension path is unaffected (extensions bypass CSP automatically).
  - ZIP filenames contain `|` (pipe) from page title, which is invalid on Windows -- fixed with path sanitization in `cli/verify.ts`
- **Site quirks**:
  - Viewer ID found via `[data-comici-viewer-id]` DOM attribute (confirmed working)
  - Also searchable in: meta tags, inline `<script>` content, or global JS state (`__NUXT__`, `__NEXT_DATA__`, `window.viewerId`)
  - Scramble pattern is a JSON number array in the API response (e.g. `[11, 6, 1, 8, ...]`)
  - Images served from `viewer.takecomic.jp/book/{viewerId}/{filename}` (note: different domain from page origin -- this is why CSP matters)
  - API supports pagination via `page-from` and `page-to` params
  - Series pages: `/series/{hash}` -- lists episodes with free/paid badges
  - Episode pages: `/episodes/{hash}` -- loads the Comici viewer
  - Free episodes accessible without login; paid episodes show "アカウント登録が必要です"
  - Some older Takeshobo sites (gammaplus, storia) migrated to takecomic.jp
- **What was tried and failed**:
  - Column-major permutation -- wrong axis; the correct approach is row-major transpose (`transposePattern` + `transposeIndex`)
  - Direct canvas tile copy without pixel alignment -- caused 1px horizontal/vertical seams between tiles
  - Fixed tile sizes -- doesn't work when image dimensions aren't perfectly divisible by grid; need `buildSegments()` for fractional-pixel-aware tile coordinates
  - Naive grid splitting (equal integer division) -- remainder pixels cause seams; `effectiveWidth/Height` approach crops to divisible region
  - Running Puppeteer without CSP bypass -- all image fetches blocked by Content Security Policy `connect-src` directive

---

## speed-binb

- **Status**: Working (old URL format only)
- **Type**: DOM-based
- **Test URL**: https://storia.takeshobo.co.jp/manga/himegimi/
- **Last tested**: Unknown (pre-migration)
- **What works**:
  - WheelEvent-based page navigation
  - `dom-to-image` for page capture
  - Recursive extraction from page 0 to END_PAGE
- **Known issues**:
  - Takeshobo sites have migrated to takecomic.jp; this handler may no longer work on those
  - END_PAGE is hardcoded to 60
- **Site quirks**:
  - Page elements are `#content-p{N}` inside a scrollable container
  - Navigation uses WheelEvent; the `typeArg` varies (`"wheel"` vs `"mousewheel"`) and must be detected at runtime
  - `deltaY` direction is inverted between the two event types

---

## nico-douga

- **Status**: Deprecated (superseded by nico-manga)
- **Type**: API-based
- **Test URL**: https://seiga.nicovideo.jp/comic/47265
- **Last tested**: Unknown
- **What works**:
  - API fetch for frame URLs and DRM hashes
  - XOR decryption with `drm_hash` (first 16 hex chars)
  - Base64 encoding of decrypted image bytes
- **Known issues**:
  - Requires Niconico login for some premium/restricted content
  - Site has migrated from `seiga.nicovideo.jp` to `manga.nicovideo.jp` -- old API endpoint is likely defunct
  - Use the new `nico-manga` handler instead
- **Site quirks**:
  - API endpoint: `ssl.seiga.nicovideo.jp/api/v1/comicwalker/episodes/{cid}/frames`
  - Episode ID comes from URL query param `?cid=...`
  - Images are encrypted: each byte XORed with cycling key derived from `drm_hash`

---

## nico-manga

- **Status**: Working with auth (cookie + email-MFA persistence proven)
- **Type**: DOM-based (canvas capture)
- **Test URL**: https://manga.nicovideo.jp/watch/mg472312 (第1話, requires login)
- **Series URL**: https://manga.nicovideo.jp/comic/47265
- **Last tested**: 2026-03-23
- **What works**:
  - Handler created based on proven canvas capture approach
  - Registered in CLI (`--reader nico-manga`) and Chrome extension
  - CLI now accepts env-driven cookie bootstrap via `NICO_MANGA_COOKIES_JSON`, merges it with any saved cookie file, and persists the merged jar to `cli/cookies/nico-manga.json` for reuse
  - `ME1_APP_PASS` works for Gmail IMAP access against `AUTOMATION_EMAIL`; browser-driving Gmail is no longer required to retrieve Nico mail
  - New helper `bun cli/nico-account.ts ensure` can validate saved cookies, log back in with stored Nico email/password, complete Nico's email-based 2-step verification, and persist refreshed `.nicovideo.jp` cookies
  - New helper `bun cli/nico-account.ts scrape --url "https://manga.nicovideo.jp/watch/mg472312"` can ensure auth and then run the existing `nico-manga` extractor in one step
  - Authenticated extraction now works end to end for `mg472312`: 34 `li.page` elements found, 34 pages captured, ZIP written, and `bun cli/verify.ts` reports all 34 pages valid PNGs at 650x924
  - New resolver `bun cli/latest.ts --reader nico-manga --seriesUrl "https://manga.nicovideo.jp/comic/47265"` resolves both the latest listed episode and Nico's "latest free" shortcut; as of 2026-03-23 both point to `https://manga.nicovideo.jp/watch/mg1006398` (`第73話`)
  - New wrapper `scripts/pull_nico_latest.sh --series-url "https://manga.nicovideo.jp/comic/47265" --output-dir ./output/watanare` builds, resolves the latest free episode, skips repeats via `.latest_episode_url`, and then delegates auth/extract/verify to the existing Nico helper
  - `bun cli/nico-account.ts` now accepts `--accountEmail` / `NICO_ACCOUNT_EMAIL` so a known-good Nico login can be seeded once instead of relying on fresh registration
- **Known issues**:
  - Unauthenticated CLI run reaches page metadata but finds zero `li.page` elements/canvases, then alerts: "No pages found. Make sure you are logged in and the reader is fully loaded."
  - Fresh device logins for a saved Nico account are not password-only: Nico sends a 6-digit email confirmation code and the helper must read it from Gmail before reader access is restored
  - Fresh account creation from the burner mailbox is still inconsistent right now: the registration page previously accepted the base address and some dotted Gmail aliases, but later in the session started responding with `Invalid email address` for both the base mailbox and new dotted variants
  - Resuming from an old registration email only works while the verification token remains valid; a stale token redirects away from the profile form
  - Reusing the system Chrome profile at `/home/ubuntu/.config/google-chrome` failed during Puppeteer attach with `TargetCloseError: Protocol error (Target.setAutoAttach): Target closed`, so it is not a reliable auth source right now
- **Site quirks**:
  - Successor to `seiga.nicovideo.jp` (old `nico-douga` handler)
  - Series page: `manga.nicovideo.jp/comic/{id}` -- lists episodes
  - Episode page: `manga.nicovideo.jp/watch/mg{id}` -- the reader
  - Mobile pages under `sp.manga.nicovideo.jp` can expose series lists and some episodes without login (confirmed: `https://sp.manga.nicovideo.jp/comic/47265`, `https://sp.manga.nicovideo.jp/watch/mg1006398`), but the user explicitly does **not** want to rely on the mobile site for this target
  - Pages are `li.page` elements with `data-page-index` attributes
  - Each page renders as `<canvas>` (excluding `.balloon` comment overlays)
  - Some pages may use `<img data-image-id="...">` as fallback
  - Pages lazy-load: must scroll into view to trigger rendering
  - Canvas starts at `width=1` until rendered; poll until real-sized
  - Without login, shows "ご視聴にはniconicoアカウントが必要です" with only a thumbnail
  - Login page (`account.nicovideo.jp/login`) supports direct email/phone + password login and third-party login with Apple, X, Facebook, LINE, Google, Yahoo! JAPAN, and Nintendo
  - Registration page (`account.nicovideo.jp/register/email`) offers the same third-party providers plus email registration guarded by Cloudflare Turnstile
  - In this environment, Cloudflare Turnstile auto-completed successfully on the registration page without extra interaction
  - Registration email actually arrives from `account@nicovideo.jp` with subject `Niconico Account Registration Notice`; Gmail placed these mails in `[Gmail]/Spam` during testing
  - Login MFA mail arrives from `account@nicovideo.jp` with subject `[Niconico]Confirmation code`; Gmail delivered these to `INBOX` during testing
  - MFA mail body includes the 6-digit code in plain text and states the code is valid for 15 minutes
  - Series pages expose a stable `最新の無料話を読む` shortcut at `/comic/{id}/new`; following `https://manga.nicovideo.jp/comic/47265/new?track=ct_new` currently 302-redirects to `https://manga.nicovideo.jp/watch/mg1006398`
  - Reference: NateScarlet's userscript (https://greasyfork.org/en/scripts/436220, updated 2026-02-04) confirms canvas capture approach
- **What was tried and failed**:
  - `bun cli/extract.ts --reader nico-manga --url "https://manga.nicovideo.jp/watch/mg472312" --out ./output/watanare-noauth` without login -- page loads and metadata extracts, but no pages are available
  - Attempted to open the burner Gmail inbox from the cloud browser to retrieve verification mail -- Google presented repeated reCAPTCHA/anti-bot challenges; IMAP app-password access is the reliable path
  - `bun cli/extract.ts --reader nico-manga --url "https://manga.nicovideo.jp/watch/mg472312" --out ./output/watanare-auth-no-profile` on 2026-03-16 still reaches metadata but no readable pages/canvases without auth
  - `bun cli/extract.ts --reader nico-manga --url "https://manga.nicovideo.jp/watch/mg472312" --out ./output/watanare-auth --profile "/home/ubuntu/.config/google-chrome"` failed before navigation with Puppeteer's `TargetCloseError`, so the default local Chrome profile cannot currently be reused as a shortcut
  - Directly calling Gmail API with the visible mailbox secret as a bearer token returned `401 Invalid Credentials`, and exchanging that secret through the Google token endpoint failed (`invalid_grant`)
  - `bun cli/gmail.ts auth --browser --headed` reached the Google OAuth sign-in flow, accepted the shared mailbox username/password, and then blocked on mandatory 2-Step Verification requesting an SMS code sent to a phone ending in `41`
  - After several successful email-registration probes, Nico's registration form started returning `Invalid email address` for the burner Gmail and fresh dotted Gmail aliases; do not assume a form rejection means the mailbox syntax is truly unsupported
  - `scripts/pull_nico_latest.sh` intentionally stops before extraction when neither `cli/cookies/nico-manga-account.json` nor `NICO_ACCOUNT_EMAIL` + `NICO_ACCOUNT_PASSWORD` are available; first successful unattended run still needs a one-time Nico account bootstrap

### Next session handoff

- **Current state**: desktop `manga.nicovideo.jp/watch/mg472312` is readable and extractable once a valid Nico cookie jar exists; anonymous access is still gated
- **Latest resolver state**: `bun cli/latest.ts` and `scripts/pull_nico_latest.sh` are in place for Nico Manga; the current latest free episode for Watanare resolves to `mg1006398` (`第73話`)
- **Do not repeat**: browser-driving Gmail in the cloud is a dead end; use Gmail IMAP with `AUTOMATION_EMAIL` + `ME1_APP_PASS`
- **User intent**: do not rely on the mobile `sp.manga.nicovideo.jp` site even if it is readable anonymously
- **Auth flow now**:
  1. Prefer `bun cli/nico-account.ts ensure --accountEmail "$NICO_ACCOUNT_EMAIL" --password "$NICO_ACCOUNT_PASSWORD"` once to seed a known-good Nico login into `cli/cookies/nico-manga-account.json`, or start with an existing account file if one already exists
  2. If cookies are stale, the helper can log in again and auto-read Nico's 6-digit email MFA code from Gmail
  3. Then run `scripts/pull_nico_latest.sh --series-url "https://manga.nicovideo.jp/comic/47265" --output-dir ./output/watanare`
- **Remaining rough edge**:
  1. Fresh account creation through the burner mailbox is not yet consistently reproducible because Nico started returning `Invalid email address` on new submissions later in this session
  2. If that recurs, use an already-created Nico alias account and let the helper manage cookie refresh + email MFA instead of re-registering

---

## comic-walker

- **Status**: Unknown (needs retest)
- **Type**: DOM-based
- **Test URL**: https://comic-walker.com/contents/detail/KDCW_AM05201400010000_68/
- **Last tested**: Unknown
- **What works**: DOM navigation + dom-to-image capture
- **Known issues**: Not recently tested
- **Site quirks**: Pages are `.page-area` elements navigated via buttons

---

## kindle

- **Status**: Unknown (needs retest)
- **Type**: DOM-based
- **Test URL**: https://read.amazon.com/
- **Last tested**: Unknown
- **What works**: Left-click navigation + canvas capture
- **Known issues**:
  - Requires Amazon login (use `--profile` flag with CLI)
- **Site quirks**: Captures `<canvas>` element via dom-to-image

---

## comicbushi

- **Status**: Broken (CORS blocked)
- **Type**: DOM-based
- **Test URL**: Unknown
- **Last tested**: Unknown
- **Known issues**: CORS blocks image capture
- **Site quirks**: Page elements are `#page_{N}`

---

## comic-pixiv

- **Status**: Unknown (needs retest)
- **Type**: DOM-based (hybrid -- extracts URLs then downloads)
- **Test URL**: https://comic.pixiv.net/
- **Last tested**: Unknown
- **What works**: Extracts `background-image` URLs, downloads via axios
- **Known issues**: Not recently tested; may need Pixiv login
- **Site quirks**: Image URLs are in CSS `background-image` properties

---
---

# Monthly Series

> Tracked series for recurring monthly extraction. For each entry, the agent should:
> 1. Visit the series URL to find the latest episode
> 2. Extract it to `output/{short_name}/`
> 3. Verify and sanity check
> 4. Update `Last grabbed` below

## yume-furarete-yuri

- **Title**: 夢でフラれてはじまる百合
- **Reader**: takecomic
- **Series URL**: https://takecomic.jp/series/8e32550d65684
- **Output folder**: `output/yume-furarete-yuri/`
- **Last grabbed**: 2026-02-14 -- 1話 (https://takecomic.jp/episodes/4a68a7464bf1f, 10 pages)
- **Notes**: Free episodes marked with 無料. Episodes listed newest-first on series page. Latest free was 51話 as of 2026-02-14.

## watanare

- **Title**: わたしが恋人になれるわけないじゃん、ムリムリ！（※ムリじゃなかった!?）
- **Reader**: nico-manga
- **Series URL**: https://manga.nicovideo.jp/comic/47265
- **Output folder**: `output/watanare/`
- **Last grabbed**: 2026-03-17 -- 第1話 (https://manga.nicovideo.jp/watch/mg472312, 34 pages)
- **Notes**: First 12 episodes (第1話-第12話) appear free. Episodes listed oldest-first on series page. Episode URLs follow pattern `manga.nicovideo.jp/watch/mg{id}`. Requires Niconico login. Latest free currently resolves via `/comic/47265/new` to `https://manga.nicovideo.jp/watch/mg1006398` (`第73話`) as of 2026-03-23.
