// Block Spam Keys: passes the captured keys on to the main add-on as command names.
// The main add-on accepts these four names from this add-on's id only.

"use strict";

const MAIN_ADDON_ID = "block-spam@thunderbird-block-spam";

browser.bareKeys.onCommand.addListener((command) => {
  browser.runtime.sendMessage(MAIN_ADDON_ID, { command }).catch((error) => {
    console.warn("Block Spam Keys: Block Spam did not answer. Is it installed and enabled?", error);
  });
});
