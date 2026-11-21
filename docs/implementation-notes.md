# Implementation notes

Decisions made while implementing `docs/specs/2026-11-21-thunderbird-block-spam-design.md`, and places where the official documentation led to something different from the specification.

## What was and was not verified

- **Verified by tests:** all of `src/core` and `src/ai` with fake mail and HTTP layers, the companion's key logic in a sandbox, and repository rules (strings, manifest, layering). Run `npm run check`.
- **Verified in a browser:** the built background page and settings page were run together in a Chromium browser against a fake of the Thunderbird API, including a scan, new mail, shortcuts, an access point with consent, and a complete ChatGPT sign-in against a fake OpenAI (code exchange, ID token signature check with WebCrypto, model list, streamed score). `npm run harness` builds that setup in `dist/harness`; the comment at the top of `scripts/harness.mjs` says how to open it.
- **Not verified:** anything in a real Thunderbird, with a real mailbox or with a real AI service. Every such check is listed in `docs/manual-test-checklist.md`.
- **Build step 1** (the ChatGPT sign-in prototype against a real account, the decision gate of specification section 8.6) was not run. The flow is implemented from OpenAI's documentation, including the paste-the-address fallback.

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
7. **Signing out revokes the session** at the `revocation_endpoint` of the discovery document, as the documentation asks. Removing a ChatGPT access point and a Replace import do the same.
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
- **AI never replaces a list entry.** If the lists change while a message is being scored, the list entry wins over the score.
- **A domain added by hand is stored as its registrable domain** (`mail.example.com` becomes `example.com`), because that is what senders are matched by.
- **The public domain list** is seeded from `free-email-domains` 1.2.21 (MIT), the last small, curated version of that package (4,779 providers, based on HubSpot's list), plus appendix A. Later versions of the package mix in tens of thousands of disposable and unrelated domains, some of them real company domains. Treating a company domain as public would weaken domain-level whitelisting, and with it the promise that mail from a customer's colleagues is not sent to the AI.
- **The forwarded-header label table** (`From:`, `Od:`, `Nadawca:`) is a setting, editable next to the forwarding mailboxes.
- **A forwarding mailbox is never the effective sender.** If a header or the body names a forwarding mailbox as the original sender, the next source is tried.

### Incoming mail

- **The fast path handles the messages of the event itself** and skips mail that arrived before protection was switched on. The Date header is written by the sender, so for a message dated before that moment the time in its newest `Received` header, written by the receiving server, decides. The tick uses the date query of the specification. Both use the same per-message handler and the same processed set.
- **A processed record of a message dated in the future** is filed under the message's date instead of today, so it cannot expire while the message would still be returned by the date query.
- **Buckets are pruned after a completed tick**, never before one.
- **An unexpected failure while handling a message** is logged and the message is marked as processed, like a failed move. It is not retried.
- **The screening sweep** checks every message in the screening folders against the lists and moves white list matches to the Inbox. It runs after each change that adds a white list entry and is logged with the outcome `released`.
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
- **The reply of an LLM is parsed strictly**, as specified. A model that wraps its answer in reasoning tags fails and the next access point is tried.
- **Server-side refusal fallbacks of the Anthropic API are not used.** The chain of access points is the fallback mechanism of this design, and a beta parameter that not every model accepts would break user-chosen models.
- **The Anthropic adapter uses plain HTTP**, not the Anthropic SDK, because the specification allows one runtime dependency.
- **The type of an access point cannot be changed after it was added.** Remove it and add a new one.

### ChatGPT sign-in

- **Tokens are stored in `storage.local`**, unencrypted, as the specification states. OpenAI's documentation recommends protected storage and warns against browser storage; a MailExtension without native messaging has no other persistent storage. The settings page says so.
- **Each ChatGPT access point is one registration** with its own issued client id. Adding another ChatGPT access point registers a new client; signing in again on an existing one reuses its client id and sends `id_token_hint` and `login_hint`.
- **The redirect port is always 1455.** Nothing listens on it; the add-on reads the address of the navigation.
- **A started sign-in is kept for 15 minutes** in storage, so it survives a restart of the background page. The background page is kept awake while a sign-in is pending.
- **The sign-in button is a plain text button.** The official ChatGPT logo asset is not bundled.

### Settings page and popup

- **The pages read storage directly and never write it.** Every change is a request to the background page. While a scan or a sign-in runs, the page asks the background for its state once a second.
- **The settings page opens after installation**, because protection is off until the user switches it on.
- **Preset names and sign-in errors are in `_locales`.** Diagnostic details of failed requests ("HTTP 401: ...", "the answer is not a probability") and of invalid data stay in English: they are stored in the log and next to the access point together with the provider's own English text.

### Data and packaging

- **Export does not contain** the protection switch, the installation time or secrets. Importing never switches protection on.
- **An account is exported by the address of its default identity**; an account without an identity by its name. When two local accounts share an address, the first one is used.
- **A file with invalid settings is rejected in both import modes**, also in Merge, which reads only the entries.
- **Imported access points that need a key** are marked as needing attention until the key is entered.
- **Add-on ids** are `block-spam@thunderbird-block-spam` and `block-spam-keys@thunderbird-block-spam`. They can be changed before the first public release; changing an id later starts with empty storage.
- **The license file names "Block Spam contributors"** as the copyright holder. Change it if you prefer your own name.
- **The XPI is written by a small ZIP writer** in `scripts/zip.mjs` with fixed timestamps, so builds are reproducible and need no extra dependency.
- **`@types/node` is a development dependency**, used only to type check the tests. The add-on code is checked without Node types.

### Companion add-on

- **The companion uses Manifest V2 with a persistent background page.** It must hold a key listener for as long as Thunderbird runs. In Manifest V3 that needs persistent-event plumbing inside the Experiment, which cannot be verified without a running Thunderbird. The main add-on is Manifest V3.
- **It listens for `keydown` and `keypress`** in the capture phase of the window and consumes both, so that Thunderbird's own handling of `B` and `W` does not run.
- **It leaves the keys alone** in text fields, in editable documents, in web content, outside mail tabs and while a menu or panel is open.

## Known limits

- A message that exists in two monitored folders of one account (the same Message-ID) is handled once.
- A sender's display name is not used anywhere, also not for the AI.
- The tick finds mail by its `Date` header, which the sender writes. Mail dated more than 48 hours before the previous tick, or before protection was switched on, is handled only by the fast path, which looks at the arrival time in the newest `Received` header. If the new mail event does not fire for such a message, it is not handled.
- The companion suppresses `B` and `W` also when the main add-on is disabled. Remove or disable the companion in that case.
