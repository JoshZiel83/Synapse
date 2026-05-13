// Utility to safely call Wails-bound Go methods.
// On Windows (WebView2), the JS-Go bridge may not be ready immediately on page load.

declare const window: any

/** Wait until window.go.main.App is available (max ~5s) */
export async function waitForWails(): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    if (window.go?.main?.App) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

/** Call a Wails method with a timeout (default 15s) */
export async function callGo<T>(method: string, ...args: any[]): Promise<T> {
  if (!window.go?.main?.App?.[method]) {
    const ready = await waitForWails()
    if (!ready || !window.go?.main?.App?.[method]) {
      throw new Error(`Wails method ${method} not available`)
    }
  }
  return Promise.race([
    window.go.main.App[method](...args) as Promise<T>,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${method} timed out`)), 15000)
    ),
  ])
}
