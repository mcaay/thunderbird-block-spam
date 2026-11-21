# Manual test checklist

Practical testing was performed on 2026-11-21 in Thunderbird 153.7.0 on macOS, using isolated profiles and loopback IMAP, SMTP and mock AI servers. Results, evidence, fixes and remaining checks are in `reviews/2026-11-21-practical-test/report.md` (git-ignored). The checkboxes below remain a reusable checklist, not a statement that every environment or real service has passed.

Use a separate Thunderbird profile and a test IMAP account. Build with `npm run check`, then install `dist/block-spam-<version>.xpi` (Add-ons and Themes, gear menu, Install Add-on From File). Keep the Error Console open (Tools, Developer Tools, Error Console) and note every message that starts with "Block Spam".

Legend: each item has the steps, what should happen, and what to do when it does not.

## A. Checks against real services (specification section 15)

### A1. ChatGPT sign-in redirect can be captured

Pending. This is also the decision gate of specification section 8.6: the sign-in prototype against a real account was not run.

1. Settings, AI, choose "ChatGPT plan", Add. Confirm the consent dialog and the permission prompt.
2. A Thunderbird tab opens `auth.openai.com`. Sign in and approve.
3. Expected: the tab closes by itself, a "ChatGPT plan" access point appears with your email address, "Using ChatGPT plan" and a model. The welcome message "You're using your ChatGPT plan" appears once.
4. Press Test on the access point. Expected: a score.

Also check:

- [ ] The permission prompt appears and lists `auth.openai.com`, `api.openai.com` and `127.0.0.1`.
- [ ] Thunderbird accepts `webRequest` as an optional permission. Its documentation does not list it among optional permissions, the shared toolkit schema does. If it is refused, the page may ask you to press the button again, and the sign-in panel then says to paste the address. Record this.
- [ ] The OpenAI page works inside a Thunderbird tab (no blocked page, no endless bot check).
- [ ] The paste fallback: start a sign-in, press "Open in my browser instead", finish in the browser, copy the address that starts with `http://127.0.0.1:1455/auth/callback` from the error page and paste it. Expected: the sign-in completes.
- [ ] "Choose model" lists the models of the account and saving another model works.
- [ ] A message from an unknown sender is scored through the plan (log shows the access point name).
- [ ] After more than one hour a message is still scored (token refresh). Restart Thunderbird in between once.
- [ ] "Sign out" ends the session (the app disappears from, or is disconnected in, ChatGPT settings), and "Continue with ChatGPT" on the same access point signs in again without creating a second access point.
- [ ] Removing the access point works and reports whether the session was ended.
- [ ] A second ChatGPT access point with another account can be added and takes over when the first reaches its limit.

If the redirect cannot be captured: the paste fallback is the supported path. If the flow cannot be completed from a MailExtension at all, the specification asks for the device-code sign-in instead and for a revision of section 8.6.

### A2. Anthropic API accepts requests from an add-on

Pending. The header `anthropic-dangerous-direct-browser-access: true` is always sent.

- [ ] Add "Claude (Anthropic API key)" with a real key, press Test. Expected: a score.
- [ ] If the error mentions that CORS requests are not allowed for the organization: this is an organization setting (zero data retention or the Compliance API) and cannot be solved in the add-on.
- [ ] Try the model `claude-haiku-5-5` as well.

### A3. Local servers accept requests that carry an add-on Origin

Pending. The README documents the server-side setting.

- [ ] Ollama without `OLLAMA_ORIGINS`: Test fails with HTTP 403 and the access point shows "Needs attention".
- [ ] Ollama started with `OLLAMA_ORIGINS` set to the origin shown in Settings, AI: Test returns a score.
- [ ] basal (`basal-serve ... --cors-origins <origin>`): Test returns a score with the "Local decision model" preset.
- [ ] LM Studio with CORS enabled: "Load models" lists the loaded model and Test returns a score.

### A4. Cloudflare wraps Clef answers under `result`

Pending. The adapter reads both shapes.

- [ ] Add "Cloudflare Clef", replace `<account id>` in the address, enter an API token, press Test. Expected: a score.

### A5. `messages.onNewMailReceived` fires reliably

The local IMAP test handled ordinary new deliveries immediately. A message already marked read was handled by the real five minute alarm. The tick covers ordinary missed events, but its date query cannot recover every backdated message; see the known limit in the implementation notes.

- [ ] With protection on, send a message from an unknown address to the test account. Note how long it takes until the log shows it: at once (the event fired) or within 5 minutes (the tick).

### A6. Alt shortcuts fire in the mail window on macOS

Pending. On macOS Option plus a letter can type a character.

- [ ] On macOS, select a message and press `Option` + `B`. Expected: a notification "Blocked: ..." and the message in Junk.
- [ ] Repeat with `Option` + `Shift` + `B`, `Option` + `W`, `Option` + `Shift` + `W`.
- [ ] Repeat on Windows or Linux with `Alt`.

