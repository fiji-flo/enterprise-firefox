/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  JSONFile: "resource://gre/modules/JSONFile.sys.mjs",
});

/**
 * Storage helper for reading and writing felt-related profile data to felt.json
 */
export const FeltStorage = {
  /**
   * Absolute path to the felt.json file in the current profile.
   *
   * @type {string}
   */
  FELT_FILE_PATH: PathUtils.join(
    Services.dirsvc.get("UAppData", Ci.nsIFile).path,
    "felt.json"
  ),

  async init() {
    this._feltStorage = new lazy.JSONFile({
      path: this.FELT_FILE_PATH,
    });
    await this._feltStorage.load();
  },

  /**
   * Gets the email that was used to signin the last time (if available)
   *
   * @returns {string | undefined} email
   */
  getLastSignedInUser() {
    return this._feltStorage.data?.lastSignedInUserEmail;
  },

  /**
   * Gets the device ID (generates a ID one if not available)
   *
   * @returns {string} email
   */
  getDeviceId() {
    let id = this._feltStorage.data?.deviceId;
    if (id) {
      return id;
    }
    id = globalThis.crypto.randomUUID();
    this._feltStorage.data.deviceId = id;
    this._feltStorage.saveSoon();
    return id;
  },

  /**
   * Updates the email that was used to sign in the last time
   *
   * @param {string} email
   */
  updateLastSignedInUserEmail(email) {
    if (this._feltStorage.data.lastSignedInUserEmail === email) {
      // Nothing changed.
      return;
    }
    this._feltStorage.data.lastSignedInUserEmail = email;
    this._feltStorage.saveSoon();
  },

  /**
   * Gets the stored (encrypted) refresh token for a locked session, if any.
   *
   * @param {string} email
   * @returns {string | undefined} The encrypted refresh token.
   */
  getLockingToken(email) {
    return this._feltStorage.data?.lockingTokens?.[email];
  },

  /**
   * Stores the (already encrypted) refresh token for a locked session.
   *
   * @param {string} email
   * @param {string} token The encrypted refresh token.
   */
  setLockingToken(email, token) {
    if (!this._feltStorage.data.lockingTokens) {
      this._feltStorage.data.lockingTokens = {};
    }
    this._feltStorage.data.lockingTokens[email] = token;
    this._feltStorage.saveSoon();
  },

  /**
   * Removes any stored locked-session token for the given user.
   *
   * @param {string} email
   */
  clearLockingToken(email) {
    if (this._feltStorage.data.lockingTokens?.[email] !== undefined) {
      delete this._feltStorage.data.lockingTokens[email];
      this._feltStorage.saveSoon();
    }
  },

  async uninit() {
    this._feltStorage = {};
  },
};
