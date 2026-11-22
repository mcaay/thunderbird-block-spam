// AI: what is sent and when, the AI services (add from a preset, edit in place,
// remove, reorder, enable, test), the ChatGPT plan sign-in, the cutoff and the prompt.

import { CHATGPT_ORIGINS, USAGE_URL } from "../../ai/chatgptAuth";
import { isLoopbackHost, originPattern, validateEndpoint } from "../../ai/http";
import { checkDefinition, FIXED_ENDPOINTS, normalizeDefinition, PRESET_GROUPS, PRESETS } from "../../ai/presets";
import type { AccessPointDefinition, DefinitionProblem, Preset } from "../../ai/presets";
import { OUTPUT_LINE } from "../../core/score";
import { DEFAULT_PROMPT } from "../../core/settings";
import type { AccessPoint } from "../../core/types";
import { stringsLocale, t, tCode } from "../../tb/i18n";
import { send } from "../../tb/protocol";
import { hostGranted, refreshGrants, remedyOf, signedIn } from "../aiState";
import { diagnosticSentence } from "../diagnostic";
import {
  address,
  addressed,
  bar,
  button,
  byId,
  description,
  dialog,
  errorText,
  externalLink,
  fieldError,
  guard,
  h,
  iconButton,
  inlineStatus,
  isUnavailable,
  learnMore,
  option,
  paneLink,
  reconcile,
  replace,
  setUnavailable,
  statusSlot,
  tNodes,
  whileBusy,
  withMore,
} from "../dom";
import type { Child, DialogResult, FieldError, Keyed } from "../dom";
import { mayRedraw, sameNumber } from "../fields";
import { formatLogTime, formatScore } from "../format";
import { icon } from "../icons";
import { LOOPBACK_ORIGIN, requestAccess } from "../permissions";
import type { Model } from "../model";
import { nothingLearned } from "../problems";
import type { Intent, Section, Shell } from "../section";
import { scanStatusView } from "./scanStatus";

function hostOf(endpoint: string): string {
  const checked = validateEndpoint(endpoint);
  return checked.ok ? checked.url.host : endpoint;
}

function patternOf(endpoint: string): string | null {
  const checked = validateEndpoint(endpoint);
  return checked.ok ? originPattern(checked.url) : null;
}

function isLocal(endpoint: string): boolean {
  const checked = validateEndpoint(endpoint);
  return checked.ok && isLoopbackHost(checked.url.hostname);
}

function definitionOf(point: AccessPoint, changes: Partial<AccessPointDefinition> = {}): AccessPointDefinition {
  return { type: point.type, name: point.name, enabled: point.enabled, endpoint: point.endpoint, model: point.model, ...changes };
}

/** The item of the model menu that leads back to the text field. No model has this name. */
const OTHER_MODEL = "\u0000other";

/** The editor of one service. Its element lives inside the row that is being edited. */
interface Editor {
  /** The service being edited, or null for a new one. */
  id: string | null;
  /** Changes with every editor that is opened, so that the row is built once per editor. */
  serial: number;
  element: HTMLElement;
  /** The name of the service as it was when the editor was opened, for the line that says its changes are not saved. */
  name: string;
  focus(): void;
  /** True while a field differs from the value the editor opened with. */
  dirty(): boolean;
}

/** An editor that was left with changes: it is kept as it is, with everything that was typed, and can be opened again. */
interface Draft {
  editor: Editor;
  /** The field that had the keyboard focus when the editor was left. */
  focus: HTMLElement | null;
}

/** The key of the draft of a service that is not saved yet. No service has this id. */
const NEW_SERVICE = "\u0000new";

interface TestState {
  text: string;
  kind: "busy" | "ok" | "error";
  /** The state of the service the result belongs to. A result is dropped when the service has changed since. */
  stamp: string | null;
}

/** What a later request can change about a service: a test result from before that no longer describes it. */
function stateStamp(point: AccessPoint): string {
  return JSON.stringify([point.needsAttention, point.cooldownUntil, point.lastError, point.endpoint, point.model, point.type]);
}

