# R8 rules for the release build (minifyEnabled in build.gradle). Capacitor's
# consumer rules keep every class extending Plugin and its @PluginMethod
# methods, which the bridge calls by name. Below is what they do not cover.

# This app's own classes, whole. They are a few thousand lines, so shrinking
# them saves nothing, and a renamed method the bridge or a manifest entry
# reaches by name fails only on a phone, at the moment it is first used.
-keep class com.valjdakosta.mbrd.** { *; }

# The bridge itself: Capacitor reflects over its own classes as well.
-keep class com.getcapacitor.** { *; }

# Anything the page reaches through addJavascriptInterface.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Stack traces from a release build that point at a line.
-keepattributes SourceFile,LineNumberTable,*Annotation*,Signature,InnerClasses,EnclosingMethod
