// A command says exactly what it changes. Every command that changes the lists, against every state the lists
// can be in for the sender: what its label says, what changes, what the line about the result says and what Undo
// restores. The label and the result name exactly the change, and nothing changes that neither names.
//
// With BLOCK_SPAM_TABLE set to a path, the table is also written there as text, for the evidence pack of a review.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseSender } from "../../src/core/address";
import { COMMANDS, commandEffect } from "../../src/core/commands";
import type { CommandName } from "../../src/core/commands";
import { manualEntry } from "../../src/core/edit";
import { applyImport, buildExport } from "../../src/core/exportImport";
import { entryKey, keyOf, matchSender } from "../../src/core/lists";
import { expectsMove, fittingAction, logOffer } from "../../src/core/logAction";
import type { Entry, LogEntry } from "../../src/core/types";
import { checkImportedDefinition } from "../../src/ai/presets";
import { logLabel, logResult } from "../../src/options/logLabels";
import { harness, INBOX1, JUNK1 } from "../helpers/harness";
import type { Harness } from "../helpers/harness";

const english = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../src/_locales/en/messages.json"), "utf8")) as Record<string, { message: string }>;

/** The English strings, read the way Thunderbird would hand them out. */
function message(key: string, substitutions: (string | number)[] = []): string {
  const found = english[key]?.message;
  if (found === undefined) {
    throw new Error(`no message ${key}`);
  }
  return found.replace(/\$(\d)/g, (_all, index: string) => String(substitutions[Number(index) - 1] ?? ""));
}

beforeAll(() => {
  vi.stubGlobal("browser", { i18n: { getMessage: (key: string, substitutions: string[] = []) => english[key]?.message.replace(/\$(\d)/g, (_all, index: string) => substitutions[Number(index) - 1] ?? "") ?? "" } });
});

const SENDERS = {
  company: { address: "anna@partner.example", domain: "partner.example" },
  "public provider": { address: "anna@gmail.com", domain: "gmail.com" },
} as const;
type SenderKind = keyof typeof SENDERS;

type Seed = [list: "white" | "black", kind: "address" | "domain", scope: "all" | "account1"];

/** The states the lists can be in for one sender. */
const STATES: Record<string, Seed[]> = {
  "on neither list": [],
  "white address": [["white", "address", "all"]],
  "white domain": [["white", "domain", "all"]],
  "black address": [["black", "address", "all"]],
  "black domain": [["black", "domain", "all"]],
  "black address inside a white domain": [
    ["white", "domain", "all"],
    ["black", "address", "all"],
  ],
  "white address inside a black domain": [
    ["black", "domain", "all"],
    ["white", "address", "all"],
  ],
  "white address of this account only": [["white", "address", "account1"]],
  "black address of this account, white address for all accounts": [
    ["white", "address", "all"],
    ["black", "address", "account1"],
  ],
  "black domain of this account, white domain for all accounts": [
    ["white", "domain", "all"],
    ["black", "domain", "account1"],
  ],
};

function seed(h: Harness, kind: SenderKind, state: string): void {
  for (const [list, entryKind, scope] of STATES[state] ?? []) {
    h.state.entries.set(entryKey(entryKind, entryKind === "address" ? SENDERS[kind].address : SENDERS[kind].domain, scope), {
      list,
      kind: entryKind,
      value: entryKind === "address" ? SENDERS[kind].address : SENDERS[kind].domain,
      scope,
      source: "sent",
      addedAt: 3,
    });
  }
}

const snapshot = (h: Harness): Map<string, Entry> => new Map([...h.state.entries].map(([key, value]) => [key, structuredClone(value)]));
const scopeText = (scope: string): string => (scope === "all" ? "" : " (this account only)");
const entryText = (entry: Pick<Entry, "list" | "kind" | "value" | "scope">): string => `${entry.list} ${entry.kind} ${entry.value}${scopeText(entry.scope)}`;

/** What changed between two states of the lists, in words. */
function diff(before: Map<string, Entry>, after: Map<string, Entry>): { text: string; keys: string[] } {
  const parts: string[] = [];
  const keys: string[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(key);
    const now = after.get(key);
    if (JSON.stringify(was) === JSON.stringify(now)) {
      continue;
    }
    keys.push(key);
    if (was === undefined && now !== undefined) {
      parts.push(`adds ${entryText(now)}`);
    } else if (was !== undefined && now === undefined) {
      parts.push(`removes ${entryText(was)}`);
    } else if (was !== undefined && now !== undefined && was.list !== now.list) {
      parts.push(`moves ${was.kind} ${was.value}${scopeText(was.scope)} from the ${was.list} list to the ${now.list} list`);
    } else if (now !== undefined) {
      parts.push(`marks ${entryText(now)} as made by hand`);
    }
  }
  return { text: parts.length === 0 ? "nothing" : parts.join("; "), keys: keys.sort() };
}

