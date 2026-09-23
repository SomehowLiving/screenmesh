package com.screenmesh.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// A small neutral palette, one accent — mirrors the web app's black/white/
// gray design (apps/web/src/styles.css) rather than Material's default
// purple, so the two clients read as the same product.
private val Accent = Color(0xFF6D5CE0)
private val AccentDark = Color(0xFF8B7DFF)

private val LightColors = lightColorScheme(
    primary = Accent,
    background = Color(0xFFFAFAFA),
    surface = Color(0xFFFFFFFF),
    surfaceVariant = Color(0xFFF1F1F3),
    onBackground = Color(0xFF171717),
    onSurface = Color(0xFF171717),
    outline = Color(0xFFD9D9DD),
)

private val DarkColors = darkColorScheme(
    primary = AccentDark,
    background = Color(0xFF121214),
    surface = Color(0xFF1B1B1E),
    surfaceVariant = Color(0xFF232327),
    onBackground = Color(0xFFF2F2F3),
    onSurface = Color(0xFFF2F2F3),
    outline = Color(0xFF3A3A40),
)

@Composable
fun ScreenMeshTheme(content: @Composable () -> Unit) {
    val colors = if (isSystemInDarkTheme()) DarkColors else LightColors
    MaterialTheme(colorScheme = colors, content = content)
}
