/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Content-process side of the Watermark policy. When the document matches one
 * of the configured matches, this draws a tiled, diagonal watermark over the
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

const PREF_LOGLEVEL = "browser.policies.loglevel";

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  let { ConsoleAPI } = ChromeUtils.importESModule(
    "resource://gre/modules/Console.sys.mjs"
  );
  return new ConsoleAPI({
    prefix: "WatermarkPolicy",
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

function templateWatermarkText(copy, config) {
  if (!copy) {
    return "";
  }
  return copy
    .replaceAll("%t", config.timestamp ?? "")
    .replaceAll("%e", config.email ?? "");
}

function watermarkBackgroundImage(config) {
  let color = escapeXML(config.color);
  let copy = escapeXML(templateWatermarkText(config.copy, config));
  let secondRowText = escapeXML(
    templateWatermarkText(config.secondaryCopy, config)
  );
  let fontSize = config.fontSize;
  let angle = config.angle;
  let width = config.size;
  let height = config.size;
  let rowGap = fontSize * 0.5;
  let textStyle =
    `fill='${color}' stroke='contrast-color(${color})' stroke-width='0.5' ` +
    `font-family='sans-serif' text-anchor='middle' dominant-baseline='middle'`;

  // Centered on its own when there's no second row, otherwise shifted up to
  // make room for it below.
  let copyY = secondRowText ? height / 2 - rowGap : height / 2;
  let texts =
    `<text x='${width / 2}' y='${copyY}' ${textStyle} ` +
    `font-size='${fontSize}'>${copy}</text>`;
  if (secondRowText) {
    texts +=
      `<text x='${width / 2}' y='${height / 2 + rowGap}' ${textStyle} ` +
      `font-size='${fontSize}'>${secondRowText}</text>`;
  }

  let svg =
    `<svg xmlns='http://www.w3.org/2000/svg' ` +
    `width='${width}' height='${height}'>` +
    `<g transform='rotate(${angle} ${width / 2} ${height / 2})'>${texts}</g>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

const PRINT_EVENT_OPTIONS = { mozSystemGroup: true };

function documentHeight(doc) {
  return Math.max(
    doc.defaultView?.innerHeight ?? 0,
    doc.documentElement?.scrollHeight ?? 0,
    doc.body?.scrollHeight ?? 0
  );
}

function watermarkCommonStyle(config) {
  return [
    "pointer-events: none !important",
    "z-index: 2147483647 !important",
    `background-image: ${watermarkBackgroundImage(config)} !important`,
    "background-repeat: repeat !important",
  ];
}

// For anonymous content 100% is in regard to view port so we have to set the
// height explicitly.
function watermarkScreenStyle(config, height) {
  return [
    "position: absolute !important",
    "top: 0 !important",
    "left: 0 !important",
    "width: 100% !important",
    `height: ${height}px !important`,
    ...watermarkCommonStyle(config),
  ].join("; ");
}

function watermarkPrintStyle(config) {
  return [
    "position: fixed !important",
    "top: 0 !important",
    "left: 0 !important",
    "width: 100% !important",
    "height: 100% !important",
    ...watermarkCommonStyle(config),
    "print-color-adjust: exact !important",
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
  #resizeObserver = null;

  actorCreated() {
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
        this.#applyWatermark(message.data.config);
        break;
    }
  }

  // Test-only introspection
  get isShowingWatermark() {
    return !!this.#helper;
  }

  // Test-only introspection
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

  #applyWatermark(
    config = Services.cpmm.sharedData.get(WATERMARK_SHARED_DATA_KEY)
  ) {
    this.#destroyWatermark();

    //if (!this.#documentMatches(config)) {
    //  return;
    //}

    let win = this.contentWindow;
    if (!win) {
      return;
    }

    // Captured once per watermark application.
    let watermarkConfig = {
      ...config,
      timestamp: new Date().toLocaleDateString(),
    };

    try {
      let { HighlighterEnvironment, CanvasFrameAnonymousContentHelper } =
        lazy.DevTools;

      this.#env = new HighlighterEnvironment();
      this.#env.initFromWindow(win);

      this.#helper = new CanvasFrameAnonymousContentHelper(this.#env, () =>
        this.#buildNode(watermarkConfig)
      );
      this.#helper.initialize();

      this.#resizeObserver = new win.ResizeObserver(() => {
        this.#helper?.setAttributeForElement(
          "enterprise-watermark",
          "style",
          watermarkScreenStyle(watermarkConfig, documentHeight(win.document))
        );
      });
      this.#resizeObserver.observe(win.document.documentElement);
    } catch (e) {
      lazy.log.error(`Failed to draw watermark: ${e}`);
      this.#destroyWatermark();
    }
  }

  #buildNode(config) {
    let doc = this.document;
    let container = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    container.setAttribute("id", "enterprise-watermark");
    container.setAttribute(
      "style",
      watermarkScreenStyle(config, documentHeight(doc))
    );
    return container;
  }

  #destroyWatermark() {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    if (this.#helper) {
      this.#helper.destroy();
      this.#helper = null;
    }
    if (this.#env) {
      this.#env.destroy();
      this.#env = null;
    }
  }

  #applyPrintWatermark(
    config = Services.cpmm.sharedData.get(WATERMARK_SHARED_DATA_KEY)
  ) {
    this.#removePrintWatermark();

    let doc = this.document;
    if (!doc?.documentElement) {
      return;
    }

    // Reflects when the document was printed, rather than when it was loaded.
    let watermarkConfig = {
      ...config,
      timestamp: new Date().toLocaleDateString(),
    };

    try {
      let node = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      node.setAttribute("id", "enterprise-watermark-print");
      node.setAttribute("style", watermarkPrintStyle(watermarkConfig));
      doc.documentElement.appendChild(node);
      this.#printNode = node;
    } catch (e) {
      lazy.log.error(`Failed to draw print watermark: ${e}`);
      this.#removePrintWatermark();
    }
  }

  #removePrintWatermark() {
    this.#printNode?.remove();
    this.#printNode = null;
  }
}
