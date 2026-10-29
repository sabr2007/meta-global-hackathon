import Foundation
import Security

/// The Ayna web app that builds a robot's twin from a mirror. The app talks to it only when you
/// pair this iPhone or tap Send to Ayna:
///
///     POST {base}/api/devices/pair               {code, deviceName}            → {token, user: {email}}
///     POST {base}/api/uploads            Bearer  {name, sizeBytes, capturedAt} → {scanId, uploadUrl, method, headers}
///     <method> uploadUrl                         the .zip, with exactly those headers (presigned: no Bearer)
///     POST {base}/api/uploads/{scanId}/complete  Bearer                        → {status: "queued"}
///
/// Failures are 4xx/5xx with {error: "message"}. A 401 means the token is no longer valid.
enum AynaServer {
  /// The default server. This is the only place its address is written down.
  static let defaultBaseURL = URL(string: "https://ayna-scan.vercel.app")!
  private static let baseURLKey = "ayna.server.baseURL"

  /// The server in use: the address set in the pairing sheet, else the default
  static var baseURL: URL {
    UserDefaults.standard.string(forKey: baseURLKey).flatMap(normalized) ?? defaultBaseURL
  }

  /// Saves the server the user typed ("ayna.example.com" or a full https:// address)
  static func setBaseURL(_ text: String) throws -> URL {
    guard let url = normalized(text) else { throw AynaServerError.invalidAddress }
    if url.absoluteString == defaultBaseURL.absoluteString {
      UserDefaults.standard.removeObject(forKey: baseURLKey)
    } else {
      UserDefaults.standard.set(url.absoluteString, forKey: baseURLKey)
    }
    return url
  }

  static func resetBaseURL() { UserDefaults.standard.removeObject(forKey: baseURLKey) }

  /// https only (the token is a bearer secret), lowercase host, no query, fragment or trailing slash
  static func normalized(_ text: String) -> URL? {
    var text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if !text.contains("://") { text = "https://" + text }
    guard var parts = URLComponents(string: text), parts.scheme?.lowercased() == "https",
          let host = parts.host, !host.isEmpty else { return nil }
    parts.scheme = "https"
    parts.host = host.lowercased()
    parts.user = nil
    parts.password = nil
    parts.query = nil
    parts.fragment = nil
    while parts.path.hasSuffix("/") { parts.path.removeLast() }
    return parts.url
  }

  /// The address without "https://", as the app shows it
  static func displayName(_ url: URL) -> String {
    let text = url.absoluteString
    return text.hasPrefix("https://") ? String(text.dropFirst("https://".count)) : text
  }
}

// MARK: - pairing (Keychain)

/// This iPhone's pairing with one server: its bearer token and the account it belongs to
struct AynaPairing: Equatable {
  let token: String
  let email: String?
}

/// Pairings live in the Keychain, one item per server address, readable after the first unlock
/// (background uploads finish while the phone is locked) and never synced or restored to
/// another device.
enum AynaKeychain {
  static let service = "com.sabyrzhan.ayna.server"

  static func pairing(for server: URL) -> AynaPairing? {
    var query = item(for: server)
    query[kSecReturnData as String] = true
    query[kSecReturnAttributes as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
          let found = result as? [String: Any],
          let data = found[kSecValueData as String] as? Data,
          let token = String(data: data, encoding: .utf8), !token.isEmpty else { return nil }
    let email = (found[kSecAttrGeneric as String] as? Data).flatMap { String(data: $0, encoding: .utf8) }
    return AynaPairing(token: token, email: email)
  }

  static func save(_ pairing: AynaPairing, for server: URL) throws {
    remove(for: server)
    var attributes = item(for: server)
    attributes[kSecValueData as String] = Data(pairing.token.utf8)
    if let email = pairing.email { attributes[kSecAttrGeneric as String] = Data(email.utf8) }
    attributes[kSecAttrLabel as String] = "Ayna (\(AynaServer.displayName(server)))"
    attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let status = SecItemAdd(attributes as CFDictionary, nil)
    guard status == errSecSuccess else { throw AynaServerError.keychain(status) }
  }

  static func remove(for server: URL) {
    SecItemDelete(item(for: server) as CFDictionary)
  }

  private static func item(for server: URL) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: service,
     kSecAttrAccount as String: server.absoluteString]
  }
}

// MARK: - errors

