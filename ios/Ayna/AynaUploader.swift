import Foundation
import UIKit

/// Send to Ayna: pair once, then for each mirror zip it (the Share .zip export), ask the server
/// for an upload URL, upload the zip from a background URLSession (it carries on while the app
/// is in the background or closed) and confirm, after which Ayna builds the twin.
@MainActor
final class AynaUploader: NSObject, ObservableObject {
  static let shared = AynaUploader()
  static let sessionIdentifier = "com.sabyrzhan.ayna.upload"
  /// An upload stuck without network fails after this instead of waiting for days (the
  /// presigned URL would have expired anyway)
  private static let resourceTimeout: TimeInterval = 6 * 60 * 60
  private static let recordsKey = "ayna.sent"
  /// staged zips no running upload reads are removed after this
  private static let staleStaging: TimeInterval = 60 * 60
  private static let maxReply = 16_384

  enum SendState: Equatable {
    case idle
    case zipping
    case uploading(sent: Int64, total: Int64)
    /// the zip is in storage; the server is being told to start
    case finishing
    case queued(at: Date, web: URL)
    case failed(message: String, needsPairing: Bool)

    /// whole percent of an upload
    var percent: Int? {
      guard case .uploading(let sent, let total) = self else { return nil }
      guard total > 0 else { return 0 }
      return Int(min(100, max(0, Double(sent) / Double(total) * 100)))
    }

    /// the state without its numbers: animate between states, not between percents
    var step: Int {
      switch self {
      case .idle: 0
      case .zipping: 1
      case .uploading: 2
      case .finishing: 3
      case .queued: 4
      case .failed: 5
      }
    }

    var isBusy: Bool { (1...3).contains(step) }
  }

  /// The server in use and this iPhone's pairing with it (nil: not paired)
  @Published private(set) var server: URL
  @Published private(set) var pairing: AynaPairing?
  /// by mirror id
  @Published private(set) var states: [String: SendState] = [:]

  /// iOS's completion handler while it has woken the app for this session's events
  var backgroundEventsDone: (() -> Void)?

  /// What a background upload is for. It lives in the task's taskDescription, which survives the
  /// app being closed.
  private struct TaskInfo: Codable {
    var mirror: String
    var scanId: String
    var server: String
    /// the staged zip's file name
    var file: String

    init(mirror: String, scanId: String, server: String, file: String) {
      self.mirror = mirror
      self.scanId = scanId
      self.server = server
      self.file = file
    }

    init?(_ description: String?) {
      guard let data = description?.data(using: .utf8), let info = try? JSONDecoder().decode(Self.self, from: data) else { return nil }
      self = info
    }

    var encoded: String { String(decoding: (try? JSONEncoder().encode(self)) ?? Data(), as: UTF8.self) }
  }

  /// A mirror whose zip reached storage; complete is confirmed (queuedAt) or still owed
  private struct SentRecord: Codable {
    var scanId: String
    var server: String
    var queuedAt: Date?
    var web: String?
  }

  private struct StagedZip {
    let url: URL
    let size: Int
  }

  private var running: [Int: (task: URLSessionTask, info: TaskInfo)] = [:]
  private var replies: [Int: Data] = [:]
  private var cancelling: Set<String> = []
  private var completing: Set<String> = []
  private var records: [String: SentRecord] { didSet { Self.save(records) } }
  private var activated = false

