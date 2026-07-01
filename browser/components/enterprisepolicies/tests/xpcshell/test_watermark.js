/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */
"use strict";

const SHARED_DATA_KEY = "EnterprisePolicies:Watermark";

add_task(async function test_watermark_config_published() {
  await setupPolicyEngineWithJson({
    policies: {
      Watermark: {
        Pages: [
          "https://example.com/*",
          "https://*.corp.example.com/*",
          "this is not a valid pattern",
        ],
        Copy: "CONFIDENTIAL",
        Color: "rgba(200, 0, 0, 0.2)",
      },
    },
  });

  let config = Services.ppmm.sharedData.get(SHARED_DATA_KEY);
  Assert.ok(config, "Watermark config is published to shared data");
  Assert.deepEqual(
    config.pages,
    ["https://example.com/*", "https://*.corp.example.com/*"],
    "Invalid match patterns are filtered out"
  );
  Assert.equal(config.copy, "CONFIDENTIAL", "Copy is published");
  Assert.equal(config.color, "rgba(200, 0, 0, 0.2)", "Color is published");
});

add_task(async function test_watermark_default_color() {
  await setupPolicyEngineWithJson({
    policies: {
      Watermark: {
        Pages: ["https://example.com/*"],
        Copy: "INTERNAL",
      },
    },
  });

  let config = Services.ppmm.sharedData.get(SHARED_DATA_KEY);
  Assert.ok(config, "Watermark config is published to shared data");
  Assert.equal(config.copy, "INTERNAL", "Copy is published");
  Assert.equal(
    config.color,
    "rgba(128, 128, 128, 0.2)",
    "A default color is used when none is provided"
  );
});
