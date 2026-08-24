/**
 * The parts of the webOS TV API this app actually touches.
 *
 * `webOSTV.js` installs a much larger surface than this, but declaring all of
 * it would be a guess: the fields below are the ones the client reads, and
 * every one of them is marked optional exactly where the platform genuinely
 * leaves it out. This file has no imports, so its declarations are global and
 * `window.webOS` is typed everywhere without an import.
 */

/** Fields of the device record that survive across firmware versions. */
interface WebOsDeviceInfo {
  readonly modelName?: string;
  readonly version?: string;
  readonly sdkVersion?: string;
  readonly screenWidth?: number;
  readonly screenHeight?: number;
}

/** What `storage.get` hands back. Older firmware calls back with null instead. */
interface WebOsStorageResult {
  readonly value?: string;
}

/**
 * The key/value store, present only on some firmware versions, which is why
 * `createServerAddressStore` always keeps a localStorage copy as well.
 */
interface WebOsStorageApi {
  readonly get: (
    key: string,
    onSuccess: (result: WebOsStorageResult | null) => void,
    onError?: (error: unknown) => void,
  ) => void;
  readonly set: (
    key: string,
    value: string,
    onSuccess: (result: unknown) => void,
    onError?: (error: unknown) => void,
  ) => void;
  readonly remove: (
    key: string,
    onSuccess: (result: unknown) => void,
    onError?: (error: unknown) => void,
  ) => void;
}

interface WebOsApi {
  /** Asynchronous even though nothing about it is: the platform decided that. */
  readonly deviceInfo: (callback: (info: WebOsDeviceInfo) => void) => void;
  /** Hands control back to whatever launched the app, which usually exits it. */
  readonly platformBack: () => void;
  readonly storage?: WebOsStorageApi;
}

interface Window {
  /** Installed by webOSTV.js; absent when the page runs in a normal browser. */
  readonly webOS?: WebOsApi;
}
