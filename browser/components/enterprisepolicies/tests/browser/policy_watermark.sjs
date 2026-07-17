/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

// Served as application/json so a top-level load renders in the built-in JSON
// viewer, whose strict CSP (img-src 'self') exercises the watermark's inline
// SVG rendering.
function handleRequest(request, response) {
  response.setHeader("Content-Type", "application/json", false);
  response.write(JSON.stringify({ watermark: "policy_watermark" }));
}
