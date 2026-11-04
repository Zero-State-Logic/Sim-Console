import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { generateFirmware } from './index'
import { hwFor, request, swarmSpec, walkerSpec } from './testing/fixtures'
import { zipFiles, zipName } from './zip'

describe('zip download', () => {
  it('packs every generated file under its folder path', () => {
    // Arrange
    const result = generateFirmware(request(swarmSpec(4), hwFor('esp32', 'ws', 'gpio', 4), 'high'))
    // Act
    const unzipped = unzipSync(zipFiles(result.files))
    // Assert
    expect(Object.keys(unzipped).sort()).toEqual(result.files.map((f) => f.path).sort())
    for (const f of result.files) expect(strFromU8(unzipped[f.path])).toBe(f.content)
  })

  it('produces the same bytes for the same files', () => {
    const files = generateFirmware(request(walkerSpec(6), hwFor('esp32', 'serial', 'pca9685', 18), 'joint')).files
    expect(zipFiles(files)).toEqual(zipFiles(files))
  })

  it('names the download after the top folder', () => {
    const mcu = generateFirmware(request(walkerSpec(6), hwFor('esp32', 'serial', 'pca9685', 18), 'joint'))
    const pi = generateFirmware(request(walkerSpec(6), hwFor('pizero2w', 'ws', 'pca9685', 18), 'high'))
    expect(zipName(mcu)).toBe('walker_esp32.zip')
    expect(zipName(pi)).toBe('kiyobridge_pi.zip')
    expect(zipName({ files: [] })).toBe('kiyobridge.zip')
  })
})
