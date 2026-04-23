/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.home.sports

import org.mozilla.fenix.components.AppStore
import org.mozilla.fenix.components.appstate.AppAction

/**
 * Controller for handling sports widget interactions on the homepage.
 */
interface SportsController {

    /**
     * Handles the user selecting countries in the sports widget country selector.
     *
     * @param countryCodes Set of ISO codes of the selected countries.
     */
    fun handleCountriesSelected(countryCodes: Set<String>)
}

/**
 * Default implementation of [SportsController] that dispatches actions to the [AppStore].
 *
 * @param appStore The [AppStore] to dispatch actions to.
 */
class DefaultSportsController(
    private val appStore: AppStore,
) : SportsController {

    override fun handleCountriesSelected(countryCodes: Set<String>) {
        appStore.dispatch(AppAction.SportsWidgetAction.CountriesSelected(countryCodes = countryCodes))
    }
}
