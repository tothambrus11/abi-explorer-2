package abiexplorer.screenshotdriver

import com.intellij.codeInsight.daemon.impl.HighlightInfo
import com.intellij.ide.ui.UISettings
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.notification.Notification
import com.intellij.notification.NotificationsManager
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.application.ApplicationInfo
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.EDT
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.application.asContextElement
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.ScrollType
import com.intellij.openapi.editor.impl.DocumentMarkupModel
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.DumbService
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.guessProjectDir
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.openapi.wm.WindowManager
import com.intellij.openapi.wm.ex.ToolWindowEx
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.awt.MouseInfo
import java.awt.Point
import java.awt.Rectangle
import java.awt.Robot
import java.awt.Window
import java.awt.event.InputEvent
import java.awt.event.KeyEvent
import java.awt.image.BufferedImage
import java.awt.image.DataBufferInt
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.time.Instant
import javax.imageio.ImageIO
import javax.swing.JDialog
import javax.swing.SwingUtilities

/**
 * Runs only when CLion starts with -Dabiexplorer.screenshots.out (see build.gradle.kts).
 * The "stills" scene opens the sample's main.cpp, waits for the plugin's warning, then
 * hovers a struct and a member, shows the intentions and the Struct Layout tool window,
 * saving each as a PNG of the IDE window. The "demo" scene records demo.cpp being hovered,
 * reordered by the quick fix and hovered again, as frames that make-gif.py turns into the
 * README's GIF. Either way CLion quits afterwards.
 */
class ScreenshotDriver : ProjectActivity {
    override suspend fun execute(project: Project) {
        val out = System.getProperty("abiexplorer.screenshots.out")?.let { Path.of(it) } ?: return
        Files.createDirectories(out)
        val shots = Shots(project, out)
        shots.log("${ApplicationInfo.getInstance().fullApplicationName} (${ApplicationInfo.getInstance().build})")
        try {
            coroutineScope {
                val closer = launch { shots.closeDialogs() }
                when (val scene = System.getProperty("abiexplorer.screenshots.scene") ?: "stills") {
                    "stills" -> shots.takeAll()
                    "demo" -> shots.recordDemo()
                    else -> error("unknown scene $scene")
                }
                closer.cancel()
            }
            shots.log("done")
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            shots.log("failed: ${error.stackTraceToString()}")
            runCatching { shots.capture("failure") }
        } finally {
            if (System.getProperty("abiexplorer.screenshots.stay") == null) {
                // Non-modal: exiting saves documents, which is not allowed from the "any" modality.
                ApplicationManager.getApplication().invokeLater(
                    { ApplicationManager.getApplication().exit(true, true, false) }, ModalityState.nonModal(),
                )
            }
        }
    }
}

private suspend fun <T> onEdt(block: () -> T): T =
    withContext(Dispatchers.EDT + ModalityState.any().asContextElement()) { block() }

private class Shots(private val project: Project, private val out: Path) {
    private val robot = Robot()

    fun log(message: String) {
        Files.writeString(
            out.resolve("driver.log"), "${Instant.now()} $message\n",
            StandardOpenOption.CREATE, StandardOpenOption.APPEND,
        )
    }

    private suspend fun placeFrame(width: Int, height: Int) = onEdt {
        val frame = WindowManager.getInstance().getFrame(project)!!
        val screen = frame.graphicsConfiguration.bounds
        frame.extendedState = java.awt.Frame.NORMAL
        frame.setBounds(screen.x + 10, screen.y + 10, minOf(width, screen.width - 20), minOf(height, screen.height - 60))
        // Windows keeps a background process from taking the foreground, and the captures are of the
        // screen: on top, CLion is what they show and where the hovers land.
        frame.isAlwaysOnTop = true
        frame.toFront()
        frame.requestFocus()
    }

    /** Opens a file of the sample and waits until the plugin has put its warning on the struct at [structAt]. */
    private suspend fun open(name: String, structAt: String): Editor {
        val file = onEdt { project.guessProjectDir()?.findChild(name) } ?: error("no $name in ${project.basePath}")
        val editor = onEdt { FileEditorManager.getInstance(project).openTextEditor(OpenFileDescriptor(project, file, 0), true) }
            ?: error("$name did not open in a text editor")
        val line = editor.document.getLineNumber(editor.document.text.indexOf(structAt))

        log("waiting for indexing")
        while (DumbService.isDumb(project)) delay(1_000)
        // CLion 2026.2 can leave the CMake project unloaded until its window is used, and without
        // it the plugin has no compile commands: click into the editor, and reload CMake if need be.
        val inside = pointAt(editor, editor.document.textLength)
        robot.mouseMove(inside.x + 200, inside.y + 120)
        robot.mousePress(InputEvent.BUTTON1_DOWN_MASK)
        robot.mouseRelease(InputEvent.BUTTON1_DOWN_MASK)
        log("waiting for the plugin's warning on $structAt")
        val warned = withTimeoutOrNull(400_000) {
            var waited = 0
            while (!onEdt { hasWarning(editor, line) }) {
                delay(2_000)
                waited += 2_000
                if (waited == 30_000) {
                    log("no warning after 30 s; reloading the CMake project")
                    runCatching { action("CMake.ReloadCMakeProject", editor) }.onFailure { log("reload failed: $it") }
                }
            }
            true
        }
        log(if (warned == true) "warning shown" else "no warning after 400 s; carrying on")
        delay(3_000)
        return editor
    }

