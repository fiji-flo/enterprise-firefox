/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.components.appstate.sports

import org.junit.Assert.assertEquals
import org.junit.Test
import org.mozilla.fenix.components.appstate.AppAction
import org.mozilla.fenix.components.appstate.AppState
import org.mozilla.fenix.components.appstate.AppStoreReducer

class SportsWidgetReducerTest {

    @Test
    fun `GIVEN no countries selected WHEN CountriesSelected is dispatched with countries THEN countriesSelected is updated`() {
        val initialState = AppState(
            sportsWidgetState = SportsWidgetState(),
        )

        val finalState = AppStoreReducer.reduce(
            initialState,
            AppAction.SportsWidgetAction.CountriesSelected(countryCodes = setOf("US", "JP")),
        )

        assertEquals(
            setOf("US", "JP"),
            finalState.sportsWidgetState.countriesSelected,
        )
    }

    @Test
    fun `GIVEN countries already selected WHEN CountriesSelected is dispatched THEN countriesSelected is replaced`() {
        val initialState = AppState(
            sportsWidgetState = SportsWidgetState(countriesSelected = setOf("US")),
        )

        val finalState = AppStoreReducer.reduce(
            initialState,
            AppAction.SportsWidgetAction.CountriesSelected(countryCodes = setOf("JP", "BR")),
        )

        assertEquals(
            setOf("JP", "BR"),
            finalState.sportsWidgetState.countriesSelected,
        )
    }

    @Test
    fun `GIVEN countries selected WHEN CountriesSelected is dispatched with empty set THEN countriesSelected is cleared`() {
        val initialState = AppState(
            sportsWidgetState = SportsWidgetState(countriesSelected = setOf("US")),
        )

        val finalState = AppStoreReducer.reduce(
            initialState,
            AppAction.SportsWidgetAction.CountriesSelected(countryCodes = emptySet()),
        )

        assertEquals(
            emptySet<String>(),
            finalState.sportsWidgetState.countriesSelected,
        )
    }

    @Test
    fun `GIVEN default state WHEN CountriesSelected is dispatched THEN countriesSelected is updated`() {
        val initialState = AppState()

        val finalState = AppStoreReducer.reduce(
            initialState,
            AppAction.SportsWidgetAction.CountriesSelected(countryCodes = setOf("DE")),
        )

        assertEquals(
            setOf("DE"),
            finalState.sportsWidgetState.countriesSelected,
        )
    }
}
