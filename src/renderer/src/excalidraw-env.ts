// Must run before the Excalidraw chunk loads: the library reads this when it resolves fonts.
// Fonts are self-hosted (scripts/copy-excalidraw-assets.mjs) so drawing works offline and under our CSP.
// An absolute URL is needed: under file:// a relative path would resolve against an opaque origin.
;(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = new URL('./excalidraw-assets/', document.baseURI).href