    suspend fun takeAll() {
        delay(3_000)
        placeFrame(1440, 900)
        capture("startup")

        val editor = open("main.cpp", "Packet {")
        val text = editor.document.text
        val packet = text.indexOf("Packet {")
        val length = text.indexOf("length;")

        // Quick documentation by hovering, as a person would.
        hover(editor, packet + 2)
        capture("clion-record-hover")
        dismiss(editor)
        hover(editor, length + 2)
        capture("clion-member-hover")
        dismiss(editor)

        // The same through the action (F1 / Ctrl+Q), in case the hover shows only the warning.
        caretAt(editor, packet + 2)
        action("QuickJavaDoc", editor)
        delay(5_000)
        capture("clion-quick-doc")
        dismiss(editor)

        // The reorder warning's fixes (Alt+Enter).
        caretAt(editor, packet + 2)
        action("ShowIntentionActions", editor)
        delay(4_000)
        capture("clion-intentions")
        dismiss(editor)

        // The tool window, following the caret.
        onEdt {
            val window = ToolWindowManager.getInstance(project).getToolWindow("Struct Layout") ?: error("no Struct Layout tool window")
            window.show()
            val width = window.component.width
            if (window is ToolWindowEx && width in 1 until 560) runCatching { window.stretchWidth(560 - width) }
        }
        delay(3_000)
        caretAt(editor, packet + 2)
        delay(8_000)
        capture("clion-tool-window")
        caretAt(editor, length + 2)
        delay(5_000)
        capture("clion-tool-window-member")
        caretAt(editor, text.indexOf("Circle : Shape") + 2)
        delay(5_000)
        capture("clion-tool-window-derived")
    }

