# Implementation notes

Decisions made while implementing `docs/specs/2026-11-21-thunderbird-block-spam-design.md`, and places where the official documentation led to something different from the specification. Nothing here was verified in a running Thunderbird; see `docs/manual-test-checklist.md` for what is pending.

## Documentation checked

Checked on 2026-11-21 against the references of the specification:

- Thunderbird WebExtension API, Manifest V3 (webextension-api.thunderbird.net): messages, compose, folders, commands, messengerUtilities, accounts, identities, mailTabs, messageDisplay, tabs, windows, permissions, webRequest, alarms, notifications, the Manifest V3 and Experiments guides.
- ATN review policy (thunderbird.github.io/atn-review-policy).
- TypeSafe System One, OpenAI Decisions, Cloudflare Clef, OpenRouter Decisions, basal (README, docs/API.md, docs/SERVING.md).
- OpenAI "Sign in with ChatGPT" plan usage for open-source apps: overview, sign-in, accounts and sessions, token reference, models and inference, errors and recovery, preview limitations, UI/UX guidelines.
- Anthropic Messages API, errors, authentication, effort, stop reasons, API versions.
- Ollama FAQ (OLLAMA_ORIGINS), Gemini OpenAI compatibility, OpenAI model pages, OpenRouter model list.

The Thunderbird "Experiment plan" thread on Topicbox could not be read without a browser session; the statement about the 2027 ESR is taken from the specification.

## Where the documentation changed the design

1. **Headers come from `messages.getHeaders`** (added in Thunderbird 147), not from `messages.getFull`. It returns all headers without parsing the MIME structure, which is what the wrapped-forward check (`X-Original-From`, `X-Original-Sender`) and the `Reply-To` line of the AI payload need.
2. **Live send uses `sendInfo.details`** of `compose.onAfterSend` (added in Thunderbird 147). The compose window may already be gone when the event fires, so the recipients are read from the event itself.
3. **Folders are stored as account id plus path.** The documentation guarantees a folder id only "throughout a session", so settings never store folder ids. Folders are looked up by account and path on each run.
4. **ChatGPT sign-in sends more than the specification lists.** The official flow also requires a `nonce`, validation of the ID token (signature against the published JWKS, issuer, audience, expiry, nonce) and a check that the granted scopes contain `chatgpt.tokens.use.direct`. All three are implemented. The ID token is verified with WebCrypto (RS256 and ES256), because the add-on bundles no JWT library.
5. **ChatGPT requests omit unsupported fields.** The preview limitations reject `max_output_tokens`, `temperature`, `metadata` and others, so the request contains only `model`, `instructions`, `input`, `store: false` and `stream: true`.
6. **ChatGPT error codes.** `subscription_sharing_usage_limit_exceeded` is a quota error as specified. In addition `subscription_sharing_usage_unavailable` and `subscription_sharing_user_unavailable` are temporary failures, and `subscription_sharing_user_not_eligible`, `subscription_sharing_invalid_user`, `subscription_sharing_route_not_supported` and `chatpass_v2_*` mark the access point as needing attention.
7. **Signing out revokes the session** at the `revocation_endpoint` of the discovery document, as the documentation asks. Removing a ChatGPT access point does the same.
8. **Thunderbird shows no data collection prompt of its own.** Its documentation says add-ons must ask for consent themselves. The manifest declares `personalCommunications` and `personallyIdentifyingInfo` as optional data collection permissions, and the settings page asks for explicit consent, naming Block Spam, before the first access point of a host is added. The same click requests the host permission and the data collection permission.
9. **Anthropic API version `2026-10-21`** is sent, the current version. The request sets `output_config.effort` to `low` (classification) and checks `stop_reason` before reading the answer. Models older than Claude Opus 4.5 reject the effort parameter.
10. **Decision model details.** OpenRouter and OpenAI can answer a question with `type: "refusal"`; both are treated as a failure of the access point. The local basal server needs no `model` field, so it is sent only when set.

## Decisions where the specification was open

### Lists and learning

