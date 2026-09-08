import { describe, expect, it } from 'bun:test'
import {
  breakpointMediaQuery,
  breakpointViewport,
  defaultBreakpointViewportHeight,
  parseBreakpoint,
} from '@core/page-tree'

describe('parseBreakpoint', () => {
  it('defaults the media query from width for existing breakpoint records', () => {
    const breakpoint = parseBreakpoint({
      id: 'tablet',
      label: 'Tablet',
      width: 768,
      icon: 'tablet',
    })

    expect(breakpoint).not.toBeNull()
    expect(breakpoint!.mediaQuery).toBe('(max-width: 768px)')
    expect(breakpointMediaQuery(breakpoint!)).toBe('(max-width: 768px)')
  })

  it('preserves an explicit mobile-first media query', () => {
    const breakpoint = parseBreakpoint({
      id: 'tablet',
      label: 'Tablet',
      width: 768,
      icon: 'tablet',
      mediaQuery: '(min-width: 768px)',
    })

    expect(breakpoint).not.toBeNull()
    expect(breakpointMediaQuery(breakpoint!)).toBe('(min-width: 768px)')
  })

  it('keeps an explicit height and drops non-numeric ones', () => {
    const withHeight = parseBreakpoint({
      id: 'mobile', label: 'Mobile', width: 375, height: 812, icon: 'smartphone',
    })
    expect(withHeight!.height).toBe(812)

    const withoutHeight = parseBreakpoint({
      id: 'mobile', label: 'Mobile', width: 375, icon: 'smartphone',
    })
    expect(withoutHeight!.height).toBeUndefined()

    const badHeight = parseBreakpoint({
      id: 'mobile', label: 'Mobile', width: 375, height: 'tall', icon: 'smartphone',
    })
    expect(badHeight!.height).toBeUndefined()
  })
})

describe('breakpointViewport', () => {
  it('uses the declared height when present', () => {
    expect(breakpointViewport({ width: 375, height: 812 })).toEqual({ width: 375, height: 812 })
  })

  it('infers a device-class default from width for legacy breakpoints', () => {
    // Phone-class → classic 2x phone viewport; tablet → portrait iPad;
    // wider keeps the historic 800px canvas height.
    expect(breakpointViewport({ width: 375 })).toEqual({ width: 375, height: 667 })
    expect(breakpointViewport({ width: 768 })).toEqual({ width: 768, height: 1024 })
    expect(breakpointViewport({ width: 1440 })).toEqual({ width: 1440, height: 800 })
    expect(defaultBreakpointViewportHeight(480)).toBe(667)
    expect(defaultBreakpointViewportHeight(1024)).toBe(1024)
    expect(defaultBreakpointViewportHeight(1025)).toBe(800)
  })
})