export function aiSection(shell: Shell): Section {
  const root = byId("ai");
  let model: Model | null = null;
  /** Results of Test, kept across redraws. */
  const tests = new Map<string, TestState>();
  let editor: Editor | null = null;
  let editorSerial = 0;
  /** Editors that were left with changes, by the id of their service. Nothing typed is lost without the user knowing. */
  const drafts = new Map<string, Draft>();
  let welcomeOpen = false;
  let signInDrawn = "";
  /** The field for the pasted redirect address. It keeps its text while the panel is redrawn. */
  const pasted = h("input", {
    type: "text",
    id: "sign-in-address",
    placeholder: "http://127.0.0.1:1455/auth/callback?code=...",
    oninput: () => drawFinish(),
    attrs: { spellcheck: "false", autocomplete: "off" },
  });
  let pastedFor: string | null = null;
  // Nothing to finish with before an address is pasted: the button says so by being unavailable.
  const finishSignIn = button(t("signInFinish"), () => void whileBusy(finishSignIn, () => guard(() => send("finishSignIn", { url: pasted.value }))).then(drawFinish));
  function drawFinish(): void {
    finishSignIn.disabled = pasted.value.trim() === "";
  }
  drawFinish();

  const list = h("ol", { class: "services" });
  // The pane the sentence names is a link to the setting it means.
  const empty = h(
    "div",
    { class: "description" },
    ...tNodes("servicesNone", paneLink("incoming", t("catIncoming"), () => shell.go("incoming", { kind: "no-verdict" }))),
  );
  /** Said under the list while the editor of a new service was left with changes. */
  const newDraft = h("div", { class: "draft-line", hidden: true });
  /** The scan as it runs, under the warning that offers it. */
  const scanStatus = scanStatusView();
  /**
   * Said under the list while a service is switched on and protection is not: a tested service is not a working
   * filter yet. The button leads to the step that is left.
   */
  const notProtecting = h("div", { class: "notice", attrs: { role: "status" } });

  /** A setting that waits for an AI service: one line says that it is not used yet and leads to the services. */
  const unused = (text: string): HTMLElement =>
    h(
      "div",
      { class: "option-note plain", hidden: true },
      icon("info"),
      h("span", { text }),
      // The way to what is missing: the first service that can be switched on, or else the control that adds one.
      button(t("openAi"), () => {
        const target = list.querySelector<HTMLElement>('[data-focus="enabled"]') ?? presetSelect;
        target.scrollIntoView({ block: "center" });
        target.focus();
      }, "link to-services"),
    );
  const cutoffUnused = unused(t("cutoffUnused"));
  cutoffUnused.id = "cutoff-unused";
  const promptUnused = unused(t("promptUnused"));
  promptUnused.id = "prompt-unused";
  const presetSelect = h(
    "select",
    { id: "preset", onchange: () => drawPresetHint() },
    ...PRESET_GROUPS.map((group) =>
      h(
        "optgroup",
        { label: tCode("presetGroup", group) },
        ...PRESETS.filter((preset) => preset.group === group).map((preset) => option(preset.id, tCode("preset", preset.id))),
      ),
    ),
  );
  const presetHint = h("div", { class: "description", id: "preset-hint" });
  presetSelect.setAttribute("aria-describedby", "preset-hint");
  /** The sign-in in progress. It is shown as part of the services list: in the row it signs in again, or as a new row. */
  const signInPanel = h("div", { class: "sign-in" });
  const signInFailed = h("div", { class: "sign-in-failed" });

  // A plain field without spin buttons: the arrow keys step the value by 0.01, as the buttons of a number field would.
  const cutoff = h("input", {
    type: "text",
    id: "cutoff",
    class: "number",
    oninput: () => {
      cutoffError.set(null);
      cutoffStatus.clear();
    },
    onchange: () => saveCutoff(),
    onkeydown: (event) => {
      if ((event.key !== "ArrowUp" && event.key !== "ArrowDown") || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      event.preventDefault();
      const now = Number(cutoff.value.trim().replace(",", "."));
      const base = cutoff.value.trim() === "" || !Number.isFinite(now) ? 0 : now;
      const next = Math.min(1, Math.max(0, Math.round((base + (event.key === "ArrowUp" ? 0.01 : -0.01)) * 100) / 100));
      cutoff.value = next.toFixed(2);
      cutoffError.set(null);
      cutoffStatus.clear();
    },
    attrs: { inputmode: "decimal", autocomplete: "off", spellcheck: "false", role: "spinbutton", "aria-valuemin": "0", "aria-valuemax": "1" },
  });
  const cutoffError = fieldError(cutoff, "cutoff-error");
  const cutoffStatus = inlineStatus();
  /** What the page put into the cutoff field last. Anything else in it is an edit. */
  let cutoffShown: string | null = null;

  const prompt = h("textarea", {
    rows: 14,
    id: "prompt",
    oninput: () => drawPromptState(),
    attrs: { "aria-labelledby": "prompt-title", "aria-describedby": "prompt-hint", spellcheck: "false" },
  });
  const promptError = fieldError(prompt, "prompt-error");
  let promptStored = "";
  const promptStatus = inlineStatus();
  const savePromptButton = button(t("promptSave"), () => void savePrompt());
  const discardPromptButton = button(t("promptDiscard"), () => {
    prompt.value = promptStored;
    promptError.set(null);
    drawPromptState();
    prompt.focus();
  });
  const restorePromptButton = button(t("promptRestore"), () => {
    // Only fills the field: the stored prompt changes when Save is pressed.
    prompt.value = DEFAULT_PROMPT;
    promptError.set(null);
    drawPromptState();
    prompt.focus();
  });

  replace(
    root,
    h("h1", { text: t("catAi"), tabIndex: -1 }),
    h("p", { class: "lead" }, ...withMore(t("aiLead"), learnMore(t("aiLeadTopic"), t("aiHint"), t("aiSecretsHint"), t("privacyText")))),
    h("h2", { text: t("servicesTitle") }),
    description(t("servicesHint")),
    empty,
    list,
    newDraft,
    notProtecting,
    h(
      "div",
      { class: "row add-service" },
      h("label", { for: "preset", text: t("serviceAddLabel") }),
      presetSelect,
      // "Add…": more is asked before anything is added, in the editor or in the consent dialog.
      button(t("serviceAdd"), () => {
        const preset = PRESETS.find((item) => item.id === presetSelect.value) ?? null;
        if (preset?.type === "chatgpt") {
          void guard(async () => {
            // The sign-in creates the service switched on: "scan first" is asked before it starts.
            const asked = await askScanFirst(false);
            if (asked.answer !== "cancel") {
              startChatGpt(null, asked.asked ? asked.answer === "after-scan" : null);
            }
          });
        } else if (preset !== null) {
          if (editor !== null && editor.id === null && editor.dirty()) {
            // The editor of a new service is open and holds typed text: it is not replaced by an empty one. The focus
            // goes to it, where "Unsaved changes" stands next to Save, and Cancel keeps the text behind "Continue editing".
            editor.focus();
            return;
          }
          openEditor(null, preset);
        }
      }),
    ),
    presetHint,
    signInFailed,
    h("h2", { text: t("cutoffTitle") }),
    cutoffUnused,
    h("div", { class: "row" }, h("label", { for: "cutoff", text: t("cutoffLabel") }), cutoff, cutoffStatus.element),
    cutoffError.element,
    h("div", { class: "description", id: "cutoff-hint", text: t("cutoffHint") }),
    h("h2", { text: t("promptTitle"), id: "prompt-title" }),
    promptUnused,
    h("div", { class: "description", id: "prompt-hint", text: t("promptHint") }),
    prompt,
    promptError.element,
    // The default prompt is English in every language of the interface: it is the model that reads it.
    description(t("promptLanguage")),
    description(t("outputLineLabel")),
    h("pre", { class: "code-block", text: OUTPUT_LINE }),
    // "Unsaved changes" stands right after the button that saves them, in a place that is kept free: the buttons after it never move.
    h("div", { class: "row" }, savePromptButton, statusSlot(promptStatus, t("unsavedChanges"), t("saved")), discardPromptButton, restorePromptButton),
    // Where a prompt or a cutoff is tried: the two tools for it live elsewhere, and this is the place that says so.
    // The names in these sentences are the labels themselves, so they cannot drift apart.
    description(t("tryOnMail", t("popupScoreSelected"))),
    h(
      "div",
      { class: "description" },
      ...tNodes(
        "tryObserve",
        t("observationLabel"),
        h("a", {
          href: "#overview",
          text: t("catOverview"),
          onclick: (event) => {
            event.preventDefault();
            shell.go("overview");
          },
        }),
      ),
    ),
  );

  function drawPresetHint(): void {
    const preset = PRESETS.find((item) => item.id === presetSelect.value);
    if (preset === undefined) {
      replace(presetHint);
      return;
    }
    replace(
      presetHint,
      tCode("presetHint", preset.id),
      // A link stays with the word before it: it never stands alone on the last line.
      preset.keyUrl === undefined ? null : "\u00a0",
      preset.keyUrl === undefined ? null : externalLink(t("getKey"), preset.keyUrl),
      preset.docsUrl === undefined ? null : preset.keyUrl === undefined ? "\u00a0" : " ",
      preset.docsUrl === undefined ? null : externalLink(t("documentation"), preset.docsUrl),
    );
  }

  // -------------------------------------------------------------------------
  // Cutoff and prompt.

  /** The cutoff is saved when the field is left or Enter is pressed, like every other setting. */
  function saveCutoff(): void {
    // A comma is the decimal sign of many languages: it is read as one.
    const value = Number(cutoff.value.trim().replace(",", "."));
    if (cutoff.value.trim() === "" || !Number.isFinite(value) || value < 0 || value > 1) {
      cutoffError.set(tCode("invalid", "cutoff-range"));
      cutoffStatus.clear();
      return;
    }
    void guard(
      async () => {
        await send("updateSettings", { patch: { cutoff: value } });
        cutoffError.set(null);
        cutoffStatus.flash(t("saved"));
      },
      (message) => cutoffError.set(message),
    );
  }

  function promptDirty(): boolean {
    return prompt.value !== promptStored;
  }

  function drawPromptState(): void {
    const dirty = promptDirty();
    savePromptButton.disabled = !dirty;
    // Save stands out only while there is something to save.
    savePromptButton.classList.toggle("primary", dirty);
    // Nothing to discard without a change: the button stays where it is and is unavailable until there is.
    discardPromptButton.disabled = !dirty;
    restorePromptButton.disabled = prompt.value === DEFAULT_PROMPT;
    if (dirty) {
      promptStatus.set(t("unsavedChanges"));
    } else if (promptStatus.element.textContent === t("unsavedChanges")) {
      promptStatus.clear();
    }
  }

  async function savePrompt(): Promise<void> {
    const text = prompt.value;
    if (text.trim() === "") {
      promptError.set(tCode("invalid", "prompt-empty"));
      prompt.focus();
      return;
    }
    await guard(
      async () => {
        await send("updateSettings", { patch: { prompt: text } });
        promptStored = text;
        promptError.set(null);
        // Save is unavailable again: the keyboard goes back to the field.
        prompt.focus();
        drawPromptState();
        promptStatus.flash(t("saved"));
      },
      (message) => promptError.set(message),
    );
  }

  // -------------------------------------------------------------------------
  // "Scan first", asked by whichever comes second: protection (on the Overview) or the first AI service (here).

  type ScanAnswer = "on" | "after-scan" | "cancel";

  /**
   * Asked before an AI service is switched on while protection is on and the sent mail was not scanned: mail from
   * people the user already writes to would be sent to it. `asked` is false when nothing had to be asked.
   * - "after-scan": the service stays off and is switched on by the background when the scan has finished.
   * - "on": the user said "use it anyway", or there was nothing to ask.
   * While a service is switched on already (the user said "use it anyway"), further services switch on without a
   * second question. While a service waits for the scan, further services wait with it. `waiting` is true for the
   * service that waits itself: ticking it by hand asks again.
   */
  async function askScanFirst(waiting: boolean): Promise<{ answer: ScanAnswer; asked: boolean }> {
    const current = model;
    const settings = current?.settings;
    if (current === null || settings === null || settings === undefined || !settings.protection || current.accessPoints.some((point) => point.enabled)) {
      return { answer: "on", asked: false };
    }
    // Asked of the background at this moment: a scan can have started since the page last heard of it.
    const status = await send("getStatus", {}).catch(() => current.status);
    const scanning = status.scan?.running === true;
    if (!scanning && !nothingLearned({ ...current, status })) {
      return { answer: "on", asked: false };
    }
    if (!waiting && status.wish.services.length > 0) {
      return { answer: "after-scan", asked: false };
    }
    const choice = await dialog(
      scanning
        ? { title: t("scanWaitTitle"), body: [t("serviceScanWaitText")], confirmLabel: t("scanWait"), extraLabel: t("useAnyway"), focus: "confirm" }
        : { title: t("scanFirstTitle"), body: [t("serviceScanFirstWarn"), t("serviceScanFirstText")], confirmLabel: t("scanFirst"), extraLabel: t("useAnyway"), focus: "confirm" },
    );
    return { answer: choice === "confirm" ? "after-scan" : choice === "extra" ? "on" : "cancel", asked: true };
  }

  // -------------------------------------------------------------------------
  // ChatGPT plan sign-in.

  /** Explains what is sent and asks for consent before sign-in. The terms of the programme require it. */
  function startChatGpt(accessPointId: string | null, afterScan: boolean | null = null): void {
    void dialog({
      title: t("chatgptConsentTitle"),
      body: [t("chatgptConsentText"), t("consentWhat"), t("consentNever"), t("chatgptConsentManage")],
      confirmLabel: t("chatgptContinue"),
      onConfirm: async () => {
        // webRequest on the loopback address lets the add-on read the sign-in redirect.
        // Where Thunderbird does not offer it, the user pastes the address by hand.
        const granted = await requestAccess([...CHATGPT_ORIGINS, LOOPBACK_ORIGIN], ["webRequest"]);
        if (!granted) {
          throw new Error(t("permissionDeclined"));
        }
        await send("startSignIn", { accessPointId, openTab: true, afterScan });
        // The sign-in opens in its own row: an editor in another row closes, and keeps what was typed.
        if (editor !== null && editor.id !== accessPointId) {
          leaveEditor();
        }
        shell.startPolling();
        return true;
      },
    });
  }

  function drawSignIn(): void {
    const signIn = model?.status.signIn;
    // Redraw only when something changed, so a pasted address is not wiped while typing.
    const signature = JSON.stringify(signIn ?? null);
    if (signature === signInDrawn) {
      return;
    }
    signInDrawn = signature;
    replace(
      signInFailed,
      signIn === undefined || signIn.error === "" ? null : h("p", { class: "field-error", text: t("signInFailed", signIn.error), attrs: { role: "alert" } }),
    );
    if (signIn === undefined || signIn.url === null) {
      // The panel leaves with the sign-in. When the keyboard was in it, it goes on in the row of that service, or with the menu for adding one.
      const held = signInPanel.contains(document.activeElement);
      const row = signInPanel.closest<HTMLElement>("li");
      replace(signInPanel);
      if (held) {
        (row?.querySelector<HTMLElement>('[data-focus="sign-in"]') ?? presetSelect).focus();
      }
      return;
    }
    const url = signIn.url;
    if (url !== pastedFor) {
      pastedFor = url;
      pasted.value = "";
    }
    const status = inlineStatus();
    replace(
      signInPanel,
      h("h3", { text: t("signInTitle") }),
      h("p", { text: t(signIn.capture ? "signInWaiting" : "signInManual") }),
      h(
        "div",
        { class: "row" },
        button(t("signInOpenBrowser"), () => void guard(() => browser.windows.openDefaultBrowser(url))),
        button(t("signInCopy"), () =>
          void guard(async () => {
            await navigator.clipboard.writeText(url);
            status.flash(t("copied"));
          }),
        ),
        status.element,
      ),
      // Where the page updates by itself, pasting is the way out when it does not. Where it cannot, pasting is the next step and was said above.
      signIn.capture ? description(t("signInPasteHint")) : null,
      h(
        "div",
        { class: "field" },
        h("label", { for: "sign-in-address", text: t("signInAddressLabel") }),
        h("div", { class: "row tight" }, pasted, finishSignIn, button(t("cancel"), () => void guard(() => send("cancelSignIn", {})))),
      ),
    );
    drawFinish();
  }

  // -------------------------------------------------------------------------
  // The editor, shown inside the row that is being edited.

  /** Puts the keyboard where the editor stood: on Edit of its row, or on the menu that adds a service. */
  function focusRow(focusId: string | null, kind = "edit"): void {
    const target =
      focusId === null
        ? (newDraft.querySelector<HTMLElement>("button") ?? presetSelect)
        : [...list.querySelectorAll<HTMLElement>("li")].find((item) => item.dataset.key === focusId)?.querySelector<HTMLElement>(`[data-focus="${kind}"]`);
    (target ?? presetSelect).focus();
  }

  /** Closes the editor after its service was saved: nothing of it is kept. */
  function closeEditor(focusId: string | null): void {
    if (editor !== null) {
      drafts.delete(editor.id ?? NEW_SERVICE);
    }
    editor = null;
    drawList();
    focusRow(focusId);
  }

  /**
   * Leaves the editor without saving (Escape, Cancel, another editor, a sign-in in another row). An editor with
   * changes is kept as it is: a line where it stood says that the changes are not saved and offers the way back.
   */
  function leaveEditor(focus = false): void {
    const left = editor;
    if (left === null) {
      return;
    }
    const key = left.id ?? NEW_SERVICE;
    if (left.dirty()) {
      const active = document.activeElement;
      drafts.set(key, { editor: left, focus: active instanceof HTMLElement && left.element.contains(active) ? active : null });
    } else {
      drafts.delete(key);
    }
    editor = null;
    drawList();
    if (focus) {
      // With a draft the keyboard lands on "Continue editing", else on Edit of the row or on the menu for adding.
      focusRow(left.id, drafts.has(key) ? "continue" : "edit");
    }
  }

  /** Opens an editor that was left with changes again, with everything that was typed and the focus where it was. */
  function continueEditing(key: string): void {
    const draft = drafts.get(key);
    if (draft === undefined) {
      return;
    }
    if (editor !== null && editor !== draft.editor) {
      leaveEditor();
    }
    drafts.delete(key);
    editor = draft.editor;
    drawList();
    draft.editor.element.scrollIntoView({ block: "nearest" });
    if (draft.focus !== null && draft.focus.isConnected && !draft.focus.hidden) {
      draft.focus.focus();
    } else {
      draft.editor.focus();
    }
  }

  /** The line that stands where an editor was left with changes. */
  function draftLine(key: string, name: string | null): HTMLElement {
    const again = button(t("draftContinue"), () => continueEditing(key), "small");
    again.dataset.focus = "continue";
    // The name is the label and its object, so that the lines of several services can be told apart.
    again.setAttribute("aria-label", name === null ? t("draftContinueNew") : t("labelNamed", t("draftContinue"), name));
    return h("div", { class: "option-note plain draft", attrs: { role: "status" } }, icon("info"), h("span", {}, ...addressed(name === null ? t("draftNew") : t("draftChanged", name))), again);
  }

  function openEditor(id: string | null, preset: Preset | null, focus: "name" | "key" = "name"): void {
    if (model === null) {
      return;
    }
    const existing = id === null ? null : (model.accessPoints.find((point) => point.id === id) ?? null);
    const type = existing?.type ?? preset?.type;
    if (type === undefined) {
      return;
    }
    // Another editor that is open closes, and keeps what was typed. This one opens afresh: a draft of the same service is replaced by it.
    leaveEditor();
    drafts.delete(id ?? NEW_SERVICE);
    editorSerial += 1;
    const serial = editorSerial;
    const prefix = `editor-${serial}`;
    const fixed = FIXED_ENDPOINTS[type] !== undefined;
    const presetName = preset === null ? "" : tCode("preset", preset.id);
    const canLoadModels = type === "openai-chat" || (type === "chatgpt" && existing !== null);

    const name = h("input", { type: "text", id: `${prefix}-name`, value: existing?.name ?? presetName });
    const endpoint = h("input", {
      type: "url",
      id: `${prefix}-endpoint`,
      value: existing?.endpoint ?? preset?.endpoint ?? "",
      disabled: fixed,
      oninput: () => {
        drawLocalNote();
        drawEndpointHint();
        drawKeyHint();
        lookUp();
      },
      attrs: { spellcheck: "false" },
    });
    const modelInput = h("input", { type: "text", id: `${prefix}-model`, value: existing?.model ?? preset?.model ?? "", attrs: { spellcheck: "false", autocomplete: "off" } });
    const modelLabel = h("label", { for: modelInput.id, text: t("fieldModel") });
    /** The loaded models as a menu. It takes the place of the text field until "Other…" is chosen. */
    const modelMenu = h("select", {
      id: `${prefix}-model-menu`,
      hidden: true,
      onchange: () => {
        if (modelMenu.value === OTHER_MODEL) {
          showModelField();
          return;
        }
        modelInput.value = modelMenu.value;
        errors.model.set(null);
        modelMenu.removeAttribute("aria-invalid");
      },
    });
    const modelControl = (): HTMLElement => (modelMenu.hidden ? modelInput : modelMenu);

    /** Back to the text field, for a model the service did not list. */
    function showModelField(): void {
      modelMenu.hidden = true;
      modelMenu.removeAttribute("aria-invalid");
      modelInput.hidden = false;
      modelLabel.htmlFor = modelInput.id;
      modelStatus.clear();
      modelInput.focus();
      modelInput.select();
    }
    const key = h("input", {
      type: "password",
      id: `${prefix}-key`,
      placeholder: existing !== null && existing.apiKey !== "" ? t("keyKeep") : t("keyPlaceholder"),
      attrs: { autocomplete: "off" },
    });
    const errors: Record<"name" | "endpoint" | "model" | "key", FieldError> = {
      name: fieldError(name, `${prefix}-name-error`),
      endpoint: fieldError(endpoint, `${prefix}-endpoint-error`),
      model: fieldError(modelInput, `${prefix}-model-error`),
      key: fieldError(key, `${prefix}-key-error`),
    };
    const fields = { name, endpoint, key };
    const modelStatus = inlineStatus("block");
    const saveStatus = inlineStatus();
    /** "Unsaved changes", right after the button that saves them, while a field differs from what the editor opened with. */
    const unsavedNote = inlineStatus();
    const opened = { name: name.value, endpoint: endpoint.value, model: modelInput.value };
    const dirty = (): boolean => name.value !== opened.name || endpoint.value !== opened.endpoint || modelInput.value !== opened.model || key.value !== "";
    const drawDirty = (): void => {
      if (dirty()) {
        if (unsavedNote.element.textContent !== t("unsavedChanges")) {
          unsavedNote.set(t("unsavedChanges"));
        }
      } else {
        unsavedNote.clear();
      }
    };
    const localNote = h("div", { class: "local-note" });
    /** What the address field expects. The sentence about the placeholder is shown only while the address holds one. */
    const endpointHint = h("div", { class: "description" });
    const drawEndpointHint = (): void => {
      const text = fixed ? t("endpointFixed") : tCode("endpointHint", type);
      const whole = !fixed && /<[^<>]*>/.test(endpoint.value) ? `${text} ${t("endpointPlaceholder")}` : text;
      if (endpointHint.textContent !== whole) {
        endpointHint.textContent = whole;
      }
    };
    /** Said under the key field only for a server on this computer, where it is true. */
    const keyLocalHint = h("span");
    const drawKeyHint = (): void => {
      const text = type !== "chatgpt" && isLocal(endpoint.value) ? ` ${t("keyHintLocal")}` : "";
      if (keyLocalHint.textContent !== text) {
        keyLocalHint.textContent = text;
      }
    };

    // What this computer already allows. Looked up ahead of the click, because nothing
    // may be awaited between a click and a permission request.
    const granted = new Map<string, boolean>();
    /** The host the user agreed to in this editor, through "Load models". */
    let consented: string | null = null;
    const lookUp = (): void => {
      const pattern = patternOf(FIXED_ENDPOINTS[type] ?? endpoint.value);
      if (pattern !== null && !granted.has(pattern)) {
        void browser.permissions
          .contains({ origins: [pattern] })
          .then((value) => granted.set(pattern, value))
          .catch(() => undefined);
      }
    };

    function drawLocalNote(): void {
      const local = type !== "chatgpt" && isLocal(endpoint.value);
      if (local === (localNote.childElementCount > 0)) {
        return;
      }
      if (!local) {
        replace(localNote);
        return;
      }
      const copied = inlineStatus();
      replace(
        localNote,
        description(t("localServerHint")),
        h(
          "div",
          { class: "row" },
          h("code", { class: "origin", text: location.origin }),
          button(t("copy"), () =>
            void guard(async () => {
              await navigator.clipboard.writeText(location.origin);
              copied.flash(t("copied"));
            }),
          ),
          copied.element,
        ),
        description(t("localServerHow")),
      );
    }

    function readDefinition(): { definition: AccessPointDefinition; newKey: string | null } {
      return {
        definition: normalizeDefinition({
          type: type as AccessPoint["type"],
          name: name.value,
          enabled: existing?.enabled ?? true,
          endpoint: endpoint.value,
          model: modelInput.value,
        }),
        newKey: key.value.trim() === "" ? null : key.value.trim(),
      };
    }

    /** Shows the problems under their fields and moves the focus to the first one. True when there are none. */
    function showProblems(problems: readonly DefinitionProblem[]): boolean {
      const byField: Record<keyof typeof errors, DefinitionProblem | undefined> = {
        name: problems.find((problem) => problem === "name-missing"),
        endpoint: problems.find((problem) => problem.startsWith("endpoint-")),
        model: problems.find((problem) => problem === "model-missing"),
        key: problems.find((problem) => problem === "key-missing"),
      };
      let first: HTMLElement | null = null;
      for (const field of ["name", "endpoint", "model", "key"] as const) {
        const problem = byField[field];
        errors[field].set(problem === undefined ? null : tCode("problem", problem));
        if (field === "model" && !modelMenu.hidden) {
          // The menu stands in for the field: it carries the mark of the error and takes the focus.
          if (problem === undefined) {
            modelMenu.removeAttribute("aria-invalid");
          } else {
            modelMenu.setAttribute("aria-invalid", "true");
            modelMenu.setAttribute("aria-describedby", errors.model.element.id);
          }
        }
        if (problem !== undefined && first === null) {
          first = field === "model" ? modelControl() : fields[field];
        }
      }
      first?.focus();
      return first === null;
    }

    /** True when the host was already allowed for this very service, or agreed to in this editor. */
    function alreadyAllowed(pattern: string): boolean {
      const stored = existing === null ? null : patternOf(existing.endpoint);
      return granted.get(pattern) === true && (pattern === consented || pattern === stored);
    }

    /**
     * A new host, or an imported service whose host was never allowed on this
     * computer: explain what will be sent there and ask for the host permission.
     */
    function withConsent(
      definition: AccessPointDefinition,
      confirmLabel: string,
      run: () => Promise<void>,
      onError: (message: string) => void,
      onClosed: (result: DialogResult) => void = () => undefined,
    ): void {
      const pattern = patternOf(definition.endpoint);
      if (pattern === null || alreadyAllowed(pattern)) {
        void guard(run, onError);
        return;
      }
      void dialog({
        title: t("consentTitle"),
        body: [h("p", {}, ...addressed(t("consentText", hostOf(definition.endpoint)))), t("consentWhat"), t("consentNever")],
        confirmLabel,
        onConfirm: async () => {
          if (!(await requestAccess([pattern]))) {
            throw new Error(t("permissionDeclined"));
          }
          granted.set(pattern, true);
          consented = pattern;
          await run();
          return true;
        },
      }).then(onClosed);
    }

    const save = (): void => {
      const { definition, newKey } = readDefinition();
      if (!showProblems(checkDefinition(definition, newKey !== null || (existing !== null && existing.apiKey !== "")))) {
        return;
      }
      saveStatus.clear();
      void guard(
        async () => {
          // A new service is saved switched on. While protection is on and the sent mail was not scanned, that asks
          // first. Cancel leaves the editor open with everything that was typed.
          const asked = existing === null ? await askScanFirst(false) : { answer: "on" as const, asked: false };
          if (asked.answer === "cancel") {
            return;
          }
          const waits = asked.answer === "after-scan";
          const saved = waits ? { ...definition, enabled: false } : definition;
          withConsent(
            saved,
            t("consentAgree"),
            // Unavailable while the request runs: a second click cannot save the service twice.
            () =>
              whileBusy(saveButton, async () => {
                const { id: savedId } = await send("saveAccessPoint", { id: existing?.id ?? null, definition: saved, apiKey: newKey });
                if (waits) {
                  // Saved switched off: the background switches it on when the scan has finished.
                  await send("enableAfterScan", { id: savedId });
                  shell.startPolling();
                }
                await shell.refresh();
                closeEditor(savedId);
                // One test right away, so the row says at once whether the service works. It sends no mail.
                runTest(savedId);
              }),
            (message) => saveStatus.set(message, "error"),
          );
        },
        (message) => saveStatus.set(message, "error"),
      );
    };

    const loadModels = (): void => {
      const { definition, newKey } = readDefinition();
      modelStatus.clear();
      if (type === "chatgpt") {
        if (existing === null) {
          return;
        }
        void guard(
          () =>
            whileBusy(loadButton, async () => {
              modelStatus.busy(t("loadModelsBusy"));
              showModels(await send("listModels", { id: existing.id }));
            }),
          (message) => modelStatus.set(message, "error"),
        );
        return;
      }
      // Only the address has to be right for this: the name and the model can still be empty.
      const problems = checkDefinition(definition, true).filter((problem) => problem.startsWith("endpoint-"));
      errors.endpoint.set(problems[0] === undefined ? null : tCode("problem", problems[0]));
      if (problems.length > 0) {
        endpoint.focus();
        return;
      }
      withConsent(
        definition,
        t("consentAgreeLoad"),
        () =>
          whileBusy(loadButton, async () => {
            // Said only once the question about the host is answered, and taken back when the request fails.
            modelStatus.busy(t("loadModelsBusy"));
            try {
              showModels(await send("listModelsFor", { id: existing?.id ?? null, definition, apiKey: newKey }));
            } catch (error) {
              modelStatus.clear();
              throw error;
            }
          }),
        (message) => modelStatus.set(message, "error"),
        (result) => {
          if (result === "cancel") {
            modelStatus.clear();
          } else {
            // The dialog gave the focus back to the button. The models are what the user asked for.
            modelControl().focus();
          }
        },
      );
    };

    /** Shows the loaded models as a menu, with the model that is set selected and "Other…" as the way back to typing. */
    function showModels(options: { id: string; label: string }[]): void {
      if (options.length === 0) {
        modelStatus.set(t("loadModelsNone"));
        modelControl().focus();
        return;
      }
      const current = modelInput.value.trim();
      const listed = options.some((item) => item.id === current);
      replace(
        modelMenu,
        current === "" ? option("", t("modelChoose"), true) : null,
        // A model the service did not list stays selected, because loading the list changes nothing by itself. The menu says that it is not on the list.
        current !== "" && !listed ? option(current, t("modelUnlisted", current), true) : null,
        ...options.map((item) => option(item.id, item.label, item.id === current)),
        option(OTHER_MODEL, t("modelOther")),
      );
      modelInput.hidden = true;
      modelMenu.hidden = false;
      modelLabel.htmlFor = modelMenu.id;
      if (current !== "" && !listed) {
        // Not a confirmation: a mistyped model would otherwise look confirmed until the test fails.
        modelStatus.set(t("loadModelsUnlisted", options.length));
      } else {
        modelStatus.set(t("loadModelsDone", options.length), "ok");
      }
      modelMenu.focus();
    }

    const field = (label: string | HTMLElement, control: HTMLElement, error: FieldError, hint: Child[], ...extra: Child[]): HTMLElement =>
      h(
        "div",
        { class: "field" },
        typeof label === "string" ? h("label", { for: control.id, text: label }) : label,
        extra.length === 0 ? control : h("div", { class: "row tight" }, control, ...extra),
        error.element,
        hint.length === 0 ? null : h("div", { class: "description" }, ...hint),
      );

    // Where the key comes from: the link of the preset, also for a service that was added from it earlier.
    const source = preset ?? PRESETS.find((item) => item.type === type && item.endpoint !== "" && item.endpoint === existing?.endpoint) ?? null;
    const keyLink =
      source?.keyUrl !== undefined
        ? externalLink(t("getKey"), source.keyUrl)
        : source?.docsUrl !== undefined
          ? externalLink(t("documentation"), source.docsUrl)
          : null;

    const titleId = `${prefix}-title`;
    const loadButton = button(t("loadModels"), loadModels);
    // The form is submitted by this button and by Enter in a field. While a save runs, neither starts a second one.
    const saveButton = h("button", { type: "submit", class: "primary", text: t("save") });
    const element = h(
      "form",
      {
        class: "editor",
        attrs: { "aria-labelledby": titleId, novalidate: "" },
        onsubmit: (event) => {
          event.preventDefault();
          if (!isUnavailable(saveButton)) {
            save();
          }
        },
        onkeydown: (event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            leaveEditor(true);
          }
        },
        oninput: () => drawDirty(),
        onchange: () => drawDirty(),
      },
      h("h3", { id: titleId, text: existing === null ? t("editorAddTitle", presetName) : t("editorEditTitle", existing.name) }),
      field(t("fieldName"), name, errors.name, []),
      type === "chatgpt" ? null : h("div", { class: "field" }, h("label", { for: endpoint.id, text: t("fieldEndpoint") }), endpoint, errors.endpoint.element, endpointHint),
      // The status of "Load models" stands on a line of its own under the row, so that nothing in the row moves when it appears.
      h(
        "div",
        { class: "field" },
        modelLabel,
        canLoadModels ? h("div", { class: "row tight" }, modelInput, modelMenu, loadButton) : modelInput,
        canLoadModels ? modelStatus.element : null,
        errors.model.element,
        h("div", { class: "description", text: tCode("modelHint", type) }),
      ),
      type === "chatgpt" ? null : field(t("fieldKey"), key, errors.key, [t("keyHint"), keyLocalHint, keyLink === null ? null : "\u00a0", keyLink]),
      localNote,
      h(
        "div",
        { class: "row" },
        saveButton,
        statusSlot(unsavedNote, t("unsavedChanges")),
        button(t("cancel"), () => leaveEditor(true)),
        saveStatus.element,
      ),
    );
    drawLocalNote();
    drawEndpointHint();
    drawKeyHint();
    lookUp();
    editor = { id: existing?.id ?? null, serial, element, name: existing?.name ?? presetName, focus: () => name.focus(), dirty };
    drawList();
    element.scrollIntoView({ block: "nearest" });
    if (focus === "key" && type !== "chatgpt") {
      // Opened from a warning about the key: the field the warning is about takes the focus.
      key.scrollIntoView({ block: "center" });
      key.focus();
    } else {
      name.focus();
      name.select();
    }
  }

  // -------------------------------------------------------------------------
  // The list of services.

  function runTest(id: string): void {
    tests.set(id, { text: t("apTesting"), kind: "busy", stamp: null });
    drawList();
    void (async () => {
      let result: Omit<TestState, "stamp">;
      try {
        const outcome = await send("testAccessPoint", { id });
        result = outcome.ok
          ? { text: t("apTestScore", formatScore(outcome.score, stringsLocale())), kind: "ok" }
          : { text: t("apTestFailed", diagnosticSentence(outcome.error)), kind: "error" };
      } catch (error) {
        result = { text: t("apTestFailed", diagnosticSentence(errorText(error))), kind: "error" };
      }
      // A successful test clears the problems of the service: read that first, so the result is tied to the state it left.
      await shell.refresh().catch(() => undefined);
      const point = model?.accessPoints.find((item) => item.id === id);
      if (point === undefined) {
        tests.delete(id);
      } else {
        tests.set(id, { ...result, stamp: stateStamp(point) });
      }
      drawList();
    })();
  }

  /** Forgets test results that a later request has overtaken, for example a test that worked before the key was rejected. */
  function dropStaleTests(points: readonly AccessPoint[]): void {
    for (const [id, test] of tests) {
      const point = points.find((item) => item.id === id);
      if (point === undefined || (test.stamp !== null && test.stamp !== stateStamp(point))) {
        tests.delete(id);
      }
    }
  }

  function statusLines(point: AccessPoint, now: number): HTMLElement[] {
    const lines: HTMLElement[] = [];
    const wish = model?.status.wish;
    const outcome = wish?.servicesOutcome?.ids.includes(point.id) === true ? wish.servicesOutcome : null;
    if (wish?.services.includes(point.id) === true) {
      // The service waits for the scan: said in the words the state of protection uses, with the way to call it off.
      const cancel = button(
        t("wishCancel"),
        () =>
          void guard(async () => {
            await send("clearServiceWish", { id: point.id });
            await shell.refresh();
            // The note goes away with the wish: the keyboard goes back to the box of the service.
            focusRow(point.id, "enabled");
          }),
        "small",
      );
      cancel.dataset.focus = "wish-cancel";
      cancel.setAttribute("aria-label", t("labelNamed", t("wishCancel"), point.name));
      lines.push(h("div", { class: "service-state waiting", attrs: { role: "status" } }, icon("clock"), h("span", { text: tCode("state", "waiting") }), cancel));
    } else if (outcome !== null && outcome.kind !== "on") {
      // The scan it waited for did not run to its end: the service was not switched on, and the row says why.
      lines.push(h("div", { class: "service-state attention", text: t(outcome.kind === "cancelled" ? "serviceRowCancelled" : "serviceRowErrors"), attrs: { role: "status" } }));
    } else if (!point.enabled) {
      lines.push(h("div", { class: "service-state off", text: t("apDisabled") }));
    }
    if (outcome !== null && outcome.kind === "on" && point.enabled) {
      lines.push(h("div", { class: "service-state ok", text: t(outcome.scanned === 0 ? "serviceRowOnEmpty" : "serviceRowOn"), attrs: { role: "status" } }));
    }
    const remedy = point.needsAttention ? remedyOf(point) : null;
    // A missing sign-in is said once: by the line that needs attention when there is one, which also says what to do.
    if (point.type === "chatgpt" && remedy !== "sign-in") {
      lines.push(
        h(
          "div",
          { class: "service-state" },
          ...(!signedIn(point)
            ? [t("chatgptSignedOut")]
            : (point.auth?.email ?? "") === ""
              ? [t("chatgptUsingPlan")]
              : addressed(t("chatgptUsingPlanAs", point.auth?.email ?? ""))),
          signedIn(point) ? "\u00a0" : null,
          signedIn(point) ? externalLink(t("chatgptManageUsage"), USAGE_URL) : null,
        ),
      );
    }
    if (remedy !== null) {
      // In the row itself the remedy points at the button that stands right below, not at "its row".
      lines.push(h("div", { class: "service-state attention" }, h("strong", { text: t("apNeedsAttention") }), " ", remedy === "sign-in" ? t("remedySignInRow") : tCode("remedy", remedy)));
    }
    if (point.cooldownUntil > now) {
      // What happens meanwhile depends on the other services: it is said only where another one can answer.
      const others = model?.accessPoints.some((item) => item.id !== point.id && item.enabled && !item.needsAttention && item.cooldownUntil <= now) === true;
      const until = formatLogTime(point.cooldownUntil, now);
      lines.push(h("div", { class: "service-state paused", text: others ? `${t("apCoolingDown", until)} ${t("apCoolingOthers")}` : t("apCoolingDown", until) }));
    }
    if (point.lastError !== "") {
      // A failure that neither paused the service nor needs the user: say that it simply is tried again.
      const retried = point.enabled && !point.needsAttention && point.cooldownUntil <= now;
      lines.push(h("div", { class: "service-state detail", text: t(retried ? "apLastErrorRetry" : "apLastError", diagnosticSentence(point.lastError)) }));
    }
    const test = tests.get(point.id);
    if (test !== undefined) {
      lines.push(
        h(
          "div",
          { class: `service-state test ${test.kind}`, attrs: { role: test.kind === "error" ? "alert" : "status" } },
          // A test in progress turns the same ring as the scan and the test of selected messages.
          test.kind === "busy" ? h("span", { class: "spinner", attrs: { "aria-hidden": "true" } }) : null,
          test.kind === "busy" ? " " : null,
          test.text,
        ),
      );
    }
    return lines;
  }

  function serviceRow(point: AccessPoint, index: number, count: number, editing: Editor | null, signingIn: boolean): HTMLElement {
    const now = Date.now();
    const enabledId = `enabled-${point.id}`;
    const enabled = h("input", {
      type: "checkbox",
      id: enabledId,
      checked: point.enabled,
      attrs: { "aria-label": t("apUseNamed", point.name), "data-focus": "enabled" },
      onchange: () =>
        void guard(async () => {
          if (enabled.checked) {
            // Nothing is switched on before the answer, and the box says so while the question is open.
            enabled.checked = false;
            const { answer } = await askScanFirst(model?.status.wish.services.includes(point.id) === true);
            if (answer === "cancel") {
              return;
            }
            if (answer === "after-scan") {
              await send("enableAfterScan", { id: point.id });
              shell.startPolling();
              await shell.refresh();
              return;
            }
            enabled.checked = true;
          }
          await send("saveAccessPoint", { id: point.id, definition: definitionOf(point, { enabled: enabled.checked }), apiKey: null });
        }),
    });
    const withFocus = <T extends HTMLElement>(element: T, focus: string): T => {
      element.dataset.focus = focus;
      return element;
    };
    const test = withFocus(button(t("apTest"), () => runTest(point.id)), "test");
    test.setAttribute("aria-label", t("apTestNamed", point.name));
    if (point.type === "chatgpt" && !signedIn(point)) {
      // Nothing can be asked without a sign-in: the button says what is missing instead of failing.
      setUnavailable(test, true, t("apTestNeedsSignIn"));
    } else {
      setUnavailable(test, tests.get(point.id)?.kind === "busy");
    }
    const edit = withFocus(button(t("edit"), () => openEditor(point.id, null)), "edit");
    edit.setAttribute("aria-label", t("editNamed", point.name));
    const up = withFocus(iconButton("up", t("moveUpNamed", point.name), () => void guard(() => send("moveAccessPoint", { id: point.id, direction: -1 })), "quiet"), "up");
    setUnavailable(up, index === 0);
    const down = withFocus(iconButton("down", t("moveDownNamed", point.name), () => void guard(() => send("moveAccessPoint", { id: point.id, direction: 1 })), "quiet"), "down");
    setUnavailable(down, index === count - 1);
    const remove = withFocus(
      iconButton(
        "trash",
        t("removeNamed", point.name),
        () =>
          void dialog({
            title: t("apRemoveTitle", point.name),
            body: [t("apRemoveText")],
            confirmLabel: t("remove"),
            danger: true,
            onConfirm: async () => {
              const { revocationConfirmed } = await send("removeAccessPoint", { id: point.id });
              tests.delete(point.id);
              if (!revocationConfirmed) {
                await dialog({ title: t("chatgptRevocationTitle"), body: [t("chatgptRevocationUnconfirmed")], confirmLabel: t("ok"), hideCancel: true });
              }
            },
          }),
        "quiet",
      ),
      "remove",
    );

    const chatgpt: Child[] = [];
    // The sign-in buttons stay while the row is edited: the line above them points at them.
    if (point.type === "chatgpt") {
      chatgpt.push(
        h(
          "div",
          { class: "row service-extra" },
          withFocus(button(t(signedIn(point) ? "chatgptSignInAgain" : "chatgptContinue"), () => startChatGpt(point.id)), "sign-in"),
          signedIn(point)
            ? withFocus(
                button(t("chatgptSignOut"), () =>
                  void guard(async () => {
                    const { revocationConfirmed } = await send("signOut", { id: point.id });
                    if (!revocationConfirmed) {
                      await dialog({ title: t("chatgptRevocationTitle"), body: [t("chatgptRevocationUnconfirmed")], confirmLabel: t("ok"), hideCancel: true });
                    }
                  }),
                ),
                "sign-out",
              )
            : null,
        ),
      );
    }

    const facts: Child[] = [`${tCode("type", point.type)} · ${point.model === "" ? t("apNoModel") : point.model}`];
    if (point.type !== "chatgpt") {
      // The host is a domain and breaks like one.
      facts.push(" · ", address(hostOf(point.endpoint)));
    }
    return h(
      "li",
      { class: `service${point.enabled ? "" : " off"}${editing === null ? "" : " editing"}` },
      h(
        "div",
        { class: "service-main" },
        h("span", { class: "service-order", text: String(index + 1), attrs: { "aria-hidden": "true" } }),
        enabled,
        h(
          "div",
          { class: "service-info" },
          h("label", { class: "service-name", for: enabledId }, ...addressed(point.name)),
          h("div", { class: "description service-facts" }, ...facts),
          ...statusLines(point, now),
        ),
        editing === null ? h("div", { class: "service-actions" }, test, edit, up, down, remove) : null,
      ),
      ...chatgpt,
      // An editor that was left with changes: the line stands where it stood.
      editing?.element ?? (drafts.has(point.id) ? draftLine(point.id, drafts.get(point.id)?.editor.name ?? point.name) : null),
      signingIn ? signInPanel : null,
    );
  }

  function drawList(): void {
    if (model === null) {
      return;
    }
    const points = model.accessPoints;
    const now = Date.now();
    dropStaleTests(points);
    if (editor !== null && editor.id !== null && !points.some((point) => point.id === editor?.id)) {
      editor = null;
    }
    // A draft goes with its service when that is removed.
    for (const key of [...drafts.keys()]) {
      if (key !== NEW_SERVICE && !points.some((point) => point.id === key)) {
        drafts.delete(key);
      }
    }
    const wish = model.status.wish;
    const current = editor;
    // A sign-in in progress belongs to the service it signs in again, or is a new row of its own.
    const signIn = model.status.signIn;
    const signInRow = signIn.url === null ? null : points.some((point) => point.id === signIn.accessPointId) ? signIn.accessPointId : "";
    // How many services can answer now: a paused one says whether another takes over.
    const answering = points.filter((point) => point.enabled && !point.needsAttention && point.cooldownUntil <= now).length;
    const items: Keyed[] = points.map((point, index) => {
      const editing = current !== null && current.id === point.id ? current : null;
      const signingIn = signInRow === point.id;
      return {
        key: point.id,
        signature:
          editing !== null
            ? `editing:${editing.serial}:${index}:${points.length}:${signingIn}`
            : JSON.stringify([
                point,
                index,
                points.length,
                tests.get(point.id) ?? null,
                point.cooldownUntil > now,
                hostGranted(point),
                signingIn,
                answering,
                drafts.has(point.id),
                wish.services.includes(point.id),
                wish.servicesOutcome?.ids.includes(point.id) === true ? wish.servicesOutcome : null,
              ]),
        build: () => serviceRow(point, index, points.length, editing, signingIn),
      };
    });
    if (current !== null && current.id === null) {
      items.push({ key: "new-service", signature: `new:${current.serial}`, build: () => h("li", { class: "service editing" }, current.element) });
    }
    if (signInRow === "") {
      items.push({ key: "sign-in", signature: "sign-in", build: () => h("li", { class: "service signing-in" }, signInPanel) });
    }
    reconcile(list, items);
    list.hidden = items.length === 0;
    empty.hidden = items.length > 0;
    // The editor of a new service that was left with changes: its line stands under the list, where the editor stood.
    const pending = current?.id === null ? undefined : drafts.get(NEW_SERVICE);
    const pendingSignature = pending === undefined ? "" : String(pending.editor.serial);
    if (newDraft.dataset.signature !== pendingSignature) {
      newDraft.dataset.signature = pendingSignature;
      replace(newDraft, pending === undefined ? null : draftLine(NEW_SERVICE, null));
    }
    newDraft.hidden = pending === undefined;
    drawDependents();
  }

  /** What depends on protection and on a service that is switched on: the note under the list, and the two settings that wait for a service. */
  function drawDependents(): void {
    const settings = model?.settings;
    if (model === null || settings === null || settings === undefined) {
      return;
    }
    const inUse = model.accessPoints.some((point) => point.enabled);
    const waiting = model.status.wish.waiting;
    const scanning = model.status.scan?.running === true;
    // With protection on and nobody learned, mail from people the user writes to is sent to the service: the warning
    // of the Overview stands here too, with the button that starts the scan.
    const kind = !inUse ? "" : !settings.protection ? (waiting ? "waiting" : "off") : nothingLearned(model) ? (scanning ? "scanning" : "before-scan") : "";
    scanStatus.update(model);
    if (notProtecting.dataset.kind !== kind) {
      const held = notProtecting.contains(document.activeElement);
      notProtecting.dataset.kind = kind;
      const scanButton: HTMLButtonElement = button(t("scanStart"), () =>
        void whileBusy(scanButton, () =>
          guard(async () => {
            await send("startScan", { from: null, to: null });
            shell.startPolling();
            await shell.refresh();
          }),
        ),
      );
      scanButton.dataset.focus = "scan";
      if (kind === "scanning") {
        // The scan is running: its progress stands under the warning, and the button has nothing to start.
        setUnavailable(scanButton, true, t("errorScanRunning"));
      }
      replace(
        notProtecting,
        kind === ""
          ? null
          : kind === "before-scan" || kind === "scanning"
            ? bar("warning", [t("warnAiBeforeScanOn")], [scanButton])
            : bar("information", [kind === "waiting" ? `${t("wishWaiting")} ${t("aiWaitingNoMail")}` : t("aiProtectionOff")], [
                button(t("aiShowSetup"), () => shell.go("overview", { kind: "protect" })),
              ]),
        kind === "before-scan" || kind === "scanning" ? scanStatus.element : null,
      );
      if (held && !notProtecting.contains(document.activeElement)) {
        // The warning went away with the scan, and its button with it: the keyboard goes on with the first service.
        (notProtecting.querySelector<HTMLElement>("button") ?? list.querySelector<HTMLElement>('[data-focus="enabled"]') ?? presetSelect).focus();
      }
    }
    cutoffUnused.hidden = inUse;
    promptUnused.hidden = inUse;
    // With no service at all the link says what it leads to: the control that adds one.
    const lead = model.accessPoints.length === 0 ? t("step2Add") : t("openAi");
    for (const link of root.querySelectorAll<HTMLElement>("button.to-services")) {
      if (link.textContent !== lead) {
        link.textContent = lead;
      }
    }
    // A hidden note would still be read as part of the description, so it is named only while it shows.
    // A field that shows an error is described by the error until it is corrected.
    if (!cutoff.hasAttribute("aria-invalid")) {
      cutoff.setAttribute("aria-describedby", inUse ? "cutoff-hint" : "cutoff-unused cutoff-hint");
    }
    if (!prompt.hasAttribute("aria-invalid")) {
      prompt.setAttribute("aria-describedby", inUse ? "prompt-hint" : "prompt-unused prompt-hint");
    }
  }

  function maybeWelcome(): void {
    const settings = model?.settings;
    if (settings === null || settings === undefined || settings.chatgptWelcomeShown || welcomeOpen) {
      return;
    }
    if (model?.accessPoints.some(signedIn) !== true) {
      return;
    }
    // Shown once, after the first sign-in with ChatGPT plan use.
    welcomeOpen = true;
    void dialog({
      title: t("chatgptWelcomeTitle"),
      body: [t("chatgptWelcomeText"), h("p", {}, externalLink(t("chatgptManageUsage"), USAGE_URL))],
      confirmLabel: t("chatgptWelcomeGotIt"),
      hideCancel: true,
    }).then(async () => {
      welcomeOpen = false;
      await guard(() => send("welcomeShown", {}));
    });
  }

  drawPresetHint();
  drawPromptState();

  return {
    render(next: Model) {
      model = next;
      const settings = next.settings;
      if (settings === null) {
        return;
      }
      drawSignIn();
      drawList();
      void refreshGrants(next.accessPoints).then((changed) => {
        if (changed && model === next) {
          drawList();
        }
      });
      // Never overwrite text the user is typing.
      if (prompt.value === promptStored) {
        prompt.value = settings.prompt;
      }
      promptStored = settings.prompt;
      drawPromptState();
      const storedCutoff = settings.cutoff.toFixed(2);
      if (mayRedraw({ value: cutoff.value, focused: document.activeElement === cutoff }, cutoffShown, storedCutoff, sameNumber)) {
        cutoff.value = storedCutoff;
        cutoffShown = storedCutoff;
      }
      maybeWelcome();
    },
    reveal(intent: Intent) {
      if (intent.kind === "ai-add") {
        presetSelect.scrollIntoView({ block: "center" });
        presetSelect.focus();
      } else if (intent.kind === "ai-edit") {
        openEditor(intent.id, null, intent.focus ?? "name");
      } else if (intent.kind === "ai-service") {
        // A warning that several services share leads to the first of them: its Edit button takes the focus.
        const row = [...list.querySelectorAll<HTMLElement>("li")].find((item) => item.dataset.key === intent.id);
        const target = row?.querySelector<HTMLElement>('[data-focus="edit"]') ?? null;
        target?.scrollIntoView({ block: "center" });
        target?.focus();
      }
    },
    unsaved() {
      // The prompt, an open editor with changes, an editor that was left with changes, a cutoff that was typed and not
      // saved yet, and a pasted sign-in address that was not sent yet: all of it is lost with the page.
      const cutoffTyped = cutoffShown !== null && cutoff.value !== cutoffShown && !sameNumber(cutoff.value, cutoffShown);
      return promptDirty() || editor?.dirty() === true || drafts.size > 0 || cutoffTyped || (pasted.isConnected && pasted.value.trim() !== "");
    },
    leave() {
      // What became of services that waited for the scan was said here and is history once the pane is left.
      if (model?.status.wish.servicesOutcome !== null && model?.status.wish.servicesOutcome !== undefined) {
        void send("clearServiceWish", { id: null })
          .then(() => shell.refresh())
          .catch(() => undefined);
      }
    },
  };
}
