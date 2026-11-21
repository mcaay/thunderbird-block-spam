# Implementation notes

Decisions made while implementing `docs/specs/2026-11-21-thunderbird-block-spam-design.md`, and places where the official documentation led to something different from the specification.

## What was and was not verified

- **Verified by tests:** all of `src/core` and `src/ai` with fake mail and HTTP layers, the companion's key logic in a sandbox, and repository rules (strings, manifest, layering). Run `npm run check`.
- **Verified in a browser:** the built background page and settings page were run together in a Chromium browser against a fake of the Thunderbird API, including a scan, new mail, shortcuts, an access point with consent, and a complete ChatGPT sign-in against a fake OpenAI (code exchange, ID token signature check with WebCrypto, model list, streamed score). `npm run harness` builds that setup in `dist/harness`; the comment at the top of `scripts/harness.mjs` says how to open it.
- **Verified in Thunderbird 153.7.0 on macOS:** isolated profiles, loopback IMAP/SMTP accounts and mock AI servers, including installation prompts, mail moves, learning, shortcuts, background suspension, imports and recovery. The practical report and evidence are in `reviews/2026-11-21-practical-test/report.md` (git-ignored). Real AI services and ChatGPT sign-in remain unverified. See `docs/manual-test-checklist.md` for the checklist and remaining checks.
- **Build step 1** (the ChatGPT sign-in prototype against a real account, the decision gate of specification section 8.6) was not run. The flow is implemented from OpenAI's documentation, including the paste-the-address fallback.
- **The interface was looked at in Thunderbird 153.7.0** after its rebuild (see [Interface](#interface)): every pane, the popup, the dialogs and the states in between, in the light and the dark theme, in English and in Polish, in a narrow window, at 200 percent zoom and in high contrast, and the keyboard order of every pane. The captures are in `reviews/2026-11-21-ux-ui/round-2/` (git-ignored). Not seen: the popup panel and the context menu as the system draws them, the desktop notification, Windows and Linux.

## Documentation checked

Checked on 2026-11-21 against the references of the specification:

- Thunderbird WebExtension API, Manifest V3 (webextension-api.thunderbird.net): messages, compose, folders, commands, messengerUtilities, accounts, identities, mailTabs, messageDisplay, tabs, windows, permissions, webRequest, alarms, notifications, the Manifest V3 and Experiments guides.
- ATN review policy (thunderbird.github.io/atn-review-policy) and the Experiments page on developer.thunderbird.net.
- TypeSafe System One, OpenAI Decisions, Cloudflare Clef, OpenRouter Decisions, basal (README, docs/API.md, docs/SERVING.md).
- OpenAI "Sign in with ChatGPT" plan usage for open-source apps: overview, sign-in, accounts and sessions, token reference, models and inference, errors and recovery, preview limitations, UI/UX guidelines.
- Anthropic Messages API, errors, authentication, effort, stop reasons, API versions, the Claude Code legal page and the monthly API credits article.
- Ollama FAQ (`OLLAMA_ORIGINS`), Gemini OpenAI compatibility, OpenAI model pages, the OpenRouter model list.

The Thunderbird "Experiment plan" thread on Topicbox could not be read without a browser session. The statement about the 2027 ESR is taken from the specification. Thunderbird's source already contains the switch for it (`extensions.experiments.suppressed`, off today, with a list of exempt add-ons).

Where the documentation left a question open, the source code of Thunderbird (`thunderbird/thunderbird-desktop`) and of the shared toolkit (`mozilla-firefox/firefox`) was read:

- `permissions.request` is refused outside a user input handler and ignores `data_collection` while the preference is off.
- Every extension API call that reaches the parent process resets the idle timer of a non-persistent background page, and `runtime.getPlatformInfo` is such a call. This is what the 20 second keep-alive relies on.
- `messages.getHeaders`, `sendInfo.details` of `compose.onAfterSend`, the inclusive date comparison of `messages.query`, the folders that `messages.onNewMailReceived` reports by default (the Inbox and folders without a special use), and `messages.move` resolving after the move has finished.
- `ExtensionSupport.registerWindowListener` also reports windows that are already open, and the tab mode names `mail3PaneTab` and `mailMessageTab`, both used by the companion.

## Where the documentation changed the design

1. **Headers come from `messages.getHeaders`** (added in Thunderbird 147), not from `messages.getFull`. It returns all headers without parsing the MIME structure, which is what the wrapped-forward check (`X-Original-From`, `X-Original-Sender`) and the `Reply-To` line of the AI payload need.
2. **Live send uses `sendInfo.details`** of `compose.onAfterSend` (added in Thunderbird 147). The compose window may already be gone when the event fires, so the recipients are read from the event itself.
3. **Folders are stored as account id plus path.** The documentation guarantees a folder id only "throughout a session", so settings never store folder ids. Folders are looked up by account and path on each run.
4. **ChatGPT sign-in sends more than the specification lists.** The official flow also requires a `nonce`, validation of the ID token (signature against the published JWKS, issuer, audience, expiry, nonce) and a check that the granted scopes contain `chatgpt.tokens.use.direct`. All three are implemented. The ID token is verified with WebCrypto (RS256 and ES256), because the add-on bundles no JWT library.
5. **ChatGPT requests omit unsupported fields.** The preview limitations reject `max_output_tokens`, `temperature`, `metadata` and others, so the request contains only `model`, `instructions`, `input`, `store: false` and `stream: true`.
6. **ChatGPT error codes.** `subscription_sharing_usage_limit_exceeded` is a quota error as specified. In addition `subscription_sharing_usage_unavailable` and `subscription_sharing_user_unavailable` are temporary failures, and `subscription_sharing_user_not_eligible`, `subscription_sharing_invalid_user`, `subscription_sharing_route_not_supported` and `chatpass_v2_*` mark the access point as needing attention.
7. **Signing out revokes the session** at the `revocation_endpoint` of the discovery document, as the documentation asks. Removing a ChatGPT access point, a Replace import and Reset do the same; Reset reads the stored sign-ins leniently, because it runs when the stored data may be invalid.
8. **The sign-in tab uses `linkHandler: "relaxed"`.** By default Thunderbird opens links to other hosts in the system browser, which would break a sign-in that passes through several hosts.
9. **OpenAI's UI guidelines are followed where they apply:** the button reads "Continue with ChatGPT", a one-time message confirms plan use after the first sign-in, the access point shows "Using ChatGPT plan" with a "Manage usage" link to ChatGPT settings.
10. **Thunderbird shows no data collection prompt of its own.** Its documentation says add-ons must ask for consent themselves, and in its source the data collection permission feature is switched off by a preference (`extensions.dataCollectionPermissions.enabled` is not set, the toolkit default is off). The settings page therefore asks for explicit consent, naming Block Spam, before the first access point of a host is added. The manifest still declares `personalCommunications` and `personallyIdentifyingInfo` as optional data collection permissions, and the page requests them together with the host permission wherever `permissions.getAll()` shows that the feature is on.
11. **`webRequest` as an optional permission.** Thunderbird's permission documentation does not list `webRequest` among optional permissions. The toolkit schema that Thunderbird shares with Firefox does allow it (`web_request.json` extends `OptionalPermissionNoPrompt`), so the manifest declares it as specified. If a Thunderbird refuses it anyway, the sign-in continues with the paste-the-address fallback only.
12. **Permission requests cannot be retried after an await.** Thunderbird accepts `permissions.request` only while the click is being handled, so a refused request cannot be repeated in another form afterwards. `src/options/permissions.ts` therefore detects what this Thunderbird supports when the page loads (data collection permissions, optional `webRequest`), tries the plainer forms at once when a form is refused synchronously, and otherwise remembers what was refused and asks the user to press the button again.
13. **Anthropic API version `2026-10-21`** is sent, the current version. The request sets `output_config.effort` to `low` (classification) and checks `stop_reason` before reading the answer. Models older than Claude Opus 4.5 reject the effort parameter.
14. **Decision model details.** OpenRouter and OpenAI can answer a question with `type: "refusal"`; both are treated as a failure of the access point. The local basal server needs no `model` field, so it is sent only when set.
15. **The README statement about Claude plans** follows Anthropic's pages: Max, Ultra and Team include monthly API credits that are used with an API key of a linked Console organization. Anthropic does not permit third-party applications to offer Claude sign-in or to route requests through plan credentials, so the add-on never does. The local bridge is described as the user's own setup under Anthropic's terms.

## Decisions where the specification was open

### Lists and learning

- **Private suffixes count.** Registrable domains use both sections of the Public Suffix List, so `someone.github.io` is its own domain and a whole hosting platform is never whitelisted or blocked as one company.
- **A shortcut always takes effect.** After a block or trust command, an older entry of the other list that would still decide that sender (for example a blocked address inside a domain that is now trusted) is removed. Without this the shortcut would appear to do nothing. Entries about other senders are not touched.
- **Learning removes every AI block that would still decide a recipient**, not only the one with the key of the new white list entry (specification section 4.5, rule 2): an AI entry scoped to the account while new entries are now shared, or an address entry from when the domain was public, would otherwise keep blocking someone the user writes to. Manual blocks stop learning as specified and are never removed.
- **AI never replaces a list entry.** If the lists change while a message is being scored, the list entry wins over the score and over the "no AI verdict" setting, and once the sender is on a list no further access point is asked.
- **A decision reads the settings when it acts.** Observation mode switched on, or protection paused, while a message is being scored means that nothing is moved for it and no AI entry is written; it is logged as observed. The cutoff and the "no AI verdict" setting are read after the AI answered.
- **A domain added by hand is stored as its registrable domain** (`mail.example.com` becomes `example.com`), because that is what senders are matched by.
- **The public domain list** is seeded from `free-email-domains` 1.2.21 (MIT), the last small, curated version of that package (4,779 providers, based on HubSpot's list), plus appendix A. Later versions of the package mix in tens of thousands of disposable and unrelated domains, some of them real company domains. Treating a company domain as public would weaken domain-level whitelisting, and with it the promise that mail from a customer's colleagues is not sent to the AI.
- **The forwarded-header label table** (`From:`, `Od:`, `Nadawca:`) is a setting, editable next to the forwarding mailboxes.
- **A forwarding mailbox is never the effective sender.** If a header or the body names a forwarding mailbox as the original sender, the next source is tried.
- **A body line is searched up to 998 characters** (the line limit of RFC 5322) for a forwarded-header label and its address. The address patterns backtrack on one very long line, which took about 0.2 seconds per message at 20,000 characters.
- **Addresses from mail are at most 254 characters long** (RFC 5321). A longer sender is treated like one that cannot be parsed and a longer recipient is not learned, so a message cannot put an arbitrarily long value into the log, the lists or the payload. Stored entries are not checked for length and keep loading.

### Incoming mail

- **Reading raw headers has a 30 second limit.** In the practical IMAP test, Thunderbird's `messages.getHeaders` stayed pending on a fresh large message and blocked the serial processing queue. The timeout uses the existing missing-header fallback and lets subsequent messages proceed. The native request cannot be cancelled; a timed-out read can omit Reply-To from the payload. Other MIME APIs did not stall in the completed tests.
- **The fast path handles the messages of the event itself** and skips mail that arrived before protection was switched on. The Date header is written by the sender, so for a message dated before that moment the time in its newest `Received` header, written by the receiving server, decides. The tick uses the date query of the specification. Both use the same per-message handler and the same processed set.
- **A message is identified by its account and a hash of its Message-ID, author and date.** Specification section 5.1 names account and Message-ID only; then one harmless message exempted every later message that reused its Message-ID, also from a blacklisted sender, for 30 days and without a log line. Copies of one message still share the identity. A sender who also copies the author and the `Date` header of the earlier message is still skipped.
- **A processed record of a message dated in the future** is filed under the message's date instead of today, so it cannot expire while the message would still be returned by the date query.
- **Buckets are pruned after a completed tick**, never before one.
- **An unexpected failure while handling a message** is logged and the message is marked as processed, like a failed move. It is not retried.
- **The screening sweep** checks every message in the screening folders against the lists and moves white list matches to the Inbox. It runs after each change that adds a white list entry and is logged with the outcome `released`. The request for a sweep lives in memory only, so the tick at Thunderbird's startup, after installation and after an update always sweeps: a sweep that was due when Thunderbird closed is not left waiting for the next white list addition.
- **The log entry has two extra fields:** `via` (the forwarding mailbox of a wrapped forward) and `action` (what was done, or would have been done in observation mode).
- **The AI payload's `From` line is the address only**, as the specification defines the effective sender, without the display name.
- **One Junk folder per account:** the first folder with the junk special use.

### AI

- **Default models:** `jev-latest` (Jev), `~typesafe/jev-latest` (OpenRouter Decisions), `clef` (Cloudflare), `gpt-6-luna` (OpenAI Decisions, OpenAI chat), `gemini-4-hydrogen` (Gemini), `openai/gpt-6-luna` (OpenRouter chat), `qwen3:8b` (Ollama), `claude-opus-5-5` (Anthropic). LM Studio, the local decision model and Custom start with an empty model. Chat access points have a "Load models" button that reads `GET <base>/models`.
- **Anthropic default model.** `claude-opus-5-5` is the default that Anthropic's own guidance names. `claude-haiku-5-5` is much cheaper and can be typed into the model field; the hint under the field says so.
- **HTTP 402** (payment required) is treated like HTTP 429: a quota error with a cool-down.
- **A cool-down lasts at most 24 hours**, whatever `Retry-After` says, and the lifetime of a ChatGPT sign-in token is capped at 30 days (a lifetime that is not a finite number counts as the default hour). A huge number in either would otherwise overflow to Infinity, which cannot be stored and validated again, and one answer of a server would switch protection off at the next start.
- **A 401 or 403 is confirmed with the sample.** Specification section 8.2 marks an access point as needing attention after HTTP 401 or 403. Some services answer 403 because of the content of one request (OpenRouter's moderation for flagged input, gateways with guardrails), so one email could switch scoring off for all later mail, against the "one wrong score" of section 8.1. When a message gets 401 or 403, the chain scores the built-in sample once with the same access point: only if that is refused with 401 or 403 too does the access point need attention. Otherwise the failure counts for that message only and the next access point is tried.
- **A successful Test** clears "needs attention" and the cool-down, like saving the access point does.
- **The host permission is the record of consent.** Before every request the background checks `permissions.contains` for the host it contacts: the fixed endpoint of a provider-bound type, both OpenAI hosts for the ChatGPT plan. Without the permission the request is not sent and the access point needs attention. The permission is granted only by saving the access point in the editor, after the consent dialog, so Test and the enable checkbox cannot activate an imported access point, and removing a host permission in the Add-ons Manager stops the requests to that host.
- **Loopback** means `localhost` and `127.0.0.1`. IPv6 loopback is not offered, because its match pattern could not be verified.
- **Answers have a size limit.** A response body, and the event stream of the ChatGPT plan, is read up to 4 MB, and the collected answer text up to 10,000 characters; beyond that the request fails like a network error. The 30 second timeout alone let a server fill the background page's memory.
- **POST requests do not follow redirects.** Scoring requests and the token exchange, refresh and revocation use `redirect: "error"`: a redirect would send the mail or a token again to an address that was never checked against the https rule, the consent and the host permission. A server that redirects fails like a network error, and the next access point is tried.
- **The reply of an LLM is parsed strictly**, as specified. A model that wraps its answer in reasoning tags fails and the next access point is tried.
- **Server-side refusal fallbacks of the Anthropic API are not used.** The chain of access points is the fallback mechanism of this design, and a beta parameter that not every model accepts would break user-chosen models.
- **The Anthropic adapter uses plain HTTP**, not the Anthropic SDK, because the specification allows one runtime dependency.
- **The type of an access point cannot be changed after it was added.** Remove it and add a new one.

### ChatGPT sign-in

- **Tokens are stored in `storage.local`**, unencrypted, as the specification states. OpenAI's documentation recommends protected storage and warns against browser storage; a MailExtension without native messaging has no other persistent storage. The settings page says so.
- **Each ChatGPT access point is one registration** with its own issued client id. Adding another ChatGPT access point registers a new client; signing in again on an existing one reuses its client id and sends `id_token_hint` and `login_hint`.
- **The redirect port is always 1455.** Nothing listens on it; the add-on reads the address of the navigation.
- **A started sign-in is kept for 15 minutes** in storage, so it survives a restart of the background page. The background page is kept awake while a sign-in is pending.
- **A 401 from the Responses API renews the access token once** and the request is repeated; only a second 401 is an auth failure. An access token can end before its stored expiry (revoked early, or a local clock that runs behind), and without this the access point would need attention although its refresh token still works.
- **Ending a session wins over a token refresh in progress.** Sign out, Remove and a Replace import clear the tokens before they revoke them. A refresh that finishes afterwards is not installed, its new refresh token is revoked, and the request that needed it is not sent.
- **A sign-in attempt is completed once.** A second callback for the attempt being completed (the captured redirect and a pasted address) waits for the first, so a code is never exchanged twice. When the attempt was cancelled or replaced while its code was exchanged, the new session is revoked and no access point is created, and a failure of an old attempt never ends a newer one.
- **The sign-in button is a plain text button.** The official ChatGPT logo asset is not bundled.

### Settings page and popup

- **The scan's end date stops one millisecond before the next local midnight.** Thunderbird's `messages.query` includes `toDate`; passing the next midnight included mail from the following day. Calendar arithmetic preserves the selected day across daylight-saving changes.
- **The pages read storage directly and never write it.** Every change is a request to the background page. While a scan or a sign-in runs, the page asks the background for its state once a second.
- **A redraw never overwrites an unsaved edit.** The page is redrawn after every storage change, also while the background writes the log. The prompt editor takes the stored text only while it still shows the text stored before. The cutoff and the forwarded-header labels take the stored value only when they still show what the page put there last, or once the stored value equals the edit (it was saved), and never while they have the focus.
- **The settings page opens after installation**, because protection is off until the user switches it on.
- **"Score selected messages" names the number of messages in its confirmation and scores at most 50 in one run.** Specification section 8.8 sets no limit, but Ctrl+A in a large folder would send all of it, also mail from whitelisted senders, one message after another, without a way to stop. A larger selection is refused before anything is sent.
- **Preset names, sign-in errors and the mistakes a user can make are in `_locales`.** The background reports such a mistake with a code (`ValidationError`), and the pages say it in the user's language. Diagnostic details of failed requests ("HTTP 401: ...", "the answer is not a probability"), of a rejected import file and of invalid stored data stay in English: they are stored in the log and next to the AI service together with the provider's own English text.

### Data and packaging

- **Stored data is checked completely at start**, also every log chunk and every field of its entries, and the log range may span at most the 100 chunks the cap keeps. While the data is invalid, the popup and the log section of the settings page read no further than the status, so the recovery controls stay usable.
- **Writes stay small per message.** A day of the processed set is stored in parts of at most 100 ids (`processed:in:<day>`, then `processed:in:<day>:1` and so on), a decision is logged and its message recorded as processed in one write, and log chunks hold 50 entries. Before, each message rewrote the whole day and a chunk of 250 entries: a catch-up over 5,000 messages wrote about 490 MB, now about 43 MB.
- **Export does not contain** the protection switch, the installation time or secrets. Importing never switches protection on.
- **An account is exported by the address of its default identity**; an account without an identity by its name. When two local accounts share an address, the first one is used.
- **A file with invalid settings is rejected in both import modes**, also in Merge, which reads only the entries. The settings are checked item by item as the settings page checks them, so an invalid address among the forwarding mailboxes rejects the file instead of being dropped silently, and every access point definition must pass the checks of Save, without the key. The endpoint of a provider-bound type is replaced by its fixed one.
- **Imported access points that need a key** are marked as needing attention until the key is entered.
- **Add-on ids** are `block-spam@thunderbird-block-spam` and `block-spam-keys@thunderbird-block-spam`. They can be changed before the first public release; changing an id later starts with empty storage.
- **The license file names "Block Spam contributors"** as the copyright holder. Change it if you prefer your own name.
- **The XPI is written by a small ZIP writer** in `scripts/zip.mjs` with fixed timestamps, so builds are reproducible and need no extra dependency.
- **`@types/node` is a development dependency**, used only to type check the tests. The add-on code is checked without Node types.

### Companion add-on

- **The companion uses Manifest V2 with a persistent background page.** It must hold a key listener for as long as Thunderbird runs. In Manifest V3 that needs persistent-event plumbing inside the Experiment, which cannot be verified without a running Thunderbird. The main add-on is Manifest V3.
- **It listens for `keydown` and `keypress`** in the capture phase of the window and consumes both, so that Thunderbird's own handling of `B` and `W` does not run.
- **It leaves the keys alone** in text fields, in editable documents, in web content, outside mail tabs and while a menu or panel is open.
- **It acts only on trusted key events.** A `keydown` that a script dispatched (`event.isTrusted` false) is ignored, so nothing but a real key press reaches the privileged code's commands.

## Interface

The settings page and the popup were rebuilt after a UX and UI review (`reviews/2026-11-21-ux-ui/`, git-ignored). The binding design decisions are in `reviews/2026-11-21-ux-ui/design.md`. This section records what changed and what was decided on the way. The specification file was not edited: where it says "access point", the interface now says "AI service", and the code keeps the old name.

### Shell and look

- **The settings page follows Thunderbird's own Settings:** a category list on the left with an icon per category, one pane at a time, no boxes around groups, Thunderbird's colors, type sizes and control sizes (`src/common.css`, shared with the popup). The colors are Thunderbird's own values as `light-dark()` pairs, so both themes come from one set of rules.
- **Nine panes with their own addresses:** `#overview`, `#lists`, `#log`, `#learning`, `#incoming`, `#ai`, `#shortcuts`, `#advanced`, `#backup`. The current category carries `aria-current="page"`. Opening a pane moves the focus to its title. The arrow keys walk the category list and keep the focus there, as in Thunderbird's Settings.
- **The icons are original drawings** in the outline style of Thunderbird's category icons. None of Thunderbird's icon files is used.
- **A description is at most two lines** at full width. What is longer sits behind "Learn more" under the same heading.
- **A filled button marks one thing only:** the confirm button of a dialog, Save in an editor, and the next step of setup.
- **Under 760 pixels** the categories become one row that stays at the top, and under 900 pixels a log row is stacked. At 200 percent zoom the page takes that narrow layout.
- **High contrast.** Where the system replaces the colors of the page, the selected category uses the system's selection colors and hover and marks are outlines.

### Overview and first run

- **The Overview opens with one sentence about the add-on,** then the protection switch with its state, a status line, warnings, the three setup steps and observation mode. Setup step 1 starts the scan in place, step 2 opens the AI pane with the add control focused, step 3 is the switch. A finished setup folds to one line.
- **The status line is computed, not stored:** the time of the last check, today's figures from the log (`src/core/stats.ts`) and how many AI services would be asked now.
- **One list of problems** (`src/core/problems.ts`) feeds the warnings of the Overview, the state "On, with problems" and the popup. Every warning has a button that leads to its fix.
- **Switching protection on too early asks first.** With an AI service on and nothing but the user's own addresses on the white list, a dialog offers "Scan first" (the default), "Switch on anyway" and Cancel.
- **A scan that ran to its end counts, also when it found nobody.** A mailbox that has sent nothing yet would otherwise never finish step 1, and the warning and the question about the first scan would never go away. The state of a scan lives in memory, so this holds until Thunderbird is restarted. The popup leaves its setup state as soon as protection is on.
- **Leaving the page with an unsaved prompt asks first** (`beforeunload`): Thunderbird then shows its own question whether to leave the page.

### Lists

- **The kind of an entry is inferred:** a value with "@" is an address, anything else a domain. The Kind menu and its column are gone, and the table shows the list, the scope, the source and the date.
- **A wrong value is said under the field** that holds it, and the field keeps the focus.
- **Removing an entry can be undone** from the confirmation that follows. The background puts back the exact entry (request `restoreEntries`), with its source and date.
- **The scope of new entries** is set in this pane.

### Log and undoing a decision

- **A log entry now holds the Message-ID** of its message (`messageId`, at most 300 characters). Entries written before have none and therefore no action.
- **One button per row** undoes the decision where it is seen (request `logAction`, rules in `src/core/logAction.ts`):
  - "Trust" for Spam, Blocked and for mail without a verdict that was moved: the smart target of the sender goes on the white list (the domain of a company, the address at a public provider), and copies of the message in Junk or a screening folder move to the Inbox.
  - "Block" for Passed, Trusted and Released, and for mail without a verdict that stayed: the smart target goes on the black list and the message moves to Junk. Where a white list entry decides the sender, only the address is blocked, so a trusted domain stays trusted.
  - The entry is a manual one, and older entries of the other list that would still decide the sender are removed, as after a shortcut.
  - When the message is no longer found, the lists change anyway and the row says so.
- **Tests and errors have no action.** A test score is not a decision, and the decision about the same message is in the log next to it. An entry about a failure decided nothing either.
- **An observed decision changes the lists only.** Nothing was moved, so nothing is moved back.
- **A row whose sender already is on the list the button would add to** offers only the move ("Move to Inbox", "Move to Junk"), or says "Trusted now" when there is nothing to move.
- **The row answers in place** with what was changed, also when an older entry of the other list was removed on the way, and an Undo, which restores the lists exactly and moves the message back (request `undoLogAction`).
- **The table has five columns** (time, sender with subject and account, decision with its reason, score, action). The seven columns of the first version do not fit the 800 pixel column of the Settings look.
- **The Refresh button is gone.** The page redraws when the log changes.

### Popup and context menu

- **The popup blocks and trusts.** With messages selected it shows the sender, "Block sender" and "Trust sender" with their shortcuts, and the whole-domain variant. They run the four commands of the shortcuts (request `runCommand`), and the popup says what was added.
- **The popup shows the state of the Overview,** counts the problems and leads to them. Until setup is finished it shows "Setup is not finished" with "Open setup" instead of the switch. The state stands under the name, because a state such as "Włączona, tylko obserwacja" does not fit next to it.
- **Only the list of the last decisions scrolls** when the popup would be taller than the 600 pixels Thunderbird shows. The state, the buttons for the selected message and the footer stay in place.
- **A row of the last decisions opens that entry in the log.** `runtime.openOptionsPage()` loads an open settings tab anew when the address differs, which would drop text typed there. The popup therefore activates the open tab (`tabs.update`) and hands the target to the page through the background (requests `showInSettings` and `takeSettingsTarget`, kept for 30 seconds).
- **Context menu of the message list:** a "Block Spam" submenu with the four commands (`menus` API). This added the permission `menus` to the manifest. Thunderbird 153.7.0 shows no line for it in the installation prompt.

### AI

- **"AI service" is the word in the interface** for what the specification and the code call an access point.
- **Presets are grouped** (decision models, chat models, the ChatGPT plan, on this computer), the chosen one is described in a line, and a link leads to the page for a key or to the documentation. Only addresses that are certain are linked. Links open in the default browser.
- **The editor opens in the row it edits,** a new service as a new row. "Load models" works before the first save: it runs the consent and permission step of Save and asks for the models of the unsaved definition (request `listModelsFor`). After Save the service is tested once.
- **A sign-in in progress is a row of the list** as well: in the row it signs in again, or as a new row (`SignInStatus.accessPointId`).
- **A service that needs attention says the remedy** (a rejected key, a missing key, a missing permission, a missing sign-in, a refused plan). A failure that neither paused the service nor needs the user says that the request is simply tried again.
- **A test result is dropped once the service changed after it,** for example a "works" from before the key was rejected.
- **The note about local servers** appears only in the editor of a service on this computer, with a button that copies the add-on's origin.
- **The cutoff saves when the field is left.** The prompt has Save, which is available only after a change, "Discard changes" and "Restore default", which only fills the field.

### Language

- **Polish is complete** (`src/_locales/pl`), with the words Thunderbird itself uses. A test keeps the keys and placeholders of every locale equal to English.
- **Counts have plural forms** (`tn` in `src/tb/i18n.ts`): "_one", "_few" and "_many" per counted string, chosen by the plural rules of the language the strings are in. Each locale names its language in `localeCode`, so a Thunderbird in a language without a translation counts and writes numbers the English way together with the English strings.
- **Numbers and scores follow the language of the strings** (0.97, in Polish 0,97). Dates and times follow Thunderbird's regional settings, like the rest of Thunderbird.
- **Folders are shown by the name Thunderbird shows** (Odebrane, Wysłane), with the path as a tooltip.
- **On macOS shortcuts are written with the key symbols** (⌥B), elsewhere as Alt+B.
- **A Polish line never ends with a one-letter word** (a, i, o, u, w, z). `t()` ties such a word to the next one with a no-break space, so the locale file stays plain text.
- **The date fields of the scan are Thunderbird's own control.** They speak Thunderbird's language, not the add-on's. The file chooser is a button of the page, so its words come from the locale file.

### Accessibility

- **Every control has a name,** and buttons that repeat name their row ("Remove example.com", "Trust leadgen-pro.test and move the message back to the Inbox"). Each pane has one title, dialogs are labelled by theirs, errors are alerts and confirmations are status messages.
- **The focus is always visible** and goes where the work goes: into an opened editor or dialog, back to the button that opened it, to the title of a pane, to the entry the popup pointed at.
- **A redraw does not disturb.** Lists are redrawn row by row (`reconcile` in `src/options/dom.ts`), and only rows that changed are rebuilt, so the focus, a half-typed value and a pending choice in a menu survive the redraw that follows every storage change.
- **Motion** is switched off where the system asks for reduced motion.
- **Dialog buttons follow the platform:** the confirming button comes first on Windows and last on macOS and Linux, as in Thunderbird's own dialogs. Only the macOS order was seen rendered.

### Smaller decisions

- The buttons that move and remove an AI service are icon buttons in the row, not a "More" menu: one click instead of two, and no menu to build that Thunderbird's Settings do not have either.
- The remove buttons of tables are always visible, quiet icons. Shown only on hover they would not exist for touch and would jump for keyboard users.
- The companion for bare keys has no download link, because the project has no public page yet. The Shortcuts pane names its file and how to install it.
- The browser harness (`npm run harness`) was run again with the rebuilt pages: the scan, the panes and the popup work against the fake API.

## Known limits

- Moments are compared by whole seconds, the precision of mail Date and Received headers. A message from the very second protection was switched on is handled, which can include one that arrived a fraction of a second before the switch. The practical test had shown that with millisecond precision such a message was skipped by both the event and the tick.
- A message that exists in two monitored folders of one account (the same Message-ID, author and date) is handled once.
- A sender's display name is not used anywhere, also not for the AI.
- For a forwarding mailbox the forwarder's labelled body line is read before the From of an attached message (review finding S5). The specification first ordered them the other way round. An inline forward carries the original's attachments, and the practical test reproduced an attached message from a trusted address deciding the sender and bypassing the AI. The new order is safe because in Thunderbird 153.7.0 `messages.listInlineTextParts` returned only the outer body for a message with an attached `message/rfc822`, so an attached message cannot plant a labelled line (checklist B7). Remaining limit: when a forwarding mailbox writes its header block with a label that is not in the label table, the first labelled line of the text can come from the original sender. The label of each forwarding mailbox belongs in the table under Forwarding mailboxes.
- The tick finds mail by its `Date` header, which the sender writes. Mail dated more than 48 hours before the previous tick, or before protection was switched on, is handled only by the fast path, which looks at the arrival time in the newest `Received` header. If the new mail event does not fire for such a message, it is not handled.
- The companion suppresses `B` and `W` also when the main add-on is disabled. Remove or disable the companion in that case.
