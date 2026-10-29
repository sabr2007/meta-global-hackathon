import SwiftUI

/// Send to Ayna on a mirror's review: idle → zipping → uploading NN% → queued, or failed with the
/// server's message and Retry. The chip in the corner opens the pairing sheet.
struct SendToAynaCard: View {
  let state: AynaUploader.SendState
  let pairing: AynaPairing?
  /// the mirror's bundle is loaded
  let ready: Bool
  var onSend: () -> Void
  var onRetry: () -> Void
  var onCancel: () -> Void
  /// pairing, server and unpair
  var onPairing: () -> Void
  @Environment(\.openURL) private var openURL

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .center) {
        AynaEyebrow(text: "Send to Ayna")
        Spacer(minLength: 8)
        pairingChip
      }
      content
    }
    .aynaCard()
    .animation(.easeInOut(duration: 0.25), value: state.step)
  }

  @ViewBuilder private var content: some View {
    switch state {
    case .idle: idle
    case .zipping: working("Preparing the .zip…")
    case .uploading(let sent, let total): uploading(sent: sent, total: total)
    case .finishing: working("Uploaded. Handing it to Ayna…")
    case .queued(let at, let web): queued(at: at, web: web)
    case .failed(let message, let needsPairing): failed(message, needsPairing: needsPairing)
    }
  }

  private var pairingChip: some View {
    Button(action: onPairing) {
      HStack(spacing: 6) {
        StatusDot(color: pairing == nil ? AynaTheme.neutral : AynaTheme.lime)
        Text(pairing.map { $0.email ?? "Paired" } ?? "Not paired")
          .lineLimit(1)
          .truncationMode(.middle)
      }
      .font(.caption.weight(.medium))
      .foregroundStyle(AynaTheme.text)
      .padding(.horizontal, 10)
      .frame(minHeight: 30)
      .background(AynaTheme.raised, in: Capsule())
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(pairing.map { "Paired with Ayna as \($0.email ?? "your account")" } ?? "Not paired with Ayna")
    .accessibilityHint("Pairing and server")
  }

  private var idle: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Ayna builds the robot's world from this mirror: the table, its objects and the hero shot.")
        .font(.subheadline)
        .foregroundStyle(AynaTheme.secondary)
        .fixedSize(horizontal: false, vertical: true)
      Button(action: onSend) {
        Label("Send to Ayna", systemImage: "paperplane")
      }
      .buttonStyle(AynaButtonStyle(kind: .lime))
      .disabled(!ready)
      if pairing == nil {
        Text("The first time, pair this iPhone with a code from Mirrors on the web.")
          .font(.caption)
          .foregroundStyle(AynaTheme.secondary)
      }
    }
  }

  private func working(_ text: String) -> some View {
    HStack(spacing: 12) {
      ProgressView().tint(AynaTheme.neutral)
      Text(text).font(.subheadline.weight(.medium))
    }
    .frame(minHeight: 52)
  }

  private func uploading(sent: Int64, total: Int64) -> some View {
    let percent = state.percent ?? 0
    return VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .lastTextBaseline) {
        Text("\(percent)%")
          .font(.doto(44, relativeTo: .largeTitle))
          .contentTransition(.numericText(value: Double(percent)))
          .animation(.easeOut(duration: 0.25), value: percent)
        Spacer(minLength: 8)
        Text("\(Self.bytes(sent)) of \(Self.bytes(total))")
          .font(.caption.monospacedDigit())
          .foregroundStyle(AynaTheme.secondary)
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("Uploading, \(percent) percent")
      UploadBar(fraction: total > 0 ? Double(sent) / Double(total) : 0)
      Text("It keeps going if you leave Ayna.")
        .font(.caption)
        .foregroundStyle(AynaTheme.secondary)
      Button("Cancel upload", action: onCancel)
        .buttonStyle(AynaButtonStyle(kind: .outline))
    }
  }

  private func queued(at: Date, web: URL) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 8) {
        StatusDot(color: AynaTheme.lime)
        Text("Queued").font(.headline)
        Spacer(minLength: 8)
        Text(at.formatted(date: .abbreviated, time: .shortened))
          .font(.caption)
          .foregroundStyle(AynaTheme.secondary)
      }
      Text("Ayna is building your twin — open it on the web.")
        .font(.subheadline)
        .fixedSize(horizontal: false, vertical: true)
      Button { openURL(web) } label: {
        Label("Open on the web", systemImage: "safari")
      }
      .buttonStyle(AynaButtonStyle(kind: .raised))
      Button("Send again", action: onSend)
        .buttonStyle(.plain)
        .font(.footnote.weight(.semibold))
        .foregroundStyle(AynaTheme.secondary)
        .frame(maxWidth: .infinity, minHeight: 44)
        .disabled(!ready)
    }
  }

  private func failed(_ message: String, needsPairing: Bool) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 8) {
        StatusDot(color: AynaTheme.orange)
        Text(needsPairing ? "Pair this iPhone again" : "Couldn't send").font(.headline)
      }
      Text(message)
        .font(.footnote)
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
      Button(action: needsPairing ? onPairing : onRetry) {
        Label(needsPairing ? "Pair again" : "Retry", systemImage: needsPairing ? "link" : "arrow.clockwise")
      }
      .buttonStyle(AynaButtonStyle(kind: .lime))
      .disabled(!needsPairing && !ready)
    }
  }

  private static func bytes(_ count: Int64) -> String {
    ByteCountFormatter.string(fromByteCount: max(0, count), countStyle: .file)
  }
}

