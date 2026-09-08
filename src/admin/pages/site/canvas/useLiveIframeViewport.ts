/**
 * Tracks the live frame iframe's on-screen viewport size.
 *
 * Live frames are the one canvas iframe whose height does NOT track content —
 * the iframe is its own scroll viewport sized by the live surface. That makes
 * it safe (no grow-to-content feedback loop) and *correct* to resolve authored
 * viewport units (`vh`, `vmin`, …) against the frame's real measured size, so
 * `100vh` heroes preview at the height a visitor would actually see. Design
 * frames instead resolve units against the breakpoint's declared viewport
 * (`breakpointViewport`) — see IframeFrameSurface.
 *
 * While `enabled` is false the observer is detached and the last measured
 * value (if any) is kept; the caller gates reads behind the same flag, so a
 * stale design-frame-era value is never consumed.
 */
import { useEffect, useState } from 'react'
import type { CanvasViewport } from './resolveViewportUnits'

export function useLiveIframeViewport(
  iframeRef: { current: HTMLIFrameElement | null },
  enabled: boolean,
): CanvasViewport | null {
  const [viewport, setViewport] = useState<CanvasViewport | null>(null)

  useEffect(() => {
    if (!enabled) return
    const iframe = iframeRef.current
    if (!iframe || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      const width = iframe.clientWidth
      const height = iframe.clientHeight
      setViewport((prev) =>
        prev && prev.width === width && prev.height === height ? prev : { width, height },
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(iframe)
    return () => observer.disconnect()
  }, [iframeRef, enabled])

  return viewport
}
