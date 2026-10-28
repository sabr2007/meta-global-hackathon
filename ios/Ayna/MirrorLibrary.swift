import Foundation

/// Ayna keeps every scan in one implicit house: each New scan is its own capture session with a
/// single room (a "mirror"), always started in a fresh ARKit world, never relocalized against
/// an earlier map. The engine's house / zone / session records stay underneath unchanged, so
/// every mirror is an ordinary house-capture/5 bundle.
enum MirrorLibrary {
  static let houseID = "ayna"

  /// One scan as the app shows it: the room of its session
  struct Mirror: Identifiable, Hashable {
    let session: String
    let roomID: String
    let index: Int
    let name: String
    let capturedAt: Date
    var id: String { roomID }
  }

  /// What the bundle on disk says about a mirror (read off the main thread)
  struct Summary {
    var photoDetail: Int?
    var photos = 0
    var depthFrames = 0
  }

  /// The implicit house, created on first use. A house.json that exists but can't be read is
  /// reported, never silently replaced.
  @MainActor static func house() throws -> HouseProject {
    let file = HouseProject.url(forHouse: houseID).appendingPathComponent("house.json")
    if FileManager.default.fileExists(atPath: file.path) { return try HouseProject.load(id: houseID) }
    let house = HouseProject(id: houseID, name: "Ayna", createdAt: Date())
    for dir in ["zones", "sessions"] {
      try FileManager.default.createDirectory(at: house.url.appendingPathComponent(dir), withIntermediateDirectories: true)
    }
    try house.save()
    return house
  }

  /// Mirrors, newest first
  static func mirrors(in house: HouseProject) -> [Mirror] {
    house.rooms.compactMap { room in
      room.active.map { Mirror(session: $0.session, roomID: room.id, index: $0.index, name: room.name, capturedAt: $0.capturedAt) }
    }
    .sorted { $0.capturedAt > $1.capturedAt }
  }

  static func bundle(of mirror: Mirror, in house: HouseProject) -> ScanBundle? {
    house.session(mirror.session).map { house.bundle(for: $0) }
  }

  /// "Mirror 01", "Mirror 02", … (rename it on the review screen)
  static func nextName(in house: HouseProject) -> String {
    let used = Set(house.rooms.map { HouseProject.roomKey($0.name) })
    var n = house.rooms.count + 1
    while used.contains(HouseProject.roomKey(name(n))) { n += 1 }
    return name(n)
  }

  private static func name(_ n: Int) -> String { String(format: "Mirror %02d", n) }

  /// Counts from manifest.json (call off the main thread)
  static func summary(of bundle: ScanBundle, index: Int) -> Summary {
    var summary = Summary()
    if let manifest = bundle.manifest {
      summary.photoDetail = manifest.rooms.first { $0.index == index }?.photographedPercent
      summary.photos = manifest.photoCount
      summary.depthFrames = manifest.depthFrameCount ?? 0
    }
    return summary
  }

  /// A new session in the implicit house. `zoneID: nil` gives it its own tracking group, so it
  /// never has a saved map to relocalize against: every scan is a fresh start.
  @MainActor static func startScan() throws -> CaptureController {
    let house = try house()
    let controller = try CaptureController.start(houseID: house.id, zoneID: nil)
    controller.roomName = nextName(in: house)
    return controller
  }

  /// Removes the mirror's session folder, its rooms in house.json and its empty tracking group
  @MainActor static func delete(_ mirror: Mirror) throws {
    try HouseProject.deleteSession(houseID: houseID, sessionID: mirror.session)
  }

  @MainActor static func rename(_ mirror: Mirror, to name: String) throws {
    try HouseProject.renameRoom(houseID: houseID, roomID: mirror.roomID, name: name)
  }
}
