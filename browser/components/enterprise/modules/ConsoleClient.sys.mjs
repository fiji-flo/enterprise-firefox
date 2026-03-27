/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  TelemetryEnvironment: "resource://gre/modules/TelemetryEnvironment.sys.mjs",
  EnterpriseCommon: "resource:///modules/enterprise/EnterpriseCommon.sys.mjs",
  FeltStorage: "resource:///modules/FeltStorage.sys.mjs",
  composeOSNames: "resource:///modules/enterprise/EnterpriseOSInfo.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return console.createInstance({
    prefix: "ConsoleClient",
    maxLogLevelPref: lazy.EnterpriseCommon.ENTERPRISE_LOGLEVEL_PREF,
  });
});

/**
 * Preferences used to integrate the a remote enterprise console
 */
export const PREFS = {
  CONSOLE_ADDRESS: "enterprise.console.address",
};

/**
 * Error logged when user needs to reauthenticate to obtain new token data
 */
class ReauthRequiredError extends Error {
  /**
   * @param {string} [message="Reauthentication required"]
   * @param {"MISSING_REFRESH_TOKEN"|"INVALID_REFRESH_TOKEN"|"UNKNOWN"} [reason="UNKNOWN"]
   * @param {{status?: number|null, cause?: any}} [options]
   */
  constructor(
    message = "Reauthentication required",
    reason = "UNKNOWN",
    options = { status: null, cause: null }
  ) {
    if (options.cause) {
      super(message, options.cause);
    } else {
      super(message);
    }
    this.name = "ReauthRequiredError";
    this.code = "REAUTH_REQUIRED";
    this.reason = reason;
    if (options.status) {
      this.status = options.status;
    }
  }
}

/**
 * Error thrown when authentication is present but invalid for the requested operation.
 */
class InvalidAuthError extends Error {
  /**
   * @param {string} [message="Invalid authentication"]
   * @param {"TOKEN_REFRESH_FAILED"|"UNKNOWN"} [reason="UNKNOWN"]
   * @param {{cause?: any}} [options]
   */
  constructor(
    message = "Invalid authentication",
    reason = "UNKNOWN",
    options = { cause: null }
  ) {
    if (options.cause) {
      super(message, options.cause);
    } else {
      super(message);
    }
    this.name = "InvalidAuthError";
    this.code = "INVALID_AUTHENTICATION";
    this.reason = reason;
  }
}

/**
 * Client taking care of the communication with the enterprise console.
 */
