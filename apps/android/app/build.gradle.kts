plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "com.screenmesh"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.screenmesh"
        // 26 (Android 8, Oreo): the modern BLE/permission model this project's
        // eventual BLE/Wi-Fi Direct/NFC work targets starts making sense here.
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")

    // registerForActivityResult / ActivityResultContracts (BLE runtime
    // permission requests in MainActivity). appcompat 1.7.0 already pulls
    // in a compatible androidx.activity transitively; pinned explicitly
    // here so the version isn't left to transitive resolution.
    implementation("androidx.activity:activity-ktx:1.9.0")

    // Relay client (WebSocket + HTTP pairing calls) — same role as
    // WebSocketRelayTransport (packages/transport) and the fetch() calls
    // in apps/web/src/lib/app.ts / apps/agent/src/join.ts.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // JSON wire format — must match the shapes in packages/protocol
    // exactly (EnvelopeJson, PresenceEntry, JoinWorkspaceResponse, ...).
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")

    // Ed25519 / X25519 / HKDF: not reliably available across API 26+ via
    // the platform's own javax.crypto/java.security providers (Android's
    // native Ed25519/X25519 support is recent and inconsistent below
    // API 33), so — like packages/crypto isolating Web Crypto behind an
    // interface — this isolates BouncyCastle behind Identity.kt/Ratchet.kt.
    implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")
}

// Prints the plain-JVM dependency classpath (one path per line), used to
// run InteropSmoke.kt (the cross-language interop check against a real
// TypeScript relay/engine — see docs/Android.md) directly with `java`
// instead of on a device/emulator. Only the non-Android-API files in this
// module (protocol/crypto/transport/sync, not MainActivity or
// transport/nearby/*) are exercised that way.
tasks.register("printRuntimeClasspath") {
    doLast {
        configurations.getByName("debugRuntimeClasspath").files.forEach { println(it.absolutePath) }
    }
}