/// A thin meter: graphite track, light-grey fill
private struct UploadBar: View {
  let fraction: Double
  var body: some View {
    Capsule()
      .fill(AynaTheme.raised)
      .overlay(alignment: .leading) {
        GeometryReader { geo in
          Capsule()
            .fill(AynaTheme.neutral)
            .frame(width: max(geo.size.height, geo.size.width * min(1, max(0, fraction))))
        }
      }
      .frame(height: 8)
      .accessibilityHidden(true)
  }
}

// MARK: - pairing

/// Pair this iPhone once with the 6-character code from Mirrors on the web, change the server, or
/// unpair (the menu).
struct AynaPairingSheet: View {
  @ObservedObject var uploader: AynaUploader
  /// a send waits for the pairing
  var sendAfter = false
  var onPaired: () -> Void = {}

  @Environment(\.dismiss) private var dismiss
  @State private var code = ""
  @State private var working = false
  @State private var error: String?
  @State private var editingServer = false
  @State private var serverText = ""
  @State private var serverError: String?
  @State private var confirmUnpair = false
  @FocusState private var focus: Field?

  private enum Field { case code, server }
  private static let codeLength = 6

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 26) {
          CircleCluster().frame(height: 56)
          if let pairing = uploader.pairing { paired(pairing) } else { codeEntry }
          serverSection
        }
        .padding(20)
      }
      .scrollDismissesKeyboard(.interactively)
      .background(AynaTheme.background.ignoresSafeArea())
      .foregroundStyle(AynaTheme.text)
      .navigationTitle("")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) { Button("Close") { dismiss() } }
        ToolbarItem(placement: .principal) { AynaEyebrow(text: "Send to Ayna") }
        ToolbarItem(placement: .topBarTrailing) { menu }
      }
      .toolbarBackground(AynaTheme.background, for: .navigationBar)
      .toolbarBackground(.visible, for: .navigationBar)
      .confirmationDialog("Unpair this iPhone?", isPresented: $confirmUnpair, titleVisibility: .visible) {
        Button("Unpair", role: .destructive) { uploader.unpair() }
      } message: {
        Text("Send to Ayna will ask for a new code. Mirrors already sent stay on the web.")
      }
      .task {
        // after the sheet has slid up, so the keyboard comes with it
        try? await Task.sleep(for: .milliseconds(450))
        if uploader.pairing == nil { focus = .code }
      }
    }
    .tint(AynaTheme.lime)
    .presentationBackground(AynaTheme.background)
    .presentationDragIndicator(.visible)
  }

  private var menu: some View {
    Menu {
      Button("Edit server", systemImage: "server.rack", action: editServer)
      if !uploader.isDefaultServer {
        Button("Use the default server", systemImage: "arrow.uturn.backward") {
          uploader.resetServer()
          editingServer = false
        }
      }
      if uploader.pairing != nil {
        Button("Unpair this iPhone", systemImage: "xmark.circle", role: .destructive) { confirmUnpair = true }
      }
    } label: {
      Image(systemName: "ellipsis").frame(width: 44, height: 44)
    }
    .accessibilityLabel("Pairing options")
  }

  private var codeEntry: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Pair this iPhone")
        .font(.michroma(24, relativeTo: .title))
      Text("Open Mirrors on the Ayna website. It shows a 6-character code that works for 10 minutes. You pair once; after that, Send to Ayna uploads right away.")
        .font(.subheadline)
        .foregroundStyle(AynaTheme.secondary)
        .fixedSize(horizontal: false, vertical: true)
      codeField
      if let error { warning(error) }
      Button(action: submit) {
        if working {
          ProgressView().tint(AynaTheme.onLime)
        } else {
          Label(sendAfter ? "Pair and send" : "Pair", systemImage: "link")
        }
      }
      .buttonStyle(AynaButtonStyle(kind: .lime))
      .disabled(code.count != Self.codeLength || working)
    }
  }

  /// Six dot-matrix cells drawn over one plain text field, so typing, paste and VoiceOver all go
  /// to the field
  private var codeField: some View {
    ZStack {
      TextField("", text: $code)
        .focused($focus, equals: .code)
        .textInputAutocapitalization(.characters)
        .autocorrectionDisabled()
        .keyboardType(.asciiCapable)
        .submitLabel(.go)
        .onSubmit(submit)
        .foregroundStyle(.clear)
        .tint(.clear)
        .frame(maxWidth: .infinity, minHeight: 64)
        .accessibilityLabel("Pairing code")
      HStack(spacing: 8) {
        ForEach(0..<Self.codeLength, id: \.self) { i in cell(i) }
      }
      .allowsHitTesting(false)
      .accessibilityHidden(true)
    }
    .onChange(of: code) { _, typed in
      let clean = String(typed.uppercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) }.prefix(Self.codeLength))
      if clean != typed { code = clean }
      error = nil
    }
  }

  private func cell(_ i: Int) -> some View {
    let characters = Array(code)
    let active = focus == .code && i == min(characters.count, Self.codeLength - 1)
    let stroke = error != nil ? AynaTheme.orange : active ? AynaTheme.neutral : AynaTheme.raised
    return ZStack {
      if i < characters.count {
        Text(String(characters[i])).font(.doto(30, relativeTo: .title))
      } else {
        Circle().fill(AynaTheme.reflection).frame(width: 6, height: 6)
      }
    }
    .frame(maxWidth: .infinity, minHeight: 64)
    .background(AynaTheme.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .strokeBorder(stroke, lineWidth: active || error != nil ? 1.5 : 1)
    )
  }

  private func paired(_ pairing: AynaPairing) -> some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Paired").font(.michroma(24, relativeTo: .title))
      HStack(spacing: 8) {
        StatusDot(color: AynaTheme.lime)
        Text(pairing.email ?? "Your Ayna account")
          .font(.headline)
          .lineLimit(1)
          .truncationMode(.middle)
      }
      Text("Mirrors you send from this iPhone appear under Mirrors on the web.")
        .font(.subheadline)
        .foregroundStyle(AynaTheme.secondary)
        .fixedSize(horizontal: false, vertical: true)
      if sendAfter {
        Button {
          onPaired()
          dismiss()
        } label: {
          Label("Send now", systemImage: "paperplane")
        }
        .buttonStyle(AynaButtonStyle(kind: .lime))
      }
      Button("Unpair this iPhone") { confirmUnpair = true }
        .buttonStyle(AynaButtonStyle(kind: .outline))
    }
  }

  private var serverSection: some View {
    VStack(alignment: .leading, spacing: 10) {
      AynaEyebrow(text: "Server")
      if editingServer {
        TextField("", text: $serverText, prompt: Text(AynaServer.displayName(AynaServer.defaultBaseURL)))
          .focused($focus, equals: .server)
          .keyboardType(.URL)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .submitLabel(.done)
          .onSubmit(saveServer)
          .font(.subheadline.monospaced())
          .padding(.horizontal, 18)
          .frame(minHeight: 52)
          .background(AynaTheme.surface, in: Capsule())
          .accessibilityLabel("Server address")
        if let serverError { warning(serverError) }
        HStack(spacing: 10) {
          Button("Cancel") {
            editingServer = false
            serverError = nil
          }
          .buttonStyle(AynaButtonStyle(kind: .raised))
          Button("Save", action: saveServer)
            .buttonStyle(AynaButtonStyle(kind: .lime))
        }
      } else {
        HStack(spacing: 12) {
          Text(AynaServer.displayName(uploader.server))
            .font(.subheadline.monospaced())
            .lineLimit(1)
            .truncationMode(.middle)
          Spacer(minLength: 8)
          Button("Edit", action: editServer)
            .font(.subheadline.weight(.semibold))
            .frame(minHeight: 44)
        }
        .aynaCard(padding: 14)
        Text(uploader.isDefaultServer ? "The Ayna server." : "A custom server. Each server keeps its own pairing.")
          .font(.caption)
          .foregroundStyle(AynaTheme.secondary)
      }
    }
  }

  private func warning(_ text: String) -> some View {
    HStack(alignment: .top, spacing: 8) {
      StatusDot(color: AynaTheme.orange).padding(.top, 5)
      Text(text).font(.footnote).fixedSize(horizontal: false, vertical: true)
    }
  }

  // MARK: actions

  private func submit() {
    guard code.count == Self.codeLength, !working else { return }
    working = true
    error = nil
    Task {
      defer { working = false }
      do {
        try await uploader.pair(code: code)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        onPaired()
        dismiss()
      } catch {
        self.error = Self.pairingMessage(error)
        UINotificationFeedbackGenerator().notificationOccurred(.error)
      }
    }
  }

  /// A 401 while pairing is about the code, not about a lost pairing
  private static func pairingMessage(_ error: Error) -> String {
    if case .unauthorized(let message)? = error as? AynaServerError {
      return message ?? "That code didn't work. A code works once, for 10 minutes: make a new one on the web."
    }
    return error.localizedDescription
  }

  private func editServer() {
    serverText = AynaServer.displayName(uploader.server)
    serverError = nil
    editingServer = true
    focus = .server
  }

  private func saveServer() {
    do {
      try uploader.setServer(serverText)
      editingServer = false
      serverError = nil
      error = nil
      focus = uploader.pairing == nil ? .code : nil
    } catch {
      serverError = error.localizedDescription
    }
  }
}
