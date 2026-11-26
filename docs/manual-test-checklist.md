# Manual test checklist

Practical testing was performed on 2026-11-21 in Thunderbird 153.7.0 on macOS, using isolated profiles and loopback IMAP, SMTP and mock AI servers. Results, evidence, fixes and remaining checks are in `reviews/2026-11-21-practical-test/report.md` (git-ignored). The checkboxes below remain a reusable checklist, not a statement that every environment or real service has passed.

Use a separate Thunderbird profile and a test IMAP account. Build with `npm run check`, then install `dist/block-spam-<version>.xpi` (Add-ons and Themes, gear menu, Install Add-on From File). Keep the Error Console open (Tools, Developer Tools, Error Console) and note every message that starts with "Block Spam".

Legend: each item has the steps, what should happen, and what to do when it does not.

The interface calls a connection to an AI an "AI service". The specification and the code say "access point".

The settings page and the popup were looked at in Thunderbird 153.7.0 in both themes, in English and in Polish; the captures are in `reviews/2026-11-21-ux-ui/round-2/` (git-ignored). Sections B10 to B13 list what to check by hand, in particular what a headless test instance cannot show: the popup panel and the context menu as drawn by the system, the desktop notification, a screen reader, Windows and Linux.

## A. Checks against real services (specification section 15)

### A1. ChatGPT sign-in redirect can be captured

Pending. This is also the decision gate of specification section 8.6: the sign-in prototype against a real account was not run.

1. Settings, AI, choose "ChatGPT" under "Subscriptions", Add. Confirm the consent dialog and the permission prompt.
2. A Thunderbird tab opens `auth.openai.com`. Sign in and approve.
3. While you sign in, the list of AI services shows a row "Signing in with ChatGPT" with the buttons for the browser and the field for the pasted address.
4. Expected: the tab closes by itself, a "ChatGPT plan" service appears with your email address, a model and the link "Manage usage". The welcome message "You're using your ChatGPT plan" appears once.
5. Press Test on the service. Expected: a score.

Also check:

- [ ] The permission prompt appears and lists `auth.openai.com`, `api.openai.com` and `127.0.0.1`.
- [ ] Thunderbird accepts `webRequest` as an optional permission. Its documentation does not list it among optional permissions, the shared toolkit schema does. If it is refused, the page may ask you to press the button again, and the sign-in panel then says to paste the address. Record this.
- [ ] The OpenAI page works inside a Thunderbird tab (no blocked page, no endless bot check).
- [ ] The paste fallback: start a sign-in, press "Open in my browser instead", finish in the browser, copy the address that starts with `http://127.0.0.1:1455/auth/callback` from the error page and paste it. Expected: the sign-in completes.
- [ ] "Choose model" lists the models of the account and saving another model works.
- [ ] A message from an unknown sender is scored through the plan (the reason line of the log entry names the service: "ChatGPT plan scored it above the cutoff" or "… did not score it above the cutoff").
- [ ] After more than one hour a message is still scored (token refresh). Restart Thunderbird in between once.
- [ ] "Sign out", in the editor of the service ("Edit"), ends the session (the app disappears from, or is disconnected in, ChatGPT settings), and "Continue with ChatGPT" on the same service signs in again without creating a second one. The sign-in row then appears inside the row of that service.
- [ ] Removing the service works and reports whether the session was ended.
- [ ] A second ChatGPT service with another account can be added and takes over when the first reaches its limit.

If the redirect cannot be captured: the paste fallback is the supported path. If the flow cannot be completed from a MailExtension at all, the specification asks for the device-code sign-in instead and for a revision of section 8.6.

### A2. Anthropic API accepts requests from an add-on

Pending. The header `anthropic-dangerous-direct-browser-access: true` is always sent.

- [ ] Add "Claude (Anthropic API key)" with a real key, press Test. Expected: a score.
- [ ] If the error mentions that CORS requests are not allowed for the organization: this is an organization setting (zero data retention or the Compliance API) and cannot be solved in the add-on.
- [ ] Try the model `claude-haiku-5-5` as well.

### A3. Local servers accept requests that carry an add-on Origin

Pending. The README documents the server-side setting.

- [ ] Ollama without `OLLAMA_ORIGINS`: Test fails with HTTP 403 and the service shows "Needs attention" with what to do.
- [ ] Ollama started with `OLLAMA_ORIGINS` set to the origin shown in the editor of the service (Settings, AI, Edit, with a Copy button): Test returns a score.
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