  private lazy var session: URLSession = {
    let configuration = URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)
    configuration.sessionSendsLaunchEvents = true
    configuration.isDiscretionary = false
    configuration.timeoutIntervalForResource = Self.resourceTimeout
    return URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
  }()

  private override init() {
    let server = AynaServer.baseURL
    self.server = server
    pairing = AynaKeychain.pairing(for: server)
    records = AynaUploader.loadRecords()
    super.init()
  }

  /// At launch, and when iOS wakes the app for upload events: re-attach the background session
  /// (uploads that ended while the app was closed report in), show uploads still running and
  /// finish confirmations still owed.
  func activate() {
    guard !activated else { return }
    activated = true
    _ = session // re-creating the session by its identifier is what delivers the pending events
    for (mirror, record) in records {
      if let state = Self.resting(record) { states[mirror] = state }
    }
    NotificationCenter.default.addObserver(self, selector: #selector(becameActive),
                                           name: UIApplication.didBecomeActiveNotification, object: nil)
    Task { await restoreRunning() }
  }

  func state(of mirror: MirrorLibrary.Mirror) -> SendState { states[mirror.id] ?? .idle }

  // MARK: pairing and server

  var isDefaultServer: Bool { server.absoluteString == AynaServer.defaultBaseURL.absoluteString }

  func pair(code: String) async throws {
    let server = self.server
    let paired = try await AynaAPI(base: server).pair(code: code, deviceName: UIDevice.current.name)
    let pairing = AynaPairing(token: paired.token, email: paired.user?.email)
    try AynaKeychain.save(pairing, for: server)
    if server.absoluteString == self.server.absoluteString { self.pairing = pairing }
  }

  func unpair() {
    AynaKeychain.remove(for: server)
    pairing = nil
  }

  /// Pairings are kept per server, so switching servers switches pairings
  func setServer(_ text: String) throws {
    server = try AynaServer.setBaseURL(text)
    pairing = AynaKeychain.pairing(for: server)
  }

  func resetServer() {
    AynaServer.resetBaseURL()
    server = AynaServer.baseURL
    pairing = AynaKeychain.pairing(for: server)
  }

  // MARK: sending

  /// Zip the mirror, reserve an upload and hand the zip to the background session
  func send(_ mirror: MirrorLibrary.Mirror, bundle: ScanBundle, name: String) {
    let id = mirror.id
    guard !state(of: mirror).isBusy else { return }
    guard let token = pairing?.token else {
      states[id] = .failed(message: "Pair this iPhone with Ayna first.", needsPairing: true)
      return
    }
    let server = self.server, index = mirror.index, capturedAt = mirror.capturedAt
    states[id] = .zipping
    Task {
      do {
        // the same export as Share .zip
        let zip = try await Task.detached(priority: .userInitiated) {
          try Self.stage(bundle.zippedRoom(index: index, name: name))
        }.value
        let ticket: AynaAPI.Ticket
        do {
          ticket = try await AynaAPI(base: server).createUpload(token: token, name: name, sizeBytes: zip.size, capturedAt: capturedAt)
        } catch {
          Self.discard(zip.url)
          throw error
        }
        try startUpload(ticket, zip: zip, mirror: id, server: server)
      } catch {
        fail(id, error, server: server)
      }
    }
  }

  /// After a failure: confirm an upload that already reached storage, else send it again
  func retry(_ mirror: MirrorLibrary.Mirror, bundle: ScanBundle?, name: String) {
    if let record = records[mirror.id], record.queuedAt == nil {
      complete(mirror.id)
    } else if let bundle {
      send(mirror, bundle: bundle, name: name)
    }
  }

  func cancel(_ mirror: MirrorLibrary.Mirror) {
    for upload in running.values where upload.info.mirror == mirror.id {
      cancelling.insert(mirror.id)
      upload.task.cancel()
    }
  }

  private func startUpload(_ ticket: AynaAPI.Ticket, zip: StagedZip, mirror: String, server: URL) throws {
    guard let scheme = ticket.uploadUrl.scheme?.lowercased(), scheme == "https" || scheme == "http" else {
      Self.discard(zip.url)
      throw AynaServerError.unreadable(status: 200)
    }
    var request = URLRequest(url: ticket.uploadUrl)
    request.httpMethod = (ticket.method ?? "PUT").uppercased()
    // Exactly the headers the server signed. The presigned URL is the credential: the Bearer
    // token never goes to storage.
    for (field, value) in ticket.headers ?? ["content-type": "application/zip"] {
      request.setValue(value, forHTTPHeaderField: field)
    }
    let info = TaskInfo(mirror: mirror, scanId: ticket.scanId, server: server.absoluteString, file: zip.url.lastPathComponent)
    let task = session.uploadTask(with: request, fromFile: zip.url)
    task.taskDescription = info.encoded
    running[task.taskIdentifier] = (task, info)
    states[mirror] = .uploading(sent: 0, total: Int64(zip.size))
    task.resume()
  }

  /// Tell the server the zip is in storage; it queues the twin
  private func complete(_ mirror: String) {
    guard let record = records[mirror], record.queuedAt == nil, !completing.contains(mirror),
          let server = URL(string: record.server) else { return }
    guard let token = AynaKeychain.pairing(for: server)?.token else {
      states[mirror] = .failed(message: "The zip is uploaded, but this iPhone is no longer paired. Pair it again to finish.", needsPairing: true)
      return
    }
    completing.insert(mirror)
    states[mirror] = .finishing
    let time = BackgroundTime(name: "Ayna: confirm upload")
    Task {
      defer {
        completing.remove(mirror)
        time.end()
      }
      do {
        let done = try await AynaAPI(base: server).complete(token: token, scanId: record.scanId)
        guard records[mirror]?.scanId == record.scanId else { return } // a newer send took over
        var queued = record
        queued.queuedAt = Date()
        queued.web = done.url.flatMap { $0.scheme == "https" ? $0.absoluteString : nil }
        records[mirror] = queued
        states[mirror] = Self.resting(queued)
      } catch {
        // The server won't take this upload (gone, expired, another account): Retry sends it again
        if case .refused(let status, _)? = error as? AynaServerError, (400..<500).contains(status),
           ![408, 425, 429].contains(status), records[mirror]?.scanId == record.scanId {
          records[mirror] = nil
        }
        fail(mirror, error, server: server)
      }
    }
  }

  private func fail(_ mirror: String, _ error: Error, server: URL) {
    if case .unauthorized? = error as? AynaServerError {
      AynaKeychain.remove(for: server)
      if server.absoluteString == self.server.absoluteString { pairing = nil }
      states[mirror] = .failed(message: "Ayna no longer accepts this iPhone. Pair it again with a new code from Mirrors on the web.", needsPairing: true)
    } else {
      states[mirror] = .failed(message: error.localizedDescription, needsPairing: false)
    }
  }

  // MARK: background session events

  private func info(of task: URLSessionTask) -> TaskInfo? {
    running[task.taskIdentifier]?.info ?? TaskInfo(task.taskDescription)
  }

  fileprivate func progressed(_ task: URLSessionTask, sent: Int64, total: Int64) {
    guard let mirror = info(of: task)?.mirror else { return }
    var known = total
    if known <= 0, case .uploading(_, let previous) = states[mirror] ?? .idle { known = previous }
    let next = SendState.uploading(sent: sent, total: known)
    if case .uploading = states[mirror] ?? .idle, states[mirror]?.percent == next.percent { return } // one update per percent
    states[mirror] = next
  }

  /// Only an error reply is ever read; keep its first few KB
  fileprivate func received(_ data: Data, for task: URLSessionTask) {
    var reply = replies[task.taskIdentifier] ?? Data()
    guard reply.count < Self.maxReply else { return }
    reply.append(data.prefix(Self.maxReply - reply.count))
    replies[task.taskIdentifier] = reply
  }

  fileprivate func finished(_ task: URLSessionTask, error: Error?) {
    let reply = replies.removeValue(forKey: task.taskIdentifier)
    guard let info = running.removeValue(forKey: task.taskIdentifier)?.info ?? TaskInfo(task.taskDescription) else { return }
    if let folder = try? Self.stagingFolder() { Self.discard(folder.appendingPathComponent(info.file)) }
    let cancelled = cancelling.remove(info.mirror) != nil
    if let error {
      if cancelled {
        // back to what the mirror was before: an earlier send, or nothing
        states[info.mirror] = records[info.mirror].flatMap(Self.resting) ?? .idle
      } else {
        states[info.mirror] = .failed(message: Self.describe(error), needsPairing: false)
      }
      return
    }
    let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      let detail = reply.flatMap(AynaAPI.errorMessage(in:)).map { ": \($0)" } ?? "."
      states[info.mirror] = .failed(message: "Storage refused the upload (HTTP \(status))\(detail)", needsPairing: false)
      return
    }
    records[info.mirror] = SentRecord(scanId: info.scanId, server: info.server)
    complete(info.mirror)
  }

  fileprivate func finishedEvents() {
    backgroundEventsDone?()
    backgroundEventsDone = nil
  }

  private func restoreRunning() async {
    let tasks = await session.allTasks
    var staged: Set<String> = []
    for task in tasks where task.state == .running || task.state == .suspended {
      guard let info = TaskInfo(task.taskDescription) else { continue }
      running[task.taskIdentifier] = (task, info)
      staged.insert(info.file)
      states[info.mirror] = .uploading(sent: task.countOfBytesSent, total: task.countOfBytesExpectedToSend)
    }
    Self.sweepStaging(keeping: staged)
    finishOwed()
  }

  /// Confirmations owed for zips already in storage (the app was closed, or the server was down)
  private func finishOwed() {
    let uploading = Set(running.values.map { $0.info.mirror })
    for (mirror, record) in records where record.queuedAt == nil && !uploading.contains(mirror) {
      complete(mirror)
    }
  }

  @objc private func becameActive() { finishOwed() }

  // MARK: helpers

  private static func resting(_ record: SentRecord) -> SendState? {
    guard let queuedAt = record.queuedAt else { return nil }
    let web = record.web.flatMap(URL.init(string:)) ?? URL(string: record.server) ?? AynaServer.defaultBaseURL
    return .queued(at: queuedAt, web: web)
  }

  private static func describe(_ error: Error) -> String {
    if (error as? URLError)?.backgroundTaskCancelledReason == .userForceQuitApplication {
      return "The upload stopped because Ayna was closed from the app switcher. Retry to send it again."
    }
    return error.localizedDescription
  }

  private static func loadRecords() -> [String: SentRecord] {
    guard let data = UserDefaults.standard.data(forKey: recordsKey) else { return [:] }
    return (try? JSONDecoder().decode([String: SentRecord].self, from: data)) ?? [:]
  }

  private static func save(_ records: [String: SentRecord]) {
    guard let data = try? JSONEncoder().encode(records) else { return }
    UserDefaults.standard.set(data, forKey: recordsKey)
  }

  /// Application Support/Uploads: unlike tmp, iOS doesn't purge it while the app is closed and
  /// the background session still reads the zip
  nonisolated private static func stagingFolder() throws -> URL {
    var folder = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      .appendingPathComponent("Uploads", isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? folder.setResourceValues(values)
    return folder
  }

  /// Moves a fresh Share .zip export out of tmp into the staging folder
  nonisolated private static func stage(_ zip: URL) throws -> StagedZip {
    let url = try stagingFolder().appendingPathComponent("\(UUID().uuidString).zip")
    try FileManager.default.moveItem(at: zip, to: url)
    FolderZipper.removeArchive(zip)
    let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
    guard size > 0 else {
      discard(url)
      throw CocoaError(.fileReadCorruptFile)
    }
    return StagedZip(url: url, size: size)
  }

  nonisolated private static func discard(_ url: URL) {
    try? FileManager.default.removeItem(at: url)
  }

  /// Zips left behind by a crash: old, and no running upload reads them
  private static func sweepStaging(keeping staged: Set<String>) {
    guard let folder = try? stagingFolder(),
          let files = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
    let cutoff = Date().addingTimeInterval(-staleStaging)
    for file in files where !staged.contains(file.lastPathComponent) {
      let modified = (try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
      if modified < cutoff { discard(file) }
    }
  }
}

extension AynaUploader: URLSessionDataDelegate {
  // The session delivers on the main queue (delegateQueue: .main)

  nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                              totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
    MainActor.assumeIsolated { self.progressed(task, sent: totalBytesSent, total: totalBytesExpectedToSend) }
  }

  nonisolated func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    MainActor.assumeIsolated { self.received(data, for: dataTask) }
  }

  nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    MainActor.assumeIsolated { self.finished(task, error: error) }
  }

  nonisolated func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    MainActor.assumeIsolated { self.finishedEvents() }
  }
}

/// A little time from iOS to finish a short request after the app leaves the foreground
@MainActor
private final class BackgroundTime {
  private var id = UIBackgroundTaskIdentifier.invalid

  init(name: String) {
    id = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in self?.end() }
  }

  func end() {
    guard id != .invalid else { return }
    UIApplication.shared.endBackgroundTask(id)
    id = .invalid
  }
}
