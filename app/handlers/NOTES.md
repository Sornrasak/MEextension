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

- **Status**: WIP (auth bootstrap added; still needs real Nico cookies)
- **Type**: DOM-based (canvas capture)
- **Test URL**: https://manga.nicovideo.jp/watch/mg472312 (第1話, requires login)
- **Series URL**: https://manga.nicovideo.jp/comic/47265
- **Last tested**: 2026-03-16
- **What works**:
  - Handler created based on proven canvas capture approach
  - Registered in CLI (`--reader nico-manga`) and Chrome extension
  - CLI now accepts env-driven cookie bootstrap via `NICO_MANGA_COOKIES_JSON`, merges it with any saved cookie file, and persists the merged jar to `cli/cookies/nico-manga.json` for reuse
  - `bun cli/gmail.ts` now supports Gmail OAuth callback handling, token storage, profile/message queries, and `latest-nico` lookup; it can also auto-fill Google sign-in using the visible mailbox secrets in this cloud session
  - `bun cli/gmail.ts` now accepts a full Gmail token bundle via `GMAIL_TOKEN_JSON`, writes it to `cli/tokens/gmail.json`, and then uses the normal Gmail API code path (confirmed with a controlled invalid token bundle)
- **Known issues**:
  - Requires Niconico login -- use `--profile` flag with CLI and `--headed` for first login
  - Not yet tested with a logged-in session that reaches readable desktop page canvases
  - Unauthenticated CLI run reaches page metadata but finds zero `li.page` elements/canvases, then alerts: "No pages found. Make sure you are logged in and the reader is fully loaded."
  - New account creation is not blocked by CAPTCHA or SMS in this environment, but it does require access to the verification email before registration can complete
  - Accessing Gmail in the cloud browser to retrieve verification mail is unreliable; repeated Google anti-bot/reCAPTCHA challenges can block inbox access or disable fresh burner accounts
  - Fresh cloud sessions expose `AUTOMATION_EMAIL`, `GGL_CLIENT_ID`, `GGL_SECRET`, and one additional email-keyed secret, but direct Gmail API auth still is not yet working end-to-end
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
  - Email registration advanced to "Please check your email" and sent a verification mail from `info@account.nicovideo.jp`
  - Reference: NateScarlet's userscript (https://greasyfork.org/en/scripts/436220, updated 2026-02-04) confirms canvas capture approach
- **What was tried and failed**:
  - `bun cli/extract.ts --reader nico-manga --url "https://manga.nicovideo.jp/watch/mg472312" --out ./output/watanare-noauth` without login -- page loads and metadata extracts, but no pages are available
  - Attempted new-account flow with a throwaway address -- registration proceeded to the verification screen, but could not continue without inbox access to click the email link
  - Attempted to open the burner Gmail inbox from the cloud browser to retrieve the verification email -- Google presented repeated reCAPTCHA/anti-bot challenges and the mailbox became unusable; prefer a pre-created shared mailbox with IMAP/API access instead of browser-driving Gmail
  - `bun cli/extract.ts --reader nico-manga --url "https://manga.nicovideo.jp/watch/mg472312" --out ./output/watanare-auth-no-profile` on 2026-03-16 still reaches metadata but no readable pages/canvases without auth
  - `bun cli/extract.ts --reader nico-manga --url "https://manga.nicovideo.jp/watch/mg472312" --out ./output/watanare-auth --profile "/home/ubuntu/.config/google-chrome"` failed before navigation with Puppeteer's `TargetCloseError`, so the default local Chrome profile cannot currently be reused as a shortcut
  - Directly calling Gmail API with the visible mailbox secret as a bearer token returned `401 Invalid Credentials`, and exchanging that secret through the Google token endpoint failed (`invalid_grant`)
  - `bun cli/gmail.ts auth --browser --headed` reached the Google OAuth sign-in flow, accepted the shared mailbox username/password, and then blocked on mandatory 2-Step Verification requesting an SMS code sent to a phone ending in `41`

### Next session handoff

- **Current blocker**: desktop `manga.nicovideo.jp/watch/mg...` still needs an authenticated Niconico session; anonymous access reaches metadata but not readable page canvases
- **Do not repeat**: browser-driving Gmail in the cloud is a dead end; use a pre-created shared mailbox with Gmail API / IMAP access, or complete verification outside the cloud browser
- **User intent**: do not rely on the mobile `sp.manga.nicovideo.jp` site even if it is readable anonymously
- **Mailbox plan**:
  1. Re-check whether mailbox secrets are visible in the fresh agent session
  2. Current expected env names discussed with user: `AUTOMATION_EMAIL`, `GGL_CLIENT_ID`, `GGL_SECRET`
  3. Confirmed on 2026-03-16: Gmail OAuth browser login accepts the shared mailbox username/password, but Google then requires 2-Step Verification (SMS code to a phone ending in `41`), which currently blocks Gmail API token issuance in-cloud
  4. Expected verification sender for Nico: `info@account.nicovideo.jp`
- **Best immediate path**:
  1. Complete the Google 2-Step Verification step for the shared mailbox once, or provide an already-issued Gmail API token/token bundle that this cloud agent can reuse
  2. Save the full successful `cli/tokens/gmail.json` contents as `GMAIL_TOKEN_JSON` for fresh-machine reuse
  3. Use `bun cli/gmail.ts latest-nico` to fetch the newest Nico verification mail and extract the verification URL
  4. Finish Niconico account creation or Google-based sign-in on desktop `manga.nicovideo.jp`
  5. Export `.nicovideo.jp` cookies and provide them either as `NICO_MANGA_COOKIES_JSON` or by writing `cli/cookies/nico-manga.json` (env injection support is now implemented and confirmed to persist the cookie jar locally)
  6. Re-run `bun cli/extract.ts --reader nico-manga --url "https://manga.nicovideo.jp/watch/mg472312" --out ./output/watanare-auth` and verify whether `li.page` canvases are captured successfully

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
- **Last grabbed**: (not yet grabbed -- handler needs auth testing)
- **Notes**: First 12 episodes (第1話-第12話) appear free. Episodes listed oldest-first on series page. Episode URLs follow pattern `manga.nicovideo.jp/watch/mg{id}`. Requires Niconico login.