- [ ] On macOS, select a message and press `Option` + `B`. Expected: a notification "Blocked: ..." and the message in the Spam folder.
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
- [ ] A wrong key gives "Needs attention. The key was rejected. Edit this service and enter a valid key." and the next service takes over. The Overview, the state under the name in the category list and the popup read "On, 1 problem".
- [ ] OpenRouter chat with a moderated model: a message the moderation flags (HTTP 403) gets no verdict from that service, the service does not need attention, and the next message is scored by it again.
- [ ] A rate limit (HTTP 429) pauses the service ("Paused until ...") and the next one takes over.
- [ ] The links under the menu of services ("Get a key", "Documentation") open the right pages in the default browser.

## B. Manual checklist in a real Thunderbird (specification section 13)

### B1. Installation and setup

- [ ] The XPI installs on Thunderbird 153 or newer. The install prompt does not ask for full access to Thunderbird and the computer.
- [ ] The settings page opens after installation on the Overview. Protection is off. The page says in one sentence what the add-on does and lists three setup steps, the first with the filled button.
- [ ] After a few seconds the white list shows your own addresses (source "Your address").
- [ ] The toolbar button shows the popup: "Setup is not finished" with "Open setup", which opens the Overview.
- [ ] Step 1 "Scan sent mail" starts the scan in place and shows its progress and Cancel there. Afterwards step 3 has the filled button.
- [ ] Step 2 opens the AI pane with the menu of services focused.
- [ ] With an AI service added before the scan: a warning appears under the switch, and switching protection on opens a dialog with "Scan first" (the default), "Switch on anyway" and Cancel. After "Scan first" the scan runs, a note under the switch says "Protection switches on when the scan has finished." with "Don’t switch on", and when the scan has ended protection is on and a bar says so. Close the settings page while the scan runs: protection is still switched on at its end.
- [ ] After step 3 the setup folds to "Setup complete", and the line under the switch shows the time of the last check and today's figures.
- [ ] No message from "Block Spam" in the Error Console.

### B2. New mail

- [ ] Protection on, no AI: mail from a whitelisted sender stays, mail from a blacklisted sender goes to the Spam folder, mail from an unknown sender follows the "no AI verdict" setting (try all three values).
- [ ] With an AI service: an obvious cold email is scored above the cutoff, the sender's domain appears on the black list (source "AI") and the message is in the Spam folder. A normal first message stays in the Inbox and nothing is remembered about its sender.
- [ ] Mail that was already in the Inbox before protection was switched on is not touched.
- [ ] A message from a blacklisted sender with a `Date` header years in the past, sent while protection is on, still goes to the Spam folder when it arrives (the new mail event reads its `Received` header).
- [ ] Observation mode: nothing is moved, nothing is added by the AI, the log shows what would have happened.
- [ ] A message whose display name is an encoded word that decodes to another address, for example `From: =?UTF-8?Q?ceo=40partner=2Eexample_=3Cceo=40partner=2Eexample=3E?= <spam@evil.example>`: the log must show `spam@evil.example` as the sender. If it shows `ceo@partner.example`, the decoded author string is parsed again, and the sender has to be read from the undecoded `From` header instead.

### B3. Mail read on a phone first

- [ ] With Thunderbird running, open a new message from a blacklisted sender on a phone first. Expected: Thunderbird still moves it to the Spam folder.
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
- [ ] Wrapped forward (for example an Outlook or Exchange "Forward" rule, or Google Groups): the message shows the forwarding mailbox. Add that mailbox under Forwarding mailboxes. Expected: the log shows the original sender "forwarded by" the mailbox, a spam forward goes to the Spam folder, the black list gets the original sender and never the forwarding mailbox.
- [ ] Check each source of the original sender if you can produce it: the `X-Original-From` header, an attached message, a "From:" line in the text.
- [ ] Select a message that was forwarded as an attachment. In the background page's console (Tools, Developer Tools, Debug Add-ons, Block Spam, Inspect) run `const [m] = (await browser.mailTabs.getSelectedMessages()).messages; await browser.messages.listInlineTextParts(m.id)` and check that the text of the attached message is not part of the result. The fix for review finding S5 relies on this: the forwarder's "From:" line is read before an attached message, which is safe only while an attached message cannot add text to the body. Repeat this check on a new Thunderbird version.
- [ ] A wrapped forward that carries an attached message from a trusted address is still judged by the sender named in the forwarder's "From:" line.
- [ ] A wrapped forward whose original sender cannot be found is scored by the AI and never trusted because of the forwarding mailbox.

### B8. Shortcuts

