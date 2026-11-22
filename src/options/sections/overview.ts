// Overview: what the add-on does, the protection switch with its state, observation
// mode as its option, a status line and warnings, the three setup steps, and the ways
// to block and trust by hand.

import { DEFAULT_FORWARD_LABELS } from "../../core/forward";
import { entriesFromArray, whiteListIsOnlyIdentities } from "../../core/lists";
import { findProblems, scanIsComplete, scanStep } from "../../core/problems";
import { DEFAULT_CUTOFF } from "../../core/score";
import type { SettingName } from "../../core/settings";
import { aiHealth, summarizeDay } from "../../core/stats";
import type { DaySummary } from "../../core/stats";
import { stringsLocale, t, tCode, tn } from "../../tb/i18n";
import { send } from "../../tb/protocol";
import { remedyOf, refreshGrants } from "../aiState";
import { bar, button, byId, checkRow, description, dialog, download, guard, h, learnMore, notice, reconcile, replace, setUnavailable, tNodes, whileBusy } from "../dom";
import type { Child, Keyed } from "../dom";
import { formatScore, formatShortTime } from "../format";
import { icon } from "../icons";
import { logReader } from "../logData";
import { accountName, forgetAccounts } from "../model";
import type { Model } from "../model";
import type { Section, Shell } from "../section";
import { loadShortcutKeys } from "../shortcutKeys";
import { scanStatusView } from "./scanStatus";

function learned(model: Model): boolean {
  return !whiteListIsOnlyIdentities(entriesFromArray(model.entries));
}

/** Nobody but the user is on the white list, and no scan of this session ran to its end and found that there is nobody. */
function nothingLearned(model: Model): boolean {
  return !learned(model) && !scanIsComplete(model.status.scan);
}

/** With AI switched on and nothing learned, mail from existing contacts would be scored. */
function aiBeforeScan(model: Model): boolean {
  return model.accessPoints.some((point) => point.enabled) && nothingLearned(model);
}

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

  /**
   * Switching protection on while the AI would get mail from existing contacts asks
   * first, and offers the scan that prevents it.
   */
  function requestProtection(on: boolean): void {
    repaired.clear();
    void guard(async () => {
      if (on && model !== null && model.status.scan?.running === true && model.accessPoints.some((point) => point.enabled)) {
        // A scan is running and has not learned everyone yet, also when it has learned some: the question is whether to wait for it.
        protection.input.checked = false;
        const choice = await dialog({
          title: t("scanWaitTitle"),
          body: [t("scanWaitText")],
          confirmLabel: t("scanWait"),
          extraLabel: t("switchOnAnyway"),
          hideCancel: true,
          focus: "confirm",
        });
        if (choice !== "extra") {
          return;
        }
      } else if (on && model !== null && aiBeforeScan(model)) {
        // Nothing is switched on before the answer, and the box says so while the question is open.
        protection.input.checked = false;
        const choice = await dialog({
          title: t("scanFirstTitle"),
          body: [t("warnAiBeforeScan"), t("scanFirstText")],
          confirmLabel: t("scanFirst"),
          extraLabel: t("switchOnAnyway"),
          focus: "confirm",
        });
        if (choice === "confirm") {
          await startFullScan();
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
            await shell.refresh();
            repaired.show(t("fatalRepaired", label, standard));
            // The button that was pressed is gone with the warning: the confirmation takes the focus and is read.
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

  /** One warning per problem, each with the way to its fix. */
  function warningBars(current: Model): Keyed[] {
    const settings = current.settings;
    if (settings === null) {
      return [];
    }
    const warning = (key: string, signature: string, text: Child[], action: HTMLElement | null): Keyed => ({
      key,
      signature,
      build: () => bar("warning", text, [action]),
    });
    const fix = (label: string, focus: string, onclick: () => void): HTMLElement =>
      h("button", { type: "button", text: label, attrs: { "data-focus": focus }, onclick });
    const problems = findProblems({
      settings,
      accessPoints: current.accessPoints,
      accounts: current.accounts,
      onlyOwnAddresses: nothingLearned(current),
      now: Date.now(),
    });
    const bars: Keyed[] = [];
    for (const problem of problems) {
      if (problem.kind === "ai-before-scan") {
        // The scan is offered once, by setup step 1 right below: the warning points there.
        bars.push(warning("ai-before-scan", "", [t("warnAiBeforeScan"), " ", t("warnAiBeforeScanFix")], null));
      } else if (problem.kind === "no-junk") {
        const name = accountName(current, problem.accountId);
        bars.push(
          warning(
            `no-junk:${problem.accountId}`,
            name,
            [t("warnNoJunk", name)],
            fix(t("checkAgain"), "check", () => {
              forgetAccounts();
              void shell.refresh();
            }),
          ),
        );
      } else if (problem.kind === "attention") {
        const point = current.accessPoints.find((item) => item.id === problem.accessPointId);
        if (point !== undefined) {
          const remedy = remedyOf(point);
          bars.push(
            warning(
              `attention:${point.id}`,
              `${point.name}|${remedy}`,
              [t("warnNeedsAttention", point.name), " ", tCode("remedy", remedy)],
              // A warning about the key leads to the key: the editor opens with that field focused.
              fix(t("editNamed", point.name), "edit", () =>
                shell.go("ai", remedy === "key-rejected" || remedy === "key-missing" ? { kind: "ai-edit", id: point.id, focus: "key" } : { kind: "ai-edit", id: point.id }),
              ),
            ),
          );
        }
      } else if (problem.kind === "ai-down") {
        bars.push(warning("ai-down", "", [t("warnAiDown")], fix(t("openAi"), "ai", () => shell.go("ai"))));
      } else {
        const accountId = problem.accountId;
        const name = accountName(current, accountId);
        bars.push(
          warning(
            `no-screening:${accountId}`,
            name,
            [t("warnNoScreening", name)],
            fix(t("chooseScreening"), "screening", () => shell.go("incoming", { kind: "screening", accountId })),
          ),
        );
      }
    }
    return bars;
  }

  function renderStatusLine(current: Model, problems: boolean): void {
    const settings = current.settings;
    if (settings === null) {
      return;
    }
    const on = settings.protection;
    const kind = !on ? "off" : problems ? "problems" : settings.observation ? "observing" : "on";
    const signature = `${kind}`;
    if (state.dataset.kind !== signature) {
      state.dataset.kind = signature;
      state.className = `state ${kind}`;
      replace(
        state,
        icon(kind === "problems" ? "warning" : kind === "off" ? "off" : "success"),
        t(kind === "off" ? "stateOff" : kind === "problems" ? "stateProblems" : kind === "observing" ? "stateObserving" : "stateOn"),
      );
    }

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
    const signature = JSON.stringify([scan, hasAi, settings.protection, complete, noAccounts]);
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
      // Without a mail account there is nothing to scan: the button says what is missing.
      setUnavailable(scanButton, true, t("noAccounts"));
    }
    const steps = h(
      "ol",
      { class: "steps" },
      step(
        scan === "done" ? "done" : scan === "running" ? "running" : "todo",
        t("step1Title"),
        t("step1Text"),
        // Without a mail account the step says in words why its button is unavailable.
        noAccounts && scan !== "running" ? h("div", {}, h("p", { text: t("noAccounts") }), scanStatus.element) : scanStatus.element,
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
        settings.protection
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
    const bars = warningBars(current);
    reconcile(warnings, bars);
    renderStatusLine(current, bars.length > 0);
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
    leave() {
      repaired.clear();
    },
  };
}
