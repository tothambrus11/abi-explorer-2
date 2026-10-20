// The CLion plugin. Run `npm run build` in editors/ first: the server and
// panel bundles are copied in from ../server/dist and ../panel/dist.
import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask.FailureLevel
import org.jetbrains.kotlin.gradle.dsl.JvmDefaultMode

plugins {
    kotlin("jvm") version "2.4.21"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "abiexplorer"
version = "0.1.0"

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
    intellijPlatform {
        clion(providers.gradleProperty("platformVersion"))
        bundledPlugin("com.intellij.clion")
        pluginVerifier()
    }
}

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            sinceBuild = providers.gradleProperty("sinceBuild")
            untilBuild = provider { null }
        }
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
