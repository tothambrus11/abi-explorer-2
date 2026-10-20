// The CLion plugin. Run `npm run build` in editors/ first: the server and
// panel bundles are copied in from ../server/dist and ../panel/dist.
import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask.FailureLevel
import org.jetbrains.kotlin.gradle.dsl.JvmDefaultMode

plugins {
    kotlin("jvm") version "2.4.21"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "abiexplorer"
version = providers.gradleProperty("pluginVersion").get()

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

kotlin {
    jvmToolchain(21)
    // Without bridges for the platform interfaces' default methods, which the plugin verifier
    // counts as overriding and calling deprecated and experimental ToolWindowFactory methods.
    compilerOptions {
        jvmDefault = JvmDefaultMode.NO_COMPATIBILITY
    }
}

dependencies {
    implementation("abiexplorer:abi-explorer-core")
    // PluginSmokeTest: the plugin in the real IntelliJ Platform, JUnit 3 style.
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.opentest4j:opentest4j:1.3.0")
    intellijPlatform {
        clion(providers.gradleProperty("platformVersion"))
        bundledPlugin("com.intellij.clion")
        pluginVerifier()
        testFramework(TestFrameworkType.Platform)
    }
}

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            sinceBuild = providers.gradleProperty("sinceBuild")
            untilBuild = provider { null }
        }
    }
    // `./gradlew signPlugin publishPlugin` in the release workflow; see editors/RELEASING.md.
    signing {
        certificateChain = providers.environmentVariable("JETBRAINS_CERTIFICATE_CHAIN")
        privateKey = providers.environmentVariable("JETBRAINS_PRIVATE_KEY")
        password = providers.environmentVariable("JETBRAINS_PRIVATE_KEY_PASSWORD")
    }
    publishing {
        token = providers.environmentVariable("JETBRAINS_MARKETPLACE_TOKEN")
    }
    // `./gradlew verifyPlugin`: the APIs the plugin uses exist in this CLion, and none is internal
    // or deprecated.
    pluginVerification {
        failureLevel = listOf(
            FailureLevel.COMPATIBILITY_PROBLEMS,
            FailureLevel.INTERNAL_API_USAGES,
            FailureLevel.DEPRECATED_API_USAGES,
            FailureLevel.SCHEDULED_FOR_REMOVAL_API_USAGES,
        )
        ides {
            create(IntelliJPlatformType.CLion, providers.gradleProperty("platformVersion").get())
        }
    }
}

tasks.processResources {
    from("../server/dist") { into("server") }
    from("../panel/dist") { into("panel") }
}

tasks.test {
    // The project the smoke test opens; the server it runs comes from processResources above.
    systemProperty("abiexplorer.fixture", file("../server/test/fixtures/project").absolutePath)
    // Its sources are not inputs Gradle sees, so it always runs when asked.
    outputs.upToDateWhen { false }
    testLogging {
        events("failed", "standard_out")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}

// The release signs and publishes the zip its smoke tests ran, not a new build:
// `./gradlew signPlugin publishPlugin -x buildPlugin -PprebuiltPlugin=/path/to/plugin.zip`
// (`-x buildPlugin`, or publishPlugin builds one first).
providers.gradleProperty("prebuiltPlugin").orNull?.let { prebuilt ->
    tasks.signPlugin {
        archiveFile = file(prebuilt)
    }
}
