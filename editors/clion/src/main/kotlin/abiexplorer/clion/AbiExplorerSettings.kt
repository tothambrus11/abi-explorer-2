package abiexplorer.clion

import com.intellij.openapi.components.BaseState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.SimplePersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service
import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogPanel
import com.intellij.platform.lsp.api.LspServerManager
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.columns
import com.intellij.ui.dsl.builder.COLUMNS_MEDIUM
import com.intellij.ui.dsl.builder.panel

/** The project's ABI Explorer settings, sent to the server as initialization options. */
@Service(Service.Level.PROJECT)
@State(name = "AbiExplorerSettings", storages = [Storage("abiExplorer.xml")])
class AbiExplorerSettings : SimplePersistentStateComponent<AbiExplorerSettings.Options>(Options()) {
    class Options : BaseState() {
        var target by string("")
    }

    fun initializationOptions(): Map<String, Any> = buildMap {
        // Quick documentation shows no SVG, so hovers draw the byte map as text.
        put("hoverImages", false)
        state.target?.trim()?.takeIf { it.isNotEmpty() }?.let { put("target", it) }
    }

    companion object {
        fun of(project: Project): AbiExplorerSettings = project.service()
    }
}

/** Settings | Tools | ABI Explorer. Applying restarts the server with the new options. */
class AbiExplorerConfigurable(private val project: Project) : BoundConfigurable("ABI Explorer") {
    private val options = AbiExplorerSettings.of(project).state

    override fun createPanel(): DialogPanel = panel {
        row("Target:") {
            textField()
                .columns(COLUMNS_MEDIUM)
                .bindText({ options.target ?: "" }, { options.target = it.trim() })
                .comment(
                    "A triple such as <code>armv7-unknown-linux-gnueabihf</code> to lay structs out for " +
                        "instead of the project's own target, with the engine's bundled headers. " +
                        "Empty uses the project's target.",
                )
        }
    }

    override fun apply() {
        super.apply()
        LspServerManager.getInstance(project).stopAndRestartIfNeeded(AbiExplorerLspSupport::class.java)
    }
}
