import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './theme.css'

// Native shell tweaks. Each is wrapped because the same bundle also runs in a
// plain browser during development, where the plugins simply aren't there.
async function nativeSetup() {
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar')
    await StatusBar.setOverlaysWebView({ overlay: true })
    await StatusBar.setStyle({ style: Style.Dark })
  } catch {}
  try {
    const { Keyboard } = await import('@capacitor/keyboard')
    // The WebView must not resize: the film would jump every time someone types.
    await Keyboard.setResizeMode({ mode: 'none' })
    await Keyboard.setAccessoryBarVisible({ isVisible: false })
  } catch {}
}
nativeSetup()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
)
