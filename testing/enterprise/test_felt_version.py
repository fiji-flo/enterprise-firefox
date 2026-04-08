#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTestsBase


class FeltVersion(FeltTestsBase):
    """
    Tests the Firefox version in the Felt window
    """

    def teardown(self):
        self._manually_closed_child = True
        super().teardown()

    def test_correct_firefox_version_in_felt_window(self):
        self._driver.set_context("chrome")

        # Get the expected values
        expected = self._driver.execute_script(
            """
            const { AppConstants } = ChromeUtils.importESModule(
            "resource://gre/modules/AppConstants.sys.mjs"
            );

            const version = AppConstants.MOZ_APP_VERSION_DISPLAY;
            let l10n_id = "felt-version";
            let isodate = null;
            const is_nightly = AppConstants.NIGHTLY_BUILD === true;

            if (is_nightly) {
                const buildID = Services.appinfo.appBuildID;
                const year = buildID.slice(0, 4);
                const month = buildID.slice(4, 6);
                const day = buildID.slice(6, 8);

                l10n_id = "felt-version-nightly";
                isodate = `${year}-${month}-${day}`;
            }

            return {
                is_nightly,
                l10n_id,
                version,
                isodate,
            };
            """
        )

        # Get the actual values
        actual = self._driver.execute_script(
            """
            const versionElement = document.querySelector(".felt-version");
            return document.l10n.getAttributes(versionElement);
            """
        )

        assert actual["id"] == expected["l10n_id"]
        assert actual["args"]["version"] == expected["version"]

        if expected["is_nightly"] is True:
            assert actual["args"]["isodate"] == expected["isodate"]
        else:
            assert "isodate" not in actual["args"]

        self._driver.set_context("content")
