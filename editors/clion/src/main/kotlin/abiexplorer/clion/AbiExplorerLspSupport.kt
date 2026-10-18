package abiexplorer.clion

import com.google.gson.JsonObject
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.platform.lsp.api.Lsp4jClient
import com.intellij.platform.lsp.api.LspServer
import com.intellij.platform.lsp.api.LspServerManager
import com.intellij.platform.lsp.api.LspServerNotificationsHandler
import com.intellij.platform.lsp.api.LspServerSupportProvider
import com.intellij.platform.lsp.api.ProjectWideLspServerDescriptor
import com.intellij.util.messages.Topic
import org.eclipse.lsp4j.jsonrpc.services.JsonNotification
import org.eclipse.lsp4j.jsonrpc.services.JsonRequest
import org.eclipse.lsp4j.services.LanguageServer
import java.util.concurrent.CompletableFuture

private val C_FAMILY_EXTENSIONS = setOf("c", "h", "cc", "cpp", "cxx", "c++", "hh", "hpp", "hxx", "h++", "ipp", "tpp", "inl")

/** Starts abi-explorer-lsp for C and C++ files, once Node.js is ready. */
class AbiExplorerLspSupport : LspServerSupportProvider {
    override fun fileOpened(project: Project, file: VirtualFile, serverStarter: LspServerSupportProvider.LspServerStarter) {
        if (!isCFamily(file)) return
        val runtime = ServerRuntime.findInstalled()
        if (runtime != null) {
            serverStarter.ensureServerStarted(AbiExplorerServerDescriptor(project, runtime))
        } else {
            installThenStart(project)
        }
    }

    companion object {
        fun server(project: Project): LspServer? =
            LspServerManager.getInstance(project).getServersForProvider(AbiExplorerLspSupport::class.java).firstOrNull()

        @Volatile
        private var installing = false

        private fun installThenStart(project: Project) {
            if (installing) return
            installing = true
            object : Task.Backgroundable(project, "Setting up ABI Explorer", true) {
                override fun run(indicator: ProgressIndicator) {
                    ServerRuntime.install(indicator)
                }

                override fun onSuccess() {
                    LspServerManager.getInstance(project).stopAndRestartIfNeeded(AbiExplorerLspSupport::class.java)
                }

                override fun onThrowable(error: Throwable) {
                    NotificationGroupManager.getInstance().getNotificationGroup("ABI Explorer")
                        .createNotification("ABI Explorer could not download Node.js", error.message ?: "", NotificationType.WARNING)
                        .notify(project)
                }

                override fun onFinished() {
                    installing = false
                }
            }.queue()
        }
    }
}

fun isCFamily(file: VirtualFile): Boolean = file.extension?.lowercase() in C_FAMILY_EXTENSIONS

class AbiExplorerServerDescriptor(project: Project, private val runtime: ServerRuntime) :
    ProjectWideLspServerDescriptor(project, "ABI Explorer") {

    override fun isSupportedFile(file: VirtualFile): Boolean = isCFamily(file)

    override fun createCommandLine() = runtime.commandLine()

    // Quick documentation shows no SVG, so hovers draw the byte map as text.
    override fun createInitializationOptions(): Any = mapOf("hoverImages" to false, "inlayHints" to "records")

    override val lsp4jServerClass: Class<out LanguageServer> = AbiExplorerServer::class.java

    override fun createLsp4jClient(handler: LspServerNotificationsHandler): Lsp4jClient = AbiExplorerClient(handler, project)
}

/** The server's requests beyond LSP; see protocol.ts in abi-explorer-lsp. */
interface AbiExplorerServer : LanguageServer {
    /** The result is passed to the panel as is, so it stays JSON here. */
    @JsonRequest("abiExplorer/layout")
    fun layout(params: LayoutParams): CompletableFuture<JsonObject>

    @JsonNotification("abiExplorer/compileCommands")
    fun compileCommands(params: CompileCommandsParams)
}

data class TextDocumentId(val uri: String)
data class LspPosition(val line: Int, val character: Int)
data class LayoutParams(val textDocument: TextDocumentId, val position: LspPosition?)
data class CompileCommandsParams(val source: String, val commands: List<abiexplorer.core.CompileCommand>)

/** Tells the tool window when the server has analysed a file again. */
fun interface LayoutsChangedListener {
    fun layoutsChanged()

    companion object {
        val TOPIC = Topic.create("ABI Explorer layouts changed", LayoutsChangedListener::class.java)
    }
}

class AbiExplorerClient(handler: LspServerNotificationsHandler, private val project: Project) : Lsp4jClient(handler) {
    @JsonNotification("abiExplorer/layoutsChanged")
    fun layoutsChanged(@Suppress("UNUSED_PARAMETER") params: Any?) {
        project.messageBus.syncPublisher(LayoutsChangedListener.TOPIC).layoutsChanged()
    }
}
