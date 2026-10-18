// The CLion plugin. Run `npm run build` in editors/ first: the server and
// panel bundles are copied in from ../server/dist and ../panel/dist.
import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType

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
    // `./gradlew verifyPlugin`: the APIs the plugin uses exist in this CLion, and none is internal.
    pluginVerification {
        ides {
            create(IntelliJPlatformType.CLion, providers.gradleProperty("platformVersion").get())
        }
    }
}

tasks.processResources {
    from("../server/dist") { into("server") }
    from("../panel/dist") { into("panel") }
}
