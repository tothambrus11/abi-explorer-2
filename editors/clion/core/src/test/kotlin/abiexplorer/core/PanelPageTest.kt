package abiexplorer.core

import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse

class PanelPageTest {
    private val theme = PanelTheme(
        foreground = cssColor(0xdf, 0xe1, 0xe5),
        muted = "#8c8c8c",
        background = "#2b2d30",
        hover = "#2e436e",
        border = "#393b40",
        warning = "#d6ae58",
        font = "Inter",
        fontSizePx = 13,
        monospaceFont = "JetBrains \"Mono\"",
    )

    @Test
    fun `writes the theme as CSS variables`() {
        val css = themeCss(theme)
        assertContains(css, "--ae-foreground: #dfe1e5;")
        assertContains(css, "--ae-mono: \"JetBrains \\\"Mono\\\"\", monospace;")
    }

    @Test
    fun `inlines the panel and the bridge`() {
        val page = panelPage("render('</script>')", ".a{}", theme, "cefQuery(message)")
        assertContains(page, "postMessage: function (message) { cefQuery(message) }")
        assertFalse("render('</script>')" in page)
        assertEquals(1, Regex("<div id=\"root\">").findAll(page).count())
    }
}
