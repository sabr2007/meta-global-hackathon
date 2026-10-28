import SwiftUI
import AVFoundation

struct CaptureReadinessError: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

enum CaptureReadiness {
  static let reserve: Int64 = 500_000_000
  static let pauseReserve: Int64 = 200_000_000
  static func available(at url: URL) -> Int64? {
    try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage
  }
  static func requireStorage(at url: URL, bytes: Int64 = reserve) throws {
    try checkStorage(available: available(at: url), required: bytes)
  }
  static func checkStorage(available: Int64?, required: Int64) throws {
    if let available, available < required {
      throw CaptureReadinessError(message: "Not enough storage. Free at least \(ByteCountFormatter.string(fromByteCount: required, countStyle: .file)) on this device, then try again. Saved scans are kept.")
    }
  }
  @MainActor static func prepare() async throws {
    guard CaptureController.isSupported else {
      throw CaptureReadinessError(message: "Scanning needs a LiDAR-equipped iPhone Pro or iPad Pro. You can import, view and share existing scans on this device.")
    }
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized: break
    case .notDetermined:
      guard await AVCaptureDevice.requestAccess(for: .video) else {
        throw CaptureReadinessError(message: "Camera access is off. Enable Camera for Ayna in Settings, then try scanning again.")
      }
    case .denied:
      throw CaptureReadinessError(message: "Camera access is off. Enable Camera for Ayna in Settings, then try scanning again.")
    case .restricted:
      throw CaptureReadinessError(message: "Camera access is restricted on this device. Check Screen Time or device-management restrictions. You can still import and view scans.")
    @unknown default:
      throw CaptureReadinessError(message: "Camera access is unavailable. You can still import and view scans.")
    }
    let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    try requireStorage(at: docs)
  }
}

struct HelpDocument: Decodable {
  struct Section: Decodable, Identifiable {
    let title: String
    let body: String
    var id: String { title }
  }
  let title: String
  let updated: String
  let sections: [Section]
  static func load(_ name: String) -> HelpDocument? {
    guard let url = Bundle.main.url(forResource: name, withExtension: "json"), let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(Self.self, from: data)
  }
}

struct HelpDocumentView: View {
  let resource: String
  var body: some View {
    ScrollView {
      if let document = HelpDocument.load(resource) {
        VStack(alignment: .leading, spacing: 24) {
          Text(document.title).font(.largeTitle.bold())
          FieldworkEyebrow(text: "Updated \(document.updated)")
          ForEach(document.sections) { section in
            VStack(alignment: .leading, spacing: 8) {
              Text(section.title).font(.headline)
              Text(section.body).foregroundStyle(Fieldwork.secondary).textSelection(.enabled)
            }
          }
        }.padding(24).frame(maxWidth: 680, alignment: .leading).frame(maxWidth: .infinity)
      } else {
        ContentUnavailableView("Help is unavailable", systemImage: "doc.text", description: Text("Please reinstall the app update to restore its bundled help."))
      }
    }.background(Fieldwork.paper).foregroundStyle(Fieldwork.ink)
  }
}

struct AppHelpScreen: View {
  var body: some View {
    List {
      Section("Ayna") {
        NavigationLink("Scanning & sharing") { HelpDocumentView(resource: "Support") }
        NavigationLink("Privacy") { HelpDocumentView(resource: "PrivacyPolicy") }
      }
      Section("Permissions") {
        Text("The camera is used only while scanning. Opening and sharing saved mirrors does not require camera access.")
        Button("Open app settings") {
          if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        }
      }
      Section("About") {
        Text("Version \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0") (\(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1"))")
        Text("Scans are approximate. Verify measurements before construction or other precision work.").font(.footnote)
      }
    }
    .scrollContentBackground(.hidden).background(Fieldwork.paper)
    .navigationTitle("Help & privacy").navigationBarTitleDisplayMode(.inline)
  }
}