const lines: string[] = [];
const section = (title: string): void => {
  lines.push("", title, "=".repeat(title.length));
};

afterAll(() => {
  const target = process.env.BLOCK_SPAM_TABLE;
  if (target !== undefined && target !== "") {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(
      target,
      [
        "Commands and lists: what every command that changes the lists says and does, for every state of the lists.",
        "Written by tests/core/commandTable.test.ts from the code itself (core/commands.ts, core/logAction.ts, options/logLabels.ts, tb/commandText.ts),",
        "with the English strings. The same test checks for every row: the label and the tooltip name the entry that changes, the lists",
        "change in exactly the entries the result line names, the command takes effect, and Undo restores the lists exactly.",
        "Sender of the company: anna@partner.example. Sender at a public provider: anna@gmail.com. New entries are shared by all accounts.",
        ...lines,
        "",
      ].join("\n"),
    );
  }
});

const POPUP_LABEL: Record<CommandName, string> = { "block-address": "popupBlock", "trust-address": "popupTrust", "block-domain": "popupBlockShort", "trust-domain": "popupTrustShort" };
const MENU_LABEL: Record<CommandName, string> = { "block-address": "cmdBlockAddress", "trust-address": "cmdTrustAddress", "block-domain": "cmdBlockDomain", "trust-domain": "cmdTrustDomain" };

describe("the four commands (buttons of the panel, shortcuts, context menu)", () => {
  for (const smart of [true, false]) {
    for (const kind of Object.keys(SENDERS) as SenderKind[]) {
      it(`${kind}, Smart ${smart ? "on" : "off"}: every state of the lists`, async () => {
        const { commandLines, commandTitle } = await import("../../src/tb/commandText");
        section(`The four commands. Sender: ${kind}. Smart ${smart ? "on" : "off"}.`);
        for (const state of Object.keys(STATES)) {
          lines.push("", `Lists: ${state}`);
          for (const command of COMMANDS) {
            const h = await harness();
            h.state.settings.smart = smart;
            seed(h, kind, state);
            const before = snapshot(h);
            const sender = parseSender(SENDERS[kind].address);
            if (sender === null) {
              throw new Error("no sender");
            }
            const block = command.startsWith("block");
            const preview = commandEffect(h.state, command, sender, "account1");
            const message_ = h.mail.put(block ? INBOX1 : JUNK1, { author: SENDERS[kind].address });
            const outcome = await h.engine.runCommand(command, [message_]);
            const changed = diff(before, snapshot(h));

            // What changes is the target and the entries the command lifts, and nothing else.
            const named = [...(preview.change === "none" ? [] : [entryKey(preview.target.kind, preview.target.value, preview.scope)]), ...preview.lifted.map(keyOf)].sort();
            const sourceOnly = changed.keys.filter((key) => !named.includes(key));
            // An entry that is on the list already is only marked as made by hand: its place on the lists does not change.
            expect(sourceOnly.every((key) => before.get(key)?.list === h.state.entries.get(key)?.list), `${command} / ${state}`).toBe(true);
            expect(changed.keys.filter((key) => named.includes(key)), `${command} / ${state}`).toEqual(named);
            // The result line names the target and every lifted entry.
            const said = commandLines(outcome);
            expect(said.join("\n")).toContain(preview.target.value);
            for (const lifted of preview.lifted) {
              expect(said.some((line) => line.startsWith(block ? "Removed from the white list" : "Removed from the black list") && line.includes(lifted.value)), `${command} / ${state}: ${lifted.value}`).toBe(true);
            }
            expect(outcome.plan.lifted.map(keyOf).sort()).toEqual(preview.lifted.map(keyOf).sort());
            // The command takes effect.
            expect(commandEffect(h.state, command, sender, "account1")).toMatchObject({ change: "none", lifted: [] });
            // The tooltip of the button says the same beforehand.
            const tip = commandTitle(command, { target: preview.target, change: preview.change, lifted: preview.lifted, moves: true, kept: preview.kept });
            if (preview.change !== "none") {
              expect(tip).toContain(preview.target.value);
            }
            // An entry of the other list that decided the sender and is still there afterwards is named as staying, and no other entry is.
            const decidedBefore = matchSender(before, sender, "account1");
            const stays = decidedBefore !== null && decidedBefore.list !== (block ? "black" : "white") && h.state.entries.get(keyOf(decidedBefore))?.list === decidedBefore.list;
            expect(preview.kept === null ? null : keyOf(preview.kept), `${command} / ${state}`).toBe(stays ? keyOf(decidedBefore) : null);
            expect(tip.endsWith(`The entry ${decidedBefore?.value ?? ""} stays on the ${decidedBefore?.list ?? ""} list.`), `${command} / ${state}`).toBe(stays);
            for (const lifted of preview.lifted) {
              expect(tip).toContain(lifted.value);
            }
            // Undo restores the lists exactly, and the message.
            await h.engine.undoCommand(outcome.undo);
            expect(snapshot(h)).toEqual(before);
            expect(h.mail.ids(block ? INBOX1 : JUNK1)).toEqual([message_.id]);

            const domainRow = command.endsWith("domain");
            const label = domainRow
              ? preview.target.kind === "domain"
                ? `"${message(POPUP_LABEL[command])}" under "${decidedBefore?.kind === "domain" && decidedBefore.value === preview.target.value ? message("popupDomainDeciding", [preview.target.value]) : `${message("popupDomain")} ${preview.target.value}:`}"`
                : `(the panel shows no domain row for a public provider: "${message("popupPublicNote")}")`
              : `"${message(POPUP_LABEL[command])}"`;
            lines.push(
              `  ${command}`,
              `    label in the panel: ${label}; as shortcut and in the context menu: "${message(MENU_LABEL[command])}"`,
              `    tooltip in the panel: ${tip}`,
              `    changes: ${changed.text}; the message moves to ${block ? "Junk" : "the Inbox"}`,
              `    result: ${said.join(" | ")}`,
              "    Undo: the lists exactly as before, the message back where it was",
            );
          }
        }
      });
    }
  }
});

