import CoreAudio
import Foundation

enum DeviceKind: String, Codable {
    case input
    case output
}

struct DeviceInfo: Codable {
    let id: String
    let name: String
    let kind: DeviceKind
    let isDefault: Bool
}

/// `device-enumerate` payload: `{"devices":[{"id","name","kind","isDefault"}]}`.
struct DeviceList: Codable {
    let devices: [DeviceInfo]

    func jsonLine() throws -> Data {
        var line = try JSONEncoder().encode(self)
        line.append(0x0A)
        return line
    }
}

enum DeviceEnumerator {
    /// A device that carries both input and output streams appears once per
    /// direction so each entry has a single, honest `kind` and default flag.
    static func enumerate() throws -> DeviceList {
        let defaultInput = CoreAudioDevices.defaultDeviceID(kAudioHardwarePropertyDefaultInputDevice)
        let defaultOutput = CoreAudioDevices.defaultDeviceID(kAudioHardwarePropertyDefaultOutputDevice)
        var devices: [DeviceInfo] = []

        for deviceID in CoreAudioDevices.allDeviceIDs() {
            let id = CoreAudioDevices.uid(deviceID) ?? String(deviceID)
            let name = CoreAudioDevices.name(deviceID) ?? "unknown device"
            if CoreAudioDevices.hasStreams(deviceID, scope: kAudioObjectPropertyScopeInput) {
                devices.append(DeviceInfo(id: id, name: name, kind: .input, isDefault: deviceID == defaultInput))
            }
            if CoreAudioDevices.hasStreams(deviceID, scope: kAudioObjectPropertyScopeOutput) {
                devices.append(DeviceInfo(id: id, name: name, kind: .output, isDefault: deviceID == defaultOutput))
            }
        }

        return DeviceList(devices: devices)
    }
}
