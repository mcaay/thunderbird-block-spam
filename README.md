# Block Spam for Thunderbird

A Thunderbird add-on that filters spam with two local lists and asks an AI only about mail from senders you have never written to.

## Problem

I've been getting more and more spam, especially in the form of "cold emails", which basically means unwanted offers.
Companies are learning to use AI to help them send more spam like this.
This results in more and more spam coming in.
It will only keep getting worse.

I have the technical possibility to connect AI to scan my emails and get rid of spam for me, but I don't want to let AI into my email accounts. Not only that - formally I can't even do this in my company account, because I get confidential emails from customers.


## Solution

The following solution solves this problem completely without letting the AI read confidential emails, as long as you agree with the following statement:

*"If it's the 1st time a private person or a company is messaging me, I don't accept that it can be confidential."*

If yes, you are free to use AI.
If not, you may still benefit from this plugin without the AI, but it will only solve the problem partially.

![[IDEA.png]]

This diagram is an obsidian canvas: [[IDEA.canvas]]

The rule everything else follows from: **the AI is consulted only when the sender is on neither list. The add-on never sends mail from a whitelisted sender anywhere on its own.**


## How it works

- **WHITE LIST.** Everyone you write to goes on the white list: the whole domain for a company (`betis.eu`), the single address at a public mail provider (`someone@gmail.com`). The list is learned from your sent mail, without AI.
- **BLACK LIST.** Senders you block, and senders the AI scored as spam. Their mail goes to the account's Spam folder.
- The folder that Thunderbird 153 calls **Spam** in English (Niechciane in Polish, Junk in older versions) is the one meant by "the Spam folder" here and in the add-on.
- **Unknown senders** (on neither list) are scored by the AI. A score above the cutoff blacklists the sender and moves the message to the Spam folder. Any other score leaves the message alone, and nothing is remembered about the sender.
- An address entry always beats a domain entry: a blocked newsletter address stays blocked inside a trusted company domain, and a trusted person passes inside a blocked domain.

Nothing is ever deleted. Every failure leaves mail where it is.


## Features

- White list and black list with addresses and domains, shared by all email accounts by default. You can switch to separate lists per account, or use both shared and per-account entries.
- White list learning from sent mail:
	- when you send a message from Thunderbird,
	- by watching the `sent` folders, which also catches mail sent from a phone or from webmail,
	- with a button that scans the entire `sent` folder to prefill the WHITE LIST in one go (without using AI). This pretty much guarantees that AI will never read confidential emails from your customers. You can limit the scan with a `start date` and an `end date`.
	- the correct `sent` folders are chosen automatically, and you can add or remove folders (e.g. if you have rules that split sent emails into different folders).