enum AynaServerError: LocalizedError, Equatable {
  /// 401: the token (or, while pairing, the code) was not accepted
  case unauthorized(String?)
  /// any other non-2xx answer, with the server's {error} message when it sent one
  case refused(status: Int, message: String?)
  /// a 2xx answer that isn't the JSON the contract describes
  case unreadable(status: Int)
  case invalidAddress
  case keychain(OSStatus)

  var errorDescription: String? {
    switch self {
    case .unauthorized(let message):
      message ?? "Ayna no longer accepts this iPhone. Pair it again with a new code from Mirrors on the web."
    case .refused(let status, let message?):
      status >= 500 ? "\(message) (HTTP \(status))" : message
    case .refused(let status, nil):
      Self.describe(status)
    case .unreadable(let status):
      "The server's answer isn't one Ayna understands (HTTP \(status)). Check the server address."
    case .invalidAddress:
      "Enter an https:// address, like \(AynaServer.displayName(AynaServer.defaultBaseURL))."
    case .keychain(let status):
      "Couldn't keep the pairing in the Keychain (error \(status))."
    }
  }

  private static func describe(_ status: Int) -> String {
    switch status {
    case 404: "This server has no Ayna API (HTTP 404). Check the server address."
    case 413: "This mirror is too large for the server (HTTP 413)."
    case 429: "Too many tries. Wait a minute, then try again."
    case 500...: "Ayna's server had a problem (HTTP \(status)). Try again in a minute."
    default: "The server refused the request (HTTP \(status))."
    }
  }
}

// MARK: - API

/// The three JSON calls. The upload itself runs in AynaUploader's background session.
struct AynaAPI {
  let base: URL

  struct Paired: Decodable {
    struct User: Decodable { let email: String? }
    let token: String
    let user: User?
  }

  struct Ticket: Decodable {
    let scanId: String
    let uploadUrl: URL
    let method: String?
    let headers: [String: String]?
  }

  struct Completed: Decodable {
    let status: String?
    /// optional: the twin's page; the app opens the server's home page without it
    let url: URL?
  }

  private struct NewUpload: Encodable {
    let name: String
    let sizeBytes: Int
    let capturedAt: String
  }

  func pair(code: String, deviceName: String) async throws -> Paired {
    let paired: Paired = try await post("api/devices/pair", body: ["code": code, "deviceName": deviceName])
    guard !paired.token.isEmpty else { throw AynaServerError.unreadable(status: 200) }
    return paired
  }

  func createUpload(token: String, name: String, sizeBytes: Int, capturedAt: Date) async throws -> Ticket {
    let body = NewUpload(name: name, sizeBytes: sizeBytes, capturedAt: capturedAt.ISO8601Format())
    return try await post("api/uploads", token: token, body: body)
  }

  func complete(token: String, scanId: String) async throws -> Completed {
    try await post("api/uploads/\(Self.pathSegment(scanId))/complete", token: token, body: [String: String]())
  }

  private func post<Body: Encodable, Response: Decodable>(_ path: String, token: String? = nil, body: Body) async throws -> Response {
    guard let url = URL(string: base.absoluteString + "/" + path) else { throw AynaServerError.invalidAddress }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    request.httpBody = try JSONEncoder().encode(body)
    let (data, response) = try await Self.session.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      let message = Self.errorMessage(in: data)
      if status == 401 { throw AynaServerError.unauthorized(message) }
      throw AynaServerError.refused(status: status, message: message)
    }
    do {
      return try JSONDecoder().decode(Response.self, from: data)
    } catch {
      throw AynaServerError.unreadable(status: status)
    }
  }

  /// The JSON calls are small: no cache or cookies, and they give up after 30 s
  private static let session: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 30
    return URLSession(configuration: configuration)
  }()

  private static let maxMessageLength = 300

  /// The server's {"error": "…"}, or the <Message> of a storage provider's XML error
  static func errorMessage(in data: Data) -> String? {
    var message: String?
    if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
      message = (object["error"] as? String) ?? (object["message"] as? String)
    } else if let text = String(data: data.prefix(16_384), encoding: .utf8),
              let start = text.range(of: "<Message>"),
              let end = text.range(of: "</Message>", range: start.upperBound..<text.endIndex) {
      message = String(text[start.upperBound..<end.lowerBound])
    }
    guard let clean = message?.trimmingCharacters(in: .whitespacesAndNewlines), !clean.isEmpty else { return nil }
    return String(clean.prefix(maxMessageLength))
  }

  /// scanId as one path segment, whatever characters the server uses
  private static func pathSegment(_ text: String) -> String {
    let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
    return text.addingPercentEncoding(withAllowedCharacters: unreserved) ?? text
  }
}