If the Option shortcuts do not fire on macOS: the specification changes the macOS defaults to `Control` + `B` and `Control` + `W` (add `"mac": "MacCtrl+B"` and so on to `suggested_key` in `src/manifest.json`).

### A7. Other decision model and chat providers

Pending for every provider. One Test and one real message each:

- [ ] Jev (TypeSafe), `jev-latest`
- [ ] OpenRouter Decisions, `~typesafe/jev-latest`
- [ ] OpenAI Decisions, `gpt-6-luna`
- [ ] OpenAI chat, `gpt-6-luna`
- [ ] Gemini, `gemini-4-hydrogen`
- [ ] OpenRouter chat, `openai/gpt-6-luna`
- [ ] A wrong key gives "Needs attention" and the next access point takes over.
- [ ] OpenRouter chat with a moderated model: a message the moderation flags (HTTP 403) gets no verdict from that access point, the access point does not need attention, and the next message is scored by it again.
- [ ] A rate limit (HTTP 429) pauses the access point ("Paused until ...") and the next one takes over.

## B. Manual checklist in a real Thunderbird (specification section 13)

### B1. Installation and setup

- [ ] The XPI installs on Thunderbird 153 or newer. The install prompt does not ask for full access to Thunderbird and the computer.
- [ ] The settings page opens after installation. Protection is off.
- [ ] After a few seconds the white list shows your own addresses (source "Your address").
- [ ] The toolbar button shows the popup with the status.
- [ ] No message from "Block Spam" in the Error Console.

### B2. New mail

- [ ] Protection on, no AI: mail from a whitelisted sender stays, mail from a blacklisted sender goes to Junk, mail from an unknown sender follows the "no AI verdict" setting (try all three values).
- [ ] With an AI access point: an obvious cold email is scored above the cutoff, the sender's domain appears on the black list (source "AI") and the message is in Junk. A normal first message stays in the Inbox and nothing is remembered about its sender.
- [ ] Mail that was already in the Inbox before protection was switched on is not touched.
- [ ] A message from a blacklisted sender with a `Date` header years in the past, sent while protection is on, still goes to Junk when it arrives (the new mail event reads its `Received` header).
- [ ] Observation mode: nothing is moved, nothing is added by the AI, the log shows what would have happened.
- [ ] A message whose display name is an encoded word that decodes to another address, for example `From: =?UTF-8?Q?ceo=40partner=2Eexample_=3Cceo=40partner=2Eexample=3E?= <spam@evil.example>`: the log must show `spam@evil.example` as the sender. If it shows `ceo@partner.example`, the decoded author string is parsed again, and the sender has to be read from the undecoded `From` header instead.

### B3. Mail read on a phone first

- [ ] With Thunderbird running, open a new message from a blacklisted sender on a phone first. Expected: Thunderbird still moves it to Junk.
- [ ] Close Thunderbird for more than an hour, receive mail meanwhile, read it on the phone, start Thunderbird. Expected: the messages are handled after startup.

### B4. Mail sent from a phone

- [ ] Send a message from the phone to a new address. Within 5 minutes of Thunderbird seeing it in the Sent folder, the recipient is on the white list (source "Sent mail").
- [ ] Send from Thunderbird itself: the recipient is on the white list at once.
- [ ] A company address is learned as its domain, a `gmail.com` address as the single address.

### B5. The manual scan with dates

- [ ] Scan without dates: progress counts go up, the white list fills, the result line shows the totals.
- [ ] Scan with a start date and an end date: only recipients of that period are added.
- [ ] Cancel during a long scan: the entries learned so far are kept.
- [ ] Add a second Sent folder under Learning and scan again: its recipients are learned too.

### B6. A long scan survives background suspension

- [ ] Scan a Sent folder with many thousands of messages (several minutes). Do not touch Thunderbird. Expected: the scan finishes and the progress never stalls for more than a few seconds. The background page must not be suspended in the middle.
- [ ] Close the settings tab during the scan and open it again: the progress is still shown.

### B7. Transparent and wrapped forwards

Practical result: `messages.listInlineTextParts` returned exactly `[{"contentType":"text/plain","content":"OUTER_BODY_SENTINEL"}]` for the attached-message fixture. The attached body was absent. The S5 trusted-decoy bypass was also reproduced and then fixed: the forwarder's labelled body line is now read before an attached message.

