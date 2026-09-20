import { describe, expect, it } from 'vitest'
import { mapGhosttyToKingu } from './mapper'

describe('mapGhosttyToKingu — split-divider-color', () => {
  it('maps valid hex to both dark and light divider colors', () => {
    const result = mapGhosttyToKingu({ 'split-divider-color': '#ff5500' })
    expect(result.diff).toEqual({
      terminalDividerColorDark: '#ff5500',
      terminalDividerColorLight: '#ff5500'
    })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps hex without hash to both divider colors', () => {
    const result = mapGhosttyToKingu({ 'split-divider-color': 'ff5500' })
    expect(result.diff).toEqual({
      terminalDividerColorDark: '#ff5500',
      terminalDividerColorLight: '#ff5500'
    })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rejects invalid split-divider-color', () => {
    const result = mapGhosttyToKingu({ 'split-divider-color': 'blue' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['split-divider-color'])
  })
})

describe('mapGhosttyToKingu — unfocused-split-opacity', () => {
  it('maps valid float to terminalInactivePaneOpacity', () => {
    const result = mapGhosttyToKingu({ 'unfocused-split-opacity': '0.5' })
    expect(result.diff).toEqual({ terminalInactivePaneOpacity: 0.5 })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rejects out-of-range unfocused-split-opacity', () => {
    const result = mapGhosttyToKingu({ 'unfocused-split-opacity': '1.2' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['unfocused-split-opacity'])
  })

  it('rejects negative unfocused-split-opacity', () => {
    const result = mapGhosttyToKingu({ 'unfocused-split-opacity': '-0.1' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['unfocused-split-opacity'])
  })
})

describe('mapGhosttyToKingu — scrollback-limit', () => {
  // Why: Ghostty's scrollback-limit is a byte budget (where 0 means unlimited),
  // while xterm's scrollback is a row count (where 0 means disabled). The
  // units and sentinel values don't line up, so we treat the key as
  // unsupported rather than silently mis-applying it by orders of magnitude.
  it('marks scrollback-limit as unsupported', () => {
    const result = mapGhosttyToKingu({ 'scrollback-limit': '50000' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['scrollback-limit'])
  })
})

describe('mapGhosttyToKingu — window-padding', () => {
  it('maps window-padding-x to terminalPaddingX', () => {
    const result = mapGhosttyToKingu({ 'window-padding-x': '8' })
    expect(result.diff).toEqual({ terminalPaddingX: 8 })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps window-padding-y to terminalPaddingY', () => {
    const result = mapGhosttyToKingu({ 'window-padding-y': '4' })
    expect(result.diff).toEqual({ terminalPaddingY: 4 })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rejects invalid window-padding-x', () => {
    const result = mapGhosttyToKingu({ 'window-padding-x': 'wide' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['window-padding-x'])
  })

  it('averages a dual-value window-padding-y', () => {
    const result = mapGhosttyToKingu({ 'window-padding-y': '10,8' })
    expect(result.diff).toEqual({ terminalPaddingY: 9 })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('averages a dual-value window-padding-x with surrounding whitespace', () => {
    const result = mapGhosttyToKingu({ 'window-padding-x': '16, 12' })
    expect(result.diff).toEqual({ terminalPaddingX: 14 })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('preserves odd-sum dual-value padding as a fractional average', () => {
    const result = mapGhosttyToKingu({ 'window-padding-x': '1,2' })
    expect(result.diff).toEqual({ terminalPaddingX: 1.5 })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rejects a dual-value padding with an invalid half', () => {
    const result = mapGhosttyToKingu({ 'window-padding-y': '10,wide' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['window-padding-y'])
  })

  it('rejects a dual-value padding with an out-of-range half', () => {
    const result = mapGhosttyToKingu({ 'window-padding-y': '10,600' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['window-padding-y'])
  })

  it('rejects paddings with more than two values', () => {
    const result = mapGhosttyToKingu({ 'window-padding-y': '10,8,6' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['window-padding-y'])
  })
})

describe('mapGhosttyToKingu — adjust-cell-height', () => {
  it('maps a percentage to terminalLineHeight', () => {
    const result = mapGhosttyToKingu({ 'adjust-cell-height': '35%' })
    expect(result.diff).toEqual({ terminalLineHeight: 1.35 })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rounds the mapped line height to two decimals', () => {
    const result = mapGhosttyToKingu({ 'adjust-cell-height': '33%' })
    expect(result.diff).toEqual({ terminalLineHeight: 1.33 })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rounds half-boundary decimal percentages to the nearest hundredth', () => {
    const result = mapGhosttyToKingu({ 'adjust-cell-height': '0.5%' })
    expect(result.diff).toEqual({ terminalLineHeight: 1.01 })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rounds higher half-boundary decimal percentages to the nearest hundredth', () => {
    const result = mapGhosttyToKingu({ 'adjust-cell-height': '1.5%' })
    expect(result.diff).toEqual({ terminalLineHeight: 1.02 })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rounds high half-boundary decimal percentages without floating-point drift', () => {
    const result = mapGhosttyToKingu({ 'adjust-cell-height': '101.5%' })
    expect(result.diff).toEqual({ terminalLineHeight: 2.02 })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('accepts the inclusive 1x line-height floor', () => {
    const result = mapGhosttyToKingu({ 'adjust-cell-height': '0%' })
    expect(result.diff).toEqual({ terminalLineHeight: 1 })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('accepts the inclusive 3x line-height ceiling', () => {
    const result = mapGhosttyToKingu({ 'adjust-cell-height': '200%' })
    expect(result.diff).toEqual({ terminalLineHeight: 3 })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rejects a pixel value (not convertible to a line-height ratio)', () => {
    const result = mapGhosttyToKingu({ 'adjust-cell-height': '2' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['adjust-cell-height'])
  })

  it('rejects a negative percentage (below the 1x line-height floor)', () => {
    const result = mapGhosttyToKingu({ 'adjust-cell-height': '-10%' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['adjust-cell-height'])
  })

  it('rejects a percentage above the 3x line-height ceiling', () => {
    const result = mapGhosttyToKingu({ 'adjust-cell-height': '250%' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['adjust-cell-height'])
  })

  it('rejects values that only fall inside the ceiling after rounding', () => {
    const result = mapGhosttyToKingu({ 'adjust-cell-height': '200.4%' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['adjust-cell-height'])
  })
})

describe('mapGhosttyToKingu — cursor-text', () => {
  it('maps valid hex to terminalColorOverrides.cursorAccent', () => {
    const result = mapGhosttyToKingu({ 'cursor-text': '#ffffff' })
    expect(result.diff).toEqual({
      terminalColorOverrides: { cursorAccent: '#ffffff' }
    })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rejects invalid cursor-text', () => {
    const result = mapGhosttyToKingu({ 'cursor-text': 'white' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['cursor-text'])
  })
})

describe('mapGhosttyToKingu — bold-color', () => {
  // Why: xterm.js ITheme has no bold color slot (xtermjs/xterm.js#6032), so bold-color can never
  // render; the importer must list it as unsupported rather than claim it was applied (#8595).
  it('reports valid bold-color as unsupported and does not apply it', () => {
    const result = mapGhosttyToKingu({ 'bold-color': '#ff0000' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['bold-color'])
  })

  it('reports invalid bold-color as unsupported', () => {
    const result = mapGhosttyToKingu({ 'bold-color': 'red' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['bold-color'])
  })
})

describe('mapGhosttyToKingu — mouse-hide-while-typing', () => {
  it('maps true to terminalMouseHideWhileTyping', () => {
    const result = mapGhosttyToKingu({ 'mouse-hide-while-typing': 'true' })
    expect(result.diff).toEqual({ terminalMouseHideWhileTyping: true })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps false to terminalMouseHideWhileTyping', () => {
    const result = mapGhosttyToKingu({ 'mouse-hide-while-typing': 'false' })
    expect(result.diff).toEqual({ terminalMouseHideWhileTyping: false })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rejects invalid mouse-hide-while-typing', () => {
    const result = mapGhosttyToKingu({ 'mouse-hide-while-typing': 'yes' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['mouse-hide-while-typing'])
  })
})

describe('mapGhosttyToKingu — selection-word-chars', () => {
  it('treats selection-word-chars as unsupported due to semantic inversion', () => {
    const result = mapGhosttyToKingu({ 'selection-word-chars': ':/?#@' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['selection-word-chars'])
  })
})

describe('mapGhosttyToKingu — cursor-opacity', () => {
  it('maps valid float to terminalCursorOpacity', () => {
    const result = mapGhosttyToKingu({ 'cursor-opacity': '0.75' })
    expect(result.diff).toEqual({ terminalCursorOpacity: 0.75 })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rejects out-of-range cursor-opacity', () => {
    const result = mapGhosttyToKingu({ 'cursor-opacity': '1.5' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['cursor-opacity'])
  })

  it('rejects negative cursor-opacity', () => {
    const result = mapGhosttyToKingu({ 'cursor-opacity': '-0.1' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['cursor-opacity'])
  })
})

describe('mapGhosttyToKingu — empty values', () => {
  it('rejects empty background-opacity', () => {
    const result = mapGhosttyToKingu({ 'background-opacity': '' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['background-opacity'])
  })

  it('rejects empty cursor-opacity', () => {
    const result = mapGhosttyToKingu({ 'cursor-opacity': '' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['cursor-opacity'])
  })

  it('rejects empty unfocused-split-opacity', () => {
    const result = mapGhosttyToKingu({ 'unfocused-split-opacity': '' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['unfocused-split-opacity'])
  })
})

describe('mapGhosttyToKingu — negative padding', () => {
  it('rejects negative window-padding-x', () => {
    const result = mapGhosttyToKingu({ 'window-padding-x': '-4' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['window-padding-x'])
  })

  it('rejects negative window-padding-y', () => {
    const result = mapGhosttyToKingu({ 'window-padding-y': '-2' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['window-padding-y'])
  })
})
