import SwiftUI

@main
struct AynaApp: App {
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
