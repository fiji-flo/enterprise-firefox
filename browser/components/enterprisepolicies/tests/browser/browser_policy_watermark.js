/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */
"use strict";

const PAGE_URL =
  "http://mochi.test:8888/browser/browser/components/enterprisepolicies/tests/browser/policy_watermark.html";

const MATCHING_POLICY = {
  policies: {
    Watermark: {
      Match: ["*://mochi.test/*policy_watermark*"],
      Copy: "CONFIDENTIAL",
      Color: "rgba(200, 0, 0, 0.2)",
    },
  },
};

const NON_MATCHING_POLICY = {
  policies: {
    Watermark: {
      Match: ["*://nomatch.example.com/*"],
      Copy: "CONFIDENTIAL",
      Color: "rgba(200, 0, 0, 0.2)",
    },
  },
};

function isShowingWatermark(browser) {
  return SpecialPowers.spawn(browser, [], async () => {
    // Use getExistingActor rather than getActor: the actor is only
    // registered to match the Watermark policy's configured pages, so
    // getActor() would throw on a page that isn't a match instead of
    // simply telling us the watermark isn't showing.
    let actor = content.windowGlobalChild.getExistingActor("WatermarkPolicy");
    return actor?.isShowingWatermark ?? false;
  });
}

function isShowingPrintWatermark(browser) {
  return SpecialPowers.spawn(browser, [], async () => {
    let actor = content.windowGlobalChild.getExistingActor("WatermarkPolicy");
    return actor?.isShowingPrintWatermark ?? false;
  });
}

function dispatchPrintEvent(browser, eventType) {
  return SpecialPowers.spawn(browser, [eventType], type => {
    content.dispatchEvent(new content.Event(type));
  });
}

add_task(async function test_watermark_shown_on_matching_page() {
  await setupPolicyEngineWithJson(MATCHING_POLICY);

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: PAGE_URL },
    async browser => {
      // The child fetches its configuration from the parent asynchronously, so
      // the watermark may be drawn slightly after the page finishes loading.
      await TestUtils.waitForCondition(
        () => isShowingWatermark(browser),
        "Watermark is drawn on a matching page"
      );
    }
  );

  await setupPolicyEngineWithJson("");
});

add_task(async function test_watermark_not_shown_on_non_matching_page() {
  await setupPolicyEngineWithJson(NON_MATCHING_POLICY);

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: PAGE_URL },
    async browser => {
      ok(
        !(await isShowingWatermark(browser)),
        "Watermark is not drawn on a non-matching page"
      );
    }
  );

  await setupPolicyEngineWithJson("");
});

// The on-screen watermark uses anonymous content, which isn't included when
// the document is cloned for printing (see WatermarkChild.sys.mjs), so this
// exercises the separate real-DOM-node watermark inserted around printing.
add_task(async function test_watermark_shown_when_printing() {
  await setupPolicyEngineWithJson(MATCHING_POLICY);

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: PAGE_URL },
    async browser => {
      // Wait for the async configuration fetch to complete (signalled by the
      // on-screen watermark appearing) so the print handler, which runs
      // synchronously, has a configuration to draw from.
      await TestUtils.waitForCondition(
        () => isShowingWatermark(browser),
        "Watermark is drawn before printing"
      );

      ok(
        !(await isShowingPrintWatermark(browser)),
        "No print watermark before printing starts"
      );

      await dispatchPrintEvent(browser, "beforeprint");
      ok(
        await isShowingPrintWatermark(browser),
        "Print watermark is inserted for beforeprint"
      );

      await dispatchPrintEvent(browser, "afterprint");
      ok(
        !(await isShowingPrintWatermark(browser)),
        "Print watermark is removed again after afterprint"
      );
    }
  );

  await setupPolicyEngineWithJson("");
});
