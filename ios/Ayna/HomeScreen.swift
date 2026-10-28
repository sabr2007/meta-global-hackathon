import AVFoundation
import SwiftUI

/// Home: the logo, the lime New scan card and the mirrors scanned so far.
/// New scan → Scan → Hero shot → Review (MirrorScreen) → Share .zip.
struct HomeView: View {
  @State private var mirrors: [MirrorLibrary.Mirror] = []
  @State private var folders: [String: URL] = [:]
  @State private var summaries: [String: MirrorLibrary.Summary] = [:]
  @State private var path: [MirrorLibrary.Mirror] = []
  @State private var capture: CaptureController?
  /// session of a scan that finished; its review opens once the capture cover is gone
  @State private var finished: String?
  @State private var working = false
  @State private var error: String?
  @State private var deleting: MirrorLibrary.Mirror?

  var body: some View {
    NavigationStack(path: $path) {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          header
          newScanCard
          if !CaptureController.isSupported {
            Text("Scanning needs an iPhone with LiDAR. Mirrors already on this device can still be opened and shared.")
              .font(.footnote).foregroundStyle(AynaTheme.secondary)
          }
          mirrorList
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 32)
      }
      .background(AynaTheme.background.ignoresSafeArea())
      .foregroundStyle(AynaTheme.text)
      .disabled(working)
      .overlay {
        if working {
          ProgressView("Starting the camera…")
            .padding(24)
            .background(AynaTheme.surface, in: RoundedRectangle(cornerRadius: AynaTheme.cardRadius, style: .continuous))
        }
      }
      .navigationTitle("")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          NavigationLink { AppHelpScreen() } label: {
            Image(systemName: "info.circle").frame(width: 44, height: 44)
          }
          .accessibilityLabel("About Ayna")
        }
      }
      .toolbarBackground(AynaTheme.background, for: .navigationBar)
      .toolbarBackground(.visible, for: .navigationBar)
      .navigationDestination(for: MirrorLibrary.Mirror.self) { mirror in
        MirrorScreen(mirror: mirror, onChange: reload, onDeleted: {
          path.removeAll()
          reload()
        })
      }
      .onAppear(perform: reload)
      .alert("Something went wrong", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
        Button("OK") { error = nil }
        if AVCaptureDevice.authorizationStatus(for: .video) == .denied {
          Button("Open Settings") {
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
          }
        }
      } message: {
        Text(error ?? "")
      }
      .confirmationDialog("Delete \(deleting?.name ?? "mirror")?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
        Button("Delete mirror", role: .destructive) {
          if let mirror = deleting {
            do { try MirrorLibrary.delete(mirror) } catch { self.error = error.localizedDescription }
          }
          deleting = nil
          reload()
        }
      } message: {
        Text("Its photos, mesh and depth are removed from this iPhone. Copies you shared are not affected.")
      }
      .fullScreenCover(item: $capture, onDismiss: captureClosed) { controller in
        CaptureScreen(controller: controller) {
          finished = controller.phase == .done ? controller.plan.sessionID : nil
          capture = nil
        }
      }
    }
    .tint(AynaTheme.lime)
    .preferredColorScheme(.dark)
  }

  // MARK: sections

  private var header: some View {
    VStack(alignment: .leading, spacing: 12) {
      AynaLogo(size: 38)
      Text("Show your robot the after.")
        .font(.title3)
        .foregroundStyle(AynaTheme.secondary)
      CircleCluster()
        .frame(height: 96)
        .padding(.top, 6)
    }
    .padding(.top, 4)
  }

  private var newScanCard: some View {
    Button(action: startScan) {
      VStack(alignment: .leading, spacing: 14) {
        HStack(alignment: .top) {
          Text("New scan")
            .font(.michroma(22, relativeTo: .title2))
            .textCase(.uppercase)
          Spacer(minLength: 12)
          Image(systemName: "arrow.up.right")
            .font(.title3.weight(.semibold))
            .frame(width: 44, height: 44)
            .background(AynaTheme.onLime.opacity(0.12), in: Circle())
        }
        Text("Walk around a table. Ayna records its physical mirror, then asks for one hero shot.")
          .font(.subheadline)
          .multilineTextAlignment(.leading)
          .fixedSize(horizontal: false, vertical: true)
        CircleCluster(fill: AynaTheme.lime, stroke: AynaTheme.onLime, accent: AynaTheme.onLime, lineWidth: 1.5)
          .frame(height: 46)
      }
      .foregroundStyle(AynaTheme.onLime)
      .padding(20)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(AynaTheme.lime, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
      .contentShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
    }
    .buttonStyle(.plain)
    .disabled(!CaptureController.isSupported)
    .opacity(CaptureController.isSupported ? 1 : 0.4)
    .accessibilityLabel("New scan")
    .accessibilityHint("Starts the camera to scan a table")
  }

  @ViewBuilder private var mirrorList: some View {
    AynaEyebrow(text: mirrors.isEmpty ? "No mirrors yet" : "Your mirrors · \(mirrors.count)")
      .padding(.top, 10)
    if mirrors.isEmpty {
      Text("Every scan becomes a mirror: a physical twin of the table with its hero shot, ready to share.")
        .font(.subheadline)
        .foregroundStyle(AynaTheme.secondary)
        .aynaCard()
    }
    ForEach(mirrors) { mirror in
      NavigationLink(value: mirror) {
        MirrorRow(mirror: mirror, folder: folders[mirror.id], summary: summaries[mirror.id])
      }
      .buttonStyle(.plain)
      .contextMenu {
        Button("Delete mirror", systemImage: "trash", role: .destructive) { deleting = mirror }
      }
    }
  }

  // MARK: actions

  private func reload() {
    do {
      if capture == nil { try? MirrorLibrary.removeAbandonedScans() }
      let house = try MirrorLibrary.house()
      let list = MirrorLibrary.mirrors(in: house)
      var bundles: [String: ScanBundle] = [:]
      for mirror in list { bundles[mirror.id] = MirrorLibrary.bundle(of: mirror, in: house) }
      mirrors = list
      folders = bundles.mapValues(\.url)
      let snapshot = bundles
      let indices = Dictionary(list.map { ($0.id, $0.index) }, uniquingKeysWith: { first, _ in first })
      Task {
        let loaded = await Task.detached(priority: .utility) { () -> [String: MirrorLibrary.Summary] in
          var out: [String: MirrorLibrary.Summary] = [:]
          for (id, bundle) in snapshot { out[id] = MirrorLibrary.summary(of: bundle, index: indices[id] ?? 0) }
          return out
        }.value
        summaries = loaded
      }
    } catch {
      self.error = error.localizedDescription
    }
  }

  private func startScan() {
    guard !working, capture == nil else { return }
    working = true
    Task {
      defer { working = false }
      do {
        try await CaptureReadiness.prepare()
        capture = try MirrorLibrary.startScan()
      } catch {
        self.error = error.localizedDescription
      }
    }
  }

  private func captureClosed() {
    reload()
    if let id = finished, let mirror = mirrors.first(where: { $0.session == id }) {
      path = [mirror]
    }
    finished = nil
  }
}