- [ ] The pane "Block and trust" shows the four commands with their keys: as `⌥B`, `⌥⇧B` and so on on macOS, as `Alt+B` elsewhere. The old address of the pane (`#shortcuts`) still opens it.
- [ ] Block address, block domain, trust address, trust domain on one message and on several selected messages.
- [ ] In a message tab and in a message window.
- [ ] Trust on a message in the Spam folder moves it back to the Inbox.
- [ ] Smart on: block domain on a `gmail.com` sender blocks only the address. Smart off: it blocks `gmail.com`.
- [ ] A message sent by yourself is ignored.
- [ ] The desktop notification is titled "Block Spam", names what was added and how many messages were moved ("Blocked: name@example.com", "Moved to the Spam folder: 1"), and says that the command can be undone from the Block Spam button in the toolbar.
- [ ] After a shortcut, open the popup: the command stands at its top with the time it was made, Undo and Dismiss. Undo removes the entry, puts back an entry the command had replaced, and moves the message back. After Thunderbird was left alone for a minute (the background page is suspended) the command is still offered.
- [ ] The shortcuts can be changed under "Manage Extension Shortcuts", and the settings page shows the new binding.
- [ ] The shortcuts work in observation mode and while protection is off.

### B9. The screening flow

- [ ] Under Incoming mail the screening folder of each account is shown only while "Mail without an AI verdict" is set to "Move it to the screening folder", directly under that menu. Choose another option: the folders are gone. Choose it again: the folders that were chosen are back.
- [ ] "Create the folder “Screening”" there asks for the folder permission and creates a "Screening" folder. Afterwards the button is gone and the folder is chosen in the menu of that account. The button is shown only while the account has no folder of that name: a folder that exists is chosen in the menu. If Thunderbird reports that folder creation is not available yet, create the folder by hand, choose it in the list and record this.
- [ ] With "no AI verdict" set to the screening folder and no AI: mail from unknown senders lands there.
- [ ] Write to one of those senders, or press a trust shortcut: their messages move from the screening folder to the Inbox.

### B10. The settings page

Shell:

- [ ] The page looks like Thunderbird's own Settings next to it (open both): the category list with icons and a filled current row, the title, the sizes of text and buttons, in the light and in the dark theme.
- [ ] Each category opens its pane, the address ends in its name (`#lists`, `#log` and so on), and Back and Forward walk the panes.
- [ ] A window narrower than 760 pixels shows the categories as a row at the top that wraps onto a second line, with every category in view, and that stays at the top while the pane scrolls.
- [ ] The settings tab shows the add-on's icon.
- [ ] Nothing floats over the page: every confirmation appears in its group, as a bar or as text next to the control.

Overview:

- [ ] The state next to "Protection" and under the name of the add-on in the category list reads Off, "Switches on after the scan", On, "On, observing only" (with an eye in the neutral color of Off, not the green check of On), "On, 2 problems" (the number of warnings), "No mail account" or "Data problem". The one in the category list is on every pane and opens the Overview. Every warning leads to its fix ("Edit" of a service, "Set up the folder"; the warning about AI before the first scan points to setup step 1).
- [ ] One warning per cause: with two accounts that have no Spam folder there is one warning that names both, and two AI services with a rejected key share one warning whose button shows the AI services.
- [ ] Observation mode stands under "Protect incoming mail". Ticked while protection is off, it says that nothing is observed yet.
- [ ] Setup step 1 while a long scan runs: a spinner, a progress bar that fills, Cancel, and no filled button on step 3. After Cancel the step shows its number again and "Scan again" is filled. Only after the scan has ended does the step show its check mark.
- [ ] A scan in an account whose Sent folders are empty says that no sent mail was found and links to the Sent folders.
- [ ] With an AI service on, switch protection on while a scan is still running: a dialog asks whether to wait for the scan. "Wait for the scan" leaves protection off for now and switches it on when the scan has finished; until then the note under the switch offers "Don’t switch on", and step 3 has no button. Cancel the scan instead: a bar says that protection was not switched on because the scan was cancelled. "Switch on anyway" switches it on at once. Quit Thunderbird while protection waits for the scan and start it again: the scan runs again and protection follows it.
- [ ] Cancel a scan in the Learning pane with the keyboard: the focus goes on to "Scan sent mail".
- [ ] "Block and trust by hand" names the two shortcuts as they are set and links to the pane "Block and trust".
- [ ] With protection on and a problem (for example a rejected key): the Block Spam button in the toolbar has a badge, and its tooltip names the number of problems and the problems ("Block Spam: 1 problem (AI service not used: OpenAI)"). Without a problem the tooltip says the state ("Block Spam: protection is on"). Its label, when the toolbar shows labels, stays "Block Spam". The badge goes away when the problem is fixed or protection is switched off.
- [ ] When an AI service first answers 401 for incoming mail, one desktop notification names the service and the remedy. More mail does not repeat it. A click on it opens the Overview.

Lists:

- [ ] Add an address and a domain without choosing a kind. A wrong value ("not an address") is refused with the reason under the field, and the field keeps the focus.
- [ ] Search and filter the entries, with scope "All accounts" and with one account.
- [ ] Remove an entry: its row stays in its place as a quiet row that says "Removed ...", with "Undo (Ctrl+Z)" (Cmd+Z on macOS) where the remove button was and the close button after it. Nothing moves under the pointer. Undo puts the entry back in its place with its source and date, and the shortcut does the same. With the keyboard, the focus is on Undo, and the arrow keys still walk the table.
- [ ] Remove several entries one after the other with the mouse: every removed row keeps its place, only the newest one offers Undo, and the pointer never lands on a row that was not aimed at. The rows below move up when a quiet row is closed, with the next other action in the table (a filter, a search, a sort, an added entry, "Show N more"), or when the pane is left.
- [ ] A click on a column header sorts the table by that column (all entries, not only the rows shown), a second click reverses the order, and the header shows an arrow. "Source:" narrows the table to what the AI, the scan, sent mail or you added.
- [ ] "Add" is unavailable while the field is empty.
- [ ] The line under the filter reads "Showing 200 of 4,001." without a filter, and "Matching: 12 of 4,001." with a filter or a search.
- [ ] With more than 200 entries the button under the table reads like "Show 200 more (3,801 left)".

Log:

- [ ] Entries appear by themselves, the filters (by decision, by time, and with several accounts by account) and the search by sender or subject work and say how many entries match ("Matching: 2 of 13."), "Clear log…" stands at the end of the line that counts the entries and asks first. An empty log shows neither the line nor the button.
- [ ] An entry from another day shows its date above the time, an entry from another year the date with the year. Nothing paints over the sender, also with a 12-hour clock.
- [ ] The table has no Score column: the score ends the first line of the decision, in one column from row to row, and the header says "Decision" at its start and "Score" at its end. After an action in a row, its result (the sentence that Undo belongs to, or "The message was not found.") is one line under the cells of the row, from the start of "Sender and subject" to the end of the row.
- [ ] In a window narrower than 900 pixels the rows are stacked in the order of the wide table: the time, then sender, subject and account, then, after a small gap and at the same edge, the decision with what was done and its reasons. The action stays at the end of the first line.
- [ ] The line above the filter names the two shortcuts: one trusts the sender of the selected message, the other blocks it.
- [ ] "Trust domain" (or "Trust address" for a sender at a public provider) on a Spam or Blocked row puts the sender on the white list, moves the message from the Spam folder back to the Inbox and says so in the row. Undo appears where the button was and takes both back.
- [ ] "Block domain" on a Passed row blocks the domain ("Block address" at a public provider) and moves the message to the Spam folder. On a Trusted row the button reads "Block address".
- [ ] "Show message" opens the message of the row in a tab. For a message that was deleted, the row says under its decision that it was not found, and the link is gone.
- [ ] A row of a test has no button. A row of an observed decision changes the lists and moves nothing.
- [ ] After the message was deleted, the button still changes the list and the row says that the message was not found.
- [ ] An observed decision reads "would go to the Spam folder", a detail line reads like "Added to the black list: example.com", and the name of the AI service stands under the score.
- [ ] A decision without a verdict says what went wrong in the language of the interface ("The service answered with error 500.") and quotes only the service's own message.

Learning and Incoming mail:

- [ ] Learning: "Scan of sent mail" stands first, the Sent folders of the accounts second.
- [ ] The folder lists are plain rows with a trash can. "Add folder" is unavailable until a folder is chosen.
- [ ] The folder menus offer only folders that can be right: no Inbox, Spam, Trash, Drafts, Templates or Outbox as a Sent folder, no Sent, Spam, Trash, Drafts, Templates or Outbox as a monitored folder, neither of these as the screening folder, and no folder that is on one of the other two lists. A folder that was stored before stays listed and can be removed. An account with nothing left to offer says so in one line.
- [ ] "Mail without an AI verdict" set to the screening folder while an account has none: a line above the folders names the account.
- [ ] With an AI service switched on and protection off, the AI pane says under the services that no new mail is sent to an AI service yet, and "Show setup" leads to the step that is left. With no AI service switched on, the cutoff and the prompt each say that they are not used yet.
- [ ] Without any mail account in Thunderbird, both panes say so in one line and "Scan sent mail" is unavailable.
- [ ] Remove a folder: its row stays in its place as a quiet row with Undo and the close button, and the lists of the accounts below do not move. Undo puts the folder back in its place.
- [ ] The date fields of the scan: the line under them says that both are optional and what an empty field means.

Advanced:

- [ ] With two or more mail accounts "Sharing between accounts" (shared or per account) is the first group, and the lead sentence of the pane names it. Its hint says that an entry added with the form under Lists uses its own "Applies to", and "Lists" in it opens the Lists pane. "Learn more" of the Lists pane says where sharing is set, with a link to Advanced.
- [ ] Public mail providers: check a domain, treat a company domain as public and back.
- [ ] Forwarding mailboxes and labels: add and remove a mailbox (the removed row stays in its place with Undo, and Undo puts it back where it was), change the labels and save. Save is filled only while the labels are changed.