- Incoming mail is checked when it arrives, at startup and every 5 minutes, also when it was read on another device first.
- Block and trust a sender in one step, see [Block and trust](#block-and-trust):
	- with the buttons of the toolbar popup, for the selected messages,
	- with the "Block Spam" entry in the context menu of the message list,
	- with keyboard shortcuts (`Alt` + `B`, `Alt` + `W`, with `Shift` for the whole domain),
	- from the log, where every decision has a button that undoes it.
- Forwarded mail and copies are judged by their original sender, never by the mailbox that forwarded them.
- Use your AI subscriptions or use AI via API, see [AI services](#ai-services).
- Use AI decision models instead of LLMs. They are much cheaper and faster, and they can return nothing but a score.
- AI returns only a probability value that the email is spam, nothing else - the value is between 0.00 and 1.00 (always only 2 decimal digits).
- You can modify the cutoff point - by default the cutoff is 0.85, meaning any probability above this value will classify the email as spam.
- Connect multiple AI subscriptions or keys as fallback (when your limits run out on the main one, the next one keeps AI functioning).
- An editable prompt, with a button that restores the default.
- **Observation mode:** decisions are computed and logged, but no message is moved and the AI adds nothing to the black list. The recommended way to try a model, a prompt or a cutoff before trusting them.
- A log of the last 5000 decisions, with a filter and a search by sender or subject. Each decision can be undone in its row: "Trust domain" or "Trust address" puts the sender on the white list and moves the message back to the Inbox, "Block domain" or "Block address" does the opposite, and "Show message" opens the message itself. Message bodies are never stored.
- "Test AI on selected messages" in the toolbar popup, to tune the prompt and the cutoff on real mail: up to 50 messages at a time, after a confirmation that says how many.
- Export and import of the lists, the settings and the AI services (without keys), to move to another computer.
- A settings page that looks and works like Thunderbird's own Settings, in the light and the dark theme, in English and in Polish.


## Extra features for non AI usage

- create an extra folder on your email accounts and select it as the "screening folder" - this folder acts as something between `inbox` and `spam` - if sender is not on the white list and not on the black list, and no AI is used, put the email to this folder
    - this is so that `spam` always means "useless junk", and e.g. `screener` means "maybe junk, maybe not"
    - when a sender is added to the white list, their messages move from the screening folder to the Inbox


## Settings

- if no AI service is set up, or all of them failed or ran out, and the sender is not on the white list and not on the black list, where to put the email?
    - default: leave it in the `inbox`
    - `spam`
    - the screening folder (the folder of each account is chosen right under this option, and only while it is chosen)
- cutoff point - probability score above which the email will be classified as spam by AI
- whether new entries are shared by all accounts or kept per account
- public domains: the list of mail providers where each address is a different person. A list is built in, and you can add or remove domains.
- forwarding mailboxes, see [Forwarded mail](#forwarded-mail)


## Install

Requires Thunderbird 153 or newer.

1. Build the add-on (see [Build](#build)) or take `block-spam-<version>.xpi` from a release.
2. In Thunderbird open Add-ons and Themes, click the gear menu and choose "Install Add-on From File".
3. The settings page opens. Protection is off after installation.

### First steps

The Overview of the settings page lists three steps, each with its button. Until the first one is done, the toolbar popup says "Setup is not finished" and leads there.

1. **Scan your sent mail.** The button starts the scan in place and shows its progress. This puts the people you already write to on the white list. The step is done when the scan has ended.
2. **Optional: add an AI service.** The button opens the AI pane on the list of services to choose from.
3. **Switch protection on.** Mail that arrived before protection was switched on is never touched. If an AI service is on, or mail without an AI verdict is set to be moved, before the scan was run or while a scan is still running, Block Spam asks first and offers to scan or to wait: until the scan, the people you already write to count as unknown senders, so their mail would be sent to the AI service or moved. The same question is asked when you choose to move mail without an AI verdict while protection is on already; that choice then waits for the scan as well. Choose that and you can leave: protection switches on by itself when the scan has finished, also when the settings page is closed by then, and a note under the switch lets you call it off. If the scan is cancelled or fails, the page says that protection was not switched on and why.

Consider ticking **observation mode**, the option right under the protection switch, first and watching the log for a few days. It can be ticked before protection is on.

The state of protection is shown in the same words everywhere: under the name of the add-on on every pane of the settings page (a click on it opens the Overview), in the popup, and as the tooltip of the Block Spam button in the toolbar. It is one of: Off, "Switches on after the scan", On, "On, observing only", "On, 2 problems", "No mail account", "Data problem". Once protection is on, the Overview also shows the time of the last check, today's figures and whether the AI services work. When something needs you (a rejected key, accounts without a Spam folder), there is one warning per cause, each with a button that leads to the fix; accounts or services that share a cause are named together. You do not have to open anything to notice: the Block Spam button in the toolbar gets a badge and its tooltip counts and names the problems (its label stays "Block Spam"), and a desktop notification tells you once when an AI service first needs attention.

The settings page opens from the toolbar popup (Settings), or from Add-ons and Themes.


## Block and trust

All of these do the same two things: put the sender on a list and move the message (Block to the Spam folder, Trust back to the Inbox from the Spam folder or from a screening folder).

- **Toolbar popup.** Select one or more messages and click the Block Spam button in the toolbar. For one message the popup says which list entry decides its sender and what Block Spam decided about the message, with "Block address" and "Trust address" and a quieter pair for the whole domain. Afterwards it says what was added and offers Undo.
- **Context menu.** Right-click a message in the message list and choose Block Spam.
- **Keyboard shortcuts:**
	- `Alt` + `B` ⮕ add the address to the BLACK LIST and move the message to the Spam folder
	- `Alt` + `Shift` + `B` ⮕ add the domain to the BLACK LIST and move the message to the Spam folder
	- `Alt` + `W` ⮕ add the address to the WHITE LIST and move the message back to the Inbox
	- `Alt` + `Shift` + `W` ⮕ add the domain to the WHITE LIST and move the message back to the Inbox
	- On macOS `Alt` is the Option key, and the settings page shows the keys as `⌥B` and so on. All four can be changed in Thunderbird under "Manage Extension Shortcuts".
	- The bare keys `B` and `W` need the optional companion add-on, see [Bare keys B and W](#bare-keys-b-and-w).
- **Log.** Settings, Log lists every decision. The button in a row undoes that decision, and the row offers Undo for the button itself. A click on one of the last decisions in the popup opens that entry in the log.

**Undo.** Every block or trust made by hand can be taken back: the popup shows the last command at its top with Undo, also when the command was made with a shortcut or from the context menu, until it is undone, dismissed or replaced by the next one. Undo restores the lists exactly and moves the messages back.

The pane Settings, Block and trust lists all of these ways with the current shortcuts.

With the **Smart** setting (on by default) the whole-domain variants handle a company as a whole domain and a sender at a public provider by address.


## AI services

The settings page calls a connection to an AI an "AI service" (the specification and the code say "access point"). Settings, AI lists them. To add one, choose it from the grouped menu: the line under the menu says what it is and links to the page where you get a key, or to its documentation.

AI services are tried from top to bottom and the first valid score is final. When one fails, the next one is tried. When one runs out of quota it is skipped for a while, which is how a second subscription or key takes over.

| Type | Use it for |
|---|---|
| Decision model (System One) | Jev (TypeSafe), Cloudflare Clef, OpenRouter Decisions, local basal and Bielik-One |
| OpenAI Decisions | `gpt-6-luna` with an OpenAI API key |
| Chat model (OpenAI-compatible) | OpenAI, Gemini, OpenRouter, Ollama, LM Studio, any custom URL |
| Claude (Anthropic) | Claude with an API key |
| ChatGPT plan | ChatGPT Plus, Pro and Business, by signing in |

Addresses must use `https`. Only `localhost` and `127.0.0.1` may use `http`. "Load models" in the editor lists the models of a chat service, also before the first save. Each service has a Test button that scores a built-in sample email, and a new service is tested once when it is saved. A service that stopped working says in its row what to do about it.

### Use your AI subscriptions

- **ChatGPT Plus, Pro, Business:** choose "ChatGPT plan" and continue with ChatGPT. This is OpenAI's official plan usage for open-source local apps. You sign in on OpenAI's page, no API key is involved, and the requests count against your ChatGPT plan. You can review and limit the usage in [ChatGPT settings](https://chatgpt.com/settings/usage). If the sign-in tab does not finish by itself, open the sign-in address in any browser and paste the address you were redirected to into the settings page.
- **Claude Max, Ultra and Team** include monthly API credits (Max 100 USD, Ultra 200 USD, Team per seat). In Claude, under Settings, Billing, link a Claude Console organization, create an API key in it and add a "Claude (Anthropic)" service. See [Monthly API credits](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans).
- **Claude on plan limits, including Pro:** only the official Claude Code program may draw on plan limits, and Block Spam never handles Claude sign-in tokens. You can run a local bridge yourself that wraps your signed-in `claude` program behind an OpenAI-compatible URL, for example [claude-code-openai-wrapper](https://github.com/RichardAtCT/claude-code-openai-wrapper), and add it as a "Custom" service. That setup is yours and Anthropic's terms for Claude Code apply to it.
- **Google:** create an AI Studio API key and use the Gemini preset. Google does not permit third-party use of its consumer plans.

### Decision models and LLMs

A decision model can answer with nothing but a probability, so the content of an email cannot make it do anything else. It is not immune to manipulation of that score: an email can still be written to look harmless. The worst outcome is one wrong score: a spam message that stays in the Inbox, or a legitimate sender that you restore with a trust shortcut. The same is true for LLMs here, because the add-on accepts only a number from them as well.

Decision models are much cheaper and faster, but less accurate. In the only benchmark found ([Polish and English](https://basal.si5.pl/benchmark/), published by the author of basal) decision models reached 62 to 85 percent accuracy and LLMs 98 to 99 percent. Use observation mode first.

### Local servers

Local servers reject requests from add-ons unless told otherwise. The editor of a service on this computer shows the add-on's origin (`moz-extension://...`) with a button that copies it.

- **Ollama:** start it with `OLLAMA_ORIGINS` set to that origin, or to `moz-extension://*`.
- **basal:** pass the origin to `basal-serve` with `--cors-origins`.
- **Other servers and bridges:** allow that origin in their CORS setting.

### What the AI receives

Only this, and only for senders on neither list (plus messages you score yourself as a test):

```
From: <sender>
Reply-To: <if present>
To: <recipients>
Subject: <subject>
Date: <date>

<plain-text body, first 20,000 characters>
```

Attachments, remote content, other headers, other messages and the lists are never sent.


## Forwarded mail

Spam that reaches you through another mailbox's automatic forwarding or copy rule is treated exactly like spam sent directly.

- If a forwarded message shows the **original author** as its sender (alias, server redirect, copy rule, Gmail forwarding), nothing needs to be configured.
- If it shows **the mailbox that forwarded it** (for example an Outlook or Exchange "Forward" rule, or Google Groups), add that mailbox once under Settings, Advanced, Forwarding mailboxes. Block Spam then finds the original sender in the message and never passes on the forwarding mailbox's own trust.


## Bare keys B and W

Thunderbird lets an add-on capture keys without a modifier only through an Experiment API, and every add-on that contains an Experiment must ask for full access to Thunderbird and your computer. Block Spam never does.

If you accept that permission, install the separate companion add-on `block-spam-keys-<version>.xpi` (Add-ons and Themes, gear menu, "Install Add-on From File"). The file is packaged inside Block Spam: the pane Settings, Block and trust has the button "Save the companion add-on file…" next to these steps. A build also writes it to `dist/`. It contains only the key capture: `B`, `Shift` + `B`, `W` and `Shift` + `W` in mail windows, never in text fields. See [companion/README.md](companion/README.md). It is best effort: Thunderbird plans to stop running Experiments on the Release channel from the 2027 ESR.


## Privacy and permissions

- What leaves the computer: the text shown under [What the AI receives](#what-the-ai-receives), only to AI services you added, only for unknown senders, plus messages you explicitly score as a test. There is no telemetry and no other network request.
- Lists, settings and the log are stored locally in the Thunderbird profile. API keys and sign-in tokens are stored there unencrypted. They are never written to the log and never exported.
- Required permissions: see your accounts and folders, read messages, move messages, the compose window (to learn recipients when you send), storage, alarms, notifications, and the context menu entry.
- Optional permissions, asked for when a feature is first used: creating a screening folder, the host of each AI service, and reading the sign-in redirect for the ChatGPT plan.
- The add-on does not check SPF, DKIM or DMARC, does not look at attachments, does not set Thunderbird's junk flag and does not process mail that arrived before protection was switched on.


## Build

Requires Node.js 20 or newer.

```bash
npm ci
```

```bash
npm run check
```

`npm run check` runs the type check, the unit tests and the build. The build writes:

- `dist/block-spam-<version>.xpi`, the add-on
- `dist/block-spam-keys-<version>.xpi`, the optional companion for bare keys

The code is TypeScript bundled with esbuild, with one runtime dependency (`tldts`, for the Public Suffix List). Third-party licenses are listed in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

More documentation:

- [Design specification](docs/specs/2026-11-21-thunderbird-block-spam-design.md)
- [Implementation notes](docs/implementation-notes.md)
- [Manual test checklist](docs/manual-test-checklist.md)


## License

MIT, see [LICENSE](LICENSE).
