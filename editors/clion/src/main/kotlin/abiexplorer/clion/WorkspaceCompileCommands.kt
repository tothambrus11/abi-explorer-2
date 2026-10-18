package abiexplorer.clion

import abiexplorer.core.CompileCommand
import abiexplorer.core.compileCommand
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.platform.lsp.api.LspServer
import com.intellij.platform.lsp.api.LspServerManager
import com.intellij.platform.lsp.api.LspServerManagerListener
import com.intellij.platform.lsp.api.LspServerState
import com.intellij.util.concurrency.AppExecutorUtil
import com.jetbrains.cidr.lang.toolchains.CidrCompilerSwitches
import com.jetbrains.cidr.lang.workspace.OCResolveConfigurations
import com.jetbrains.cidr.lang.workspace.OCWorkspace
import com.jetbrains.cidr.lang.workspace.OCWorkspaceListener

/** Ends with the project, or when the plugin is unloaded: the parent for the plugin's listeners. */
@Service(Service.Level.PROJECT)
class PluginLifetime : Disposable {
    override fun dispose() {}
}

/** Sends the project model once more whenever a server (re)starts. */
class PushCompileCommandsOnStart : ProjectActivity {
    override suspend fun execute(project: Project) {
        LspServerManager.getInstance(project).addLspServerManagerListener(object : LspServerManagerListener {
            override fun serverStateChanged(lspServer: LspServer) {
                if (lspServer.state == LspServerState.Running && lspServer.descriptor is AbiExplorerServerDescriptor) {
                    WorkspaceCompileCommands.push(project)
                }
            }
        }, project.service<PluginLifetime>(), true)
    }
}

/**
 * Sends the server every file's compiler and switches from CLion's project
 * model whenever it changes, so CMake, Makefile and other projects work
 * without a compile_commands.json on disk.
 */
class WorkspaceCompileCommands(private val project: Project) : OCWorkspaceListener {
    override fun workspaceChanged(event: OCWorkspaceListener.OCWorkspaceEvent) {
        push(project)
    }

    companion object {
        fun push(project: Project) {
            ReadAction.nonBlocking<List<CompileCommand>> { collect(project) }
                .expireWith(project)
                .submit(AppExecutorUtil.getAppExecutorService())
                .onSuccess { commands ->
                    val server = AbiExplorerLspSupport.server(project) ?: return@onSuccess
                    server.sendNotification { (it as AbiExplorerServer).compileCommands(CompileCommandsParams("CLion", commands)) }
                }
        }

        private fun collect(project: Project): List<CompileCommand> {
            val files = OCWorkspace.getInstance(project).configurations.flatMap { it.sources }.distinctBy { it.path }
            val commands = ArrayList<CompileCommand>()
            for (file in files) {
                // A file in several configurations (Debug, Release) takes the one selected for it in the editor.
                val configuration = OCResolveConfigurations.getPreselectedConfiguration(file, project) ?: continue
                val kind = configuration.getDeclaredLanguageKind(file) ?: continue
                val settings = configuration.getCompilerSettings(kind, file)
                commands += compileCommand(
                    compiler = settings.compilerExecutable?.path,
                    workingDirectory = settings.compilerWorkingDir?.path,
                    switches = settings.compilerSwitches?.getList(CidrCompilerSwitches.Format.RAW).orEmpty(),
                    file = file.path,
                )
            }
            return commands
        }
    }
}