AI:

- [ ] The pane opens with what is sent and that mail from the white list never is.
- [ ] Add a service from each group of the menu. The line under the menu describes the choice. The editor opens as a new row of the list, and for an existing service inside its row.
- [ ] "Load models" before the first save shows the consent dialog and the permission prompt, then the models as a menu in place of the Model field, with "Other…" as its last item, which brings the text field back. Nothing says "Loading…" while the dialog is open, nor after Cancel.
- [ ] The hint of the API key field ends with "Get a key" or "Documentation" for a service from a preset. The sentence about servers on this computer shows only for an address on this computer.
- [ ] "Load models" for a service whose model is not on the loaded list: the menu marks that model as not on the list, and the status says that the model that is set is not among them.
- [ ] While a slow service answers, the row says "Testing…" and the editor "Loading…", and the button that was pressed is unavailable.
- [ ] The warning about a rejected key on the Overview opens the editor with the focus in the API key field.
- [ ] The services are plain rows with separator lines, also with the editor or a sign-in inside a row.
- [ ] Under the prompt, two lines say how to try a prompt or a cutoff: with "Test AI on selected messages…" of the toolbar button, and with the observation option on the Overview (a link).
- [ ] The ChatGPT sign-in: where the page updates by itself, the text says so and a hint says what to do when it does not; where the address has to be pasted, one instruction says so. "Finish sign-in" is unavailable until an address is pasted. Test of a service without a sign-in is unavailable.
- [ ] After Save the service is tested once and its row shows the result.
- [ ] Edit, reorder (arrows), disable, test and remove services. Removing asks first.
- [ ] The permission prompt for a new host appears and can be accepted. Thunderbird has data collection permissions switched off today, so the prompt shows the host only. If a later Thunderbird refuses the data collection part, the page says to press the button again and then asks for the hosts alone. Record which happened.
- [ ] A service that came from an import works after you open it, enter the key and save: the save shows the consent dialog and asks for the host permission.
- [ ] Before that save, Test and the enable checkbox of the imported service send nothing: Test reports "no permission for ...". The same happens after removing the host permission of a working service in the Add-ons Manager (Block Spam, Permissions).
- [ ] Prompt: Save is available and filled only after a change, followed by "Unsaved changes" and "Discard changes". "Restore default" only fills the field. An empty prompt is refused under the field. Leaving the page with an unsaved prompt asks first. A line under the field says why the default prompt is English.
- [ ] A failed Test and the line about the last failed request are in the language of the interface, with only the service's own message quoted.
- [ ] Cutoff: a valid value is saved when the field is left, values outside 0.00 to 1.00 are refused under the field.

Export and import:

