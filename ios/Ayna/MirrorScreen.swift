import SwiftUI

/// Review of one mirror: its 3D preview, what was recorded, sending it to Ayna and sharing the
/// bundle.
struct MirrorScreen: View {
  let mirror: MirrorLibrary.Mirror
  /// renamed: the list should reload
  var onChange: () -> Void = {}
  var onDeleted: () -> Void = {}

  @ObservedObject private var ayna: AynaUploader
  @State private var name: String
  @State private var source: PreviewSource?
  @State private var bundle: ScanBundle?
  @State private var summary: MirrorLibrary.Summary?
  @State private var loaded = false
  @State private var sharing: URL?
  @State private var zipping = false
  @State private var error: String?
  @State private var renaming = false
  @State private var newName = ""
  @State private var deleting = false
  @State private var pairingSheet: PairingIntent?

  /// Why the pairing sheet is open: to manage the pairing, or for a send that waits for it
  private enum PairingIntent: Identifiable {
    case manage, send
    var id: Self { self }
  }

  init(mirror: MirrorLibrary.Mirror, onChange: @escaping () -> Void = {}, onDeleted: @escaping () -> Void = {}) {
    self.mirror = mirror
    self.onChange = onChange
    self.onDeleted = onDeleted
    _ayna = ObservedObject(wrappedValue: AynaUploader.shared)
    _name = State(initialValue: mirror.name)
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        title
        if let source {
          MirrorPreview(source: source).id(mirror.id)
        } else if loaded {
          Text("This mirror's files are missing.").foregroundStyle(AynaTheme.orange).aynaCard()
        }
        metrics
        heroRow
        actions
      }
      .padding(.horizontal, 20)
      .padding(.top, 4)
      .padding(.bottom, 32)
    }
    .background(AynaTheme.background.ignoresSafeArea())
    .foregroundStyle(AynaTheme.text)
    .navigationTitle("")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .principal) { AynaEyebrow(text: "Mirror") }
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          Button("Pairing with Ayna", systemImage: "link") { pairingSheet = .manage }
          Button("Rename mirror", systemImage: "pencil") { newName = name; renaming = true }
          Button("Delete mirror", systemImage: "trash", role: .destructive) { deleting = true }
        } label: {
          Image(systemName: "ellipsis").frame(width: 44, height: 44)
        }
        .accessibilityLabel("Mirror options")
      }
    }
    .toolbarBackground(AynaTheme.background, for: .navigationBar)
    .toolbarBackground(.visible, for: .navigationBar)
    .onAppear(perform: load)
    .sheet(item: $sharing) { ShareSheet(items: [$0]) }
    .sheet(item: $pairingSheet) { intent in
      AynaPairingSheet(uploader: ayna, sendAfter: intent == .send) {
        if intent == .send { retrySend() }
      }
    }
    .onChange(of: needsPairing) { _, needs in
      // the server stopped accepting this iPhone (401) while the mirror was open: ask right away
      if needs && pairingSheet == nil { pairingSheet = .send }
    }
    .alert("Rename mirror", isPresented: $renaming) {
      TextField("Name", text: $newName)
      Button("Save", action: rename)
      Button("Cancel", role: .cancel) {}
    }
    .confirmationDialog("Delete \(name)?", isPresented: $deleting, titleVisibility: .visible) {
      Button("Delete mirror", role: .destructive, action: delete)
    } message: {
      Text("Its photos, mesh and depth are removed from this iPhone. Copies you shared are not affected.")
    }
    .alert("Something went wrong", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
      Button("OK") { error = nil }
    } message: {
      Text(error ?? "")
    }
  }

  // MARK: sections

  private var title: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(name)
        .font(.michroma(26, relativeTo: .largeTitle))
        .lineLimit(2)
        .minimumScaleFactor(0.7)
      Text(mirror.capturedAt.formatted(date: .abbreviated, time: .shortened))
        .font(.subheadline)
        .foregroundStyle(AynaTheme.secondary)
    }
  }

  private var metrics: some View {
    let detail = summary?.photoDetail
    return HStack(alignment: .top, spacing: 8) {
      DotoMetric(value: summary.map { "\($0.photos)" } ?? "—", label: "Photos")
        .frame(maxWidth: .infinity, alignment: .leading)
      DotoMetric(value: summary.map { "\($0.depthFrames)" } ?? "—", label: "Depth frames")
        .frame(maxWidth: .infinity, alignment: .leading)
      DotoMetric(value: detail.map { "\($0)%" } ?? "—", label: "Coverage", tint: AynaTheme.detailColor(detail))
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .aynaCard()
  }

  private var heroRow: some View {
    let hero = summary?.hero
    return HStack(spacing: 14) {
      if let hero {
        UprightPhoto(url: hero, maxPixels: 600)
          .frame(width: 72, height: 96)
          .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
      }
      VStack(alignment: .leading, spacing: 5) {
        HStack(spacing: 6) {
          StatusDot(color: summary == nil ? AynaTheme.secondary : hero == nil ? AynaTheme.orange : AynaTheme.lime)
          Text(hero == nil ? "No hero shot" : "Hero shot").font(.headline)
        }
        Text(hero == nil
             ? "Take one after Done on the next scan: a full view of the work surface, the \"before\" for Muse Image."
             : "The \"before\" for Muse Image: the whole work surface, posed in the same world as the scan.")
          .font(.caption)
          .foregroundStyle(AynaTheme.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 0)
    }
    .aynaCard()
    .accessibilityElement(children: .combine)
  }

  private var actions: some View {
    VStack(alignment: .leading, spacing: 10) {
      SendToAynaCard(state: ayna.state(of: mirror), pairing: ayna.pairing, ready: bundle != nil,
                     onSend: sendToAyna, onRetry: retrySend, onCancel: { ayna.cancel(mirror) },
                     onPairing: { pairingSheet = needsPairing ? .send : .manage })
      Button(action: share) {
        Label(zipping ? "Preparing .zip…" : "Share .zip", systemImage: "square.and.arrow.up")
      }
      .buttonStyle(AynaButtonStyle(kind: .raised))
      .disabled(zipping || bundle == nil)
      .padding(.top, 6)
      Text("Send to Ayna and Share .zip use the same house-capture/5 bundle of this mirror: RoomPlan layout, LiDAR mesh, posed photos (the hero shot is marked \"hero\": true in photos.json) and depth frames.")
        .font(.caption)
        .foregroundStyle(AynaTheme.secondary)
        .padding(.top, 6)
    }
  }

  // MARK: actions

  private func load() {
    guard !loaded else { return }
    loaded = true
    do {
      let house = try MirrorLibrary.house()
      guard let session = house.session(mirror.session) else { return }
      var preview = PreviewSource.session(house, session)
      preview.title = name
      preview.rooms = preview.rooms.filter { $0.index == mirror.index }
      source = preview
      let bundle = house.bundle(for: session)
      self.bundle = bundle
      let index = mirror.index
      Task {
        summary = await Task.detached(priority: .utility) { MirrorLibrary.summary(of: bundle, index: index) }.value
      }
    } catch {
      self.error = error.localizedDescription
    }
  }

  private func share() {
    guard let bundle, !zipping else { return }
    zipping = true
    let index = mirror.index, title = name
    Task {
      let result = await Task.detached(priority: .userInitiated) { Result { try bundle.zippedRoom(index: index, name: title) } }.value
      zipping = false
      switch result {
      case .success(let url): sharing = url
      case .failure(let e): error = e.localizedDescription
      }
    }
  }

  /// The send failed because Ayna no longer accepts this iPhone (or it was never paired)
  private var needsPairing: Bool {
    if case .failed(_, true) = ayna.state(of: mirror) { return true }
    return false
  }

  /// Unpaired: the pairing sheet first, which sends once it has paired
  private func sendToAyna() {
    guard let bundle else { return }
    if ayna.pairing == nil {
      pairingSheet = .send
    } else {
      ayna.send(mirror, bundle: bundle, name: name)
    }
  }

  private func retrySend() {
    if ayna.pairing == nil {
      pairingSheet = .send
    } else {
      ayna.retry(mirror, bundle: bundle, name: name)
    }
  }

  private func rename() {
    let clean = newName.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !clean.isEmpty, clean != name else { return }
    do {
      try MirrorLibrary.rename(mirror, to: clean)
      name = clean
      onChange()
    } catch {
      self.error = error.localizedDescription
    }
  }

  private func delete() {
    do {
      try MirrorLibrary.delete(mirror)
      onDeleted()
    } catch {
      self.error = error.localizedDescription
    }
  }
}

/// The mirror's LiDAR mesh in 3D, coloured from its photos once the preview has baked them
/// (that also writes mesh/room-N-colors.bin, which the share .zip includes)
private struct MirrorPreview: View {
  @StateObject private var model: PreviewModel
  @State private var expanded = false

  init(source: PreviewSource) { _model = StateObject(wrappedValue: PreviewModel(source: source)) }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ZStack {
        if !expanded { PreviewSceneView(scene: model.scene) }
        switch model.phase {
        case .loading:
          ProgressView(model.loadStage)
            .font(.caption)
            .tint(AynaTheme.neutral)
            .padding()
            .background(AynaTheme.surface.opacity(0.95), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        case .empty(let message):
          ContentUnavailableView("No preview yet", systemImage: "cube.transparent", description: Text(message))
        case .ready:
          EmptyView()
        }
      }
      .frame(height: 300)
      .frame(maxWidth: .infinity)
      .clipShape(RoundedRectangle(cornerRadius: AynaTheme.cardRadius, style: .continuous))
      .overlay(alignment: .topTrailing) {
        Button {
          model.scene.scene.background.contents = AynaTheme.uiBackground
          model.scene.view.backgroundColor = AynaTheme.uiBackground
          expanded = true
        } label: {
          Image(systemName: "arrow.up.left.and.arrow.down.right")
            .font(.system(size: 15, weight: .semibold))
            .frame(width: 44, height: 44)
            .background(AynaTheme.raised.opacity(0.9), in: Circle())
        }
        .foregroundStyle(AynaTheme.text)
        .padding(10)
        .accessibilityLabel("Open full screen viewer")
      }
      HStack(spacing: 6) {
        if let f = model.bakeFraction {
          StatusDot(color: AynaTheme.orange)
          Text("\(model.bakeLabel) · \(Int(f * 100))%").monospacedDigit()
        } else if model.phase == .ready {
          StatusDot(color: model.bakeNote == nil ? AynaTheme.lime : AynaTheme.orange)
          Text(model.bakeNote ?? "Drag to rotate · pinch to zoom")
        }
      }
      .font(.caption)
      .foregroundStyle(AynaTheme.secondary)
    }
    .onAppear {
      surfaceBackground()
      model.start()
    }
    .onDisappear { if !expanded { model.cancelBake() } }
    .fullScreenCover(isPresented: $expanded, onDismiss: surfaceBackground) { PreviewScreen(model: model) }
  }

  private func surfaceBackground() {
    model.scene.scene.background.contents = AynaTheme.uiSurface
    model.scene.view.backgroundColor = AynaTheme.uiSurface
  }
}
