import ARKit
import RoomPlan
import SwiftUI

/// Full-screen scan of one mirror: the camera with the LiDAR mesh drawn over it (orange needs
/// photos, lime is covered), photo detail and the photo count on top, RoomPlan's coaching in the
/// middle, the radar, the shutter and Done at the bottom. Once the room is saved the session
/// finishes by itself and the screen closes; Home then opens the review.
struct CaptureScreen: View {
  @ObservedObject var controller: CaptureController
  /// Ayna's flow: start scanning on appear, finish the session once its room is saved, close
  /// when done. Off for -autotest, which drives the controller itself.
  var autoFlow = true
  let onClose: () -> Void
  @State private var confirmClose = false
  @Environment(\.scenePhase) private var scenePhase

  private var scanning: Bool { controller.phase == .scanning }

  var body: some View {
    ZStack {
      ARViewContainer(view: controller.scanView.view).ignoresSafeArea()
      if scanning {
        // keeps the HUD legible over a bright camera image
        VStack(spacing: 0) {
          LinearGradient(colors: [.black.opacity(0.55), .clear], startPoint: .top, endPoint: .bottom).frame(height: 190)
          Spacer()
          LinearGradient(colors: [.clear, .black.opacity(0.6)], startPoint: .top, endPoint: .bottom).frame(height: 240)
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
      }
      VStack(spacing: 12) {
        topBar
        Spacer(minLength: 0)
        middle
        bottomBar
      }
      .padding(.horizontal, 16)
      .padding(.bottom, 8)
      .animation(.easeInOut(duration: 0.3), value: controller.notice)
    }
    .background(AynaTheme.background)
    .foregroundStyle(AynaTheme.text)
    .tint(AynaTheme.lime)
    .preferredColorScheme(.dark)
    .confirmationDialog("Discard this scan?", isPresented: $confirmClose, titleVisibility: .visible) {
      Button("Discard scan", role: .destructive) {
        controller.abandon()
        onClose()
      }
      Button("Keep scanning", role: .cancel) {}
    } message: {
      Text("The photos, mesh and depth recorded so far are deleted.")
    }
    .onAppear {
      controller.begin()
      guard autoFlow else { return }
      Task {
        try? await Task.sleep(for: .milliseconds(350)) // let the cover finish presenting
        controller.startRoom()
      }
    }
    .onChange(of: controller.phase) { _, next in
      guard autoFlow else { return }
      switch next {
      case .betweenRooms where !controller.rooms.isEmpty:
        Task { await controller.finishSession() } // one room per mirror
      case .done:
        onClose()
      default:
        break
      }
    }
    .onChange(of: controller.quality.ready) { _, ready in
      if ready && scanning { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    }
    .onChange(of: scenePhase) { _, phase in
      // leaving the app interrupts the camera: don't keep counting coverage across the gap
      if phase != .active { controller.pause() }
    }
    .statusBarHidden()
  }

  // MARK: top

  private var topBar: some View {
    ZStack(alignment: .top) {
      HStack(alignment: .top) {
        if canClose {
          Button {
            if controller.phase == .done { onClose() } else { confirmClose = true }
          } label: {
            Image(systemName: "xmark")
              .font(.headline)
              .frame(width: 44, height: 44)
              .background(AynaTheme.surface.opacity(0.85), in: Circle())
          }
          .accessibilityLabel("Close")
        }
        Spacer()
        if scanning {
          VStack(alignment: .trailing, spacing: 4) {
            Text("\(controller.photoCount)")
              .font(.doto(28, fixed: true))
              .contentTransition(.numericText())
              .animation(.easeOut(duration: 0.25), value: controller.photoCount)
            AynaEyebrow(text: "Photos")
          }
          .padding(.top, 4)
          .accessibilityElement(children: .ignore)
          .accessibilityLabel("\(controller.photoCount) photos")
        }
      }
      if scanning {
        VStack(spacing: 2) {
          Text("\(controller.stats.percent)%")
            .font(.doto(58, fixed: true))
            .foregroundStyle(AynaTheme.detailColor(controller.stats.percent))
            .contentTransition(.numericText())
            .animation(.easeOut(duration: 0.3), value: controller.stats.percent)
          AynaEyebrow(text: "Photo detail", color: AynaTheme.neutral)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Photo detail, \(controller.stats.percent) percent of observed surfaces")
      }
    }
    .padding(.top, 6)
  }

  private var canClose: Bool {
    switch controller.phase {
    case .scanning, .relocalizing, .done: true
    case .betweenRooms: controller.rooms.isEmpty
    case .finishingRoom, .finishing, .failed: false
    }
  }

  // MARK: middle

  @ViewBuilder private var middle: some View {
    switch controller.phase {
    case .scanning:
      if let issue = controller.trackingIssue, issue != .starting, issue != .settling {
        recoveryCard(issue)
      } else if controller.paused {
        pausedCard
      } else {
        hints
      }
    case .betweenRooms:
      if controller.rooms.isEmpty { readyCard } else { statusCard("Saving \(controller.roomName)…") }
    case .relocalizing:
      statusCard("Finding your place in the earlier scan…")
    case .finishingRoom:
      statusCard("Saving \(controller.roomName)…")
    case .finishing:
      statusCard(controller.finishingStep.isEmpty ? "Saving…" : controller.finishingStep)
    case .done:
      statusCard("Saved")
    case .failed(let message):
      failedCard(message)
    }
  }

  /// RoomPlan's coaching and the scan's state, one short line each
  private var hints: some View {
    VStack(spacing: 8) {
      if let notice = controller.notice {
        pill(notice, dot: AynaTheme.lime).transition(.opacity)
      }
      if let warning = controller.lastWarning {
        pill(warning, dot: AynaTheme.orange)
      }
      if let issue = controller.trackingIssue {
        pill(issue.message, dot: AynaTheme.orange)
      } else if controller.captureReady {
        pill(hint, dot: controller.quality.ready ? AynaTheme.lime : AynaTheme.orange)
        if controller.coveragePlateau && !controller.quality.ready {
          pill("Photo detail isn't improving much. Tap Done to keep what you have.", dot: AynaTheme.orange)
        }
        if controller.captureBudget.constrained {
          pill("Reducing background capture to keep scanning responsive.", dot: AynaTheme.neutral)
        }
      }
    }
    .frame(maxWidth: 500)
  }

  private var hint: String {
    if !controller.meshReady { return "Starting LiDAR…" }
    if controller.quality.ready { return controller.quality.message }
    return controller.instruction ?? controller.quality.message
  }

  private func pill(_ text: String, dot: Color) -> some View {
    HStack(spacing: 8) {
      StatusDot(color: dot)
      Text(text)
        .font(.footnote.weight(.medium))
        .multilineTextAlignment(.leading)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .background(AynaTheme.surface.opacity(0.88), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    .accessibilityElement(children: .combine)
  }

  private func recoveryCard(_ issue: TrackingRecovery.Issue) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        StatusDot(color: AynaTheme.orange)
        Text("Recovering your position").font(.headline)
      }
      Text(issue.message).font(.subheadline)
      Text("Recording is paused. Saved photos are safe; capture resumes when your position is stable.")
        .font(.caption)
        .foregroundStyle(AynaTheme.secondary)
      if let url = controller.recoveryPhoto, let image = UIImage(contentsOfFile: url.path) {
        Image(uiImage: image)
          .resizable()
          .scaledToFit()
          .frame(height: 100)
          .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        Text("Return to this view and pan slowly.").font(.caption).foregroundStyle(AynaTheme.secondary)
      }
      Button("Done: keep what I have", action: done)
        .buttonStyle(AynaButtonStyle(kind: .raised))
    }
    .frame(maxWidth: 500)
    .aynaCard(AynaTheme.surface.opacity(0.94))
    .accessibilityElement(children: .contain)
  }

  private var pausedCard: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        StatusDot(color: AynaTheme.orange)
        Text("Paused").font(.headline)
      }
      Text("No photos, depth or coverage while paused. Tracking keeps running: keep the camera on the table, not the floor or your pocket, so it doesn't lose its place.")
        .font(.footnote)
        .foregroundStyle(AynaTheme.secondary)
      Button(action: controller.resume) {
        Label("Resume", systemImage: "play.fill")
      }
      .buttonStyle(AynaButtonStyle(kind: .lime))
      Button("Done: keep what I have", action: done)
        .buttonStyle(AynaButtonStyle(kind: .raised))
    }
    .frame(maxWidth: 500)
    .aynaCard(AynaTheme.surface.opacity(0.94))
  }

  /// Only seen if the scan couldn't start by itself (storage, a failed session)
  private var readyCard: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("New scan")
        .font(.michroma(20, relativeTo: .title2))
        .textCase(.uppercase)
      Text("Walk slowly around the table and its surroundings. The mesh turns from orange to lime where Ayna has sharp photos. Photos are taken automatically; the shutter adds close-ups.")
        .font(.subheadline)
        .foregroundStyle(AynaTheme.secondary)
      if let warning = controller.lastWarning {
        HStack(spacing: 8) {
          StatusDot(color: AynaTheme.orange)
          Text(warning).font(.footnote)
        }
      }
      Button(action: controller.startRoom) {
        Label("Start scan", systemImage: "viewfinder")
      }
      .buttonStyle(AynaButtonStyle(kind: .lime))
      .disabled(!controller.canStartRoom)
    }
    .frame(maxWidth: 500)
    .aynaCard(AynaTheme.surface.opacity(0.96))
  }

  private func statusCard(_ text: String) -> some View {
    HStack(spacing: 12) {
      ProgressView().tint(AynaTheme.lime)
      Text(text).font(.subheadline.weight(.medium))
    }
    .frame(maxWidth: 500)
    .aynaCard(AynaTheme.surface.opacity(0.96))
  }

  private func failedCard(_ message: String) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        StatusDot(color: AynaTheme.orange)
        Text("Couldn't save the scan").font(.headline)
      }
      Text(message).font(.footnote)
      Text("Keep this screen open while freeing storage, then retry. Files already written are kept.")
        .font(.caption)
        .foregroundStyle(AynaTheme.secondary)
      Button("Retry saving") { Task { await controller.finishSession() } }
        .buttonStyle(AynaButtonStyle(kind: .lime))
      Button("Close", action: onClose)
        .buttonStyle(AynaButtonStyle(kind: .raised))
    }
    .frame(maxWidth: 500)
    .aynaCard(AynaTheme.surface.opacity(0.96))
  }

  // MARK: bottom

  @ViewBuilder private var bottomBar: some View {
    if scanning && !controller.paused {
      HStack(alignment: .bottom) {
        VStack(alignment: .leading, spacing: 6) {
          Legend()
          CoverageMap(coverage: controller.coverage, camera: controller.cameraPose, photos: controller.photoPositions,
                      redSpots: controller.stats.redSpots)
            .frame(width: 112, height: 112)
        }
        .frame(width: 112, alignment: .leading)
        Spacer(minLength: 8)
        shutter
        Spacer(minLength: 8)
        doneButton.frame(width: 112)
      }
    }
  }

  private var shutter: some View {
    Button {
      UIImpactFeedbackGenerator(style: .medium).impactOccurred()
      controller.takePhoto()
    } label: {
      ZStack {
        Circle().fill(AynaTheme.neutral)
        Circle().strokeBorder(AynaTheme.background, lineWidth: 2).padding(5)
        Image(systemName: "camera.fill").font(.title3).foregroundStyle(AynaTheme.background)
      }
      .frame(width: 74, height: 74)
      .contentShape(Circle())
    }
    .buttonStyle(.plain)
    .disabled(!controller.canTakePhoto)
    .opacity(controller.canTakePhoto ? 1 : 0.4)
    .accessibilityLabel("Take a close-up photo")
  }

  private var doneButton: some View {
    let ready = controller.quality.ready
    return Button(action: done) {
      HStack(spacing: 6) {
        if ready { Image(systemName: "checkmark").font(.subheadline.weight(.bold)) }
        Text("Done").font(.body.weight(.semibold))
      }
      .frame(maxWidth: .infinity, minHeight: 52)
      .foregroundStyle(ready ? AynaTheme.onLime : AynaTheme.text)
      .background(ready ? AynaTheme.lime : AynaTheme.raised, in: Capsule())
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .animation(.easeInOut(duration: 0.25), value: ready)
    .accessibilityHint(ready ? "Photo detail looks complete. Saves the scan." : "Saves the scan with what was recorded so far.")
  }

  private func done() {
    controller.finishRoom()
  }
}

private struct Legend: View {
  var body: some View {
    HStack(spacing: 10) {
      ForEach([(AynaTheme.orange, "needs photos"), (AynaTheme.lime, "covered")], id: \.1) { color, label in
        HStack(spacing: 4) {
          Circle().fill(color).frame(width: 7, height: 7)
          Text(label).font(.system(size: 10, weight: .medium))
        }
      }
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 5)
    .background(AynaTheme.surface.opacity(0.85), in: Capsule())
    .fixedSize()
    .accessibilityElement(children: .combine)
  }
}

/// Hosts the scan's ARSCNView (camera + coverage mesh + RoomPlan outlines)
struct ARViewContainer: UIViewRepresentable {
  let view: ARSCNView
  func makeUIView(context: Context) -> ARSCNView { view }
  func updateUIView(_ uiView: ARSCNView, context: Context) {}
}