describe("the action of a log row", () => {
  const ROWS: Record<string, Partial<LogEntry>> = {
    "Blocked, moved to Junk": { outcome: "blocked", action: "junk", reason: "black-address" },
    "Spam, moved to Junk": { outcome: "spam", action: "junk", reason: "ai-above" },
    "Spam, would go to Junk (observed)": { outcome: "spam", action: "junk", reason: "ai-above", observed: true },
    "No verdict, moved to the screening folder": { outcome: "no-verdict", action: "screening", reason: "no-ai" },
    "No verdict, left where it is": { outcome: "no-verdict", action: "none", reason: "no-ai" },
    Passed: { outcome: "passed", action: "none", reason: "ai-below" },
    Trusted: { outcome: "trusted", action: "none", reason: "white-domain" },
    "Released, moved to the Inbox": { outcome: "released", action: "inbox", reason: "whitelisted" },
  };

  for (const kind of Object.keys(SENDERS) as SenderKind[]) {
    it(`${kind}: every decision against every state of the lists`, async () => {
      section(`The action of a log row. Sender: ${kind}.`);
      for (const [rowName, partial] of Object.entries(ROWS)) {
        lines.push("", `Row: ${rowName}`);
        for (const state of Object.keys(STATES)) {
          const h = await harness();
          seed(h, kind, state);
          const before = snapshot(h);
          const entry: LogEntry = {
            time: 1,
            accountId: "account1",
            account: "Work",
            sender: SENDERS[kind].address,
            via: "",
            subject: "Subject",
            outcome: "spam",
            action: "junk",
            score: null,
            accessPoint: "",
            reason: "",
            detail: "",
            observed: false,
            test: false,
            messageId: "m@test",
            ...partial,
          };
          const action = fittingAction(entry);
          if (action === null) {
            throw new Error("no action");
          }
          const scoped = { entries: h.state.entries, publicDomains: h.state.publicDomains, newEntryScope: (accountId: string) => h.state.newEntryScope(accountId) };
          const offer = logOffer(scoped, entry, action);
          if (offer === null) {
            throw new Error("no offer");
          }
          const said = logLabel(offer, expectsMove(entry, action));
          const outcome = await h.engine.runLogAction(entry, action);
          const changed = diff(before, snapshot(h));
          // Exactly the entry the label names changes, or nothing.
          expect(changed.keys, `${rowName} / ${state}`).toEqual(offer.change === "none" ? [] : [entryKey(offer.target.kind, offer.target.value, offer.scope)]);
          if (offer.change !== "none") {
            expect(said.label.endsWith(offer.target.kind), `${rowName} / ${state}`).toBe(true);
            expect(said.titleArgs[0]).toBe(offer.target.value);
          }
          // The action takes effect.
          expect(logOffer(scoped, entry, action)?.change).toBe("none");
          const result = logResult(outcome);
          expect(message(`logResult_${result.code.replace(/-/g, "_")}`, result.args)).toContain(offer.target.value);
          await h.engine.undoLogAction(outcome.undo);
          expect(snapshot(h)).toEqual(before);

          const key = (prefix: string, code: string): string => `${prefix}_${code.replace(/-/g, "_")}`;
          lines.push(
            `  Lists: ${state}`,
            `    ${said.acts ? "button" : "note, no button"}: "${message(key("logLabel", said.label))}"; tooltip: ${message(key("logTitle", said.title), said.titleArgs)}`,
            `    changes: ${changed.text}${said.acts && expectsMove(entry, action) ? `; the message moves to ${action === "trust" ? "the Inbox" : "Junk"}` : ""}`,
            `    result: ${message(key("logResult", result.code), result.args)}`,
            "    Undo: the lists exactly as before, the message back where it was",
          );
        }
      }
    });
  }
});

