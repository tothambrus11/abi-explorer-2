package abiexplorer.clion

import abiexplorer.core.PanelTheme
import abiexplorer.core.cssColor
import abiexplorer.core.panelPage
import com.google.gson.JsonParser
import com.intellij.ide.ui.LafManagerListener
import com.intellij.openapi.Disposable
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.editor.event.CaretEvent
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.CaretListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.JBColor
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefJSQuery
import com.intellij.util.Alarm
import com.intellij.util.ui.NamedColorUtil
import com.intellij.util.ui.UIUtil
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.awt.Color

private const val CARET_DEBOUNCE_MS = 150

class LayoutToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = LayoutPanel(project)
        val content = toolWindow.contentManager.factory.createContent(panel.component, null, false)
        content.setDisposer(panel)
        toolWindow.contentManager.addContent(content)
    }
}

/** The shared layout panel in JCEF, following the caret like the VS Code view. */
class LayoutPanel(private val project: Project) : Disposable {
    private val browser = JBCefBrowser()
    private val fromPage = JBCefJSQuery.create(browser)
    private val alarm = Alarm(Alarm.ThreadToUse.SWING_THREAD, this)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var editor: Editor? = null

    val component get() = browser.component

    init {
        Disposer.register(this, browser)
        Disposer.register(this, fromPage)
        fromPage.addHandler { message -> reveal(message); null }
        browser.loadHTML(page())

        EditorFactory.getInstance().eventMulticaster.addCaretListener(object : CaretListener {
            override fun caretPositionChanged(event: CaretEvent) = follow(event.editor)
        }, this)
        project.messageBus.connect(this).apply {
            subscribe(FileEditorManagerListener.FILE_EDITOR_MANAGER, object : FileEditorManagerListener {
                override fun selectionChanged(event: FileEditorManagerEvent) {
                    follow(FileEditorManager.getInstance(project).selectedTextEditor)
                }
            })
            subscribe(LayoutsChangedListener.TOPIC, LayoutsChangedListener { follow(editor) })
            // The page carries the theme's colours: redraw it in the new ones.
            subscribe(LafManagerListener.TOPIC, LafManagerListener {
                browser.loadHTML(page())
                follow(editor)
            })
        }
        follow(FileEditorManager.getInstance(project).selectedTextEditor)
    }

    private fun follow(next: Editor?) {
        if (next != null && next.project != project) return
        val file = next?.let { FileDocumentManager.getInstance().getFile(it.document) }
        if (file != null && !isCFamily(file)) return
        editor = next ?: editor
        alarm.cancelAllRequests()
        alarm.addRequest(::update, CARET_DEBOUNCE_MS)
    }

    private fun update() {
        val editor = editor ?: return
        val file = FileDocumentManager.getInstance().getFile(editor.document) ?: return
        val server = AbiExplorerLspSupport.server(project) ?: return
        // LSP characters are UTF-16 code units, as Java string offsets are.
        val offset = editor.caretModel.offset
        val line = editor.document.getLineNumber(offset)
        val position = LspPosition(line, offset - editor.document.getLineStartOffset(line))
        val params = LayoutParams(TextDocumentId(server.descriptor.getFileUri(file)), position)
        scope.launch {
            val result = server.sendRequest { (it as AbiExplorerServer).layout(params) } ?: return@launch
            browser.cefBrowser.executeJavaScript("window.postMessage({ type: 'layout', result: $result }, '*');", browser.cefBrowser.url, 0)
        }
    }

    /** A click in the panel: `{ "type": "reveal", "range": … }`. */
    private fun reveal(message: String) {
        val json = JsonParser.parseString(message).asJsonObject
        if (json["type"]?.asString != "reveal") return
        val start = json.getAsJsonObject("range").getAsJsonObject("start")
        val file = editor?.let { FileDocumentManager.getInstance().getFile(it.document) } ?: return
        UIUtil.invokeLaterIfNeeded {
            OpenFileDescriptor(project, file, start["line"].asInt, start["character"].asInt).navigate(true)
        }
    }

    private fun page(): String {
        fun resource(name: String) = LayoutPanel::class.java.getResource("/view/$name")?.readText() ?: error("plugin is missing view/$name")
        val scheme = EditorColorsManager.getInstance().globalScheme
        val font = UIUtil.getLabelFont()
        val theme = PanelTheme(
            foreground = css(UIUtil.getLabelForeground()),
            muted = css(NamedColorUtil.getInactiveTextColor()),
            background = css(UIUtil.getPanelBackground()),
            hover = css(UIUtil.getListSelectionBackground(false)),
            border = css(JBColor.border()),
            warning = css(JBColor.namedColor("Label.warningForeground", JBColor.ORANGE)),
            font = font.family,
            fontSizePx = font.size,
            monospaceFont = scheme.editorFontName,
        )
        return panelPage(resource("view.js"), resource("view.css"), theme, fromPage.inject("message"))
    }

    override fun dispose() {
        scope.cancel()
    }
}

private fun css(color: Color): String = cssColor(color.red, color.green, color.blue)