export const ConsoleClient = {
  /**
   * This is our guard against concurrent access token refresh operations on the browser side.
   * When a refresh is in progress, this promise encapsulates the ongoing operation.
   * If the promise present on subsequent calls, (i.e. a refresh operation is already underway),
   * it is simply returned to the caller, eventually resolving.
   * Otherwise, the promise is created and assigned to _refreshPromise.
   *
   * Since the refresh operation involves IPC communication with the console process,
   * the resolve/reject functions of the promise are also pulled out to be called when the console/FELT
   * signals that a token refresh has successfully completed or failed.
   */
  _refreshPromise: null,
  _refreshResolve: null,
  _refreshReject: null,

  /**
   * This promise guards agains multiple refresh operations on the console/FELT side, similar
   * to what happens on the browser side (`_refreshPromise`).
   *
   * Concurrent refresh operations are all answered by returning the ongoing promise rather
   * than starting a new refresh process.
   */
  _feltRefreshPromise: null,

  /**
   * Base URL of the remote enterprise console
   *
   * @returns {URL}
   */
  get consoleBaseURI() {
    let consoleURI;
    try {
      consoleURI = Services.prefs.getStringPref(PREFS.CONSOLE_ADDRESS);
    } catch (e) {
      lazy.log.error("Critial misconfiguration: Missing console URI.");
      throw e;
    }
    return new URL(consoleURI);
  },

  /**
   * Paths to API endpoints of the remote enterprise console
   */
  get _paths() {
    return {
      SSO: "/sso/login",
      SIGNOUT: "/sso/logout",
      SSO_CALLBACK: "/sso/callback",
      STARTUP_PREFS: "/api/browser/hacks/startup",
      DEFAULT_PREFS: "/api/browser/hacks/default",
      REMOTE_POLICIES: "/api/browser/policies",
      KEY: "/api/browser/key",
      TOKEN: "/sso/token",
      DEVICE_POSTURE: "/sso/device_posture",
      WHOAMI: "/api/browser/whoami",
      LEARN_MORE: "/downloads/firefox.html",
      FXACCOUNT: "/api/browser/account",
      FXACCOUNTS_OAUTH: "/api/fxa/oauth/v1",
      FXACCOUNTS_PROFILE: "/api/fxa/profile/v1",
      FXACCOUNTS_AUTH: "/api/fxa/api/v1",
    };
  },

  /**
   * Constructs an absolute URL for a console API path.
   *
   * @param {string} path
   * @returns {string} Absolute URL string.
   */
  constructURI(path) {
    const url = this.consoleBaseURI;
    url.pathname = path;
    return url.href;
  },

  /**
   * Constructs the SSO login URL for the provided email.
   *
   * @param {string} email - Email address to prefill for SSO initiation.
   * @param {string} devicePostureToken - Token received for device posture
   * @returns {nsIURI}
   */
  constructSsoLoginURI(email, devicePostureToken) {
    const deviceId = lazy.FeltStorage.getDeviceId();
    const url = this.consoleBaseURI;
    url.pathname = this._paths.SSO;
    url.searchParams.set("target", "browser");
    url.searchParams.set("email", email);
    url.searchParams.set("devicePostureToken", devicePostureToken);
    url.searchParams.set("deviceId", deviceId);
    // Consumer expects uri as nsIURI
    const uri = Services.io.newURI(url.href);
    return uri;
  },

  /**
   * Learn more uri linked in the enterprise panel
   *
   * @returns {string} learn more uri
   */
  get learnMoreURI() {
    const url = this.consoleBaseURI;
    url.pathname = this._paths.LEARN_MORE;
    return url.href;
  },

  /**
   * SSO callback uri that we match to create Felt actors on
   *
   * @returns {string}
   */
  get ssoCallbackUriMatchPattern() {
    // Dropping the port is required here because the matcher being used by
    // JSActors code relies on WebExtensions MatchPattern
    // https://searchfox.org/firefox-main/source/toolkit/components/extensions/MatchPattern.cpp#370-384
    // The match pattern should then NOT use any port otherwise matching would
    // not happen.
    const url = this.consoleBaseURI;
    url.pathname = this._paths.SSO_CALLBACK;
    url.port = "";
    return url.href + "?*";
  },

  // prefs that needs to be read at startup, i.e., written to profile's prefs.js
  // tbd: remove
  async getStartupPrefs() {
    const payload = await this._get(this._paths.STARTUP_PREFS);
    return payload;
  },

  // prefs that do not need to be written and can be sent during runtime
  // tbd: remove
  async getDefaultPrefs() {
    const payload = await this._get(this._paths.DEFAULT_PREFS);
    return payload;
  },

  /**
   * Fetches remote enterprise policies.
   *
   * @returns {Promise<{policies: Record<string, any>}>}
   */
  async getRemotePolicies() {
    const payload = await this._get(this._paths.REMOTE_POLICIES);
    return payload;
  },

  /**
   * Fetch the account data used for fxa and sync.
   *
   * @returns {Promise<object>}
   */
  async getFxAccountData() {
    const deviceId = Services.prefs.getStringPref(
      lazy.EnterpriseCommon.ENTERPRISE_DEVICE_ID_PREF,
      ""
    );
    const body = {};
    if (deviceId !== "") {
      body.device_id = deviceId;
    }
    const payload = await this._post(this._paths.FXACCOUNT, body);
    return payload;
  },

  /**
   * Gets the error name for a channel status code.
   *
   * @param {number} status - The channel status code
   * @returns {string} Human-readable error name
   */
  _getErrorNameForStatus(status) {
    try {
      const nssErrorsService = Cc[
        "@mozilla.org/nss_errors_service;1"
      ].getService(Ci.nsINSSErrorsService);
      return nssErrorsService.getErrorName(status);
    } catch {
      // Not an NSS error, check common network error codes

      // Mapping here should follow what nsDocShell::DisplayLoadError uses.
      // Consumer code will expect those to fail when using Fluent to format
      // and perform fallback to string bundles where they are defined.
      const networkErrors = {
        [Cr.NS_ERROR_UNKNOWN_HOST]: "dnsNotFound2",
        [Cr.NS_ERROR_CONNECTION_REFUSED]: "connectionFailure",
        [Cr.NS_ERROR_NET_TIMEOUT]: "netTimeout",
        [Cr.NS_ERROR_NET_RESET]: "netReset",
        [Cr.NS_ERROR_NET_INTERRUPT]: "netInterrupt",
        [Cr.NS_ERROR_OFFLINE]: "netOffline",
      };
      return networkErrors[status] || "network";
    }
  },

  /**
   * Fetch-like wrapper that exposes detailed network errors.
   * Uses XMLHttpRequest internally to access channel.status on error,
   * which native fetch() does not expose.
   *
   * Limitations compared to native fetch():
   * - Response object only has: ok, status, json(), text()
   * - Missing: statusText, headers, url, redirected, clone(),
   *   arrayBuffer(), blob(), formData()
   * - json()/text() can be called multiple times (no body consumption)
   *
   * @param {string} url - The URL to fetch
   * @param {object} options - Fetch-like options
   * @param {string} [options.method="GET"] - HTTP method
   * @param {object} [options.headers={}] - Request headers
   * @param {string|null} [options.body=null] - Request body
   * @returns {Promise<{ok: boolean, status: number, json: Function, text: Function}>}
   */
  _xhrFetch(url, { method = "GET", headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url, true);

      // Handle both plain objects and Headers instances
      const headerEntries = Headers.isInstance(headers)
        ? headers.entries()
        : Object.entries(headers);
      for (const [key, value] of headerEntries) {
        xhr.setRequestHeader(key, value);
      }

      xhr.onload = () => {
        const response = {
          ok: xhr.status >= 200 && xhr.status < 300,
          status: xhr.status,
          json() {
            try {
              return Promise.resolve(JSON.parse(xhr.responseText));
            } catch (e) {
              return Promise.reject(e);
            }
          },
          text: () => Promise.resolve(xhr.responseText),
        };
        resolve(response);
      };

      xhr.onerror = () => {
        const errorName = this._getErrorNameForStatus(xhr.channel?.status);
        reject(
          new TypeError(errorName, { cause: { host: new URL(url).host } })
        );
      };

      xhr.ontimeout = () => {
        reject(new TypeError("NS_ERROR_NET_TIMEOUT"));
      };

      xhr.onabort = () => {
        reject(new TypeError("NS_BINDING_ABORTED"));
      };

      xhr.send(body);
    });
  },

  /**
   * Collect the device posture data and send them to the console.
   *
   * @returns {Promise<{posture: string}>} Token reported by console.
   */
  async sendDevicePosture() {
    const devicePosture = await this._collectDevicePosture();
    const url = this.constructURI(this._paths.DEVICE_POSTURE);

    const res = await this._xhrFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(devicePosture),
    });

    if (res.ok) {
      return await res.json();
    }

    const text = await res.text().catch(() => "");
    throw new Error(`Post failed (${res.status}): ${text}`);
  },

  /**
   * Fetches user information from the current session.
   *
   * @returns {Promise<object>}
   */
  async getLoggedInUserInfo() {
    const payload = await this._get(this._paths.WHOAMI);
    return payload;
  },

  /**
   * Retrieves primary secret used for enterprise storage encryption.
   *
   * @returns {Promise<Record<string, any>>}
   */
  async getPrimarySecret() {
    const payload = await this._get(this._paths.KEY);
    return payload;
  },

  /**
   * Ensures that we have a valid session and performs an authenticated fetch against
   * a registered console endpoint. If we get a 401 or 403 refresh and retry once.
   *
   * @param {string} path - Console API to request
   * @param {"GET"|"POST"} method - Console API method to use
   * @param {{ _didRefresh?: boolean, jsonBody?: object }} [options]
   * @throws {InvalidAuthError|Error}
   * @returns {Promise<any>} Parsed JSON response body.
   */
  async _fetch(path, method, { _didRefresh = false, jsonBody = null } = {}) {
    if (method !== "GET" && method !== "POST") {
      throw new TypeError(
        `Invalid method: ${method}. Expected "GET" or "POST".`
      );
    }

    const headers = new Headers({});
    const accessToken = await this.getAccessToken();
    headers.set("Authorization", `Bearer ${accessToken}`);
    headers.set("Accept", "application/json");
    if (jsonBody !== null) {
      headers.set("Content-Type", "application/json");
    }

    const url = this.constructURI(path);
    const res = await this._xhrFetch(url, {
      method,
      headers,
      body: jsonBody === null ? undefined : JSON.stringify(jsonBody),
    });

    if (res.ok) {
      return await res.json();
    }

    if ((res.status === 403 || res.status === 401) && !_didRefresh) {
      await this._refreshSession();
      return this._fetch(path, method, { _didRefresh: true, jsonBody });
    }

    const text = await res.text().catch(() => "");
    throw new Error(`Fetch ${method} ${path} failed (${res.status}): ${text}`);
  },

  /**
   * Initiates a GET request against a registered console endpoint.
   *
   * @param {string} path - Console API to request
   *
   * @throws {InvalidAuthError|Error}
   *
   * @returns {Promise<any>} Promise which resolves to a parsed JSON response body.
   */
  async _get(path) {
    return this._fetch(path, "GET");
  },

  /**
   * Initiates a POST request against a registered console endpoint.
   *
   * @param {string} path - Console API to request
   * @param {object} jsonBody - JSON body
   *
   * @throws {InvalidAuthError|Error}
   *
   * @returns {Promise<any>} Promise which resolves to a parsed JSON response body.
   */
  async _post(path, jsonBody = null) {
    return this._fetch(path, "POST", { jsonBody });
  },

  /**
   * Ensures a non-expired access token is available, refreshing if it's expiring soon.
   *
   * @returns {Promise<string>}
   * @throws {InvalidAuthError}
   */
  async getAccessToken() {
    let accessToken = Services.felt.getAccessTokenIfValid();
    if (Services.felt.isFeltBrowser() && !accessToken) {
      await this._refreshSession();
      accessToken = Services.felt.getAccessTokenIfValid();
    }
    if (!accessToken) {
      // If we are in Firefox at this point, Felt failed to shut us down
      // correctly after an unsuccessful token refresh.
      // If we are in Felt at this point, the authentication flow has
      // completed, but we do not have a valid token.
      // Either case should not happen normally, so throw an error.
      throw new InvalidAuthError(
        "Unhandled reauthentication",
        "UNHANDLED_REAUTHENTICATION"
      );
    }
    return accessToken;
  },

  /**
   * Refreshes the session using a refresh token.
   * Serializes concurrent refreshes via an internal promise.
   * This should only be called from the Felt UI context.
   *
   * @throws {InvalidAuthError | ReauthRequiredError} If unable to refresh session
   * @returns {Promise<{ access_token, refresh_token, expires_at }>}
   */
  async refreshTokens() {
    // Assert we are in Felt UI context
    if (Services.felt.isFeltBrowser()) {
      throw new Error(
        "refreshTokens(): Called from Browser context, which is not allowed."
      );
    }

    // If a refresh is already underway, just return the promise.
    if (this._feltRefreshPromise) {
      return this._feltRefreshPromise;
    }

    // At this point, we are in the Felt UI context and no
    // _feltRefreshPromise exists, so do the actual refresh.
    this._feltRefreshPromise = (async () => {
      const refreshToken = Services.felt.getRefreshToken();
      if (!refreshToken) {
        const e = new ReauthRequiredError(
          "No refresh token available",
          "MISSING_REFRESH_TOKEN"
        );
        lazy.log.error(e);
        throw e;
      }

      const url = this.constructURI(this._paths.TOKEN);
      let res;
      try {
        res = await this._xhrFetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
          }),
        });
      } catch (cause) {
        const e = new InvalidAuthError(
          `Token refresh request failed: ${cause.message}`,
          "TOKEN_REFRESH_FAILED",
          { cause }
        );
        lazy.log.error(e);
        throw e;
      }

      if (res.status === 401 || res.status === 403) {
        const e = new ReauthRequiredError(
          "Invalid refresh token",
          "INVALID_REFRESH_TOKEN",
          { status: res.status }
        );
        lazy.log.error(e);
        throw e;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new InvalidAuthError(
          `Token refresh failed (${res.status}): ${text}`,
          "TOKEN_REFRESH_FAILED"
        );
      }

      const { access_token, refresh_token, expires_in } = await res.json();
      const expires_at = Math.floor(Date.now() / 1000) + Number(expires_in);
      return { access_token, refresh_token, expires_at };
    })().finally(() => {
      this._feltRefreshPromise = null;
    });
    return this._feltRefreshPromise;
  },

  /**
   * Refreshes the session by asking FELT to do a fetch an updated token.
   * Serializes concurrent refresh calls via an internal promise.
   * This should only be called from the browser context.
   *
   * @returns {Promise<void>}
   */
  async _refreshSession() {
    // Assert we are in the browser
    if (!Services.felt.isFeltBrowser()) {
      throw new Error(
        "_refreshSession: called from non-Browser context, which is not allowed."
      );
    }

    if (this._refreshPromise) {
      return this._refreshPromise;
    }

    // If we are in the Browser, notify FELT via IPC to refresh the token
    // create an internal promise that will resolve when FELT signals a refreshed token
    // Note that only FELT holds the needed refresh token.
    this._refreshPromise = new Promise((resolve, reject) => {
      // remember our resolve/reject functions
      this._refreshResolve = resolve;
      this._refreshReject = reject;
      // notify FELT to refresh the token
      Services.felt.refreshTokens();
    });
    return this._refreshPromise;
  },

  /**
   * @typedef {object} DeviceNetwork
   * @property {null} ipv4 IPv4 address, TBD
   * @property {null} ipv6 IPv6 address, TBD
   */

  /**
   * @typedef {object} DevicePosture
   * @property {object} os Telemetry-reported os information.
   * @property {object|undefined} security Telemetry-reported security software info (windows only)
   * @property {object} build Telemetry-reported build info info
   * @property {DeviceNetwork} network Network posture (placeholders for now).
   */

  /**
   * Collects the device posture from TelemetryEnvironment.currentEnvironment
   * and others data sources.
   *
   * @returns {Promise<DevicePosture>} devicePosture
   */
  async _collectDevicePosture() {
    const getImeiValue = async () => {
      try {
        return await Cc["@mozilla.org/imei/provider;1"]
          .getService()
          .QueryInterface(Ci.nsIImeiProvider).imei;
      } catch {
        return "";
      }
    };

    const networkInterfaces = Cc["@mozilla.org/network/network-link-service;1"]
      .getService()
      .QueryInterface(Ci.nsINetworkLinkService).networkInterfaces;

    const baseOs = lazy.TelemetryEnvironment.currentEnvironment.system.os;
    const { long: os_long_name, short: os_short_name } =
      await lazy.composeOSNames(baseOs);
    const os = {
      ...baseOs,
      ...(os_long_name != null && { os_long_name }),
      ...(os_short_name != null && { os_short_name }),
    };

    const devicePosturePayload = {
      os,
      security: lazy.TelemetryEnvironment.currentEnvironment.system.sec,
      build: lazy.TelemetryEnvironment.currentEnvironment.build,
      network: {
        mobileEquipmentId: await getImeiValue(),
        interfaces: networkInterfaces,
      },
      secureBootEnabled:
        Services.sysinfo.getPropertyAsBool("secureBootEnabled"),
    };
    return devicePosturePayload;
  },

  /**
   * Perform signout against the console and share the information down to
   * XPCOM to make FELT aware.
   *
   * This is only allowed to be executed from the browser side.
   *
   * @throws {Error} If called from a non-browser context
   */
  async signoutUser() {
    if (!Services.felt.isFeltBrowser()) {
      throw new Error(
        "Performing signout from something else than browser is wrong"
      );
    }

    // TODO: Assert or force-enable session restore?

    // Signal FELT to perform the server-side signout POST and clear its tokens.
    Services.felt.performSignout();
  },

  /**
   * Performs a server-side signout POST request.
   * This is to be called only from the Felt side.
   *
   * @returns Promise<any>
   */
  async performServerSignout() {
    return this._post(this._paths.SIGNOUT);
  },

  /**
   * Register shutdown observer to clean up the client.
   */
  init() {
    Services.obs.addObserver(this, "xpcom-shutdown");

    if (Services.felt.isFeltBrowser()) {
      Services.obs.addObserver(this, "felt-firefox-access-token-refreshed");
      Services.obs.addObserver(this, "felt-firefox-shutdown-for-reauth");
    }

    return this;
  },

  observe(_, topic) {
    switch (topic) {
      case "xpcom-shutdown": {
        Services.obs.removeObserver(this, "xpcom-shutdown");
        Services.felt.clearTokens();
        this._refreshPromise = null;
        this._refreshResolve = null;
        this._refreshReject = null;
        break;
      }
      case "felt-firefox-shutdown-for-reauth": {
        Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
        break;
      }
      case "felt-firefox-access-token-refreshed": {
        // Resolve the promise, if any
        this._refreshResolve?.();
        // Reset the promise since we're done.
        this._refreshPromise = null;
        this._refreshResolve = null;
        this._refreshReject = null;
        break;
      }
    }
  },
}.init();
