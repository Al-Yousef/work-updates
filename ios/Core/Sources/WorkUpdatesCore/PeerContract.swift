import Foundation

public struct PeerContract: Codable, Sendable {
    public let schema: Int
    public let version: Int
    public let minimumVersion: Int
    public let commands: [String]
    public let receiptVersion: Int
    public let attachments: Bool
    public let assistant: Bool
    public let orderedSnapshots: Bool
    public let sourceBoundMessages: Bool
    public let executorReports:Int?
    public static let supported: Set<String> = ["create","start","action","undo","send","queueMessage","cancelMessage","clearMessages","stop","respond","details","group","refresh","open"]
    public static let legacy: Set<String> = ["create","start","action","undo","send","stop","respond","details","group","refresh","open"]
    public func validate() throws {
        guard schema == 1, version == 2, minimumVersion == 1, receiptVersion == 1,
              !attachments, !assistant, orderedSnapshots, sourceBoundMessages,
              executorReports==nil || executorReports==1,
              commands.count <= Self.supported.count, Set(commands).count == commands.count,
              commands.allSatisfy({Self.supported.contains($0)}) else {throw PeerError.unsupportedState}
    }
}

// An HTTP success alone cannot clear a message draft.
public struct DeliveryReceipt: Sendable {
    public let messageID: String
    public let sourceID: String
    public let delivery: String
    public let turnID: String?
    public let taskID: String?
    public static func decode(_ value: JSONValue, messageID: String, sourceID: String) throws -> DeliveryReceipt {
        guard let result = value.object,
              result["messageId"]?.string == messageID,
              result["sourceId"]?.string == sourceID,
              let delivery = result["delivery"]?.string,
              ["queued","sent","cancelled"].contains(delivery),
              delivery != "sent" || !(result["turnId"]?.string ?? "").isEmpty
        else {throw PeerError.uncertainDelivery}
        return DeliveryReceipt(messageID:messageID, sourceID:sourceID, delivery:delivery,
                               turnID:result["turnId"]?.string, taskID:result["taskId"]?.string)
    }
}
