import Foundation

public struct QueueStateVersion: Codable, Equatable, Sendable {
    public var epoch: String
    public var revision: Int64
    public init(epoch: String, revision: Int64) {self.epoch=epoch;self.revision=revision}
}

// A host run has an opaque epoch and strictly increasing snapshot revisions.
// A different epoch needs a new connection baseline, never a timestamp guess.
public struct StateOrder: Sendable {
    private var current: QueueStateVersion?
    public init() {}
    public mutating func accept(_ version: QueueStateVersion?) throws -> Bool {
        guard let version,version.epoch.count==36,UUID(uuidString:version.epoch) != nil,
              (1...9_007_199_254_740_991).contains(version.revision) else {throw PeerError.unsupportedState}
        if let current {
            guard version.epoch==current.epoch else {throw PeerError.hostRestarted}
            guard version.revision>current.revision else {return false}
        }
        current=version
        return true
    }
}
