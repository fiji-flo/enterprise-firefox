/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Content-process side of the Watermark policy. When the document matches one
 * of the configured pages, this draws a tiled, diagonal watermark over the
 * page using the DevTools CanvasFrameAnonymousContentHelper, which inserts the
 * markup into the document's canvasFrame anonymous content and keeps it in sync
 * across in-document navigations.
 *
 * Anonymous content isn't included when a document is cloned for printing,
 * so it's not enough to watermark printed pages. For that, a second,
 * real (non-anonymous) watermark node is inserted directly into the document
 * on "beforeprint", and removed again on "afterprint" (see
 * #applyPrintWatermark).
 */

// Key used to read the watermark configuration published by WatermarkPolicy.
// Must be kept in sync with WatermarkPolicy.sys.mjs.
const WATERMARK_SHARED_DATA_KEY = "EnterprisePolicies:Watermark";

// Size of a single watermark tile, in CSS pixels.
const TILE_WIDTH = 300;
const TILE_HEIGHT = 200;

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

ChromeUtils.defineLazyGetter(lazy, "DevTools", () => {
  const { require } = ChromeUtils.importESModule(
    "resource://devtools/shared/loader/Loader.sys.mjs"
  );
  return {
    HighlighterEnvironment:
      require("resource://devtools/server/actors/highlighters.js")
        .HighlighterEnvironment,
    CanvasFrameAnonymousContentHelper:
      require("resource://devtools/server/actors/highlighters/utils/markup.js")
        .CanvasFrameAnonymousContentHelper,
  };
});

function escapeXML(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// Builds the tiled, diagonal watermark texture as a `background-image` CSS
// value, shared by both the on-screen (anonymous content) and print (real
// DOM node) watermarks.
function watermarkBackgroundImage(config) {
  let color = escapeXML(config.color);
  let copy = escapeXML(config.copy);
  let svg =
    `<svg xmlns='http://www.w3.org/2000/svg' ` +
    `width='${TILE_WIDTH}' height='${TILE_HEIGHT}'>` +
    `<text x='${TILE_WIDTH / 2}' y='${TILE_HEIGHT / 2}' fill='${color}' ` +
    `font-family='sans-serif' font-size='28' text-anchor='middle' ` +
    `dominant-baseline='middle' ` +
    `transform='rotate(-45 ${TILE_WIDTH / 2} ${TILE_HEIGHT / 2})'>` +
    `${copy}</text></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

// beforeprint/afterprint are dispatched directly on the window rather than on
// the document, and aren't reliably delivered through the JSWindowActorChild
// declarative `events` registration used for DOMContentLoaded/pageshow above
// (there's no other actor in the tree relying on those two events for that
// mechanism). They're added imperatively in actorCreated() instead, in the
// system group so they aren't affected by the page's own script.
const PRINT_EVENT_OPTIONS = { mozSystemGroup: true };

// Common styling for both the on-screen and print watermark nodes. `position:
// fixed` is repeated on every page when printing, which is what tiles the
// watermark across the whole print job rather than just the first page.
function watermarkNodeStyle(config) {
  return [
    "position: fixed",
    "top: 0",
    "left: 0",
    "width: 100%",
    "height: 100%",
    "pointer-events: none",
    "z-index: 2147483647",
    `background-image: ${watermarkBackgroundImage(config)}`,
    "background-repeat: repeat",
    // By default, browsers don't print background images (to save ink; see
    // the "economy" value of the print-color-adjust spec), so without this
    // the watermark would be invisible when printed. Setting `opacity` on the
    // node instead (to work around that) causes it to be composited as an
    // opaque group in print, hiding the whole page underneath it.
    "print-color-adjust: exact",
  ].join("; ");
}

/**
 * Draws the watermark in the content process for documents matching the
 * Watermark policy configuration.
 */
export class WatermarkPolicyChild extends JSWindowActorChild {
  #helper = null;
  #env = null;
  #printNode = null;

  // Log through the parent actor so messages are visible in the Browser
  // Console without enabling "Show Content Messages", and also to the local
  // content-process console.
  #log(text, level = "debug") {
    if (level === "error") {
      lazy.log.error(text);
    } else {
      lazy.log.debug(text);
    }
    try {
      this.sendAsyncMessage("Watermark:Log", { level, text });
    } catch (e) {
      // The parent actor may be gone; ignore.
    }
  }

  actorCreated() {
    this.#log(`actor created for ${this.document?.documentURI}`);
    this.contentWindow?.addEventListener(
      "beforeprint",
      this,
      PRINT_EVENT_OPTIONS
    );
    this.contentWindow?.addEventListener(
      "afterprint",
      this,
      PRINT_EVENT_OPTIONS
    );
  }

  handleEvent(event) {
    switch (event.type) {
      case "DOMContentLoaded":
      case "pageshow":
        this.#log(`${event.type} for ${this.document?.documentURI}`);
        // Don't redraw if we already have a watermark (e.g. the other event
        // already fired, or a bfcache restore).
        if (!this.#helper) {
          this.#applyWatermark();
        }
        break;
      case "beforeprint":
        this.#applyPrintWatermark();
        break;
      case "afterprint":
        this.#removePrintWatermark();
        break;
    }
  }

  receiveMessage(message) {
    switch (message.name) {
      case "Watermark:Refresh":
        // A live policy was applied, changed, or removed. The up-to-date
        // configuration (or null when the policy was removed) is provided in
        // the message rather than read from sharedData, to avoid racing the
        // sharedData snapshot update against this message.
        this.#applyWatermark(message.data.config);
        break;
    }
  }

  // Test-only introspection: whether a watermark is currently drawn for this
  // document.
  get isShowingWatermark() {
    return !!this.#helper;
  }

  // Test-only introspection: whether a print watermark is currently inserted
  // for this document.
  get isShowingPrintWatermark() {
    return !!this.#printNode;
  }

  didDestroy() {
    this.contentWindow?.removeEventListener(
      "beforeprint",
      this,
      PRINT_EVENT_OPTIONS
    );
    this.contentWindow?.removeEventListener(
      "afterprint",
      this,
      PRINT_EVENT_OPTIONS
    );
    this.#destroyWatermark();
    this.#removePrintWatermark();
  }

  #documentMatches(config) {
    if (!config || !config.pages?.length || !config.copy) {
      return false;
    }

    let uri = this.document?.documentURI;
    if (!uri) {
      return false;
    }

    try {
      return new MatchPatternSet(config.pages).matches(uri);
    } catch (e) {
      lazy.log.error(`Failed to match ${uri}: ${e}`);
      return false;
    }
  }

  #applyWatermark(
    config = Services.cpmm.sharedData.get(WATERMARK_SHARED_DATA_KEY)
  ) {
    // Start from a clean slate so changes to the copy, color, or page list are
    // reflected, and so the watermark is removed when it no longer applies.
    this.#destroyWatermark();

    if (!this.#documentMatches(config)) {
      this.#log(
        `Not watermarking ${this.document?.documentURI}: ` +
          (config
            ? `URI does not match pages ${JSON.stringify(config.pages)}`
            : "no watermark configuration present in this process")
      );
      return;
    }

    let win = this.contentWindow;
    if (!win) {
      return;
    }

    try {
      let { HighlighterEnvironment, CanvasFrameAnonymousContentHelper } =
        lazy.DevTools;

      this.#env = new HighlighterEnvironment();
      this.#env.initFromWindow(win);

      this.#helper = new CanvasFrameAnonymousContentHelper(this.#env, () =>
        this.#buildNode(config)
      );
      this.#helper.initialize();
      this.#log(`drew watermark on ${this.document?.documentURI}`);
    } catch (e) {
      this.#log(`Failed to draw watermark: ${e}`, "error");
      this.#destroyWatermark();
    }
  }

  #buildNode(config) {
    let doc = this.document;
    let container = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    container.setAttribute("id", "enterprise-watermark");
    container.setAttribute("style", watermarkNodeStyle(config));
    return container;
  }

  #destroyWatermark() {
    if (this.#helper) {
      this.#helper.destroy();
      this.#helper = null;
    }
    if (this.#env) {
      this.#env.destroy();
      this.#env = null;
    }
  }

  // The on-screen watermark uses native anonymous content (see #buildNode)
  // so that it's invisible to, and can't be tampered with by, the page's own
  // script. That content isn't part of the DOM tree that gets cloned for
  // printing though, so it never shows up in print output. To watermark
  // printed pages too, insert a real DOM node right before printing starts,
  // i.e. before the static clone used for the print job is created, and
  // remove it again immediately afterwards, so it's never visible on screen.
  #applyPrintWatermark(
    config = Services.cpmm.sharedData.get(WATERMARK_SHARED_DATA_KEY)
  ) {
    this.#removePrintWatermark();

    if (!this.#documentMatches(config)) {
      return;
    }

    let doc = this.document;
    if (!doc?.documentElement) {
      return;
    }

    try {
      let node = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      node.setAttribute("id", "enterprise-watermark-print");
      node.setAttribute("style", watermarkNodeStyle(config));
      doc.documentElement.appendChild(node);
      this.#printNode = node;
      this.#log(`drew print watermark on ${doc.documentURI}`);
    } catch (e) {
      this.#log(`Failed to draw print watermark: ${e}`, "error");
      this.#removePrintWatermark();
    }
  }

  #removePrintWatermark() {
    this.#printNode?.remove();
    this.#printNode = null;
  }
}
