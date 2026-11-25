// Overview: what the add-on does, the protection switch with its state, observation
// mode as its option, a status line and warnings (one per cause), the three setup
// steps, and the ways to block and trust by hand.

import { accountProtected } from "../../core/folders";
import { DEFAULT_FORWARD_LABELS } from "../../core/forward";
import { scanStep } from "../../core/problems";
import type { Remedy } from "../../core/problems";
import { DEFAULT_CUTOFF } from "../../core/score";
import type { SettingName } from "../../core/settings";
import { aiHealth, summarizeDay } from "../../core/stats";
import type { DaySummary } from "../../core/stats";
import { stringsLocale, t, tCode, tn } from "../../tb/i18n";
import { send } from "../../tb/protocol";
import { beforeScanText, noVerdictOutcomeText, scanFirstReason, scanWaitReason, servicesOutcomeText, wishOutcomeText } from "../../tb/stateText";
import { refreshGrants } from "../aiState";
import { announce, bar, button, byId, checkRow, closeButton, description, dialog, download, guard, h, iconButton, learnMore, named, notice, paneLink, reconcile, replace, setUnavailable, tNodes, whileBusy } from "../dom";
import type { Child, Keyed } from "../dom";
import { formatLogTime, formatScore, formatShortTime } from "../format";
import { icon } from "../icons";
import { logReader } from "../logData";
import { accountName, forgetAccounts } from "../model";
import type { Model } from "../model";
import { actsOnUnknownSenders } from "../../core/problems";
import { beforeScan, effectsOf, learned, problemsOf, stateOf } from "../problems";
import type { Section, Shell } from "../section";
import { loadShortcutKeys } from "../shortcutKeys";
import { drawState } from "../state";
import { scanStatusView } from "./scanStatus";

function startOfToday(): number {
  return new Date().setHours(0, 0, 0, 0);
}

/** The group or the field of the page a stored setting belongs to, as the page names it. */
const SETTING_LABELS: Partial<Record<SettingName, () => string>> = {
  protection: () => t("protectionTitle"),
  observation: () => t("observationTitle"),
  newEntryScope: () => t("newEntriesTitle"),
  noVerdictAction: () => t("noVerdictTitle"),
  smart: () => t("smartTitle"),
  periodicCheck: () => t("periodicLabel"),
  cutoff: () => t("cutoffTitle"),
  prompt: () => t("promptTitle"),
  publicDomainsAdded: () => t("publicAddedTitle"),
  publicDomainsRemoved: () => t("publicRemovedTitle"),
  forwardingMailboxes: () => t("forwardingTitle"),
  forwardLabels: () => t("forwardLabelsTitle"),
  sentFoldersAdded: () => t("sentFoldersTitle"),
  sentFoldersRemoved: () => t("sentFoldersTitle"),
  monitoredFoldersAdded: () => t("monitoredTitle"),
  accountSwitches: () => t("incomingAccountsTitle"),
  screeningFolders: () => t("screeningTitle"),
};

function settingLabel(name: string): string {
  return (SETTING_LABELS[name as SettingName] ?? (() => t("settingInternal")))();
}

/** The default of a setting in words, for the offer to set it back. */
function settingDefault(name: string): string {
  switch (name as SettingName) {
    case "cutoff":
      return formatScore(DEFAULT_CUTOFF, stringsLocale());
    case "prompt":
      return t("settingDefaultPrompt");
    case "protection":
    case "observation":
      return t("settingOff");
    case "smart":
    case "periodicCheck":
      return t("settingOn");
    case "newEntryScope":
      return t("scopeShared");
    case "noVerdictAction":
      return t("noVerdictLeave");
    case "forwardLabels":
      return DEFAULT_FORWARD_LABELS.join(", ");
    case "publicDomainsAdded":
    case "publicDomainsRemoved":
    case "forwardingMailboxes":
    case "sentFoldersAdded":
    case "sentFoldersRemoved":
    case "monitoredFoldersAdded":
    case "accountSwitches":
    case "screeningFolders":
      return t("settingDefaultList");
    default:
      return t("settingDefaultInternal");
  }
}

