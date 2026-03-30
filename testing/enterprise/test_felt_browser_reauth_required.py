#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from base_test import Environment
from felt_tests import FeltTests


class BrowserReauthRequired(FeltTests):
    def test_browser_reauth_required(self):
        self.get_driver(Environment.FELT).set_prefs(
            {"enterprise.felt_tests.is_blocking_shutdown": True},
            default_branch=True,
        )
        self.run_felt_base()
        self.connect_child_browser()
        self._browser_pid = self._child_driver.session_capabilities["moz:processID"]

        # Invalidate the server-side refresh token so the next refresh fails with 401
        self.policy_refresh_token.value = "invalid-token"

        # Trigger a token refresh from Firefox via XPCOM IPC to FELT
        self.trigger_token_refresh()
        self._manually_closed_child = True
        self.wait_process_exit(self._browser_pid)

        # FELT should display the authentication window again
        self.await_felt_auth_window()
        self.force_window()

        # FELT tokens should have been cleared
        self.assert_felt_tokens_cleared()

    def trigger_token_refresh(self):
        driver = self.get_driver(Environment.FIREFOX)
        driver.set_context("chrome")
        try:
            driver.execute_script("Services.felt.refreshTokens();")
        except Exception:
            pass
        driver.set_context("content")

    def assert_felt_tokens_cleared(self):
        driver = self.get_driver(Environment.FELT)
        driver.set_context("chrome")
        tokens = driver.execute_script(
            """
            return [
                Services.felt.getAccessTokenIfValid(),
                Services.felt.getRefreshToken(),
            ];
            """
        )
        driver.set_context("content")
        assert tokens[0] in ("", None), (
            f"FELT access token should be cleared after failed reauth, got: {tokens[0]}"
        )
        assert tokens[1] in ("", None), (
            f"FELT refresh token should be cleared after failed reauth, got: {tokens[1]}"
        )
