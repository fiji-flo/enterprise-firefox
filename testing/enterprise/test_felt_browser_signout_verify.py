#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from test_felt_browser_signout import BaseBrowserSignout


class BrowserSignoutVerify(BaseBrowserSignout):
    def test_browser_signout(self):
        super().run_felt_base()
        # self.run_felt_chrome_on_email_submit()
        # self.run_wait_until_sso_loaded()
        # self.run_felt_perform_sso_auth()

        for i in range(10):
            print(f"Attempt {i + 1} A")
            self.run_perform_signout()
            print(f"Attempt {i + 1} B")
            self.run_prefilled_email_submit()
            print(f"Attempt {i + 1} C")
            self.run_load_sso()
            print(f"Attempt {i + 1} D")
            self.run_perform_sso_auth()
            print(f"Attempt {i + 1} E")
        self._manually_closed_child = True
