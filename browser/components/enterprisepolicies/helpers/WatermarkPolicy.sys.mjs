/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * This module implements the Watermark policy, which draws a tiled, diagonal
 * watermark over a configurable list of websites.
 *
 * The list of affected pages is given as an array of MatchPattern strings, as
 * documented at
 * https://developer.mozilla.org/en-US/Add-ons/WebExtensions/Match_patterns.
 *
 * The configuration is published to content processes through `sharedData`,
 * and the actual drawing happens in the content process from WatermarkChild.
 * Rather than registering the WatermarkPolicy actor for every http(s) page
 * (which would mean creating it, and running its DOMContentLoaded/pageshow
 * listeners, on every navigation everywhere, even with no policy applied),
 * this module registers the actor itself with `matches` set to the policy's
 * own Pages list, so the actor only ever gets constructed for pages that can
 * possibly be watermarked. It (re-)registers the actor whenever the policy is
 * applied or changed, and unregisters it when the policy is removed.
 */

const PREF_LOGLEVEL = "browser.policies.loglevel";

// Key used to publish the watermark configuration to content processes through
// `sharedData`. Must be kept in sync with WatermarkChild.sys.mjs.
export const WATERMARK_SHARED_DATA_KEY = "EnterprisePolicies:Watermark";

const WATERMARK_ACTOR_NAME = "WatermarkPolicy";

const LIST_LENGTH_LIMIT = 1000;
const DEFAULT_COLOR = "rgba(128, 128, 128, 0.2)";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  let { ConsoleAPI } = ChromeUtils.importESModule(
    "resource://gre/modules/Console.sys.mjs"
  );
  return new ConsoleAPI({
    prefix: "Watermark Policy",
    // tip: set maxLogLevel to "debug" and use log.debug() to create detailed
    // messages during development. See LOG_LEVELS in Console.sys.mjs for details.
    maxLogLevel: "error",
    maxLogLevelPref: PREF_LOGLEVEL,
  });
});

export let WatermarkPolicy = {
  init(pages, copy, color) {
    let validPages = [];

    for (let i = 0; i < pages.length && i < LIST_LENGTH_LIMIT; i++) {
      try {
        // Build a MatchPattern to validate the entry before sending it to
        // content processes, where the actual matching happens.
        new MatchPattern(pages[i]);
        validPages.push(pages[i]);
      } catch (e) {
        lazy.log.error(`Invalid pattern on Watermark. Pages: ${pages[i]}`);
      }
    }

    if (!validPages.length || !copy) {
      lazy.log.error(
        "Watermark policy has no valid pages or no copy; not applying."
      );
      this._unregisterActor();
      Services.ppmm.sharedData.delete(WATERMARK_SHARED_DATA_KEY);
      Services.ppmm.sharedData.flush();
      this._refreshOpenTabs(null);
      return;
    }

    let config = {
      pages: validPages,
      copy,
      color: color || DEFAULT_COLOR,
    };

    // Registering with `matches: validPages` means the actor (and its
    // DOMContentLoaded/pageshow listeners) is only ever created for pages
    // that this policy could actually watermark, instead of on every http(s)
    // page load. Re-registering also picks up changes to Pages from a live
    // policy update.
    this._registerActor(validPages);

    Services.ppmm.sharedData.set(WATERMARK_SHARED_DATA_KEY, config);
    Services.ppmm.sharedData.flush();
    lazy.log.debug(`Watermark config published: ${JSON.stringify(config)}`);

    // When this runs at startup, no browser windows exist yet, and every
    // matching page will be watermarked as it loads. When it runs at runtime
    // (a live policy from the enterprise console), refresh already-open tabs
    // so the watermark appears without requiring a reload.
    this._refreshOpenTabs(config);
  },

  cleanup() {
    this._unregisterActor();

    Services.ppmm.sharedData.delete(WATERMARK_SHARED_DATA_KEY);
    Services.ppmm.sharedData.flush();

    // Remove the watermark from already-open tabs when a live policy is
    // removed.
    this._refreshOpenTabs(null);
  },

  _registerActor(pages) {
    // Unregistering first avoids "actor is already registered" errors when
    // re-registering with an updated Pages list; unregistering an actor that
    // isn't currently registered is a no-op.
    ChromeUtils.unregisterWindowActor(WATERMARK_ACTOR_NAME);
    ChromeUtils.registerWindowActor(WATERMARK_ACTOR_NAME, {
      parent: {
        esModuleURI: "resource:///modules/policies/WatermarkParent.sys.mjs",
      },
      child: {
        esModuleURI: "resource:///modules/policies/WatermarkChild.sys.mjs",
        events: {
          DOMContentLoaded: {},
          pageshow: {},
        },
      },
      matches: pages,
      messageManagerGroups: ["browsers"],
      safeForUntrustedWebProcess: true,
    });
  },

  _unregisterActor() {
    ChromeUtils.unregisterWindowActor(WATERMARK_ACTOR_NAME);
  },

  _refreshOpenTabs(config) {
    let windows;
    try {
      windows = lazy.BrowserWindowTracker.orderedWindows;
    } catch (e) {
      // No browser windows available (e.g. during early startup or in
      // non-browser contexts); nothing to refresh.
      return;
    }
    for (let win of windows) {
      for (let browser of win.gBrowser?.browsers ?? []) {
        try {
          browser.sendMessageToActor(
            "Watermark:Refresh",
            { config },
            "WatermarkPolicy"
          );
        } catch (e) {
          // The actor may not be available for this browser (e.g. non-web
          // documents); ignore.
        }
      }
    }
  },
};
