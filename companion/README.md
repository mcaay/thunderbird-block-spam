# Block Spam Keys

Optional companion of [Block Spam](../README.md). It makes the bare keys work in Thunderbird's mail windows:

| Key | Action |
|---|---|
| `B` | block the sender's address |
| `Shift` + `B` | block the sender's domain |
| `W` | trust the sender's address |
| `Shift` + `W` | trust the sender's domain |

## Why it is a separate add-on

Thunderbird lets an add-on capture keys without a modifier only through an Experiment API, and every add-on that contains an Experiment must ask for **full, unrestricted access to Thunderbird and your computer** when it is installed. Block Spam itself never asks for that. If you do not want to grant it, do not install this companion and use the default shortcuts of Block Spam instead (`Alt` + `B`, `Alt` + `W`, with `Shift` for the domain).

## What it does

It contains only the Experiment in `api/implementation.js` and a few lines in `background.js`:

- It listens for `B`, `Shift` + `B`, `W` and `Shift` + `W` in the main window (mail tabs and message tabs) and in message windows.
- It never captures keys in text fields, in web pages shown inside Thunderbird, or while a menu is open.
- It acts only on real key presses: a key event that a script dispatched is ignored.
- It suppresses Thunderbird's own action for those keys (`B` is "previous message", `W` is "watch thread").
- It sends the matching command name to Block Spam with `runtime.sendMessage`. Block Spam accepts the four command names from this add-on's id only.

It reads no mail, stores nothing and makes no network request.

## Limits

- It does nothing without Block Spam installed and enabled.
- It is best effort: Thunderbird plans to stop running Experiments on the Release channel from the 2027 ESR.
- It uses Manifest V2 with a persistent background page, because it has to hold a key listener for as long as Thunderbird runs.

## Build and install

`npm run build` in the repository root writes `dist/block-spam-keys-<version>.xpi`. The same file is packaged inside Block Spam: its settings page saves it with the button "Save the companion add-on file…" in the pane "Block and trust". Install it in Thunderbird under Add-ons and Themes, gear menu, Install Add-on From File.
