import Foundation

public struct PairingCode: Codable, Equatable, Sendable {
    public let host: String
    public let port: Int
    public let pin: String
    public let token: String
    public init(_ code: String) throws {
        let text = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count <= 2000, text.hasPrefix("wu1:") else { throw PeerError.invalidCode }
        var encoded = String(text.dropFirst(4)).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
        guard let data = Data(base64Encoded: encoded), let value = try? JSONDecoder().decode(Self.self, from: data),
              Self.privateAddress(value.host), (1...65535).contains(value.port),
              value.pin.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              value.token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw PeerError.invalidCode }
        self = value
    }
    public static func privateAddress(_ host: String) -> Bool {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        let values = parts.compactMap { part -> Int? in
            guard !part.isEmpty, part.allSatisfy({ $0.isASCII && $0.isNumber }),
                  part.count == 1 || part.first != "0", let n = Int(part), (0...255).contains(n) else { return nil }
            return n
        }
        guard values.count == 4 else { return false }
        return values[0] == 10 || values[0] == 127 ||
            (values[0] == 192 && values[1] == 168) ||
            (values[0] == 172 && (16...31).contains(values[1])) ||
            (values[0] == 100 && (64...127).contains(values[1]))
    }
    public var baseURL: URL { URL(string: "https://\(host):\(port)")! }
}
public enum PeerError: LocalizedError {
    case invalidCode, unpaired, revoked, responseTooLarge, unsupportedState, redirect, uncertainDelivery, hostRestarted
    case server(String)
    public var errorDescription: String? {
        switch self {
        case .invalidCode: return "Paste a complete Work Updates pairing code from your computer."
        case .unpaired: return "Connect to this computer before sending an action."
        case .revoked: return "Pairing was revoked. Forget this connection and pair again."
        case .responseTooLarge: return "The computer returned too much data."
        case .unsupportedState: return "Update Work Updates on this computer to connect its queue."
        case .hostRestarted: return "The computer restarted. Reconnecting to its current queue."
        case .redirect: return "The paired connection redirected. No action was forwarded."
        case .uncertainDelivery: return "Delivery is not confirmed. Check the latest chat before retrying; this action was not resent."
        case .server(let message): return message
        }
    }
}
public struct HostIdentity: Codable, Sendable {
    public var id: String
    public var name: String?
    public var kind: String?
}
public struct DeviceIcon: Codable, Sendable {
    public var kind: String?
    public var label: String?
}
public struct WaitingOn: Codable, Sendable {
    public var kind: String?
    public var name: String?
}
public struct ChatMessage: Codable, Identifiable, Sendable {
    public var id: String
    public var role: String
    public var text: String
    public var at: Double?
}
public struct ChatSource: Codable, Identifiable, Sendable {
    public var id: String
    public var title: String?
    public var body: String?
    public var lifecycle: String?
    public var contextLoaded: Bool?
    public var device: DeviceIcon?
    public var queuedMessages: Int?
    public var messageQueue: [JSONValue]?
    public var deliveryOutcomes: [JSONValue]?
    public var messageOutcomes: [JSONValue]?
    public var taskRevision: String?
    public var turnId: String?
    public var turnOutcome: String?
}
public struct TaskCard: Codable, Identifiable, Sendable {
    public var id: String
    public var taskKey: String
    public var contextRevision: String?
    public var title: String
    public var chatName: String?
    public var summary: String?
    public var label: String
    public var status: String
    public var kind: String
    public var sources: [ChatSource]
    public var primarySourceId: String?
    public var threadId: String?
    public var messages: [ChatMessage]?
    public var device: DeviceIcon?
    public var waitingOn: WaitingOn?
    public var urgent: Bool?
    public var readyForReview: Bool?
    public var reviewed: Bool?
    public var snoozed: Bool?
    public var done: Bool?
    public var at: Double?
    public var notificationVersion: String?
    public var error: String?
    public var replyError: String?
    public var priorityRank: Int {
        if status == "needs" || (["blocked", "waiting"].contains(status) && waitingOn?.kind == "you") { return 0 }
        if urgent == true { return 1 }
        if status == "blocked" && waitingOn?.kind != "other" { return 2 }
        if readyForReview == true && !["waiting", "blocked"].contains(status) { return 3 }
        return ["queued":4, "starting":5, "working":5, "waiting":6, "blocked":6][status] ?? 7
    }
    public var canComplete: Bool {
        !["starting", "working"].contains(status) && (status != "needs" || readyForReview == true)
    }
}
public enum JSONValue: Codable, Sendable {
    case string(String), number(Double), bool(Bool), object([String:JSONValue]), array([JSONValue]), null
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let v = try? container.decode(Bool.self) { self = .bool(v) }
        else if let v = try? container.decode(String.self) { self = .string(v) }
        else if let v = try? container.decode(Double.self) { self = .number(v) }
        else if let v = try? container.decode([String:JSONValue].self) { self = .object(v) }
        else { self = .array(try container.decode([JSONValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        }
    }
    public var string: String? { if case .string(let v) = self { return v }; return nil }
    public var object: [String:JSONValue]? { if case .object(let v) = self { return v }; return nil }
    public var pretty: String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return (try? String(data: encoder.encode(self), encoding: .utf8)) ?? ""
    }
}
public struct QuestionOption: Codable, Sendable {
    public var label: String
    public var description: String?
}
public struct ApprovalQuestion: Codable, Identifiable, Sendable {
    public var id: String
    public var question: String
    public var options: [QuestionOption]?
}
public struct Approval: Codable, Identifiable, Sendable {
    public var id: String
    public var taskId: String
    public var kind: String
    public var reason: String?
    public var command: String?
    public var cwd: String?
    public var questions: [ApprovalQuestion]?
    public var permissions: JSONValue?
    public var grantRoot: String?
}
public struct QueueSettings: Codable, Sendable { public var projects: [String]? }
public struct QueueHealth: Codable, Sendable { public var ok: Bool?; public var message: String? }
public struct QueueState: Codable, Sendable {
    public var peerContract: PeerContract?
    public var protocolVersion: Int?
    public var host: HostIdentity?
    public var servedAt: Double?
    public var stateVersion: QueueStateVersion?
    public var cards: [TaskCard]
    public var done: [TaskCard]
    public var approvals: [Approval]
    public var settings: QueueSettings
    public var health: QueueHealth?
    public var undo: Bool?
    public var monitoredCount: Int?
    public static func decode(_ data: Data) throws -> QueueState {
        guard data.count <= 16_000_000 else { throw PeerError.responseTooLarge }
        let state = try JSONDecoder().decode(QueueState.self, from: data)
        if let protocolVersion=state.protocolVersion, ![2,3].contains(protocolVersion) {throw PeerError.unsupportedState}
        try state.peerContract?.validate()
        if state.peerContract != nil && state.stateVersion == nil {throw PeerError.unsupportedState}
        guard state.cards.count + state.done.count <= 10_000,
              (state.cards + state.done).allSatisfy({ !$0.id.isEmpty && !$0.taskKey.isEmpty && $0.id.count <= 2048 }) else { throw PeerError.unsupportedState }
        return state
    }
    public func supports(_ command:String) -> Bool {
        peerContract.map{$0.commands.contains(command)} ?? PeerContract.legacy.contains(command)
    }
}
public struct PairedComputer: Codable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var code: String
    public init(name: String, code: String, id: String = UUID().uuidString) {self.id=id; self.name=name; self.code=code}
}