describe("the add row, the remove button and the merge of an import", () => {
  it("add and remove change one entry and say which", async () => {
    section("The add row of the Lists pane (Add), and the remove button of a row");
    for (const state of Object.keys(STATES)) {
      for (const [list, value] of [
        ["white", SENDERS.company.address],
        ["black", SENDERS.company.domain],
      ] as const) {
        const h = await harness();
        seed(h, "company", state);
        const before = snapshot(h);
        const added = manualEntry({ list, value, scope: "all" }, ["account1", "account2"]);
        const result = h.state.addEntry(added, 9);
        const changed = diff(before, snapshot(h));
        const key = entryKey(added.kind, added.value, added.scope);
        // Only the entry that was typed changes, whatever else is on the lists.
        expect(changed.keys.filter((other) => other !== key)).toEqual([]);
        const said =
          result === "added"
            ? message(list === "white" ? "listsAddedWhite" : "listsAddedBlack", [value])
            : result === "moved"
              ? message(list === "white" ? "listsMovedWhite" : "listsMovedBlack", [value])
              : message("listsAlreadyThere", [value]);
        lines.push(`  Lists: ${state}. Add ${value} to the ${list} list: changes: ${changed.text}; result: ${said}`);
      }
    }
    const h = await harness();
    seed(h, "company", "black address inside a white domain");
    const before = snapshot(h);
    const removed = h.state.entries.get(entryKey("address", SENDERS.company.address, "all")) as Entry;
    h.state.removeEntry(keyOf(removed));
    expect(diff(before, snapshot(h)).keys).toEqual([keyOf(removed)]);
    h.state.restoreEntry(removed);
    expect(snapshot(h)).toEqual(before);
    lines.push(
      "",
      `  Remove (the trash can of a row, named "${message("removeNamed", [removed.value])}"): removes that entry; result: ${message("listsRemoved", [removed.value])}`,
      `  Undo: puts the entry back exactly as it was, with its source and date; result: ${message("listsRestored", [removed.value])}`,
    );
  });

  it("a merge adds, moves entries that are on the other list here, and can be taken back exactly", async () => {
    section('Export and import: "Merge lists"');
    const source = await harness();
    seed(source, "company", "black address inside a white domain");
    source.state.entries.set(entryKey("domain", "new.example", "all"), { list: "white", kind: "domain", value: "new.example", scope: "all", source: "sent", addedAt: 4 });
    const accounts = [{ id: "account1", name: "Work", email: "me@mycompany.example" }];
    const { file } = buildExport(source.state, accounts, 10);

    const h = await harness();
    seed(h, "company", "white address inside a black domain");
    const before = snapshot(h);
    const report = applyImport(h.state, JSON.parse(JSON.stringify(file)), "merge", { accounts, folders: new Set(), newId: () => "id", needsSecret: () => true, checkAccessPoint: checkImportedDefinition });
    const changed = diff(before, snapshot(h));
    expect(report).toMatchObject({ entriesAdded: 1, entriesReplaced: 2, entriesUnchanged: 0 });
    const undo = report.undo;
    if (undo === null) {
      throw new Error("no undo");
    }
    expect([...undo.remove, ...undo.restore.map(keyOf)].sort()).toEqual(changed.keys);
    for (const key of undo.remove) {
      h.state.removeEntry(key);
    }
    for (const entry of undo.restore) {
      h.state.restoreEntry(entry);
    }
    expect(snapshot(h)).toEqual(before);
    lines.push(
      `  Said before the click: ${message("importHint")}`,
      "  Lists here: white address inside a black domain. File: black address inside a white domain, and the white domain new.example.",
      `  changes: ${changed.text}`,
      `  result: ${message("importEntries", [report.entriesAdded, report.entriesReplaced, report.entriesUnchanged])} With the button "${message("undo")}".`,
      `  Undo: removes what was added and puts back what was moved, exactly; result: ${message("importUndone", [undo.remove.length, undo.restore.length])}`,
      `  "Replace everything" asks first: ${message("importReplaceText")}`,
    );
  });
});
