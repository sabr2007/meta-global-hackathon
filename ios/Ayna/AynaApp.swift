import SwiftUI

@main
struct AynaApp: App {
  @UIApplicationDelegateAdaptor(AynaAppDelegate.self) private var appDelegate

  var body: some Scene {
    WindowGroup {
      #if DEBUG
      let args = ProcessInfo.processInfo.arguments
      if let preview = PreviewDebug.launchView() {
        preview // -preview-house <folder> (see PreviewDebug.swift)
      } else if args.contains("-diag") {
        DiagnosticsView()
      } else if args.contains("-selftest") {
        SelfTestView()
      } else if args.contains("-autotest") || args.contains("-autotest-continue") {
        AutoTestView(continueLatest: args.contains("-autotest-continue"))
      } else {
        HomeView()
      }
      #else
      HomeView()
      #endif
    }
  }
}

/// Send to Ayna uploads in a background URLSession: re-attach it at launch, and keep iOS's
/// completion handler when iOS wakes the app for its events.
final class AynaAppDelegate: NSObject, UIApplicationDelegate {
  func application(_ application: UIApplication,
                   didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    AynaUploader.shared.activate()
    return true
  }

  func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                   completionHandler: @escaping () -> Void) {
    guard identifier == AynaUploader.sessionIdentifier else {
      completionHandler()
      return
    }
    AynaUploader.shared.backgroundEventsDone = completionHandler
    AynaUploader.shared.activate()
  }
}

struct ShareSheet: UIViewControllerRepresentable {
  let items: [Any]
  func makeCoordinator() -> [URL] { items.compactMap { $0 as? URL } }
  static func dismantleUIViewController(_ controller: UIActivityViewController, coordinator: [URL]) {
    for url in coordinator { FolderZipper.removeArchive(url) }
  }
  func makeUIViewController(context: Context) -> UIActivityViewController {
    UIActivityViewController(activityItems: items, applicationActivities: nil)
  }
  func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}

extension URL: @retroactive Identifiable {
  public var id: String { absoluteString }
}

extension CaptureController: Identifiable {}