/// One mirror in the list: its clay thumbnail, name, date and photo detail
private struct MirrorRow: View {
  let mirror: MirrorLibrary.Mirror
  let folder: URL?
  let summary: MirrorLibrary.Summary?

  var body: some View {
    HStack(spacing: 14) {
      MirrorThumbnail(folder: folder, index: mirror.index)
        .frame(width: 84, height: 84)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
      VStack(alignment: .leading, spacing: 6) {
        Text(mirror.name)
          .font(.michroma(15, relativeTo: .headline))
          .lineLimit(1)
        Text(mirror.capturedAt.formatted(date: .abbreviated, time: .shortened))
          .font(.caption)
          .foregroundStyle(AynaTheme.secondary)
        HStack(spacing: 6) {
          StatusDot(color: AynaTheme.detailColor(summary?.photoDetail))
          Text("photo detail").font(.caption).foregroundStyle(AynaTheme.secondary)
        }
      }
      Spacer(minLength: 0)
      Text(summary?.photoDetail.map { "\($0)%" } ?? "—")
        .font(.doto(24, relativeTo: .title2))
        .foregroundStyle(AynaTheme.detailColor(summary?.photoDetail))
    }
    .aynaCard(padding: 12)
    .contentShape(RoundedRectangle(cornerRadius: AynaTheme.cardRadius, style: .continuous))
    .accessibilityElement(children: .combine)
  }
}