export function overviewSection(shell: Shell): Section {
  const root = byId("overview");
  let model: Model | null = null;
  let today: DaySummary | null = null;

  const fatalBox = h("div", { class: "fatal" });
  const body = h("div");
  const state = h("span", { class: "state" });
  const protection = checkRow("protection-switch", t("protectionLabel"), (checked) => requestProtection(checked));
  /** Said while protection waits for the scan: what will happen, and the way to call it off. */
  const wishNote = h(
    "div",
    { class: "option-note plain indent", id: "protection-wish", hidden: true, attrs: { role: "status" } },
    icon("clock"),
    h("span", { text: t("wishWaiting"), id: "protection-wish-text" }),
  );
  /** "Don’t switch on": it is described by the sentence it stands in, so that the focus that lands on it reads both. */
  const wishCancel = button(
    t("wishCancel"),
    () =>
      void guard(async () => {
        // The note goes away with the wish: the keyboard goes back to the switch it belongs to.
        protection.input.focus();
        await send("clearProtectionWish", {});
        await shell.refresh();
      }),
    "small",
  );
  wishCancel.setAttribute("aria-describedby", "protection-wish-text");
  wishNote.appendChild(wishCancel);
  /** What became of AI services that waited for the scan: switched on, or why not. It stays until it is dismissed or the pane is left. */
  const servicesOutcome = h("div", { class: "notice", tabIndex: -1, attrs: { role: "group" } });
  /** What became of the choice to move mail without an AI verdict that waited for the scan. It stays until it is dismissed or the pane is left. */
  const choiceOutcome = h("div", { class: "notice", tabIndex: -1, attrs: { role: "group" } });
  /** When "Check again" was last pressed and found the problem still there. Null before that, and once the problem is gone. */
  let junkCheckedAt: number | null = null;
  const junkCheckedText = (): string => (junkCheckedAt === null ? "" : t("checkAgainStill", formatLogTime(junkCheckedAt, Date.now())));
  /** What became of protection that waited for the scan: switched on, or why not. It stays until it is dismissed or protection is switched. */
  const wishOutcome = h("div", { class: "notice", tabIndex: -1, attrs: { role: "group" } });
  // The answer to "is it working": directly under the heading with the state, before the switch and its options.
  const statusLine = h("p", { class: "status-line" });
  const warnings = h("div", { class: "warnings" });
  const setup = h("div", { class: "setup" });
  /** What a repair of stored data did. It stays until protection is switched. */
  const repaired = notice();
  const observation = checkRow("observation-switch", t("observationLabel"), (checked) =>
    void guard(() => send("updateSettings", { patch: { observation: checked } })),
  );
  const observationNote = h("div", { class: "option-note indent", id: "observation-note", hidden: true, attrs: { role: "status" } }, icon("info"), t("observationOff"));
  const scanStatus = scanStatusView(() => shell.go("learning"));
  const byHand = h("p", { class: "ways-short" });

  replace(
    body,
    // The page is read from the top, so it stands in the order of doing: the steps of setup first, protection after them.
    // Once setup is complete it is one line that opens.
    h("h2", { text: t("setupTitle") }),
    setup,
    h("h2", {}, t("protectionTitle"), " ", state),
    statusLine,
    // What needs attention follows the state directly, before the switch and its options: the outcome of something that waited, then the warnings.
    wishOutcome,
    servicesOutcome,
    repaired.element,
    warnings,
    protection.row,
    description(
      t("protectionHint"),
      learnMore(t("protectionTitle"), h("p", {}, ...tNodes("protectionMore", paneLink("incoming", t("catIncoming"), () => shell.go("incoming", { kind: "no-verdict" }))))),
      "indent",
    ),
    wishNote,
    // Observation mode is an option of the switch: it stands under it, indented, and can be set before protection is on.
    h(
      "div",
      { class: "sub-option" },
      observation.row,
      h("div", { class: "description indent", id: "observation-hint" }, ...tNodes("observationHint", paneLink("log", t("catLog"), () => shell.go("log")))),
      observationNote,
    ),
    h("h2", { text: t("byHandTitle") }),
    byHand,
  );
  replace(root, h("h1", { text: t("catOverview"), tabIndex: -1 }), h("p", { class: "lead", text: t("overviewLead") }), fatalBox, body);
  // The third outcome of a scan that something waited for stands directly after the second, wherever that stands.
  servicesOutcome.after(choiceOutcome);

  async function startFullScan(): Promise<void> {
    await send("startScan", { from: null, to: null });
    shell.startPolling();
    await shell.refresh();
  }

  /** The wish is kept: protection is switched on by the background when the scan has finished, also when this page is closed by then. */
  async function protectAfterScan(): Promise<void> {
    await send("protectAfterScan", {});
    shell.startPolling();
    await shell.refresh();
  }

  /**
   * Switching protection on while mail from existing contacts would be sent to an AI service or moved (the sent
   * mail is not scanned, and a service is on or mail without a verdict is moved) asks first, and the question names
   * what would happen. The answer that scans or waits keeps the wish: protection follows the scan.
   */
  function requestProtection(on: boolean): void {
    repaired.clear();
    void guard(async () => {
      // Asked of the background at this moment: a scan can have started or ended since the page last heard of it.
      const status = on && model !== null ? await send("getStatus", {}).catch(() => model?.status ?? null) : null;
      const current = model !== null && status !== null ? { ...model, status } : model;
      const effects = current === null ? null : effectsOf(current);
      const scanning = on && current !== null && effects !== null && current.status.scan?.running === true && actsOnUnknownSenders(effects);
      const unscanned = on && current !== null && !scanning ? beforeScan(current) : null;
      if (effects !== null && (scanning || unscanned !== null)) {
        // Nothing is switched on before the answer, and the box says so while the question is open.
        protection.input.checked = false;
        const choice = await dialog(
          scanning
            ? // A scan is running and has not learned everyone yet, also when it has learned some: the question is whether to wait for it.
              { title: t("scanWaitTitle"), body: [scanWaitReason(effects)], confirmLabel: t("scanWait"), extraLabel: t("switchOnAnyway"), focus: "confirm" }
            : { title: t("scanFirstTitle"), body: [scanFirstReason(effects), t("scanFirstText")], confirmLabel: t("scanFirst"), extraLabel: t("switchOnAnyway"), focus: "confirm" },
        );
        if (choice === "confirm") {
          await protectAfterScan();
          const active = document.activeElement;
          if (!wishNote.hidden && (active === null || active === document.body || (active instanceof HTMLElement && active.matches("section.pane > h1")))) {
            // The button of setup step 3 that asked is gone with the wish: the keyboard goes on with the note
            // under the switch, which says what will happen and offers to call it off.
            wishCancel.focus();
          }
        }
        if (choice !== "extra") {
          return;
        }
      }
      await send("setProtection", { on });
    });
  }

  /**
   * Stored data that failed validation. When all that is wrong is the stored value of
   * one or more settings, each can be set back to its default on its own. The reset of
   * everything is the last resort. Nothing is repaired without the user asking for it.
   */
  function renderFatal(message: string, repair: readonly string[] | null): void {
    const repairs = (repair ?? []).map((name) => {
      const label = settingLabel(name);
      const standard = settingDefault(name);
      const reset = button(t("fatalRepair"), () =>
        void whileBusy(reset, () =>
          guard(async () => {
            await send("repairSetting", { name });
            // The button that was pressed goes away with the warning. It gives the focus up first, so that the focus ring follows to the confirmation.
            reset.blur();
            await shell.refresh();
            repaired.show(t("fatalRepaired", label, standard));
            repaired.element.focus({ preventScroll: true });
          }),
        ),
      );
      reset.setAttribute("aria-label", t("fatalRepairNamed", label));
      return h("div", { class: "row repair" }, h("span", { class: "repair-text", text: t("fatalRepairText", label, standard) }), reset);
    });
    replace(
      fatalBox,
      bar("critical", [h("strong", { text: t("fatalTitle") }), " ", t("fatalText")]),
      h("pre", { class: "code-block", text: message }),
      repairs.length === 0 ? null : h("p", { text: t("fatalRepairLead") }),
      ...repairs,
      repairs.length === 0 ? null : h("p", { class: "last-resort", text: t("fatalLastResort") }),
      h(
        "div",
        { class: "row" },
        button(t("fatalDownload"), () =>
          void guard(async () => {
            // Read-only: the page reads storage but never writes it.
            const raw = await browser.storage.local.get(null);
            download("block-spam-raw-data.json", JSON.stringify(raw, null, 2));
          }),
        ),
        button(t("fatalReset"), () =>
          void dialog({
            title: t("fatalResetTitle"),
            body: [t("fatalResetText")],
            confirmLabel: t("fatalResetConfirm"),
            danger: true,
            onConfirm: async () => {
              await send("resetData", {});
              await shell.refresh();
            },
          }),
        ),
      ),
      description(t("fatalDownloadHint")),
    );
  }

  /** One warning per cause, each with the way to its fix. Accounts and services that share a cause are named in one sentence. */
  function warningBars(current: Model): Keyed[] {
    if (current.settings === null) {
      return [];
    }
    const warning = (key: string, signature: string, text: Child[], action: HTMLElement | null): Keyed => ({
      key,
      signature,
      build: () => bar("warning", text, [action]),
    });
    const fix = (label: string, focus: string, onclick: () => void): HTMLElement =>
      h("button", { type: "button", text: label, attrs: { "data-focus": focus }, onclick });
    const bars: Keyed[] = [];
    if (current.accounts.length === 0) {
      // Without a mail account there is nothing to scan and nothing to protect: said once, here.
      bars.push(warning("no-accounts", "", [t("noAccounts")], null));
    }
    for (const problem of problemsOf(current)) {
      if (problem.kind === "before-scan") {
        // One cause, one warning: it says what happens to mail from people the user already writes to (sent to the AI
        // service, moved, or both). While protection is on it happens, while it is off it would. Its button starts the scan.
        const on = current.settings.protection;
        const scanning = current.status.scan?.running === true;
        const text = beforeScanText(problem, on);
        const scanButton: HTMLButtonElement = button(t("scanStart"), () => void whileBusy(scanButton, () => guard(startFullScan)));
        scanButton.dataset.focus = "scan-first";
        if (scanning) {
          // The scan is running and has not learned anyone yet: the button has nothing to start, and step 1 below shows its progress.
          setUnavailable(scanButton, true, t("errorScanRunning"));
        }
        bars.push({ key: "before-scan", signature: JSON.stringify([text, scanning]), build: () => bar("warning", [text], [scanButton]) });
      } else if (problem.kind === "no-junk") {
        const names = problem.accountIds.map((id) => accountName(current, id)).join(", ");
        // The button checks the accounts again. When the folder is still missing, the bar says that it checked and what it found.
        const checked = h("div", { class: "bar-status", id: "junk-checked", attrs: { role: "status" } });
        const again: HTMLButtonElement = button(t("checkAgain"), () =>
          void whileBusy(again, () =>
            guard(async () => {
              forgetAccounts();
              await shell.refresh();
              // Still here: the problem remains. A bar that is gone needs no answer, the warning itself was it.
              const status = document.getElementById("junk-checked");
              if (status !== null) {
                junkCheckedAt = Date.now();
                announce(status, junkCheckedText());
              }
            }),
          ),
        );
        again.dataset.focus = "check";
        // The name says which accounts are checked.
        named(again, names);
        bars.push({
          key: "no-junk",
          signature: names,
          build: () => {
            checked.textContent = junkCheckedText();
            return bar("warning", [t(problem.accountIds.length === 1 ? "warnNoJunk" : "warnNoJunkMany", names), checked], [again]);
          },
        });
      } else if (problem.kind === "attention") {
        const points = current.accessPoints.filter((item) => problem.accessPointIds.includes(item.id));
        const [first] = points;
        if (first === undefined) {
          continue;
        }
        const remedy: Remedy = problem.remedy;
        const names = points.map((point) => point.name).join(", ");
        // A warning about the key leads to the key: the editor opens with that field focused.
        const keyed = remedy === "key-rejected" || remedy === "key-missing";
        bars.push(
          points.length === 1
            ? warning(
                `attention:${remedy}`,
                `${first.id}|${names}`,
                [t("warnNeedsAttention", names), " ", tCode("remedy", remedy)],
                fix(t("editNamed", first.name), "edit", () => shell.go("ai", keyed ? { kind: "ai-edit", id: first.id, focus: "key" } : { kind: "ai-edit", id: first.id })),
              )
            : warning(
                `attention:${remedy}`,
                `${first.id}|${names}`,
                [t("warnNeedsAttentionMany", names), " ", tCode("remedyMany", remedy)],
                // Several services share the cause: the button leads to the first of them in the list.
                fix(t("openAi"), "edit", () => shell.go("ai", { kind: "ai-service", id: first.id })),
              ),
        );
      } else if (problem.kind === "ai-down") {
        // The sentence also says what then happens to such mail: where the choice of Incoming mail sends it.
        const action = current.settings.noVerdictAction;
        bars.push(warning("ai-down", action, [tCode("warnAiDown", action)], fix(t("openAi"), "ai", () => shell.go("ai"))));
      } else {
        const [firstAccount] = problem.accountIds;
        const names = problem.accountIds.map((id) => accountName(current, id)).join(", ");
        const many = problem.accountIds.length > 1;
        bars.push(
          warning(
            "no-screening",
            names,
            [t(many ? "warnNoScreeningMany" : "warnNoScreening", names)],
            // The button leads to the menu of the first account that has no folder.
            fix(t(many ? "chooseScreeningMany" : "chooseScreening"), "screening", () => shell.go("incoming", { kind: "screening", accountId: firstAccount ?? "" })),
          ),
        );
      }
    }
    if (!bars.some((item) => item.key === "no-junk")) {
      // The problem is gone: what the last check found is history.
      junkCheckedAt = null;
    }
    return bars;
  }

  /** Protection that waited for the scan: the note while it waits, and afterwards what became of it. */
  function renderWish(current: Model): void {
    const { waiting, outcome } = current.status.wish;
    if (wishNote.hidden === waiting) {
      wishNote.hidden = !waiting;
    }
    const signature = outcome === null ? "" : JSON.stringify(outcome);
    if (wishOutcome.dataset.signature === signature) {
      return;
    }
    wishOutcome.dataset.signature = signature;
    if (outcome === null) {
      wishOutcome.removeAttribute("aria-label");
      replace(wishOutcome);
      return;
    }
    const text = wishOutcomeText(outcome);
    const box = bar(outcome.kind === "on" ? "success" : "warning", [text], [
      iconButton("close", t("dismiss"), () =>
        void guard(async () => {
          // The bar goes away: the keyboard goes back to the switch it was about.
          protection.input.focus();
          await send("clearProtectionWish", {});
          await shell.refresh();
        }),
      ),
    ]);
    box.setAttribute("role", "status");
    wishOutcome.setAttribute("aria-label", text);
    replace(wishOutcome, box);
  }

  /** AI services that waited for the scan: what became of them, with the way to them. */
  function renderServicesOutcome(current: Model): void {
    const outcome = current.status.wish.servicesOutcome;
    const names = outcome === null ? [] : outcome.ids.map((id) => current.accessPoints.find((point) => point.id === id)?.name).filter((name): name is string => name !== undefined);
    const signature = outcome === null || names.length === 0 ? "" : JSON.stringify([outcome, names]);
    if (servicesOutcome.dataset.signature === signature) {
      return;
    }
    servicesOutcome.dataset.signature = signature;
    if (outcome === null || signature === "") {
      servicesOutcome.removeAttribute("aria-label");
      replace(servicesOutcome);
      return;
    }
    const text = servicesOutcomeText(outcome, names);
    const box = bar(outcome.kind === "on" ? "success" : "warning", [text], [
      button(t("openAi"), () => shell.go("ai", { kind: "ai-service", id: outcome.ids[0] ?? "" })),
      iconButton("close", t("dismiss"), () =>
        void guard(async () => {
          // The bar goes away: the keyboard goes back to the switch of the group.
          protection.input.focus();
          await send("clearServiceWish", { id: null });
          await shell.refresh();
        }),
      ),
    ]);
    box.setAttribute("role", "status");
    servicesOutcome.setAttribute("aria-label", text);
    replace(servicesOutcome, box);
  }

  /** The choice to move mail without an AI verdict that waited for the scan: what became of it, with the way to the menu. */
  function renderChoiceOutcome(current: Model): void {
    const outcome = current.status.wish.noVerdictOutcome;
    const signature = outcome === null ? "" : JSON.stringify(outcome);
    if (choiceOutcome.dataset.signature === signature) {
      return;
    }
    choiceOutcome.dataset.signature = signature;
    if (outcome === null) {
      choiceOutcome.removeAttribute("aria-label");
      replace(choiceOutcome);
      return;
    }
    const text = noVerdictOutcomeText(outcome, outcome.action);
    const box = bar(outcome.kind === "on" ? "success" : "warning", [text], [
      // The button says what it shows: the menu of this choice, on the pane it is set on.
      button(t("showSetting"), () => shell.go("incoming", { kind: "no-verdict" })),
      closeButton(() =>
        void guard(async () => {
          // The bar goes away: the keyboard goes back to the switch of the group.
          protection.input.focus();
          await send("clearNoVerdictWish", {});
          await shell.refresh();
        }),
      ),
    ]);
    box.setAttribute("role", "status");
    choiceOutcome.setAttribute("aria-label", text);
    replace(choiceOutcome, box);
  }

  function renderStatusLine(current: Model): void {
    const settings = current.settings;
    if (settings === null) {
      return;
    }
    const on = settings.protection;
    const shown = stateOf(current);
    drawState(state, shown.kind, shown.problems);

    const parts: string[] = [];
    if (on) {
      parts.push(current.lastTick === null ? t("statusNeverChecked") : t("statusLastCheck", formatShortTime(current.lastTick, Date.now())));
      if (!settings.periodicCheck) {
        // Said because the time of the last check then stays old, and that is as it was set up.
        parts.push(t("statusNoPeriodic"));
      }
      if (today !== null) {
        parts.push(
          today.checked === 0
            ? t("statusTodayNone")
            : t("statusToday", tn("statusChecked", today.checked), tn("statusJunk", today.junk), tn("statusScored", today.scored)),
        );
      }
    }
    // Said only when an account is left out, so that "on" is not read as "everywhere".
    const protectedAccounts = current.accounts.filter((account) => accountProtected(settings, account.id)).length;
    if (on && protectedAccounts < current.accounts.length) {
      parts.push(t("statusAccounts", protectedAccounts, current.accounts.length));
    }
    const health = aiHealth(current.accessPoints, Date.now());
    const waitingServices = current.status.wish.services.length;
    if (health.enabled > 0) {
      parts.push(t("statusAi", health.working, health.enabled));
    } else if (current.accessPoints.length > 0 && waitingServices === 0) {
      // While protection is on, the sentence also says what then happens to mail from unknown senders.
      parts.push(on ? tCode("statusAiOffThen", settings.noVerdictAction) : t("statusAiOff"));
    }
    if (waitingServices > 0) {
      parts.push(tn("statusAiWaiting", waitingServices));
    }
    // The line breaks between its sentences, never inside "Last check: …" or "AI services available: 2 of 2.".
    replace(statusLine, ...parts.flatMap((part, index) => [index === 0 ? null : " ", h("span", { class: "sentence", text: part })]));
    statusLine.hidden = parts.length === 0;
  }

  function step(mark: "todo" | "running" | "done", title: string, text: string | Child[], status: HTMLElement | null, action: HTMLElement | null): HTMLElement {
    return h(
      "li",
      { class: `step${mark === "todo" ? "" : ` ${mark}`}` },
      h(
        "span",
        { class: "step-mark", attrs: { "aria-hidden": "true" } },
        mark === "done" ? icon("check", 14) : mark === "running" ? h("span", { class: "spinner" }) : null,
      ),
      h(
        "div",
        { class: "step-text" },
        h(
          "div",
          { class: "step-title" },
          title,
          mark === "todo" ? null : h("span", { class: "visually-hidden", text: ` (${t(mark === "done" ? "stepDone" : "stepRunning")})` }),
        ),
        typeof text === "string" ? description(text) : h("div", { class: "description" }, ...text),
        status === null ? null : h("div", { class: "step-status" }, status),
      ),
      h("div", { class: "step-action" }, action),
    );
  }

  function renderSetup(current: Model): void {
    const settings = current.settings;
    if (settings === null) {
      return;
    }
    scanStatus.update(current);
    const scan = scanStep(current.status.scan, learned(current));
    const hasAi = current.accessPoints.length > 0;
    // A scan that found no sent mail does not hold setup up: there is nobody to learn yet.
    const scanned = scan === "done" || scan === "empty";
    const complete = scanned && settings.protection;
    // While the scan runs nothing is the next step: protection waits for the contacts to be learned.
    const next = scan === "running" ? 0 : !scanned ? 1 : !settings.protection ? 3 : 0;
    const noAccounts = current.accounts.length === 0;
    const waiting = current.status.wish.waiting;
    const signature = JSON.stringify([scan, hasAi, settings.protection, complete, noAccounts, waiting]);
    if (setup.dataset.signature === signature) {
      return;
    }
    const active = document.activeElement;
    const focus = active instanceof HTMLElement && setup.contains(active) ? active.dataset.focus : undefined;
    const wasOpen = setup.querySelector("details")?.open === true;
    setup.dataset.signature = signature;

    const scanButton: HTMLButtonElement =
      scan === "running"
        ? h("button", { type: "button", text: t("scanCancel"), attrs: { "data-focus": "scan" }, onclick: () => void guard(() => send("cancelScan", {})) })
        : // A button that cannot act is never filled: without a mail account the step has nothing to start.
          button(t(scan === "todo" ? "scanStart" : "scanAgain"), () => void whileBusy(scanButton, () => guard(startFullScan)), next === 1 && !noAccounts ? "primary" : "");
    scanButton.dataset.focus = "scan";
    if (noAccounts && scan !== "running") {
      // Without a mail account there is nothing to scan: the tooltip of the button says what is missing, and so does the warning above.
      setUnavailable(scanButton, true, t("noAccounts"));
    }
    const steps = h(
      "ol",
      { class: "steps" },
      step(
        scan === "done" ? "done" : scan === "running" ? "running" : "todo",
        t("step1Title"),
        t("step1Text"),
        scanStatus.element,
        scanButton,
      ),
      step(
        hasAi ? "done" : "todo",
        t("step2Title"),
        // The pane the sentence names is a link to the setting it means.
        tNodes("step2Text", paneLink("incoming", t("catIncoming"), () => shell.go("incoming", { kind: "no-verdict" }))),
        null,
        h("button", {
          type: "button",
          text: t(hasAi ? "openAi" : "step2Add"),
          attrs: { "data-focus": "ai" },
          onclick: () => (hasAi ? shell.go("ai") : shell.go("ai", { kind: "ai-add" })),
        }),
      ),
      step(
        settings.protection ? "done" : "todo",
        t("protectionSwitchOn"),
        t("step3Text"),
        null,
        // While protection waits for the scan, the note under the switch says so and offers to call it off: the step offers nothing.
        settings.protection || waiting
          ? null
          : h("button", {
              type: "button",
              text: t("protectionSwitchOn"),
              class: next === 3 ? "primary" : "",
              attrs: { "data-focus": "protect" },
              onclick: () => requestProtection(true),
            }),
      ),
    );
    replace(
      setup,
      complete
        ? h("details", { class: "setup-complete", open: wasOpen }, h("summary", {}, icon("success"), h("span", { text: t("setupComplete") })), steps)
        : steps,
    );
    if (focus !== undefined) {
      [...setup.querySelectorAll<HTMLElement>("[data-focus]")].find((candidate) => candidate.dataset.focus === focus)?.focus();
    }
  }

  /** The daily actions in one sentence, with the keys as they are set now, and the way to everything else. */
  async function drawByHand(): Promise<void> {
    const { keys } = await loadShortcutKeys().catch(() => ({ keys: new Map<string, string>() }));
    const block = keys.get("block-address");
    const trust = keys.get("trust-address");
    const all = h("a", {
      href: "#block-and-trust",
      text: t("byHandAll"),
      onclick: (event) => {
        event.preventDefault();
        shell.go("block-and-trust");
      },
    });
    const signature = `${block ?? ""}|${trust ?? ""}`;
    if (byHand.dataset.signature === signature) {
      return;
    }
    byHand.dataset.signature = signature;
    replace(
      byHand,
      ...(block === undefined || trust === undefined ? [t("byHandNoKeys")] : tNodes("byHandKeys", h("kbd", { text: block }), h("kbd", { text: trust }))),
      " ",
      all,
    );
  }

  function renderBody(current: Model): void {
    const settings = current.settings;
    if (settings === null) {
      return;
    }
    protection.input.checked = settings.protection;
    observation.input.checked = settings.observation;
    // Ticked while protection is off: nothing happens yet, and the page says so.
    const waiting = settings.observation && !settings.protection;
    observationNote.hidden = !waiting;
    // A hidden note would still be read as part of the description, so it is named only while it shows.
    observation.input.setAttribute("aria-describedby", waiting ? "observation-hint observation-note" : "observation-hint");
    renderWish(current);
    renderServicesOutcome(current);
    renderChoiceOutcome(current);
    reconcile(warnings, warningBars(current));
    renderStatusLine(current);
    renderSetup(current);
  }

  browser.commands.onChanged.addListener(() => void guard(drawByHand));
  void guard(drawByHand);

  return {
    render(next: Model) {
      model = next;
      if (next.status.fatal !== null || next.settings === null) {
        renderFatal(next.status.fatal ?? t("errorNotReady"), next.status.repair);
        fatalBox.hidden = false;
        body.hidden = true;
        return;
      }
      fatalBox.hidden = true;
      body.hidden = false;
      renderBody(next);
      // Today's figures come from the log, and the remedies from the host permissions.
      void (async () => {
        const [log, grantsChanged] = await Promise.all([logReader.load(), refreshGrants(next.accessPoints)]);
        const summary = summarizeDay(log.entries, startOfToday());
        const changed = today === null || JSON.stringify(summary) !== JSON.stringify(today);
        today = summary;
        if ((changed || grantsChanged) && model === next) {
          renderBody(next);
        }
      })().catch((error: unknown) => console.error("Block Spam: the status line could not be drawn", error));
    },
    reveal(intent) {
      if (intent.kind === "protect") {
        // The step that switches protection on, or else the switch itself, which also carries the note while protection waits for the scan.
        const target = setup.querySelector<HTMLElement>('[data-focus="protect"]') ?? protection.input;
        target.scrollIntoView({ block: "center" });
        target.focus();
      }
    },
    leave() {
      repaired.clear();
      // What became of protection that waited for the scan was shown here and is history once the pane is left, like every confirmation in place.
      junkCheckedAt = null;
      const checked = document.getElementById("junk-checked");
      if (checked !== null) {
        checked.textContent = "";
      }
      const wish = model?.status.wish;
      if (wish !== undefined && (wish.outcome !== null || wish.servicesOutcome !== null || wish.noVerdictOutcome !== null)) {
        void Promise.all([
          wish.outcome === null ? null : send("clearProtectionWish", {}),
          wish.servicesOutcome === null ? null : send("clearServiceWish", { id: null }),
          // Only what the last choice came to: a choice that still waits is not called off by leaving the pane.
          wish.noVerdictOutcome === null || wish.noVerdict !== null ? null : send("clearNoVerdictWish", {}),
        ])
          .then(() => shell.refresh())
          .catch(() => undefined);
      }
    },
  };
}
