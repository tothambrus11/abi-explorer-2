package abiexplorer.clion

import abiexplorer.core.PanelTheme
import abiexplorer.core.cssColor
import abiexplorer.core.panelPage
import com.google.gson.JsonArray
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.ide.ui.LafManagerListener
import com.intellij.openapi.ide.CopyPasteManager
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
import com.intellij.ui.components.JBLabel
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefJSQuery
import com.intellij.util.Alarm
import com.intellij.util.ui.NamedColorUtil
import com.intellij.util.ui.UIUtil
import java.awt.datatransfer.StringSelection
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlin.coroutines.cancellation.CancellationException
import java.awt.Color
import java.util.concurrent.atomic.AtomicInteger

private const val CARET_DEBOUNCE_MS = 150

class LayoutToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val factory = toolWindow.contentManager.factory
        if (!JBCefApp.isSupported()) {
            val message = JBLabel("The Struct Layout panel needs JCEF, which this IDE runtime does not include.")
            toolWindow.contentManager.addContent(factory.createContent(message, null, false))
            return
        }
        val panel = LayoutPanel(project)
        val content = factory.createContent(panel.component, null, false)
        content.setDisposer(panel)
        toolWindow.contentManager.addContent(content)
    }
}

/** The shared layout panel (editors/panel) in JCEF, following the caret like the VS Code view. */
class LayoutPanel(private val project: Project) : Disposable {
    private val browser = JBCefBrowser()
    private val fromPage = JBCefJSQuery.create(browser)
    private val alarm = Alarm(Alarm.ThreadToUse.SWING_THREAD, this)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    // Written from the EDT, read from the LSP and coroutine threads.
    @Volatile private var editor: Editor? = null
    @Volatile private var pageReady = false
    @Volatile private var lastResult: String? = null
    private val requestNumber = AtomicInteger()

    val component get() = browser.component

    init {
        Disposer.register(this, browser)
        Disposer.register(this, fromPage)
        fromPage.addHandler { message -> receive(message); null }
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
            // The page carries the theme's colours: load it again in the new ones.
            subscribe(LafManagerListener.TOPIC, LafManagerListener {
                pageReady = false
                browser.loadHTML(page())
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
        val editor = editor?.takeUnless { it.isDisposed }
        this.editor = editor
        val file = editor?.let { FileDocumentManager.getInstance().getFile(it.document) }
        val server = AbiExplorerLspSupport.server(project)
        if (editor == null || file == null || server == null) {
            val failure = AbiExplorerLspSupport.setupFailure
            show(placeholder(when {
                editor == null -> "Open a C or C++ file to see the layouts of its structs."
                failure != null -> "ABI Explorer could not set up Node.js: $failure"
                else -> "Starting…"
            }))
            return
        }
        // LSP characters are UTF-16 code units, as Java string offsets are.
        val offset = editor.caretModel.offset
        val line = editor.document.getLineNumber(offset)
        val position = LspPosition(line, offset - editor.document.getLineStartOffset(line))
        val params = LayoutParams(TextDocumentId(server.descriptor.getFileUri(file)), position)
        val number = requestNumber.incrementAndGet()
        scope.launch {
            val result = try {
                server.sendRequest { (it as AbiExplorerServer).layout(params) }?.toString() ?: return@launch
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                placeholder("The layout request failed: ${error.message}")
            }
            // A slow answer to an older caret position is dropped.
            if (number == requestNumber.get()) show(result)
        }
    }

    /** Sends a layout result (JSON) to the page, or keeps it until the page has loaded. */
    private fun show(result: String) {
        lastResult = result
        if (!pageReady) return
        // The HostMessage of editors/panel/src/messages.ts.
        browser.cefBrowser.executeJavaScript("window.postMessage({ type: 'layout', result: $result }, '*');", browser.cefBrowser.url, 0)
    }

    /** A PanelMessage from the page (editors/panel/src/messages.ts). */
    private fun receive(message: String) {
        val json = JsonParser.parseString(message).asJsonObject
        when (json["type"]?.asString) {
            "ready" -> {
                pageReady = true
                lastResult?.let(::show)
            }
            "reveal" -> {
                val start = json.getAsJsonObject("range").getAsJsonObject("start")
                UIUtil.invokeLaterIfNeeded { reveal(start["line"].asInt, start["character"].asInt) }
            }
            "copy" -> CopyPasteManager.getInstance().setContents(StringSelection(json["text"].asString))
        }
    }

    private fun reveal(line: Int, character: Int) {
        val editor = editor?.takeUnless { it.isDisposed } ?: return
        val file = FileDocumentManager.getInstance().getFile(editor.document) ?: return
        if (line >= editor.document.lineCount) return
        // By offset: a column would count a tab as several.
        OpenFileDescriptor(project, file, editor.document.getLineStartOffset(line) + character).navigate(true)
    }

    private fun page(): String {
        fun resource(name: String) = LayoutPanel::class.java.getResource("/panel/$name")?.readText() ?: error("plugin is missing panel/$name")
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
        return panelPage(resource("panel.js"), resource("panel.css"), theme, fromPage.inject("message"))
    }

    override fun dispose() {
        scope.cancel()
    }
}

private fun placeholder(message: String): String {
    val result = JsonObject()
    result.addProperty("state", "unavailable")
    result.addProperty("message", message)
    result.add("records", JsonArray())
    result.add("selection", JsonNull.INSTANCE)
    result.add("context", JsonNull.INSTANCE)
    return result.toString()
}

private fun css(color: Color): String = cssColor(color.red, color.green, color.blue)
