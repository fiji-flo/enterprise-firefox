/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const ENTERPRISE_LOCKING_TOKENS_PREF = "enterprise.locking.tokens";
const ENTERPRISE_LOCKING_ENABLED_PREF = "enterprise.locking.enabled";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  createEnterpriseLogger:
    "resource://gre/modules/enterprise/EnterpriseCommon.sys.mjs",
  ConsoleClient: "resource://gre/modules/enterprise/ConsoleClient.sys.mjs",
  FeltStorage: "resource://gre/modules/enterprise/FeltStorage.sys.mjs",
  OSKeyStore: "resource://gre/modules/OSKeyStore.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.createEnterpriseLogger("FeltLocking");
});

function lockingEnabled() {
  return Services.prefs.getBoolPref(ENTERPRISE_LOCKING_ENABLED_PREF, false);
}

/**
 * The email of the currently signed-in user, used as the key under which a
 * locked session's refresh token is stored. Read from the cached value rather
 * than the network so locking cannot hang or fail at shutdown.
 *
 * @returns {string | undefined} email
 */
function currentEmail() {
  return lazy.FeltStorage.getLastSignedInUser();
}

async function updateTokensPref(tokens, email, token) {
  if (token) {
    const encryptedUpdatedRefreshToken = await lazy.OSKeyStore.encrypt(
      token,
      "",
      false
    );
    tokens[email] = encryptedUpdatedRefreshToken;
  } else {
    delete tokens[email];
  }
  Services.prefs.setStringPref(
    ENTERPRISE_LOCKING_TOKENS_PREF,
    JSON.stringify(tokens)
  );
}

function getTokens() {
  const tokensString = Services.prefs.getStringPref(
    ENTERPRISE_LOCKING_TOKENS_PREF,
    "{}"
  );
  let tokens;
  try {
    tokens = JSON.parse(tokensString);
  } catch {
    console.warn(`FeltLocking: unable to parse tokens from pref`);
    tokens = {};
  }
  return tokens;
}

export const FeltLocking = {
  get enabled() {
    return lockingEnabled();
  },

  /**
   * Attempt to resume a previously locked session for the given user. Requires
   * OS-level authentication and a stored, still-valid refresh token.
   *
   * @param {string} email
   * @param {Element} browser
   * @returns {Promise<boolean>} Whether the session was successfully unlocked.
   */
  tryUnlock: async (email, browser) => {
    if (lockingEnabled()) {
      const tokens = getTokens();
      const token = tokens?.[email];
      if (token) {
        const { authenticated } = await lazy.OSKeyStore.ensureLoggedIn(
          "Trying to unlock existing session",
          "Firefox Enterprise"
        );
        if (authenticated) {
          const refreshToken = await lazy.OSKeyStore.decrypt(token, "", false);
          if (!refreshToken) {
            Services.felt.setTokens("", "", 0);
            await updateTokensPref(tokens, email, null);
            return false;
          }
          // Only set the refresh token since that's all we have.
          Services.felt.setTokens("", refreshToken, 0);
          try {
            // Get an access token to force a refresh.
            const { access_token, refresh_token, expires_at } =
              await lazy.ConsoleClient.refreshTokens();
            Services.felt.setTokens(access_token, refresh_token, expires_at);

            await updateTokensPref(tokens, email, refresh_token);

            const parentActor =
              browser.browsingContext.currentWindowGlobal.domProcess.getActor(
                "FeltProcess"
              );
            parentActor.receiveMessage({
              name: "FeltChild:StartFirefox",
              data: {},
            });
            return true;
          } catch (err) {
            console.warn(`FeltLocking: Error resuming from token: ${err}`);
            Services.felt.setTokens("", "", 0);
            await updateTokensPref(tokens, email, null);
          }
        }
      }
    }
    return false;
  },

  /**
   * Persist the (encrypted) refresh token for the current user so the session
   * can later be unlocked. No-op when locking is disabled or no user is known.
   *
   * @param {string} refresh_token
   * @returns {Promise<void>}
   */
  store: async refresh_token => {
    if (!lockingEnabled()) {
      return;
    }
    const email = currentEmail();
    if (!email) {
      lazy.log.warn(
        "store: no signed-in user known, cannot persist locked session"
      );
      return;
    }
    const tokens = getTokens();
    await updateTokensPref(tokens, email, refresh_token);
  },

  /**
   * Remove any stored locked-session token for the current user. Always runs
   * (even when locking is disabled) so signing out can never leave a credential
   * behind. No-op when no user is known or nothing is stored.
   *
   * @returns {Promise<void>}
   */
  clear: async () => {
    const email = currentEmail();
    if (!email) {
      return;
    }
    const tokens = getTokens();
    if (email in tokens) {
      await updateTokensPref(tokens, email, null);
    }
  },
};
