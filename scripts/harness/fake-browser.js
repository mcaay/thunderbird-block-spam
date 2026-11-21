// A fake of the Thunderbird WebExtension API for the browser harness (see
// scripts/harness.mjs). It keeps two accounts with a few folders and messages in
// memory, so that the real background page and the real settings page can run
// together in an ordinary browser. Development aid only: it is never shipped.
//
// Drive it from the browser console through window.__fake, for example:
//   __fake.tick()                                  run the 5 minute job now
//   __fake.newMail("account1://INBOX", { author: "x@y.example", body: "..." })
//   __fake.select(__fake.ids("account1://INBOX")); __fake.command("block-domain")
//   __fake.menu("trust-domain")                    the same through the context menu

(() => {
  const MESSAGES = window.__HARNESS_MESSAGES;
  const ADDON_ID = "block-spam@thunderbird-block-spam";
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const log = (...args) => console.log("[fake]", ...args);
  const clone = (value) => (value === undefined ? undefined : structuredClone(value));

  function makeEvent() {
    const listeners = new Set();
    return {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener),
      hasListener: (listener) => listeners.has(listener),
      fire: (...args) => [...listeners].map((listener) => listener(...args)),
    };
  }

  // Accounts, folders and messages.
  const accounts = [
    { id: "account1", name: "Work", type: "imap", identities: [{ id: "id1", accountId: "account1", email: "me@mycompany.example" }] },
    { id: "account2", name: "Private", type: "imap", identities: [{ id: "id2", accountId: "account2", email: "me@gmail.com" }] },
  ];
  const folders = [];

  function addFolder(accountId, path, specialUse = []) {
    const folder = {
      id: `${accountId}:/${path}`,
      accountId,
      path,
      name: path.split("/").pop(),
      specialUse,
      isRoot: false,
      isVirtual: false,
      isUnified: false,
      isTag: false,
      messages: [],
    };
    folders.push(folder);
    return folder;
  }

  for (const account of accounts) {
    account.rootFolder = { id: `${account.id}://`, accountId: account.id, path: "/", name: "Root", specialUse: [], isRoot: true };
    addFolder(account.id, "/INBOX", ["inbox"]);
    addFolder(account.id, "/Sent", ["sent"]);
    addFolder(account.id, "/Junk", ["junk"]);
    addFolder(account.id, "/Archive", ["archives"]);
    addFolder(account.id, "/Projects");
  }

  const folderById = (id) => {
    const folder = folders.find((item) => item.id === id);
    if (!folder) {
      throw new Error(`no folder ${id}`);
    }
    return folder;
  };
  const publicFolder = ({ messages, ...folder }) => folder;

  let nextMessageId = 1;
  function put(folderId, partial = {}) {
    const message = {
      id: nextMessageId++,
      author: "Someone <someone@unknown.example>",
      recipients: ["me@mycompany.example"],
      ccList: [],
      bccList: [],
      subject: "Hello",
      date: new Date(now - 60 * 60 * 1000),
      headerMessageId: `m${nextMessageId}@fake`,
      size: 2000,
      body: "Hello there",
      headers: {},
      ...partial,
    };
    folderById(folderId).messages.push(message);
    return message;
  }

  for (let index = 0; index < 40; index += 1) {
    put("account1://Sent", {
      author: "Me <me@mycompany.example>",
      recipients: [`Contact ${index} <person${index}@customer${index % 12}.example>`],
      ccList: index % 5 === 0 ? [`friend${index}@gmail.com`] : [],
      date: new Date(now - index * DAY),
      subject: `Sent ${index}`,
    });
  }
  put("account2://Sent", { author: "me@gmail.com", recipients: ["anna@wp.pl", "bob@partner.example"], date: new Date(now - 2 * DAY) });

  const locate = (messageId) => {
    for (const folder of folders) {
      const message = folder.messages.find((item) => item.id === messageId);
      if (message) {
        return { folder, message };
      }
    }
    throw new Error(`no message ${messageId}`);
  };
  const header = (message, folder) => ({
    id: message.id,
    author: message.author,
    recipients: message.recipients,
    ccList: message.ccList,
    bccList: message.bccList,
    subject: message.subject,
    date: message.date,
    headerMessageId: message.headerMessageId,
    size: message.size,
    external: false,
    folder: publicFolder(folder),
  });
  const list = (folder, keep = () => true) => ({ id: null, messages: folder.messages.filter(keep).map((message) => header(message, folder)) });

  // Events and state.
  let store = {};
  const storageChanged = makeEvent();
  const onMessage = makeEvent();
  const onNewMail = makeEvent();
  const onCommand = makeEvent();
  const onAlarm = makeEvent();
  const onMenu = makeEvent();
  const granted = { permissions: new Set(), origins: new Set() };
  const selected = [];
  const mailTab = { id: 1, windowId: 1, type: "mail", active: true };

  // A fake AI at https://api.fake.test: cold outreach scores high, everything else low.
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, init = {}) => {
    const address = String(url);
    if (!address.startsWith("https://api.fake.test/")) {
      return realFetch(url, init);
    }
    log("fetch", address);
    if (address.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "fake-small" }, { id: "fake-large" }] }), { status: 200 });
    }
    let userText = "";
    try {
      const body = JSON.parse(String(init.body ?? "{}"));
      userText = String(body.messages?.at(-1)?.content ?? body.state ?? body.input ?? "");
    } catch {
      userText = "";
    }
    if ((init.headers?.authorization ?? "").includes("bad-key")) {
      return new Response(JSON.stringify({ error: { message: "Invalid key", code: "invalid_api_key" } }), { status: 401 });
    }
    const score = /SEO|outreach|link-building/i.test(userText) ? "0.97" : "0.08";
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: score }, finish_reason: "stop" }] }), { status: 200 });
  };

  window.browser = {
    accounts: {
      list: async () => clone(accounts),
      get: async (id) => clone(accounts.find((account) => account.id === id) ?? null),
    },
    identities: {
      list: async () => accounts.flatMap((account) => account.identities),
      get: async (id) => accounts.flatMap((account) => account.identities).find((identity) => identity.id === id) ?? null,
    },
    folders: {
      query: async (info = {}) =>
        folders
          .filter((folder) => !info.accountId || folder.accountId === info.accountId)
          .filter((folder) => !info.specialUse || info.specialUse.every((use) => folder.specialUse.includes(use)))
          .map(publicFolder),
      create: async (parentId, name) => {
        const created = addFolder(parentId.split(":")[0], `/${name}`);
        log("folder created", created.path);
        return publicFolder(created);
      },
    },
    messages: {
      query: async (info) => {
        if (info.headerMessageId !== undefined) {
          // The lookup of one message by its Message-ID, across the folders of an account.
          const found = [];
          for (const folder of folders.filter((item) => !info.accountId || item.accountId === info.accountId)) {
            found.push(...folder.messages.filter((message) => message.headerMessageId === info.headerMessageId).map((message) => header(message, folder)));
          }
          return { id: null, messages: found };
        }
        return list(folderById(info.folderId), (message) => (!info.fromDate || message.date >= info.fromDate) && (!info.toDate || message.date <= info.toDate));
      },
      list: async (folderId) => list(folderById(folderId)),
      continueList: async () => ({ id: null, messages: [] }),
      abortList: async () => {},
      getHeaders: async (id) => locate(id).message.headers,
      listAttachments: async () => [],
      listInlineTextParts: async (id) => [{ contentType: "text/plain", content: locate(id).message.body }],
      move: async (ids, folderId) => {
        const target = folderById(folderId);
        for (const id of ids) {
          const { folder, message } = locate(id);
          folder.messages.splice(folder.messages.indexOf(message), 1);
          target.messages.push(message);
        }
        log("moved", ids, "to", folderId);
      },
      onNewMailReceived: onNewMail,
    },
    messengerUtilities: {
      parseMailboxString: async (text) =>
        String(text)
          .split(",")
          .map((part) => {
            const email = (/<([^<>]+)>/.exec(part)?.[1] ?? part).trim();
            return email.includes("@") ? { email } : {};
          }),
      convertToPlainText: async (html) => String(html).replace(/<[^>]+>/g, ""),
    },
    mailTabs: {
      getSelectedMessages: async () => ({
        id: null,
        messages: selected.map((id) => {
          const { folder, message } = locate(id);
          return header(message, folder);
        }),
      }),
    },
    messageDisplay: { getDisplayedMessages: async () => ({ id: null, messages: [] }) },
    compose: { onAfterSend: makeEvent() },
    commands: {
      getAll: async () =>
        [
          ["block-address", "Alt+B"],
          ["block-domain", "Alt+Shift+B"],
          ["trust-address", "Alt+W"],
          ["trust-domain", "Alt+Shift+W"],
        ].map(([name, shortcut]) => ({ name, shortcut })),
      openShortcutSettings: async () => log("openShortcutSettings"),
      onCommand,
      onChanged: makeEvent(),
    },
    tabs: {
      create: async (properties) => {
        log("tabs.create", properties.url);
        return { id: 99, windowId: 1, type: "content", active: true };
      },
      query: async () => [mailTab],
      get: async (id) => ({ ...mailTab, id }),
      update: async (id) => ({ ...mailTab, id }),
      remove: async (id) => log("tabs.remove", id),
    },
    windows: { openDefaultBrowser: async (url) => log("openDefaultBrowser", url), update: async () => ({}) },
    menus: {
      create: (properties, callback) => {
        log("menu item", properties.id);
        callback?.();
        return properties.id;
      },
      removeAll: async () => {},
      onClicked: onMenu,
    },
    alarms: {
      create: (name, info) => log("alarm created", name, JSON.stringify(info)),
      get: async () => undefined,
      onAlarm,
    },
    notifications: {
      create: async (options) => {
        log("notification:", options.message);
        window.__fake.notifications.push(options.message);
        return "notification";
      },
    },
    permissions: {
      request: async (request) => {
        log("permissions.request", JSON.stringify(request));
        (request.permissions ?? []).forEach((item) => granted.permissions.add(item));
        (request.origins ?? []).forEach((item) => granted.origins.add(item));
        window.__fake.permissionRequests.push(request);
        return true;
      },
      contains: async () => true,
      // Like Thunderbird today: no data_collection in the answer, the feature is off.
      getAll: async () => ({ permissions: [...granted.permissions], origins: [...granted.origins] }),
      onAdded: makeEvent(),
      onRemoved: makeEvent(),
    },
    storage: {
      local: {
        get: async (keys) => {
          if (keys === null || keys === undefined) {
            return clone(store);
          }
          const result = {};
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            if (key in store) {
              result[key] = clone(store[key]);
            }
          }
          return result;
        },
        set: async (items) => {
          const changes = {};
          for (const [key, value] of Object.entries(items)) {
            changes[key] = { oldValue: store[key], newValue: value };
            store[key] = clone(value);
          }
          storageChanged.fire(changes, "local");
        },
        remove: async (keys) => {
          const changes = {};
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            changes[key] = { oldValue: store[key] };
            delete store[key];
          }
          storageChanged.fire(changes, "local");
        },
        clear: async () => {
          store = {};
          storageChanged.fire({}, "local");
        },
      },
      onChanged: storageChanged,
    },
    runtime: {
      id: ADDON_ID,
      lastError: null,
      getURL: (path) => path,
      getManifest: () => ({ version: "0.0.0", name: "Block Spam", optional_permissions: ["accountsFolders", "webRequest"] }),
      getPlatformInfo: async () => ({ os: "harness" }),
      openOptionsPage: async () => log("openOptionsPage"),
      sendMessage: async (message) => {
        const sender = { id: ADDON_ID, tab: { id: 5, windowId: 1, type: "content", active: true } };
        const replies = onMessage.fire(clone(message), sender).filter((reply) => reply !== undefined);
        return clone(await replies[0]);
      },
      onMessage,
      onMessageExternal: makeEvent(),
      onInstalled: makeEvent(),
      onStartup: makeEvent(),
    },
    i18n: {
      getMessage: (name, substitutions = []) => {
        const values = Array.isArray(substitutions) ? substitutions : [substitutions];
        return (MESSAGES[name]?.message ?? "").replace(/\$(\d)/g, (_match, index) => values[Number(index) - 1] ?? "");
      },
      getUILanguage: () => "en",
    },
  };

  window.__fake = {
    notifications: [],
    permissionRequests: [],
    /** Everything in the fake storage. */
    store: () => store,
    /** Adds a message to a folder without telling the add-on. */
    put,
    /** Message ids in a folder. */
    ids: (folderId) => folderById(folderId).messages.map((message) => message.id),
    /** Sets the selected messages of the mail tab. */
    select: (ids) => {
      selected.length = 0;
      selected.push(...ids);
    },
    /** Presses a shortcut: block-address, block-domain, trust-address or trust-domain. */
    command: (name) => onCommand.fire(name, mailTab),
    /** Chooses a command from the context menu of the message list, for the selected messages. */
    menu: (name) =>
      onMenu.fire({
        menuItemId: name,
        selectedMessages: {
          id: null,
          messages: selected.map((id) => {
            const { folder, message } = locate(id);
            return header(message, folder);
          }),
        },
      }),
    /** Fires the 5 minute alarm. */
    tick: () => onAlarm.fire({ name: "tick" }),
    /** Delivers a new message and fires messages.onNewMailReceived. */
    newMail: (folderId, partial = {}) => {
      const folder = folderById(folderId);
      const message = put(folderId, { date: new Date(), ...partial });
      onNewMail.fire(publicFolder(folder), { id: null, messages: [header(message, folder)] });
      return message.id;
    },
  };
})();
