import Foundation

extension HouseProject {
  struct DeletedRoom: Codable, Identifiable {
    var id: String { room.id }
    var room: Room
    var deletedAt: Date
  }
  var deletedRooms: [DeletedRoom] {
    guard let data = try? Data(contentsOf: url.appendingPathComponent("recently-deleted.json")) else { return [] }
    return (try? JSONDecoder().decode([DeletedRoom].self, from: data)) ?? []
  }
  private func saveDeleted(_ entries: [DeletedRoom]) throws {
    try JSONEncoder().encode(entries).write(to: url.appendingPathComponent("recently-deleted.json"), options: .atomic)
  }
  @MainActor static func renameRoom(houseID: String, roomID: String, name: String) throws {
    let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !clean.isEmpty else { throw CocoaError(.validationMissingMandatoryProperty) }
    try modify(houseID) { h in
      guard let i = h.rooms.firstIndex(where: { $0.id == roomID }) else { return }
      h.rooms[i].name = clean
    }
  }
  /// Soft deletion keeps data intact until the user explicitly deletes it permanently.
  @MainActor static func moveRoomToTrash(houseID: String, roomID: String) throws {
    let h = try load(id: houseID)
    guard let room = h.rooms.first(where: { $0.id == roomID }) else { return }
    var entries = h.deletedRooms.filter { $0.id != roomID }
    entries.append(.init(room: room, deletedAt: Date()))
    try h.saveDeleted(entries)
    try modify(houseID) { $0.rooms.removeAll { $0.id == roomID } }
  }
  @MainActor static func restoreRoom(houseID: String, roomID: String) throws {
    let h = try load(id: houseID)
    guard let entry = h.deletedRooms.first(where: { $0.id == roomID }) else { return }
    try modify(houseID) { h in
      if !h.rooms.contains(where: { $0.id == roomID }) { h.rooms.append(entry.room) }
    }
    try h.saveDeleted(h.deletedRooms.filter { $0.id != roomID })
  }
  @MainActor static func permanentlyDeleteRoom(houseID: String, roomID: String) throws {
    try restoreRoom(houseID: houseID, roomID: roomID)
    try deleteRoom(houseID: houseID, roomID: roomID)
  }
  @MainActor static func deleteScan(houseID: String, roomID: String, ref: RoomRef) throws {
    // Put the removed version in Recently Deleted as a recoverable standalone room.
    let h = try load(id: houseID)
    guard let room = h.rooms.first(where: { $0.id == roomID }), room.history.contains(ref) else { return }
    var removed = room
    removed.id = UUID().uuidString
    removed.name += " (older scan)"
    removed.active = ref
    removed.history = [ref]
    removed.zone = h.session(ref.session)?.zone ?? room.zone
    try h.saveDeleted(h.deletedRooms + [.init(room: removed, deletedAt: Date())])
    try modify(houseID) { h in
      guard let i = h.rooms.firstIndex(where: { $0.id == roomID }) else { return }
      h.rooms[i].history.removeAll { $0 == ref }
      if h.rooms[i].active == ref { h.rooms[i].active = h.rooms[i].history.last }
      if let active = h.rooms[i].active { h.rooms[i].zone = h.session(active.session)?.zone ?? room.zone }
      if h.rooms[i].history.isEmpty { h.rooms.remove(at: i) }
    }
  }
}
