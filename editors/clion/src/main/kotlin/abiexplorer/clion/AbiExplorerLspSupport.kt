package abiexplorer.clion

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.platform.lsp.api.Lsp4jClient
import com.intellij.platform.lsp.api.LspServer
import com.intellij.platform.lsp.api.LspServerManager
import com.intellij.platform.lsp.api.LspServerNotificationsHandler
import com.intellij.platform.lsp.api.LspServerSupportProvider
import com.intellij.platform.lsp.api.ProjectWideLspServerDescriptor
import org.eclipse.lsp4j.services.LanguageServer
import java.util.concurrent.atomic.AtomicBoolean

private val C_FAMILY_EXTENSIONS = setOf("c", "h", "cc", "cpp", "cxx", "c++", "hh", "hpp", "hxx", "h++", "ipp", "tpp", "inl")

fun isCFamily(file: VirtualFile): Boolean = file.extension?.lowercase() in C_FAMILY_EXTENSIONS

/** Starts abi-explorer-lsp for C and C++ files, once Node.js and the server are in place. */
class AbiExplorerLspSupport : LspServerSupportProvider {
    override fun fileOpened(project: Project, file: VirtualFile, serverStarter: LspServerSupportProvider.LspServerStarter) {
        if (!isCFamily(file)) return
        // Finding Node.js runs a process, so it never happens here, on the caller's thread.
        val runtime = ServerRuntime.ready
        if (runtime != null) serverStarter.ensureServerStarted(AbiExplorerServerDescriptor(project, runtime)) else prepare(project)
    }

    companion object {
        fun server(project: Project): LspServer? =
            LspServerManager.getInstance(project).getServersForProvider(AbiExplorerLspSupport::class.java).firstOrNull()

        private val preparing = AtomicBoolean(false)

        /** Why Node.js or the server could not be set up; not retried until the IDE restarts. */
        @Volatile
        var setupFailure: String? = null
            private set

        private fun prepare(project: Project) {
            if (setupFailure != null || !preparing.compareAndSet(false, true)) return
            object : Task.Backgroundable(project, "Setting up ABI Explorer", true) {
                override fun run(indicator: ProgressIndicator) {
                    ServerRuntime.prepare(indicator)
                }

                override fun onSuccess() {
                    // Every project that opened a C or C++ file meanwhile, not just this one.
                    for (open in ProjectManager.getInstance().openProjects) {
                        LspServerManager.getInstance(open).stopAndRestartIfNeeded(AbiExplorerLspSupport::class.java)
                    }
                }

                override fun onThrowable(error: Throwable) {
                    setupFailure = error.message ?: error.javaClass.simpleName
                    NotificationGroupManager.getInstance().getNotificationGroup("ABI Explorer")
                        .createNotification("ABI Explorer could not set up Node.js", error.message ?: "", NotificationType.WARNING)
                        .notify(project)
                }

                override fun onFinished() {
                    preparing.set(false)
                }
            }.queue()
        }
    }
}

class AbiExplorerServerDescriptor(project: Project, private val runtime: ServerRuntime) :
    ProjectWideLspServerDescriptor(project, "ABI Explorer") {

    override fun isSupportedFile(file: VirtualFile): Boolean = isCFamily(file)

    override fun createCommandLine() = runtime.commandLine()

    // Quick documentation shows no SVG, so hovers draw the byte map as text.
    override fun createInitializationOptions(): Any = mapOf("hoverImages" to false, "inlayHints" to "records")

    override val lsp4jServerClass: Class<out LanguageServer> = AbiExplorerServer::class.java

    override fun createLsp4jClient(handler: LspServerNotificationsHandler): Lsp4jClient = AbiExplorerClient(handler, project)
}