- [ ] "Import" is unavailable until a file is chosen.
- [ ] Export, then import with Merge and with Replace on a second profile. The file is chosen with the button "Choose file", and the report counts the entries and names what was skipped. Account-scoped entries follow the account with the same email address.
- [ ] Stored data that is not valid (edit the add-on's storage by hand in a test profile, for example replace an older `log:` chunk with text): protection is off, the page shows only the Overview with the error, "Download the raw data…" and "Reset everything…", the popup shows the data problem, the toolbar button has a badge, and the reset gives a working add-on again.
- [ ] One stored setting that is not valid (for example `settings.cutoff` set to 7): the page names the setting with its default and offers "Reset only this setting" first. It sets back that setting only, and the page says so.

Block and trust:

- [ ] Under the shortcuts the pane says that a key on its own, such as B, cannot be a shortcut. Nothing on it offers a second add-on.

### B11. The popup

- [ ] The panel looks like a Thunderbird panel in both themes (the test instance could not show the panel itself, only its content).
- [ ] The header shows the state as the Overview does, and Settings opens the settings page. With the settings page already open it is brought to the front, not loaded anew.
- [ ] With one message selected: the sender, the list entry that decides it ("On the white list (entry ...)" or "On neither list"), the decision about this message as a row that opens its log entry, "Block address" and "Trust address" with their shortcuts, and "Whole domain" with its own pair. For a sender at a public provider the popup says that only the address is used. A button that would change nothing is unavailable.
- [ ] After a click the result stands at the top with Undo and Dismiss. Undo takes the command back and the popup says so.
- [ ] The panel and the popup inside it have the same background and text color, in the light and in the dark theme: no seam, no lighter rectangle inside the rounded panel.
- [ ] With several messages selected: their number, and the same buttons for all of them.
- [ ] The six newest decisions, each in two lines: the address and the time, and under them the outcome with its score and marks. Nothing is cut but an address that is longer than the panel, every row has the same height, and "Open the log" leads to the rest. Tests and observed decisions say so and have a hollow dot. A click on a row opens the Log pane with that entry in view, marked and focused.
- [ ] With a problem (for example a rejected key) the state reads "On, 1 problem" and a line that names the problems ("Needs your attention: AI service not used: OpenAI."), with "Show in settings", opens the Overview.
- [ ] Without a mail account the popup says "No mail account" and that one has to be added first, and does not point at setup.
- [ ] While protection waits for a scan the state reads "Switches on after the scan", and the footer says so and offers "Don’t switch on".
- [ ] "Switch protection off" and "Switch protection on".
- [ ] "Test AI on selected messages…" asks for confirmation, writes test entries to the log, moves nothing and creates no entry. While it asks and while it scores, the answers stand on a line of their own and the switch of protection is not shown.
- [ ] The confirmation names the number of selected messages. With no message selected, or with more than 50, the button is unavailable and its tooltip says why.
- [ ] After a shortcut, the popup shows the command with its time, and with its date too when the command is not from today.
- [ ] With the keyboard: after "Trust address", Undo, Cancel or the protection switch, the focus is on a control of the popup, never lost.

### B12. The context menu

- [ ] Right-click a message in the message list: the menu has a "Block Spam" entry with "Block the sender's address", "Block the sender's domain", "Trust the sender's address" and "Trust the sender's domain".
- [ ] Each of them does what its shortcut does, for one message and for several selected messages, and the notification says what was added.

### B13. Language and accessibility

- [ ] In a Polish Thunderbird everything is Polish: the settings page, the popup, the context menu, the notifications, the name and the description in the Add-ons Manager and the commands under "Manage Extension Shortcuts". Counts are right ("1 wpis", "2 wpisy", "5 wpisów").
- [ ] In a Thunderbird in a third language the add-on is English throughout, with English counts and numbers.
- [ ] Keyboard only: Tab reaches the categories and every control of a pane, the focus is always visible, the arrow keys walk the categories, Enter and Space operate everything, Escape closes a dialog and the focus returns to the button that opened it.
- [ ] With a screen reader (VoiceOver, NVDA or Orca): every control is announced with a name, the buttons of a row name their row, an error under a field and a confirmation are announced.
- [ ] At 200 percent zoom nothing is cut off and nothing scrolls sideways.
- [ ] In high contrast (Windows contrast themes, or Thunderbird's own setting to override colors) the current category is marked and every state can be read.
- [ ] On Windows and on Linux the page still matches Thunderbird's Settings (fonts, button sizes, the popup panel).

## C. Robustness

- [ ] Leave Thunderbird running for a day with protection on. The log keeps filling, the Error Console stays free of "Block Spam" errors.
- [ ] Work offline: nothing is moved or scored wrongly, and mail is handled once the account is online again.
- [ ] An account without a Spam folder: a warning appears on the Overview with "Check again", and its spam stays where it is.
- [ ] Two accounts with per-account entries: an entry of one account does not affect the other.

## After review round 5

- [ ] Protection on, nothing scanned, no AI service: add a service and press Save (or tick the box of a service that is off). Expected: the question "Scan your sent mail first?" with "Cancel", "Use it anyway" and "Scan first". "Scan first" saves the service switched off, starts the scan, the row says "Switches on after the scan" with "Don’t switch on", and the service is on when the scan has finished. Cancel leaves the editor open with everything that was typed.
- [ ] The same while a scan runs: the question is "Wait for the scan to finish?". Cancel the scan while the service waits: the row says that the service was not switched on and why.
- [ ] "Use it anyway": the service is on, and the warning about mail from people you already write to stands on the Overview and on the AI pane ("is sent"), on the AI pane with "Scan sent mail".
- [ ] Close and reopen the settings page, and restart Thunderbird, while a service waits: it still waits, and the scan starts again after a restart.
- [ ] Log: a row "Blocked" for an address inside a trusted domain offers "Unblock address" and only removes the black entry. A row for a blocked address elsewhere offers "Trust address" and does not trust the domain. Undo restores the lists exactly.
- [ ] Popup: "Block" for the whole domain of a sender whose address is on the white list says "Removed from the white list: ..." in its result, and the tooltip of the button says so beforehand.
- [ ] AI: change a field in the editor of a service and press Escape, Cancel or "Edit" of another row. Expected (changed in round 6): the editor closes, and where it stood a bar says "Discarded the changes to ..." with "Undo", which opens the editor with everything that was typed. Closing the tab then does not ask.
- [ ] Export and import: "Merge lists" of a file whose entries are on the other list here reports them as moved and offers Undo. Undo restores the lists exactly. "Replace everything" asks first and says that it cannot be undone.
- [ ] One mail account: the Advanced pane shows no "Sharing between accounts" and its lead sentence does not name it, "Learn more" of Lists has no sentence about it, and the Lists pane shows no "Applies to" menu and no "Applies to" column. With an entry of a removed account the column stays.
- [ ] Overview: the status line stands directly under "Protection". "Check again" on the warning about a missing Spam folder answers "Checked at ...: the Spam folder is still missing." when nothing changed.
- [ ] The warning about a missing Spam folder names Account Settings, "Spam Settings" and "Move new spam messages to:". Following it makes the warning go away after "Check again".
- [ ] Incoming mail, under the first sentence: "Also check every 5 minutes" is ticked, with its reasons under it. Unticked, mail read on a phone first stays unchecked until Thunderbird starts again, and the Overview says "The check every 5 minutes is switched off." Ticked again, such mail is handled at once.
- [ ] Incoming mail, under "Also check every 5 minutes": "Mark mail moved to Spam as read" is ticked, with its reason under it. A message moved to Spam by the black list, by the AI and with Block (Alt+B) arrives there read, also on IMAP after Thunderbird has synchronized the Spam folder, and the folder shows no unread count. Undo in the popup, and the button of its row in the log, put an unread message back unread. Unticked, mail arrives in Spam unread. Installing this version asks for the permission to change the state of messages.
- [ ] Incoming mail, "Accounts and monitored folders": every account has the switch "Protect this account", ticked. Unticked, the account shows one sentence in place of its folders, its new mail stays untouched (also mail from a blocked sender), and the Overview says "Protected accounts: 1 of 2." Ticked again, mail that arrived meanwhile is still left alone and new mail is handled.
- [ ] Incoming mail, "Mail without an AI verdict" (the first group of the pane, above "Accounts and monitored folders"): first the sentence about which mail this is, then "What to do with it:", and the screening folders only with the third option.
- [ ] The cutoff is a plain field: the arrow keys step it by 0.01, a value outside 0 to 1 is refused.

## After review round 6: logic

- [ ] No AI service, nothing scanned, "Mail without an AI verdict" set to "Move it to the Spam folder" while protection is off (nothing is asked there). Tick "Protect incoming mail". Expected: "Scan your sent mail first?" with "Cancel", "Switch on anyway" and "Scan first", and a text that says such mail "would be moved to the Spam folder". The same with the screening folder ("to a screening folder"), and with a service on as well (sent, and moved without an AI verdict).
- [ ] "Switch on anyway": the state is "On, 1 problem", the toolbar button has its badge, and the warning "Your sent mail is not scanned yet, so mail from people you already write to is moved to the Spam folder." stands on the Overview and under the menu of Incoming mail, each with "Scan sent mail". The scan ends the warning.
- [ ] Protection on, nothing scanned, the menu on "Leave the message where it is": choose "Move it to the Spam folder". Expected: the same question with "Choose anyway". "Cancel": the menu is back on "Leave". "Scan first": the menu still shows "Leave", a note under it says that the option takes effect when the scan has finished, with "Don’t change", and when the scan has ended the menu shows the Spam folder and a bar says so. While protection is off the menu saves at once.
- [ ] While the choice waits: close the settings page, or restart Thunderbird. It still waits, and the scan starts again after a restart. Cancel the scan: the menu stays, and a bar says that nothing was changed and why. "Don’t change" calls the choice off.
- [ ] Incoming mail with no AI service available: one line under the menu says where every message from an unknown sender goes now (Spam folder, screening folder of its account, stays where it is), with "once protection is on" while protection is off. With a service available the line is gone.
- [ ] Overview with all services switched off and protection on: the status line says where mail from unknown senders goes. The warning that no AI service is available says the same.
- [ ] AI: press "Add…" or "Edit" of another row while an editor holds changes. Expected: the same bar with "Undo" where the editor stood. "Edit" on that row opens a fresh editor and the bar is gone. An unchanged editor closes without a bar. The close button of the bar puts the focus on "Edit" of the row.
- [ ] AI: "Test" with a cutoff of 0.85. A score above it: "Works: ... above the cutoff of 0.85." in green. A score that is not: "The service answers, but ... not above the cutoff of 0.85 ..." in the warning color. Change the cutoff: the line follows.
- [ ] Log: trust or block from a row, then "Undo". Expected: "Taken back: ... is on the black list again." (or the white list, or neither list), and "The message is back in ..." only when the message was moved back.
- [ ] Every bar with Undo (Lists, Learning, Incoming mail, Advanced, AI), the import report and what its Undo says end with a close button. Closing moves the focus to a control, never to nothing.
- [ ] Lists and Log with more than one page: Tab reaches one control of the table and the next Tab reaches "Show N more". Up, Down, Home and End move between rows, Left and Right between the action and "Show message" of a log row. After a removal or an action Tab still enters at that row.
- [ ] Export and import: "Merge lists" of a file whose entries are on the other list here names them: "Moved to the white list: ..." and "Moved to the black list: ...", the first ten and then "and N more".
- [ ] A screen reader on the cutoff field says the value and the range 0 to 1, also after an arrow key and after typing.

## After review round 6: wording

- [ ] Overview, protection on, no new mail today: the status line reads "Last check: ... No new mail today yet."
- [ ] Import a file with an AI service on a computer that has not allowed it yet: the warning, the row and the test say "Thunderbird may not connect to ... yet. Edit ... and press “Save” to allow it.", in Polish "Thunderbird nie ma jeszcze zgody na połączenia z ...".
- [ ] Popup, "Test AI on selected messages": when every message got a score the line is "Scored: N. The scores are in the log.". "Without a score: N." appears only when a service failed for some.
- [ ] Narrow the window while a sentence with "sign-in", "add-on" or the Polish "e-mail" stands at the end of a line (for example the dialog "Replace lists, settings and AI services?"): the word moves to the next line whole.
- [ ] The editor of a service: no hint says "provider", "server" or "endpoint".

## After review round 7: logic and wording

- [ ] Popup, block or trust one sender, then "Undo": the line reads "Taken back: ... is on neither list again." (or "on the black list again", "on the white list again") and "The message is back in the Inbox." (or the Spam folder, or the named folder). The same after a shortcut, when the popup is opened next. In Polish: "Cofnięto: ...".
- [ ] Popup, block the domain of a sender whose address is on the white list, then "Undo": "Taken back: 2 entries. The lists are as they were before."
- [ ] Popup, "Test AI on selected messages" while no service can answer (for example a wrong key): "No AI service answered: none of the N messages got a score. The log says why." with the link "Open the log", which opens the log. With one message selected the sentence names "the message". When only some got no score: "Scored: N. Without a score: M. The scores and the reasons are in the log.", with the same link.
- [ ] Popup, a message of a sender whose domain is on the black list: the line above the domain row reads "Whole domain ..., the entry that decided:", and the tooltip of "Trust address" ends with "The entry ... stays on the black list." The mirrored case (domain on the white list, "Block address") names the white list. Without a deciding domain entry the line is "Whole domain ...:" and no tooltip has that ending.
- [ ] Lists, add an entry: a bar under the form says "Added ... to the white list." with "Undo (Ctrl+Z)" and a close button, and stays while the next value is typed. Undo removes the entry and the bar says "Taken back: ... is on neither list again." Right after an add, with the focus still in the empty field, Ctrl+Z (Cmd+Z on macOS) does the same; once something is typed it belongs to the text again.
- [ ] Lists, add to the white list a value that is on the black list (made by AI): "Moved ... from the black list to the white list." Undo: the entry is on the black list again with the source and the date it had, and the bar says so. Add a value that learning put on the same list: "Its source is now “Manual”"; Undo gives the source back and says "Taken back: the source of ... is “Sent mail” again."
- [ ] Lists, a value that is on that list already by hand: the bar says so and offers no Undo. An invalid value: the error stands under the field as before, and the bar is gone.
- [ ] The category list with the keyboard: Tab from the state under the name lands on the current category, the next Tab reaches the pane. Up, Down, Home and End (and Left and Right, also in a narrow window) move between the categories and the pane follows. Shift+Tab from the pane comes back to the current category. After every arrow key the focus ring is on the category whose pane is shown, and the next arrow key goes on from there.
- [ ] Lists, add an entry, then remove a row of the table: the bar of the add stays above the table without "Undo", the removed row offers "Undo", and no row moves. Undo of the removal puts the row back.
- [ ] Learning, protection waiting for the scan: directly under the progress of the scan, before "Sent folders", the pane reads "Protection switches on when the scan has finished. If you cancel the scan, protection stays off." Afterwards the same place says what came of it.
- [ ] Learning with a screen reader: entering the row of the scan announces the group "Scan of sent mail" with the hint of the dates once; the parts of a date field do not repeat it.
- [ ] Lists: the lead says what the white list and the black list do and that an address entry beats a domain entry; "Learn more" starts with how a sender is matched.
- [ ] Incoming mail, an account without a screening folder: "... stays where it is until you choose or create a folder below." The warning on the Overview has the button "Set up the folder" (or "Set up the folders"). The bar "Mail without an AI verdict is now moved ..." has the button "Show the setting".
- [ ] Polish log and popup: "przeniesiono do folderu do sprawdzenia"; observed decisions read "trafiłaby do Niechcianych", "trafiłaby do folderu do sprawdzenia", "trafiłaby do Odebranych".