- **Private suffixes count.** Registrable domains use both sections of the Public Suffix List, so `someone.github.io` is its own domain and a whole hosting platform is never whitelisted or blocked as one company.
- **A shortcut always takes effect.** After a block or trust command, an older entry of the other list that would still decide that sender (for example a blocked address inside a domain that is now trusted) is removed. Without this the shortcut would appear to do nothing.
- **AI never replaces a list entry.** If the lists change while a message is being scored, the list entry wins over the score.
- **The public domain list** is seeded from `free-email-domains` 1.2.21 (MIT), the last small, curated version of that package (4,779 providers, based on HubSpot's list), plus appendix A. Later versions of the package mix in tens of thousands of disposable and unrelated domains, some of them real company domains, which would weaken domain-level whitelisting.
- **The forwarded-header label table** (`From:`, `Od:`, `Nadawca:`) is a setting, editable next to the forwarding mailboxes.

### Incoming mail

- **The fast path handles the messages of the event itself** and skips mail dated before protection was switched on. The tick uses the date query of the specification. Both use the same per-message handler and the same processed set.
- **A processed record of a message dated in the future** is filed under the message's date instead of today, so it cannot expire while the message would still be returned by the date query.
- **Buckets are pruned after a completed tick**, never before one.
- **An unexpected failure while handling a message** is logged and the message is marked as processed, like a failed move. It is not retried.
- **The screening sweep** checks every message in the screening folders against the lists and moves white list matches to the Inbox. It runs after each change that adds a white list entry and is logged with the outcome `released`.

### AI

- **Default models:** `jev-latest` (Jev), `~typesafe/jev-latest` (OpenRouter Decisions), `clef` (Cloudflare), `gpt-6-luna` (OpenAI Decisions, OpenAI chat), `gemini-4-hydrogen` (Gemini), `openai/gpt-6-luna` (OpenRouter chat), `qwen3:8b` (Ollama), `claude-opus-5-5` (Anthropic). LM Studio, the local decision model and Custom start with an empty model. Chat access points have a "Load models" button that reads `GET <base>/models`.
- **Anthropic default model.** `claude-opus-5-5` is the current default recommended by Anthropic's own guidance. `claude-haiku-5-5` is much cheaper and can be typed into the model field.
- **HTTP 402** (payment required) is treated like HTTP 429: a quota error with a cool-down.
- **A successful Test** clears "needs attention" and the cool-down, like saving the access point does.
- **Loopback** means `localhost` and `127.0.0.1`. IPv6 loopback is not offered, because its match pattern could not be verified.
- **The reply of an LLM is parsed strictly**, as specified. A model that wraps its answer in reasoning tags fails and the next access point is tried.
- **Server-side refusal fallbacks of the Anthropic API are not used.** The chain of access points is the fallback mechanism of this design, and a beta parameter that not every model accepts would break user-chosen models.

### ChatGPT sign-in

- **Tokens are stored in `storage.local`**, unencrypted, as the specification states. OpenAI's documentation recommends protected storage and warns against browser storage; a MailExtension without native messaging has no other persistent storage. The settings page says so.
- **Each ChatGPT access point is one registration** with its own issued client id. Adding another ChatGPT access point registers a new client; signing in again on an existing one reuses its client id and sends `id_token_hint` and `login_hint`.
- **The redirect port is always 1455.** Nothing listens on it; the add-on reads the address of the navigation.
- **The sign-in button is a plain text button** labelled "Continue with ChatGPT". The official logo asset is not bundled.

### Data and packaging

- **Export does not contain** the protection switch, the installation time or secrets. Importing never switches protection on.
- **An account is exported by the address of its default identity**; an account without an identity by its name.
- **Imported access points that need a key** are marked as needing attention until the key is entered.
- **Add-on ids** are `block-spam@thunderbird-block-spam` and `block-spam-keys@thunderbird-block-spam`. They can be changed before the first public release; changing an id later starts with empty storage.
- **The XPI is written by a small ZIP writer** in `scripts/zip.mjs` with fixed timestamps, so builds are reproducible and need no extra dependency.

### Companion add-on

- **The companion uses Manifest V2 with a persistent background page.** It must hold a key listener for as long as Thunderbird runs. In Manifest V3 that needs persistent-event plumbing inside the Experiment, which cannot be verified without a running Thunderbird. The main add-on is Manifest V3.
