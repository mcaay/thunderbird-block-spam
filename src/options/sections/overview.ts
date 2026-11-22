// Overview: what the add-on does, the protection switch with its state, observation
// mode as its option, a status line and warnings (one per cause), the three setup
// steps, and the ways to block and trust by hand.

import { DEFAULT_FORWARD_LABELS } from "../../core/forward";
import { scanStep } from "../../core/problems";
import type { Remedy } from "../../core/problems";
import { DEFAULT_CUTOFF } from "../../core/score";
import type { SettingName } from "../../core/settings";
import { aiHealth, summarizeDay } from "../../core/stats";
import type { DaySummary } from "../../core/stats";
import { stringsLocale, t, tCode, tn } from "../../tb/i18n";
import { send } from "../../tb/protocol";
import { wishOutcomeText } from "../../tb/stateText";
import { refreshGrants } from "../aiState";
import { bar, button, byId, checkRow, description, dialog, download, guard, h, iconButton, learnMore, notice, reconcile, replace, setUnavailable, tNodes, whileBusy } from "../dom";
import type { Child, Keyed } from "../dom";
import { formatScore, formatShortTime } from "../format";
import { icon } from "../icons";
import { logReader } from "../logData";
import { accountName, forgetAccounts } from "../model";
import type { Model } from "../model";
import { aiBeforeScan, learned, problemsOf, stateOf } from "../problems";
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
  cutoff: () => t("cutoffTitle"),
  prompt: () => t("promptTitle"),
  publicDomainsAdded: () => t("publicAddedTitle"),
  publicDomainsRemoved: () => t("publicRemovedTitle"),
  forwardingMailboxes: () => t("forwardingTitle"),
  forwardLabels: () => t("forwardLabelsTitle"),
  sentFoldersAdded: () => t("sentFoldersTitle"),
  sentFoldersRemoved: () => t("sentFoldersTitle"),
  monitoredFoldersAdded: () => t("monitoredTitle"),
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
    h("span", { text: t("wishWaiting") }),
    button(
      t("wishCancel"),
      () =>
        void guard(async () => {
          // The note goes away with the wish: the keyboard goes back to the switch it belongs to.
          protection.input.focus();
          await send("clearProtectionWish", {});
          await shell.refresh();
        }),
      "small",
    ),
  );
  /** What became of protection that waited for the scan: switched on, or why not. It stays until it is dismissed or protection is switched. */
  const wishOutcome = h("div", { class: "notice", tabIndex: -1, attrs: { role: "group" } });
  const statusLine = h("p", { class: "status-line indent" });
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
    h("h2", {}, t("protectionTitle"), " ", state),
    protection.row,
    wishNote,
    description(t("protectionHint"), learnMore(t("protectionTitle"), t("protectionMore")), "indent"),
    // Observation mode is an option of the switch: it stands under it, indented, and can be set before protection is on.
    h(
      "div",
      { class: "sub-option" },
      observation.row,
      h("div", { class: "description indent", id: "observation-hint", text: t("observationHint") }),
      observationNote,
    ),
    statusLine,
    repaired.element,
    wishOutcome,
    warnings,
    h("h2", { text: t("setupTitle") }),
    setup,
    h("h2", { text: t("byHandTitle") }),
    byHand,
  );
  replace(root, h("h1", { text: t("catOverview"), tabIndex: -1 }), h("p", { class: "lead", text: t("overviewLead") }), fatalBox, body);

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
   * Switching protection on while the AI would get mail from existing contacts asks
   * first. The answer that scans or waits keeps the wish: protection follows the scan.
   */
  function requestProtection(on: boolean): void {
    repaired.clear();
    void guard(async () => {
      const scanning = on && model !== null && model.status.scan?.running === true && model.accessPoints.some((point) => point.enabled);
      if (scanning || (on && model !== null && aiBeforeScan(model))) {
        // Nothing is switched on before the answer, and the box says so while the question is open.
        protection.input.checked = false;
        const choice = await dialog(
          scanning
            ? // A scan is running and has not learned everyone yet, also when it has learned some: the question is whether to wait for it.
              { title: t("scanWaitTitle"), body: [t("scanWaitText")], confirmLabel: t("scanWait"), extraLabel: t("switchOnAnyway"), focus: "confirm" }
            : { title: t("scanFirstTitle"), body: [t("warnAiBeforeScan"), t("scanFirstText")], confirmLabel: t("scanFirst"), extraLabel: t("switchOnAnyway"), focus: "confirm" },
        );
        if (choice === "confirm") {
          await protectAfterScan();
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
      if (problem.kind === "ai-before-scan") {
        // The scan is offered once, by setup step 1 right below: the warning points there.
        bars.push(warning("ai-before-scan", "", [t("warnAiBeforeScan"), " ", t("warnAiBeforeScanFix")], null));
      } else if (problem.kind === "no-junk") {
        const names = problem.accountIds.map((id) => accountName(current, id)).join(", ");
        bars.push(
          warning(
            "no-junk",
            names,
            [t(problem.accountIds.length === 1 ? "warnNoJunk" : "warnNoJunkMany", names)],
            fix(t("checkAgain"), "check", () => {
              forgetAccounts();
              void shell.refresh();
            }),
          ),
        );
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
        bars.push(warning("ai-down", "", [t("warnAiDown")], fix(t("openAi"), "ai", () => shell.go("ai"))));
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
      if (today !== null) {
        parts.push(
          today.checked === 0
            ? t("statusTodayNone")
            : t("statusToday", tn("statusChecked", today.checked), tn("statusJunk", today.junk), tn("statusScored", today.scored)),
        );
      }
    }
    const health = aiHealth(current.accessPoints, Date.now());
    if (health.enabled > 0) {
      parts.push(t("statusAi", health.working, health.enabled));
    } else if (current.accessPoints.length > 0) {
      parts.push(t("statusAiOff"));
    }
    statusLine.textContent = parts.join(" ");
    statusLine.hidden = parts.length === 0;
  }

  function step(mark: "todo" | "running" | "done", title: string, text: string, status: HTMLElement | null, action: HTMLElement | null): HTMLElement {
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
        description(text),
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
        : button(t(scan === "todo" ? "scanStart" : "scanAgain"), () => void whileBusy(scanButton, () => guard(startFullScan)), next === 1 ? "primary" : "");
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
        t("step2Text"),
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
      if (model?.status.wish.outcome !== null && model?.status.wish.outcome !== undefined) {
        void send("clearProtectionWish", {})
          .then(() => shell.refresh())
          .catch(() => undefined);
      }
    },
  };
}
