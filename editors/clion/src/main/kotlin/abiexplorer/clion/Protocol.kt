package abiexplorer.clion

import abiexplorer.core.CompileCommand
import com.google.gson.JsonObject
import com.intellij.openapi.project.Project
import com.intellij.platform.lsp.api.Lsp4jClient
import com.intellij.platform.lsp.api.LspServerNotificationsHandler
import com.intellij.util.messages.Topic
import org.eclipse.lsp4j.jsonrpc.services.JsonNotification
import org.eclipse.lsp4j.jsonrpc.services.JsonRequest
import org.eclipse.lsp4j.services.LanguageServer
import java.util.concurrent.CompletableFuture

// The server's messages beyond LSP, mirroring editors/shared/src/protocol.ts.

interface AbiExplorerServer : LanguageServer {
    /** The result goes to the panel as it is, so it stays JSON here. */
    @JsonRequest("abiExplorer/layout")
    fun layout(params: LayoutParams): CompletableFuture<JsonObject>

    @JsonNotification("abiExplorer/compileCommands")
    fun compileCommands(params: CompileCommandsParams)
}

data class TextDocumentId(val uri: String)

/** `character` counts UTF-16 code units, as Java string offsets do. */
data class LspPosition(val line: Int, val character: Int)

data class LayoutParams(val textDocument: TextDocumentId, val position: LspPosition?)

data class CompileCommandsParams(val source: String, val commands: List<CompileCommand>)

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
