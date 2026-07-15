/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Content-process side of the Watermark policy. When the document matches one
 * of the configured matches, this draws a tiled, diagonal watermark over the
 * page using Document.insertAnonymousContent(), which inserts the markup into
 * the document's canvasFrame anonymous content, on top of the page but
 * inaccessible to it.
 *
 * Anonymous content isn't included when a document is cloned for printing,
 * so it's not enough to watermark printed pages. For that, a second,
 * real (non-anonymous) watermark node is inserted directly into the document
 * on "beforeprint", and removed again on "afterprint" (see
 * #applyPrintWatermark).
 */

/**
 * @typedef {import("./WatermarkPolicy.sys.mjs").WatermarkConfig} WatermarkConfig
 */

const PREF_LOGLEVEL = "browser.policies.loglevel";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ReaderMode: "moz-src:///toolkit/components/reader/ReaderMode.sys.mjs",
});

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

/**
 * Escapes characters that are special in XML/SVG markup.
 *
 * @param {*} str
 * @returns {string}
 */
function escapeXML(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Substitutes the "%t" (timestamp) and "%e" (email) placeholders in `copy`.
 *
 * @param {string} copy Watermark text, possibly containing placeholders.
 * @param {WatermarkConfig} config Watermark configuration providing `timestamp` and `email`.
 * @returns {string}
 */
function templateWatermarkText(copy, config) {
  if (!copy) {
    return "";
  }
  return copy
    .replaceAll("%t", config.timestamp ?? "")
    .replaceAll("%e", config.email ?? "");
}

/**
 * Builds a `url("data:image/svg+xml,...")` value for a single watermark
 * tile, containing the (optionally two-line) rotated watermark text.
 *
 * @param {WatermarkConfig} config Watermark configuration.
 * @returns {string}
 */
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

/**
 * Returns the height, in pixels, that the watermark should cover to fill
 * the visible viewport as well as any content that overflows it.
 *
 * @param {Document} doc
 * @returns {number}
 */
function documentHeight(doc) {
  return Math.max(
    doc.defaultView?.innerHeight ?? 0,
    doc.documentElement?.scrollHeight ?? 0,
    doc.body?.scrollHeight ?? 0
  );
}

/**
 * Returns the width, in pixels, that the watermark should cover to fill
 * the visible viewport as well as any content that overflows it.
 *
 * @param {Document} doc
 * @returns {number}
 */
function documentWidth(doc) {
  return Math.max(
    doc.defaultView?.innerWidth ?? 0,
    doc.documentElement?.scrollWidth ?? 0,
    doc.body?.scrollWidth ?? 0
  );
}

/**
 * CSS declarations shared by the on-screen and print watermark nodes.
 *
 * @param {WatermarkConfig} config Watermark configuration.
 * @returns {Array<string>}
 */
function watermarkCommonStyle(config) {
  return [
    "pointer-events: none !important",
    "z-index: 2147483647 !important",
    `background-image: ${watermarkBackgroundImage(config)} !important`,
    "background-repeat: repeat !important",
  ];
}

/**
 * CSS declarations for the on-screen watermark node. For anonymous content,
 * 100% is in regard to the viewport, so the height has to be set explicitly
 * to also cover content that overflows it.
 *
 * @param {WatermarkConfig} config Watermark configuration.
 * @param {number} width Width in pixels, from documentWidth().
 * @param {number} height Height in pixels, from documentHeight().
 * @returns {string}
 */
function watermarkScreenStyle(config, width, height) {
  return [
    "position: absolute !important",
    "top: 0 !important",
    "left: 0 !important",
    `min-width: ${width}px !important`,
    `min-height: ${height}px !important`,
    ...watermarkCommonStyle(config),
    "print-color-adjust: exact !important",
  ].join("; ");
}

/**
 * CSS declarations for the print-only watermark node.
 *
 * @param {WatermarkConfig} config Watermark configuration.
 * @returns {string}
 */
function watermarkPrintStyle(config) {
  return [
    "position: fixed !important",
    "top: 0 !important",
    "left: 0 !important",
    "min-width: 100% !important",
    "min-height: 100% !important",
    ...watermarkCommonStyle(config),
    "print-color-adjust: exact !important",
  ].join("; ");
}

/**
 * Draws the watermark in the content process for documents matching the
 * Watermark policy configuration.
 */
export class WatermarkPolicyChild extends JSWindowActorChild {
  #content = null;
  #node = null;
  #printNode = null;
  #resizeObserver = null;
  // Watermark configuration for this document, fetched from the parent when
  // the actor is created and updated by "Watermark:Refresh". Null until it has
  // been received, or when the policy isn't applied.
  #config = null;
  // Whether a "DOMContentLoaded"/"pageshow" event has fired, so we know the
  // document is ready to be watermarked once the configuration arrives.
  #loaded = false;

  /**
   * Registers the "beforeprint"/"afterprint" listeners used to show a
   * separate, non-anonymous watermark node while printing, and fetches the
   * watermark configuration from the parent.
   */
  async actorCreated() {
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

    let config;
    try {
      config = await this.sendQuery("Watermark:GetConfig");
    } catch (e) {
      // The actor may have been destroyed before the query resolved; there's
      // nothing to draw in that case.
      return;
    }

    // A "Watermark:Refresh" may have delivered a newer config while the query
    // was in flight; don't clobber it.
    this.#config ??= config;

    // The document may already have loaded while the configuration was in
    // flight, in which case nothing else will trigger the initial draw.
    if (this.#loaded && !this.#content && this.#config) {
      this.#applyWatermark();
    }
  }

  /**
   * @param {Event} event
   */
  handleEvent(event) {
    switch (event.type) {
      case "DOMContentLoaded":
      case "pageshow":
        this.#loaded = true;
        if (this.#config && !this.#content) {
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

  /**
   * @param {ReceiveMessageArgument} message
   */
  receiveMessage(message) {
    switch (message.name) {
      case "Watermark:Refresh":
        this.#config = message.data.config;
        this.#applyWatermark();
        break;
    }
  }

  // Test-only introspection
  get isShowingWatermark() {
    return !!this.#content;
  }

  // Test-only introspection
  get isShowingPrintWatermark() {
    return !!this.#printNode;
  }

  // Test-only introspection
  get hasReceivedConfig() {
    return !!this.#config;
  }

  /**
   * Whether the current document should be watermarked given `config`. Normal
   * documents always qualify: the actor is only constructed for them because a
   * configured site pattern already matched the document URI. Reader Mode
   * (about:reader) and View Source (view-source:) wrap another URL, so the
   * actor is also constructed for those; they qualify only when the wrapped
   * URL matches the configured patterns.
   *
   * @param {WatermarkConfig} config
   * @returns {boolean}
   */
  #matchesDocument(config) {
    let doc = this.document;
    if (!doc) {
      return false;
    }
    let documentURI = doc.documentURI;
    let url;
    if (documentURI.startsWith("view-source:")) {
      url = documentURI.substring("view-source:".length);
    } else if (documentURI.startsWith("about:reader")) {
      url = lazy.ReaderMode.getOriginalUrl(documentURI);
    } else {
      return true;
    }
    if (!url) {
      return false;
    }
    try {
      return new MatchPatternSet(config.match).matches(url);
    } catch (e) {
      lazy.log.error(`Failed to match wrapped document URL: ${e}`);
      return false;
    }
  }

  /**
   * Removes the print listeners and tears down both watermark nodes.
   */
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

  /**
   * (Re-)draws the on-screen watermark as anonymous content, and keeps it
   * sized to the document via a ResizeObserver. A no-op if no configuration
   * has been received yet, or the policy has just been removed.
   */
  #applyWatermark() {
    this.#destroyWatermark();

    let win = this.contentWindow;
    let doc = this.document;
    let config = this.#config;
    if (!win || !doc || !config) {
      return;
    }
    if (!this.#matchesDocument(config)) {
      return;
    }

    // Captured once per watermark application.
    let watermarkConfig = {
      ...config,
      timestamp: Temporal.Now.instant().toString({ smallestUnit: "second" }),
    };

    try {
      this.#content = doc.insertAnonymousContent();
      this.#node = this.#buildNode(watermarkConfig);
      this.#content.root.appendChild(this.#node);

      this.#resizeObserver = new win.ResizeObserver(() => {
        this.#node?.setAttribute(
          "style",
          watermarkScreenStyle(
            watermarkConfig,
            documentWidth(doc),
            documentHeight(doc)
          )
        );
      });
      this.#resizeObserver.observe(doc.documentElement);
    } catch (e) {
      lazy.log.error(`Failed to draw watermark: ${e}`);
      this.#destroyWatermark();
    }
  }

  /**
   * Builds the anonymous content node that displays the on-screen watermark.
   *
   * @param {WatermarkConfig} config Watermark configuration.
   * @returns {Element}
   */
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

  /**
   * Undoes #applyWatermark, tearing down the resize observer and removing
   * the anonymous content node.
   */
  #destroyWatermark() {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.#node = null;
    if (this.#content) {
      try {
        this.document.removeAnonymousContent(this.#content);
      } catch (e) {
        // The document the content was inserted into may already be gone;
        // ignore.
      }
      this.#content = null;
    }
  }

  /**
   * Inserts a real (non-anonymous) watermark node into the document for
   * printing, since anonymous content isn't included in cloned print documents.
   * Uses the configuration cached by the actor, so it can run synchronously
   * within the "beforeprint" handler. A no-op if no configuration has been
   * received yet, or the policy has just been removed.
   */
  #applyPrintWatermark() {
    this.#removePrintWatermark();

    let doc = this.document;
    let config = this.#config;
    if (!doc?.documentElement || !config) {
      return;
    }
    if (!this.#matchesDocument(config)) {
      return;
    }

    // Reflects when the document was printed, rather than when it was loaded.
    let watermarkConfig = {
      ...config,
      timestamp: Temporal.Now.instant().toString({ smallestUnit: "second" }),
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

  /**
   * Removes the print-only watermark node inserted by #applyPrintWatermark.
   */
  #removePrintWatermark() {
    this.#printNode?.remove();
    this.#printNode = null;
  }
}