- [ ] Transparent forward (alias or server redirect): the message shows the original author. It is handled like direct mail, without configuration.
- [ ] Wrapped forward (for example an Outlook or Exchange "Forward" rule, or Google Groups): the message shows the forwarding mailbox. Add that mailbox under Forwarding mailboxes. Expected: the log shows the original sender "forwarded by" the mailbox, a spam forward goes to Junk, the black list gets the original sender and never the forwarding mailbox.
- [ ] Check each source of the original sender if you can produce it: the `X-Original-From` header, an attached message, a "From:" line in the text.
- [ ] Select a message that was forwarded as an attachment. In the background page's console (Tools, Developer Tools, Debug Add-ons, Block Spam, Inspect) run `const [m] = (await browser.mailTabs.getSelectedMessages()).messages; await browser.messages.listInlineTextParts(m.id)` and check that the text of the attached message is not part of the result. The fix for review finding S5 relies on this: the forwarder's "From:" line is read before an attached message, which is safe only while an attached message cannot add text to the body. Repeat this check on a new Thunderbird version.
- [ ] A wrapped forward that carries an attached message from a trusted address is still judged by the sender named in the forwarder's "From:" line.
- [ ] A wrapped forward whose original sender cannot be found is scored by the AI and never trusted because of the forwarding mailbox.

### B8. Shortcuts

- [ ] Block address, block domain, trust address, trust domain on one message and on several selected messages.
- [ ] In a message tab and in a message window.
- [ ] Trust on a message in Junk moves it back to the Inbox.
- [ ] Smart on: block domain on a `gmail.com` sender blocks only the address. Smart off: it blocks `gmail.com`.
- [ ] A message sent by yourself is ignored.
- [ ] The desktop notification names what was added.
- [ ] The shortcuts can be changed under "Manage Extension Shortcuts", and the settings page shows the new binding.
- [ ] The shortcuts work in observation mode and while protection is off.

### B9. The screening flow

- [ ] "Create folder" under Incoming mail asks for the folder permission and creates a "Screening" folder. If Thunderbird reports that folder creation is not available yet, create the folder by hand, choose it in the list and record this.
- [ ] With "no AI verdict" set to the screening folder and no AI: mail from unknown senders lands there.
- [ ] Write to one of those senders, or press a trust shortcut: their messages move from the screening folder to the Inbox.

### B10. The settings page

- [ ] Lists: add, search and remove entries, with scope "All accounts" and with one account.
- [ ] Public domains: check a domain, treat a company domain as public and back.
- [ ] AI: add, edit, reorder, disable, test and remove access points. The consent dialog and the permission prompt appear when a host is new.
- [ ] The permission prompt for a new host appears and can be accepted. Thunderbird has data collection permissions switched off today, so the prompt shows the host only. If a later Thunderbird refuses the data collection part, the page says to press the button again and then asks for the hosts alone. Record which happened.
- [ ] An access point that came from an import works after you open it, enter the key and save: the save shows the consent dialog and asks for the host permission.
- [ ] Before that save, Test and the enable checkbox of the imported access point send nothing: Test reports "no permission for ...". The same happens after removing the host permission of a working access point in the Add-ons Manager (Block Spam, Permissions).
- [ ] Prompt: save a changed prompt, restore the default, try to save an empty prompt.
- [ ] Cutoff: values outside 0.00 to 1.00 are refused.
- [ ] Log: entries appear, the filter works, Clear empties it.
- [ ] Data: export, then import with Merge and with Replace on a second profile. Account-scoped entries follow the account with the same email address.
- [ ] Stored data that is not valid (edit the add-on's storage by hand in a test profile, for example replace an older `log:` chunk with text): protection is off, the page shows the error with "Download the raw data" and "Reset", the popup shows the data problem, and Reset gives a working add-on again.

### B11. The popup

- [ ] Status, pause and resume.
- [ ] The last ten decisions.
- [ ] "Score selected messages" asks for confirmation, writes test entries to the log, moves nothing and creates no entry.
- [ ] The confirmation names the number of selected messages. With more than 50 selected, it refuses and sends nothing.

### B12. The companion add-on

- [ ] `dist/block-spam-keys-<version>.xpi` installs and asks for full access.
- [ ] `B`, `Shift` + `B`, `W`, `Shift` + `W` in the message list, in a message tab and in a message window run the four commands.
- [ ] Thunderbird's own action for `B` (previous message) and `W` (watch thread) no longer happens.
- [ ] The keys type normally in the quick filter, in the global search, in the compose window and in the settings page of an add-on.
- [ ] The keys do nothing in the calendar and address book tabs.
- [ ] With the companion disabled or removed, `B` and `W` are Thunderbird's own again.
- [ ] After updating the companion, the new version is active without restarting Thunderbird.

## C. Robustness

- [ ] Leave Thunderbird running for a day with protection on. The log keeps filling, the Error Console stays free of "Block Spam" errors.
- [ ] Work offline: nothing is moved or scored wrongly, and mail is handled once the account is online again.
- [ ] An account without a Junk folder: a warning appears under Status, and its spam stays where it is.
- [ ] Two accounts with per-account entries: an entry of one account does not affect the other.
