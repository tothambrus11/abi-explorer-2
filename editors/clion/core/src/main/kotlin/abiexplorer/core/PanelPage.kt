package abiexplorer.core

/** The IDE's look, as the panel's `--ae-*` CSS variables (see editors/panel/src/panel.css). */
data class PanelTheme(
    val foreground: String,
    val muted: String,
    val background: String,
    val hover: String,
    val border: String,
    val warning: String,
    val font: String,
    val fontSizePx: Int,
    val monospaceFont: String,
)

/**
 * The tool window's page: the shared panel's script and styles inline (JCEF
 * loads it from a string, with nothing to fetch), the theme, and the bridge
 * that hands clicks to the plugin. `postToPlugin` is a JavaScript expression
 * calling the plugin with a string named `message`, from `JBCefJSQuery.inject`.
 */
fun panelPage(script: String, styles: String, theme: PanelTheme, postToPlugin: String): String = """
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>${styles.closingTagsEscaped("style")}</style>
<style>${themeCss(theme)}</style>
<script>window.abiExplorerHost = { postMessage: function (message) { $postToPlugin } };</script>
</head>
<body>
<div id="root"></div>
<script>${script.closingTagsEscaped("script")}</script>
</body>
</html>
""".trimIndent()

fun themeCss(theme: PanelTheme): String = buildString {
    append(":root {")
    append(" --ae-foreground: ${theme.foreground};")
    append(" --ae-muted: ${theme.muted};")
    append(" --ae-background: ${theme.background};")
    append(" --ae-hover: ${theme.hover};")
    append(" --ae-border: ${theme.border};")
    append(" --ae-warning: ${theme.warning};")
    append(" --ae-font: ${cssFontFamily(theme.font)}, system-ui, sans-serif;")
    append(" --ae-font-size: ${theme.fontSizePx}px;")
    append(" --ae-mono: ${cssFontFamily(theme.monospaceFont)}, monospace;")
    append(" }")
}

/** `#rrggbb` for an RGB colour, as `java.awt.Color` gives it. */
fun cssColor(red: Int, green: Int, blue: Int): String = "#%02x%02x%02x".format(red, green, blue)

private fun cssFontFamily(name: String): String = "\"" + name.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

/** Inline code must not end its own element early. */
private fun String.closingTagsEscaped(tag: String): String = replace("</$tag", "<\\/$tag", ignoreCase = true)