    /**
     * Hover the struct, apply "Reorder members by alignment" with Alt+Enter, hover a use of
     * the struct: frames of the whole IDE window, each new image once, in demo/, and
     * demo/frames.tsv saying when each was on screen and where the mouse was. The cursor
     * is not in the captures; make-gif.py draws it from those positions.
     */
    suspend fun recordDemo() {
        delay(3_000)
        // Zoomed in, so the GIF reads at README size.
        val scale = System.getProperty("abiexplorer.screenshots.zoom")?.toFloat() ?: 1.5f
        onEdt {
            UISettings.getInstance().ideScale = scale
            UISettings.getInstance().fireUISettingsChanged()
        }
        placeFrame(1880, 1040)
        val editor = open("demo.cpp", "Message {")
        awaitProjectDialogs()
        // A fresh CLion's notifications and other tabs would cover the editor.
        onEdt {
            val notifications = NotificationsManager.getNotificationsManager()
            (notifications.getNotificationsOfType(Notification::class.java, project) +
                notifications.getNotificationsOfType(Notification::class.java, null)).forEach { it.expire() }
            val manager = FileEditorManager.getInstance(project)
            manager.openFiles.filter { it != editor.virtualFile }.forEach { manager.closeFile(it) }
        }
        // The editor and, beside it, the Struct Layout tool window: no other tool windows.
        val panelWindow = onEdt {
            val manager = ToolWindowManager.getInstance(project)
            manager.toolWindowIds.forEach { manager.getToolWindow(it)?.hide() }
            manager.getToolWindow("Struct Layout")?.also { it.show() } ?: error("no Struct Layout tool window")
        }
        delay(2_000)
        onEdt {
            val frameWidth = WindowManager.getInstance().getFrame(project)!!.width
            val width = panelWindow.component.width
            if (panelWindow is ToolWindowEx && width > 0) runCatching { panelWindow.stretchWidth(frameWidth * 45 / 100 - width) }
        }
        // The caret in the struct, so the panel shows its layout from the first frame.
        caretAt(editor, editor.document.text.indexOf("Message {") + 3)
        val neutral = onEdt {
            val visible = editor.contentComponent.visibleRect
            val point = Point(visible.x + visible.width * 3 / 4, visible.y + visible.height * 3 / 4)
            SwingUtilities.convertPointToScreen(point, editor.contentComponent)
            point
        }
        robot.mouseMove(neutral.x, neutral.y)
        // The panel follows the caret into the struct once recording starts; let JCEF load first.
        delay(6_000)
        capture("demo-start")

        val dir = out.resolve("demo")
        dir.toFile().deleteRecursively()
        Files.createDirectories(dir)
        val (frameBounds, editorBounds, panelBounds) = onEdt {
            val frame = WindowManager.getInstance().getFrame(project)!!
            val origin = frame.locationOnScreen
            fun within(component: java.awt.Component): Rectangle {
                val at = Point(0, 0).also { SwingUtilities.convertPointToScreen(it, component) }
                return Rectangle(at.x - origin.x, at.y - origin.y, component.width, component.height)
            }
            Triple(Rectangle(origin, frame.size), within(editor.component), within(panelWindow.component))
        }
        Files.writeString(
            dir.resolve("bounds.tsv"),
            "frame\t${frameBounds.width}\t${frameBounds.height}\n" +
                "editor\t${editorBounds.x}\t${editorBounds.y}\t${editorBounds.width}\t${editorBounds.height}\n" +
                "panel\t${panelBounds.x}\t${panelBounds.y}\t${panelBounds.width}\t${panelBounds.height}\n",
        )

        coroutineScope {
            val recorder = launch(Dispatchers.IO) { record(dir, frameBounds) }
            delay(1_200)

            val name = editor.document.text.indexOf("Message {") + 3
            glide(pointAt(editor, name))
            delay(5_000)

            // Click the name, then Alt+Enter and pick the fix by typing, as a person would.
            robot.mousePress(InputEvent.BUTTON1_DOWN_MASK)
            robot.mouseRelease(InputEvent.BUTTON1_DOWN_MASK)
            delay(900)
            glide(neutral, steps = 12)
            delay(500)
            robot.keyPress(KeyEvent.VK_ALT)
            robot.keyPress(KeyEvent.VK_ENTER)
            robot.keyRelease(KeyEvent.VK_ENTER)
            robot.keyRelease(KeyEvent.VK_ALT)
            delay(1_500)
            for (key in "reorder") {
                val code = KeyEvent.getExtendedKeyCodeForChar(key.code)
                robot.keyPress(code)
                robot.keyRelease(code)
                delay(140)
            }
            delay(1_000)
            robot.keyPress(KeyEvent.VK_ENTER)
            robot.keyRelease(KeyEvent.VK_ENTER)
            delay(3_500)

            val use = editor.document.text.indexOf("Message inbox") + 3
            glide(pointAt(editor, use))
            delay(5_500)
            recorder.cancel()
        }
        log("recorded the demo")
    }

    private suspend fun record(dir: Path, bounds: Rectangle) {
        val start = System.nanoTime()
        val index = StringBuilder("ms\tframe\tmouseX\tmouseY\n")
        var lastHash = 0
        var frames = 0
        try {
            while (currentCoroutineContext().isActive) {
                val began = System.nanoTime()
                val image = grab(bounds)
                val pixels = (image.raster.dataBuffer as DataBufferInt).data
                val hash = pixels.contentHashCode()
                if (frames == 0 || hash != lastHash) {
                    frames++
                    lastHash = hash
                    ImageIO.write(image, "png", dir.resolve("frame-%04d.png".format(frames)).toFile())
                }
                // The mouse in the image's pixels, relative to the window.
                val mouse = MouseInfo.getPointerInfo().location
                val ratio = image.width.toDouble() / bounds.width
                val x = ((mouse.x - bounds.x) * ratio).toInt()
                val y = ((mouse.y - bounds.y) * ratio).toInt()
                index.append("${(began - start) / 1_000_000}\t$frames\t$x\t$y\n")
                delay(maxOf(0, 60 - (System.nanoTime() - began) / 1_000_000))
            }
        } finally {
            Files.writeString(dir.resolve("frames.tsv"), index)
        }
    }

    /** Moves the mouse there over [steps] events, as a hand would. */
    private suspend fun glide(to: Point, steps: Int = 24) {
        val from = MouseInfo.getPointerInfo().location
        for (step in 1..steps) {
            val t = step.toDouble() / steps
            val eased = t * t * (3 - 2 * t)
            robot.mouseMove((from.x + (to.x - from.x) * eased).toInt(), (from.y + (to.y - from.y) * eased).toInt())
            delay(30)
        }
    }

    private suspend fun pointAt(editor: Editor, offset: Int): Point = onEdt {
        val xy = editor.offsetToXY(offset)
        val point = Point(xy.x, xy.y + editor.lineHeight / 2)
        SwingUtilities.convertPointToScreen(point, editor.contentComponent)
        point
    }

