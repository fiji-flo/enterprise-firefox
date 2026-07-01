/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Parent-process side of the Watermark policy actor. It exists so that the
 * parent process can message the content-process WatermarkPolicyChild (for
 * example to refresh already-open tabs when a live policy is applied or
 * removed), and so the child's diagnostics can be logged from the parent
 * process where they are always visible in the Browser Console.
 */

const PREF_LOGLEVEL = "browser.policies.loglevel";

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  let { ConsoleAPI } = ChromeUtils.importESModule(
    "resource://gre/modules/Console.sys.mjs"
  );
  return new ConsoleAPI({
    prefix: "Watermark Policy",
    maxLogLevel: "error",
    maxLogLevelPref: PREF_LOGLEVEL,
  });
});

/**
 * Parent-process side of the Watermark policy actor. Relays messages to the
 * content-process child and logs the child's diagnostics.
 */
export class WatermarkPolicyParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name === "Watermark:Log") {
      let { level, text } = message.data;
      if (level === "error") {
        lazy.log.error(`[content] ${text}`);
      } else {
        lazy.log.debug(`[content] ${text}`);
      }
    }
  }
}
