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
const DEFAULT_COLOR = "rgba(200, 0, 0, 0.5)";
const DEFAULT_FONT_SIZE = 28;
const MAX_FONT_SIZE = 64;
const DEFAULT_ANGLE = -45;
const DEFAULT_TILE_SIZE = 300;
const MIN_TILE_SIZE = 100;
const MAX_TILE_SIZE = 2048;

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  ConsoleClient: "resource://gre/modules/enterprise/ConsoleClient.sys.mjs",
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
  async init(match, copy, color, fontSize, angle, secondaryCopy, size) {
    let validMatches = [];

    for (let i = 0; i < match.length && i < LIST_LENGTH_LIMIT; i++) {
      try {
        new MatchPattern(match[i]);
        validMatches.push(match[i]);
      } catch (e) {
        lazy.log.error(`Invalid pattern on Watermark. Pages: ${match[i]}`);
      }
    }

    if (!validMatches.length) {
      lazy.log.error("Watermark policy has no valid pages; not applying.");
      this._unregisterActor();
      Services.ppmm.sharedData.delete(WATERMARK_SHARED_DATA_KEY);
      Services.ppmm.sharedData.flush();
      this._refreshOpenTabs(null);
      return;
    }

    if (typeof secondaryCopy !== "string") {
      secondaryCopy = "%t";
    }

    if (typeof size !== "number") {
      size = DEFAULT_TILE_SIZE;
    }

    let email;
    if (!copy || copy?.includes?.("%e") || secondaryCopy.includes("%e")) {
      try {
        email = (await lazy.ConsoleClient.getLoggedInUserInfo())?.email;
      } catch (e) {
        lazy.log.error(`Failed to get logged in user info for Watermark: ${e}`);
      }
    }

    if (!copy) {
      copy = email || "CONFIDENTIAL";
    }

    let config = {
      match: validMatches,
      copy,
      color: sanitizeCSSColor(color) ?? DEFAULT_COLOR,
      size: Math.min(Math.max(MIN_TILE_SIZE, size), MAX_TILE_SIZE),
      fontSize: Math.min(
        typeof fontSize === "number" && fontSize > 0
          ? fontSize
          : DEFAULT_FONT_SIZE,
        MAX_FONT_SIZE
      ),
      angle: (typeof angle === "number" ? angle : DEFAULT_ANGLE) % 360,
      secondaryCopy,
      email: email || "",
    };

    this._registerActor(validMatches);

    Services.ppmm.sharedData.set(WATERMARK_SHARED_DATA_KEY, config);
    Services.ppmm.sharedData.flush();

    this._refreshOpenTabs(config);
  },

  cleanup() {
    this._unregisterActor();

    Services.ppmm.sharedData.delete(WATERMARK_SHARED_DATA_KEY);
    Services.ppmm.sharedData.flush();

    this._refreshOpenTabs(null);
  },

  _registerActor(matches) {
    ChromeUtils.unregisterWindowActor(WATERMARK_ACTOR_NAME);
    ChromeUtils.registerWindowActor(WATERMARK_ACTOR_NAME, {
      child: {
        esModuleURI: "resource:///modules/policies/WatermarkChild.sys.mjs",
        events: {
          DOMContentLoaded: {},
          pageshow: {},
        },
      },
      matches,
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
    } catch (_) {
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
        } catch (_) {
          // The actor may not be available for this browser (e.g. non-web
          // documents); ignore.
        }
      }
    }
  },
};

function sanitizeCSSColor(value) {
  if (typeof value !== "string") {
    return null;
  }

  value = value.trim();

  if (!CSS.supports("color", value)) {
    return null;
  }

  return value;
}