    private fun hasWarning(editor: Editor, line: Int): Boolean {
        val markup = DocumentMarkupModel.forDocument(editor.document, project, false) ?: return false
        return markup.allHighlighters.any { highlighter ->
            val info = HighlightInfo.fromRangeHighlighter(highlighter) ?: return@any false
            info.severity == HighlightSeverity.WARNING && editor.document.getLineNumber(info.startOffset) == line
        }
    }

    private suspend fun caretAt(editor: Editor, offset: Int) = onEdt {
        editor.caretModel.moveToOffset(offset)
        editor.scrollingModel.scrollToCaret(ScrollType.MAKE_VISIBLE)
        editor.contentComponent.requestFocusInWindow()
    }

    private suspend fun hover(editor: Editor, offset: Int) {
        caretAt(editor, offset)
        val point = pointAt(editor, offset)
        // Mouse-moved events, ending still on the identifier.
        robot.mouseMove(point.x - 40, point.y + 3)
        delay(300)
        robot.mouseMove(point.x - 4, point.y)
        delay(200)
        robot.mouseMove(point.x + 2, point.y)
        delay(6_000)
    }

    private suspend fun dismiss(editor: Editor) {
        val corner = onEdt {
            val point = Point(editor.contentComponent.visibleRect.width - 40, editor.contentComponent.visibleRect.y + 10)
            SwingUtilities.convertPointToScreen(point, editor.contentComponent)
            point
        }
        robot.mouseMove(corner.x, corner.y)
        robot.keyPress(KeyEvent.VK_ESCAPE)
        robot.keyRelease(KeyEvent.VK_ESCAPE)
        delay(1_500)
    }

    private suspend fun action(id: String, editor: Editor) = onEdt {
        val action = ActionManager.getInstance().getAction(id) ?: error("no action $id")
        ActionManager.getInstance().tryToExecute(action, null, editor.contentComponent, ActionPlaces.UNKNOWN, true)
    }

    /** That part of the screen at its full resolution (HiDPI screens capture larger than [bounds]). */
    private fun grab(bounds: Rectangle): BufferedImage {
        val variants = robot.createMultiResolutionScreenCapture(bounds).resolutionVariants
        val image = variants.maxBy { it.getWidth(null) }
        val rgb = BufferedImage(image.getWidth(null), image.getHeight(null), BufferedImage.TYPE_INT_RGB)
        rgb.createGraphics().apply { drawImage(image, 0, 0, null); dispose() }
        return rgb
    }

    /** The IDE window and whatever pops up over it. */
    suspend fun capture(name: String) {
        val bounds = onEdt {
            val frame = WindowManager.getInstance().getFrame(project)!!
            Rectangle(frame.locationOnScreen, frame.size)
        }
        ImageIO.write(grab(bounds), "png", out.resolve("$name.png").toFile())
        log("saved $name.png")
    }

    /**
     * Waits for the CMake profile dialog a fresh project opens, which can come up well after the
     * plugin's warning, to show and close again (closeDialogs accepts it): 60 s when none comes.
     */
    private suspend fun awaitProjectDialogs() {
        val start = System.nanoTime()
        var seen = false
        var quietSince = System.nanoTime()
        while (true) {
            val showing = onEdt { Window.getWindows().any { it is java.awt.Dialog && it.isShowing } }
            val now = System.nanoTime()
            if (showing) {
                seen = true
                quietSince = now
            }
            val quiet = (now - quietSince) / 1_000_000 >= 3_000
            val waited = (now - start) / 1_000_000
            if (quiet && (seen || waited >= 60_000) || waited >= 180_000) break
            delay(500)
        }
        log(if (seen) "the project's dialogs closed" else "no project dialog for 60 s")
    }

    /**
     * Accepts dialogs a fresh CLion opens over the project (the CMake profile wizard, which CLion 2026.3
     * opens modeless, say), never a licence one.
     */
    suspend fun closeDialogs() {
        while (true) {
            delay(2_000)
            val closed = onEdt {
                Window.getWindows().filterIsInstance<JDialog>().filter { it.isShowing && (it.isModal || DialogWrapper.findInstance(it) != null) }.mapNotNull { dialog ->
                    val title = dialog.title.orEmpty()
                    if ("licen" in title.lowercase()) return@mapNotNull null
                    val button = dialog.rootPane.defaultButton
                    if (button != null) button.doClick() else DialogWrapper.findInstance(dialog)?.close(DialogWrapper.OK_EXIT_CODE)
                    title
                }
            }
            for (title in closed) log("accepted dialog \"$title\"")
        }
    }
}
