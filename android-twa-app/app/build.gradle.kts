plugins {
    id("com.android.application")
}

android {
    namespace = "com.tanzirdev.java2dex"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.tanzirdev.java2dex"
        minSdk = 21
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    // Trusted Web Activity launcher — wraps the deployed PWA in a signed, installable app
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.6.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
}
