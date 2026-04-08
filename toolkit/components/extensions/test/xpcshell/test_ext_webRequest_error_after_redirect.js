"use strict";

const server = createHttpServer({ hosts: ["example.com"] });
const BASE_URL = "http://example.com";

server.registerPathHandler("/dummy", (request, response) => {
  response.setStatusLine(request.httpVersion, 200, "OK");
  response.write("OK");
});
server.registerPathHandler("/start", (request, response) => {
  response.setStatusLine(request.httpVersion, 302, "Found");
  response.setHeader("Location", `${BASE_URL}/end`);
});

add_task(async function test_error_occurred_after_redirect() {
  // Cancel the redirect-target channel before it connects. Without the
  // needOpening fix that adds onErrorOccurred to http-on-modify-request,
  // no ChannelWrapper would be created for the redirect-target channel and
  // onErrorOccurred would never fire (the test would time out).
  const observer = channel => {
    if (
      channel instanceof Ci.nsIHttpChannel &&
      channel.URI.spec === `${BASE_URL}/end`
    ) {
      Services.obs.removeObserver(observer, "http-on-before-connect");
      Promise.resolve().then(() => channel.cancel(Cr.NS_BINDING_ABORTED));
    }
  };
  Services.obs.addObserver(observer, "http-on-before-connect");

  const extension = ExtensionTestUtils.loadExtension({
    manifest: { permissions: ["webRequest", `${BASE_URL}/`] },
    background() {
      browser.webRequest.onErrorOccurred.addListener(
        details => browser.test.sendMessage("error-occurred", details),
        { urls: ["<all_urls>"] }
      );
    },
  });

  await extension.startup();
  await ExtensionTestUtils.fetch(
    `${BASE_URL}/dummy`,
    `${BASE_URL}/start`
  ).catch(() => {});

  const { url, error } = await extension.awaitMessage("error-occurred");
  equal(
    url,
    `${BASE_URL}/end`,
    "onErrorOccurred fires for redirect target, not original URL"
  );
  equal(
    error,
    "NS_BINDING_ABORTED",
    "onErrorOccurred carries the expected error"
  );

  await extension.unload();
});
