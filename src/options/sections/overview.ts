// Overview: what the add-on does, the protection switch with its state, a status
// line and warnings, the three setup steps, and observation mode.

import { entriesFromArray, whiteListIsOnlyIdentities } from "../../core/lists";
import { findProblems, scanIsComplete } from "../../core/problems";
import { aiHealth, summarizeDay } from "../../core/stats";
import type { DaySummary } from "../../core/stats";
import { t, tCode, tn } from "../../tb/i18n";
import { send } from "../../tb/protocol";
import { remedyOf, refreshGrants } from "../aiState";
import { bar, button, byId, checkRow, description, dialog, download, guard, h, learnMore, reconcile, replace } from "../dom";
import type { Child, Keyed } from "../dom";
import { formatShortTime } from "../format";
import { icon } from "../icons";
import { logReader } from "../logData";
import { accountName, forgetAccounts } from "../model";
import type { Model } from "../model";
import type { Section, Shell } from "../section";
import { scanText } from "./scanText";

/** Nobody but the user is on the white list, and no scan of this session ran to its end and found that there is nobody. */
function nothingLearned(model: Model): boolean {
  return whiteListIsOnlyIdentities(entriesFromArray(model.entries)) && !scanIsComplete(model.status.scan);
}

/** With AI switched on and nothing learned, mail from existing contacts would be scored. */
function aiBeforeScan(model: Model): boolean {
  return model.accessPoints.some((point) => point.enabled) && nothingLearned(model);
}

function startOfToday(): number {
  return new Date().setHours(0, 0, 0, 0);
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
  const observation = checkRow("observation-switch", t("observationLabel"), (checked) =>
    void guard(() => send("updateSettings", { patch: { observation: checked } })),
  );

  replace(
    body,
    h("h2", {}, t("protectionTitle"), " ", state),
    protection.row,
    description(
      t("protectionHint"),
      learnMore(t("protectionTitle"), t("protectionMore")),
      "indent",
    ),
    statusLine,
    warnings,
    h("h2", { text: t("setupTitle") }),
    setup,
    h("h2", { text: t("observationTitle") }),
    observation.row,
    description(t("observationHint"), null, "indent"),
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
    void guard(async () => {
      if (on && model !== null && aiBeforeScan(model)) {
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

  function renderFatal(message: string): void {
    replace(
      fatalBox,
      bar("critical", [h("strong", { text: t("fatalTitle") }), " ", t("fatalText")]),
      h("pre", { class: "code-block", text: message }),
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

  /** One warning per problem, each with the button that leads to its fix. */
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
        const running = current.status.scan?.running === true;
        bars.push(
          warning("ai-before-scan", String(running), [t("warnAiBeforeScan")], running ? null : fix(t("scanStart"), "scan", () => void guard(startFullScan))),
        );
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
              fix(t("editNamed", point.name), "edit", () => shell.go("ai", { kind: "ai-edit", id: point.id })),
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

  function step(
    done: boolean,
    title: string,
    text: string,
    status: string,
    action: HTMLElement | null,
  ): HTMLElement {
    return h(
      "li",
      { class: `step${done ? " done" : ""}` },
      h("span", { class: "step-mark", attrs: { "aria-hidden": "true" } }, done ? icon("check", 14) : null),
      h(
        "div",
        { class: "step-text" },
        h("div", { class: "step-title" }, title, done ? h("span", { class: "visually-hidden", text: ` (${t("stepDone")})` }) : null),
        description(text),
        status === "" ? null : h("div", { class: "step-status", text: status, attrs: { role: "status" } }),
      ),
      h("div", { class: "step-action" }, action),
    );
  }

  function renderSetup(current: Model): void {
    const settings = current.settings;
    if (settings === null) {
      return;
    }
    const scanned = !nothingLearned(current);
    const hasAi = current.accessPoints.length > 0;
    const scan = scanText(current);
    const complete = scanned && settings.protection;
    const next = !scanned ? 1 : !settings.protection ? 3 : 0;
    const signature = JSON.stringify([scanned, hasAi, settings.protection, scan, complete]);
    if (setup.dataset.signature === signature) {
      return;
    }
    const active = document.activeElement;
    const focus = active instanceof HTMLElement && setup.contains(active) ? active.dataset.focus : undefined;
    const wasOpen = setup.querySelector("details")?.open === true;
    setup.dataset.signature = signature;

    const scanButton = scan.running
      ? h("button", { type: "button", text: t("scanCancel"), attrs: { "data-focus": "scan" }, onclick: () => void guard(() => send("cancelScan", {})) })
      : h("button", {
          type: "button",
          text: t(scanned ? "scanAgain" : "scanStart"),
          class: next === 1 ? "primary" : "",
          attrs: { "data-focus": "scan" },
          onclick: () => void guard(startFullScan),
        });
    const steps = h(
      "ol",
      { class: "steps" },
      step(scanned, t("step1Title"), t("step1Text"), scan.text, scanButton),
      step(
        hasAi,
        t("step2Title"),
        t("step2Text"),
        "",
        h("button", {
          type: "button",
          text: t(hasAi ? "openAi" : "step2Add"),
          attrs: { "data-focus": "ai" },
          onclick: () => (hasAi ? shell.go("ai") : shell.go("ai", { kind: "ai-add" })),
        }),
      ),
      step(
        settings.protection,
        t("protectionSwitchOn"),
        t("step3Text"),
        "",
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

  function renderBody(current: Model): void {
    const settings = current.settings;
    if (settings === null) {
      return;
    }
    protection.input.checked = settings.protection;
    observation.input.checked = settings.observation;
    const bars = warningBars(current);
    reconcile(warnings, bars);
    renderStatusLine(current, bars.length > 0);
    renderSetup(current);
  }

  return {
    render(next: Model) {
      model = next;
      if (next.status.fatal !== null || next.settings === null) {
        renderFatal(next.status.fatal ?? t("errorNotReady"));
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
  };
}
