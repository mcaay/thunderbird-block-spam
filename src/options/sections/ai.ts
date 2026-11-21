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
import {
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
  learnMore,
  option,
  reconcile,
  replace,
  setUnavailable,
} from "../dom";
import type { Child, FieldError, Keyed } from "../dom";
import { mayRedraw, sameNumber } from "../fields";
import { formatLogTime, formatScore } from "../format";
import { LOOPBACK_ORIGIN, requestAccess } from "../permissions";
import type { Model } from "../model";
import type { Intent, Section, Shell } from "../section";

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

/** The editor of one service. Its element lives inside the row that is being edited. */
interface Editor {
  /** The service being edited, or null for a new one. */
  id: string | null;
  /** Changes with every editor that is opened, so that the row is built once per editor. */
  serial: number;
  element: HTMLElement;
  focus(): void;
}

interface TestState {
  text: string;
  kind: "busy" | "ok" | "error";
}

export function aiSection(shell: Shell): Section {
  const root = byId("ai");
  let model: Model | null = null;
  /** Results of Test, kept across redraws. */
  const tests = new Map<string, TestState>();
  let editor: Editor | null = null;
  let editorSerial = 0;
  let welcomeOpen = false;
  let signInDrawn = "";
  /** The field for the pasted redirect address. It keeps its text while the panel is redrawn. */
  const pasted = h("input", { type: "text", id: "sign-in-address", placeholder: "http://127.0.0.1:1455/auth/callback?code=..." });
  let pastedFor: string | null = null;

  const list = h("ol", { class: "services" });
  const empty = description(t("servicesNone"));
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
  const signInPanel = h("div", { class: "sign-in" });

  const cutoff = h("input", {
    type: "number",
    id: "cutoff",
    min: "0",
    max: "1",
    step: "0.01",
    oninput: () => {
      cutoffError.set(null);
      cutoffStatus.clear();
    },
    onchange: () => saveCutoff(),
  });
  const cutoffError = fieldError(cutoff, "cutoff-error");
  const cutoffStatus = inlineStatus();
  /** What the page put into the cutoff field last. Anything else in it is an edit. */
  let cutoffShown: string | null = null;

  const prompt = h("textarea", { rows: 14, id: "prompt", oninput: () => drawPromptState(), attrs: { "aria-describedby": "prompt-hint", spellcheck: "false" } });
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
    h("p", { class: "lead" }, t("aiLead"), " ", learnMore(t("aiLeadTopic"), t("aiHint"), t("aiSecretsHint"), t("privacyText"))),
    h("h2", { text: t("servicesTitle") }),
    description(t("servicesHint")),
    empty,
    list,
    h(
      "div",
      { class: "row add-service" },
      h("label", { for: "preset", text: t("serviceAddLabel") }),
      presetSelect,
      button(t("add"), () => {
        const preset = PRESETS.find((item) => item.id === presetSelect.value) ?? null;
        if (preset?.type === "chatgpt") {
          startChatGpt(null);
        } else if (preset !== null) {
          openEditor(null, preset);
        }
      }),
    ),
    presetHint,
    signInPanel,
    h("h2", { text: t("cutoffTitle") }),
    h("div", { class: "row" }, h("label", { for: "cutoff", text: t("cutoffLabel") }), cutoff, cutoffStatus.element),
    cutoffError.element,
    description(t("cutoffHint")),
    h("h2", { text: t("promptTitle") }),
    h("div", { class: "description", id: "prompt-hint", text: t("promptHint") }),
    prompt,
    promptError.element,
    description(t("outputLineLabel")),
    h("pre", { class: "code-block", text: OUTPUT_LINE }),
    h("div", { class: "row" }, savePromptButton, discardPromptButton, restorePromptButton, promptStatus.element),
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
      preset.keyUrl === undefined ? null : " ",
      preset.keyUrl === undefined ? null : externalLink(t("getKey"), preset.keyUrl),
      preset.docsUrl === undefined ? null : " ",
      preset.docsUrl === undefined ? null : externalLink(t("documentation"), preset.docsUrl),
    );
  }

  // -------------------------------------------------------------------------
  // Cutoff and prompt.

  /** The cutoff is saved when the field is left or Enter is pressed, like every other setting. */
  function saveCutoff(): void {
    const value = Number(cutoff.value);
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
    discardPromptButton.hidden = !dirty;
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
        drawPromptState();
        promptStatus.flash(t("saved"));
      },
      (message) => promptError.set(message),
    );
  }

  // -------------------------------------------------------------------------
  // ChatGPT plan sign-in.

  /** Explains what is sent and asks for consent before sign-in. The terms of the programme require it. */
  function startChatGpt(accessPointId: string | null): void {
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
        await send("startSignIn", { accessPointId, openTab: true });
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
    if (signIn === undefined || (signIn.url === null && signIn.error === "")) {
      replace(signInPanel);
      return;
    }
    const failed = signIn.error === "" ? null : h("p", { class: "field-error", text: t("signInFailed", signIn.error), attrs: { role: "alert" } });
    if (signIn.url === null) {
      replace(signInPanel, failed);
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
      description(t("signInPasteHint")),
      h(
        "div",
        { class: "row" },
        h("label", { for: "sign-in-address", class: "visually-hidden", text: t("signInAddressLabel") }),
        pasted,
        button(t("signInFinish"), () => void guard(() => send("finishSignIn", { url: pasted.value }))),
        button(t("cancel"), () => void guard(() => send("cancelSignIn", {}))),
      ),
      failed,
    );
  }

  // -------------------------------------------------------------------------
  // The editor, shown inside the row that is being edited.

  function closeEditor(focusId: string | null): void {
    editor = null;
    drawList();
    if (focusId === null) {
      presetSelect.focus();
    } else {
      [...list.querySelectorAll<HTMLElement>("li")]
        .find((item) => item.dataset.key === focusId)
        ?.querySelector<HTMLElement>('[data-focus="edit"]')
        ?.focus();
    }
  }

  function openEditor(id: string | null, preset: Preset | null): void {
    if (model === null) {
      return;
    }
    const existing = id === null ? null : (model.accessPoints.find((point) => point.id === id) ?? null);
    const type = existing?.type ?? preset?.type;
    if (type === undefined) {
      return;
    }
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
        lookUp();
      },
      attrs: { spellcheck: "false" },
    });
    const modelInput = h("input", { type: "text", id: `${prefix}-model`, value: existing?.model ?? preset?.model ?? "", attrs: { list: `${prefix}-models`, spellcheck: "false", autocomplete: "off" } });
    const models = h("datalist", { id: `${prefix}-models` });
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
    const fields = { name, endpoint, model: modelInput, key };
    const modelStatus = inlineStatus();
    const saveStatus = inlineStatus();
    const localNote = h("div", { class: "local-note" });

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
        if (problem !== undefined && first === null) {
          first = fields[field];
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
    function withConsent(definition: AccessPointDefinition, confirmLabel: string, run: () => Promise<void>, onError: (message: string) => void): void {
      const pattern = patternOf(definition.endpoint);
      if (pattern === null || alreadyAllowed(pattern)) {
        void guard(run, onError);
        return;
      }
      void dialog({
        title: t("consentTitle"),
        body: [t("consentText", hostOf(definition.endpoint)), t("consentWhat"), t("consentNever")],
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
      });
    }

    const save = (): void => {
      const { definition, newKey } = readDefinition();
      if (!showProblems(checkDefinition(definition, newKey !== null || (existing !== null && existing.apiKey !== "")))) {
        return;
      }
      saveStatus.clear();
      withConsent(
        definition,
        t("consentAgree"),
        async () => {
          const { id: savedId } = await send("saveAccessPoint", { id: existing?.id ?? null, definition, apiKey: newKey });
          await shell.refresh();
          closeEditor(savedId);
          // One test right away, so the row says at once whether the service works.
          runTest(savedId);
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
          async () => showModels(await send("listModels", { id: existing.id })),
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
      modelStatus.set(t("loadModelsBusy"));
      withConsent(
        definition,
        t("consentAgreeLoad"),
        async () => showModels(await send("listModelsFor", { id: existing?.id ?? null, definition, apiKey: newKey })),
        (message) => modelStatus.set(message, "error"),
      );
    };

    function showModels(options: { id: string; label: string }[]): void {
      replace(models, ...options.map((item) => option(item.id, item.label)));
      modelStatus.set(options.length === 0 ? t("loadModelsNone") : t("loadModelsDone", options.length), options.length === 0 ? "plain" : "ok");
      modelInput.focus();
    }

    const field = (label: string, control: HTMLElement, error: FieldError, hint: string, ...extra: Child[]): HTMLElement =>
      h(
        "div",
        { class: "field" },
        h("label", { for: control.id, text: label }),
        extra.length === 0 ? control : h("div", { class: "row tight" }, control, ...extra),
        error.element,
        hint === "" ? null : description(hint),
      );

    const titleId = `${prefix}-title`;
    const element = h(
      "form",
      {
        class: "editor",
        attrs: { "aria-labelledby": titleId, novalidate: "" },
        onsubmit: (event) => {
          event.preventDefault();
          save();
        },
        onkeydown: (event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            closeEditor(existing?.id ?? null);
          }
        },
      },
      h("h3", { id: titleId, text: existing === null ? t("editorAddTitle", presetName) : t("editorEditTitle", existing.name) }),
      field(t("fieldName"), name, errors.name, ""),
      type === "chatgpt" ? null : field(t("fieldEndpoint"), endpoint, errors.endpoint, fixed ? t("endpointFixed") : tCode("endpointHint", type)),
      field(
        t("fieldModel"),
        modelInput,
        errors.model,
        tCode("modelHint", type),
        canLoadModels ? button(t("loadModels"), loadModels) : null,
        canLoadModels ? modelStatus.element : null,
      ),
      models,
      type === "chatgpt" ? null : field(t("fieldKey"), key, errors.key, t("keyHint")),
      localNote,
      h(
        "div",
        { class: "row" },
        h("button", { type: "submit", class: "primary", text: t("save") }),
        button(t("cancel"), () => closeEditor(existing?.id ?? null)),
        saveStatus.element,
      ),
    );
    drawLocalNote();
    lookUp();
    editor = { id: existing?.id ?? null, serial, element, focus: () => name.focus() };
    drawList();
    element.scrollIntoView({ block: "nearest" });
    name.focus();
    name.select();
  }

  // -------------------------------------------------------------------------
  // The list of services.

  function runTest(id: string): void {
    tests.set(id, { text: t("apTesting"), kind: "busy" });
    drawList();
    void (async () => {
      try {
        const outcome = await send("testAccessPoint", { id });
        tests.set(id, outcome.ok ? { text: t("apTestScore", formatScore(outcome.score, stringsLocale())), kind: "ok" } : { text: t("apTestFailed", outcome.error), kind: "error" });
      } catch (error) {
        tests.set(id, { text: t("apTestFailed", errorText(error)), kind: "error" });
      }
      drawList();
    })();
  }

  function statusLines(point: AccessPoint, now: number): HTMLElement[] {
    const lines: HTMLElement[] = [];
    if (!point.enabled) {
      lines.push(h("div", { class: "service-state off", text: t("apDisabled") }));
    }
    if (point.type === "chatgpt") {
      lines.push(
        h(
          "div",
          { class: "service-state" },
          !signedIn(point)
            ? t("chatgptSignedOut")
            : (point.auth?.email ?? "") === ""
              ? t("chatgptUsingPlan")
              : t("chatgptUsingPlanAs", point.auth?.email ?? ""),
          signedIn(point) ? " " : null,
          signedIn(point) ? externalLink(t("chatgptManageUsage"), USAGE_URL) : null,
        ),
      );
    }
    if (point.needsAttention) {
      lines.push(h("div", { class: "service-state attention" }, h("strong", { text: t("apNeedsAttention") }), " ", tCode("remedy", remedyOf(point))));
    }
    if (point.cooldownUntil > now) {
      lines.push(h("div", { class: "service-state paused", text: t("apCoolingDown", formatLogTime(point.cooldownUntil, now)) }));
    }
    if (point.lastError !== "") {
      lines.push(h("div", { class: "service-state detail", text: t("apLastError", point.lastError) }));
    }
    const test = tests.get(point.id);
    if (test !== undefined) {
      lines.push(h("div", { class: `service-state test ${test.kind}`, text: test.text, attrs: { role: test.kind === "error" ? "alert" : "status" } }));
    }
    return lines;
  }

  function serviceRow(point: AccessPoint, index: number, count: number, editing: Editor | null): HTMLElement {
    const now = Date.now();
    const enabledId = `enabled-${point.id}`;
    const enabled = h("input", {
      type: "checkbox",
      id: enabledId,
      checked: point.enabled,
      attrs: { "aria-label": t("apUseNamed", point.name), "data-focus": "enabled" },
      onchange: () => void guard(() => send("saveAccessPoint", { id: point.id, definition: definitionOf(point, { enabled: enabled.checked }), apiKey: null })),
    });
    const withFocus = <T extends HTMLElement>(element: T, focus: string): T => {
      element.dataset.focus = focus;
      return element;
    };
    const test = withFocus(button(t("apTest"), () => runTest(point.id)), "test");
    setUnavailable(test, tests.get(point.id)?.kind === "busy");
    test.setAttribute("aria-label", t("apTestNamed", point.name));
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
    if (point.type === "chatgpt" && editing === null) {
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

    const facts = [tCode("type", point.type), point.model === "" ? t("apNoModel") : point.model];
    if (point.type !== "chatgpt") {
      facts.push(hostOf(point.endpoint));
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
          h("label", { class: "service-name", for: enabledId, text: point.name }),
          h("div", { class: "description service-facts", text: facts.join(" · ") }),
          ...statusLines(point, now),
        ),
        editing === null ? h("div", { class: "service-actions" }, test, edit, up, down, remove) : null,
      ),
      ...chatgpt,
      editing?.element ?? null,
    );
  }

  function drawList(): void {
    if (model === null) {
      return;
    }
    const points = model.accessPoints;
    const now = Date.now();
    if (editor !== null && editor.id !== null && !points.some((point) => point.id === editor?.id)) {
      editor = null;
    }
    const current = editor;
    const items: Keyed[] = points.map((point, index) => {
      const editing = current !== null && current.id === point.id ? current : null;
      return {
        key: point.id,
        signature:
          editing !== null
            ? `editing:${editing.serial}:${index}:${points.length}`
            : JSON.stringify([point, index, points.length, tests.get(point.id) ?? null, point.cooldownUntil > now, hostGranted(point)]),
        build: () => serviceRow(point, index, points.length, editing),
      };
    });
    if (current !== null && current.id === null) {
      items.push({ key: "new-service", signature: `new:${current.serial}`, build: () => h("li", { class: "service editing" }, current.element) });
    }
    reconcile(list, items);
    list.hidden = items.length === 0;
    empty.hidden = points.length > 0;
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
      drawList();
      drawSignIn();
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
        openEditor(intent.id, null);
      }
    },
    unsaved() {
      return promptDirty();
    },
  };
}
