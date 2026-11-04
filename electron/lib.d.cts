/* Types for electron/lib.cjs (used by the Vitest suite). */

export interface SerialPortInfo {
  portId: string
  portName: string
  displayName?: string
  vendorId?: string
  productId?: string
}

export interface BluetoothDeviceInfo {
  deviceId: string
  deviceName: string
}

export interface Chooser {
  readonly buttons: readonly string[]
  readonly ids: readonly string[]
  readonly cancelId: number
  readonly hidden: number
}

export interface ScanTiming {
  settleMs: number
  maxMs: number
}

export interface ScanState {
  readonly phase: 'idle' | 'scanning' | 'prompting'
  readonly startedAt: number
  readonly devices: readonly BluetoothDeviceInfo[]
}

export type ScanEvent =
  | { type: 'devices'; devices: readonly BluetoothDeviceInfo[]; now: number }
  | { type: 'tick'; now: number }
  | { type: 'done' }

export interface ScanStep {
  state: ScanState
  effect: 'wait' | 'prompt' | 'none'
  delayMs: number
}

export interface PairingDetails {
  deviceId: string
  pairingKind: 'confirm' | 'confirmPin' | 'providePin'
  pin?: string
}

export interface MenuItem {
  role?: string
  label?: string
  type?: string
  submenu?: MenuItem[]
  click?: () => void
}

export declare const LINKS: Readonly<{ project: string; issues: string; releases: string }>
export declare const MIME_TYPES: ReadonlyMap<string, string>
export declare const DEFAULT_MIME: string
export declare const MAX_CHOOSER_ITEMS: number
export declare const SCAN_TIMING: Readonly<ScanTiming>
export declare const SCAN_IDLE: ScanState
export declare const ALLOWED_PERMISSIONS: ReadonlySet<string>

export declare function mimeTypeFor(fileName: string): string
export declare function resolveSafePath(root: string, requestUrl: string, pathImpl?: typeof import('node:path')): string | null
export declare function isLoopbackHostHeader(host: string | undefined): boolean
export declare function sameOrigin(a: string | undefined, b: string | undefined): boolean
export declare function isExternalHttpsUrl(url: string): boolean
export declare function isPermissionAllowed(permission: string, requestingUrl: string | undefined, appUrl: string): boolean
export declare function serialPortLabel(port: SerialPortInfo): string
export declare function bluetoothDeviceLabel(device: BluetoothDeviceInfo): string
export declare function orderBluetoothDevices(devices: readonly BluetoothDeviceInfo[]): BluetoothDeviceInfo[]
export declare function buildChooser<T>(items: readonly T[], toLabel: (item: T) => string, toId: (item: T) => string, max?: number): Chooser
export declare function chosenId(chooser: Chooser, response: number): string
export declare function once<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => boolean
export declare function bluetoothScanStep(state: ScanState, event: ScanEvent, timing?: ScanTiming): ScanStep
export declare function pairingPrompt(details: PairingDetails): { message: string; detail: string } | null
export declare function aboutDetail(versions: { electron?: string; chrome?: string; node?: string }): string
export declare function menuTemplate(options: { isMac: boolean; openUrl: (url: string) => void; showAbout: () => void }): MenuItem[]
