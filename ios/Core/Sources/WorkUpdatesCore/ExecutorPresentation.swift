import Foundation

public struct ExecutorPresentation:Codable,Sendable {
    public let schema:Int
    public let deviceId:String
    public let binding:String
    public let liveExecutorVerified:Bool
    public let cloud:Bool
    public let capabilities:[String]
    public let access:String?
    public let serverVersion:String?
    public let verifiedAt:Double?
    public func validate() throws {
        guard schema==1,!deviceId.isEmpty,deviceId.count<=512,!liveExecutorVerified,!cloud,
              ["recorded_grant","unreported","storage_held"].contains(binding),
              binding=="recorded_grant" ? capabilities==["task_create","task_continue","turn_interrupt"] &&
                ["active","revoked"].contains(access ?? "") && !(serverVersion ?? "").isEmpty &&
                (serverVersion?.count ?? 0)<=512 && (verifiedAt ?? 0)>0 && (verifiedAt?.isFinite ?? false) : capabilities.isEmpty
        else {throw PeerError.unsupportedState}
    }
    public var caption:String {
        if binding=="storage_held" {return "Executor storage needs recovery. Work stays on its original computer."}
        if binding != "recorded_grant" {return "Executor grant is unreported for this source."}
        return "Recorded local executor grant · "+(access ?? "unknown")+" · "+(serverVersion ?? "unknown")+". Current provider access is rechecked before dispatch."
    }
}
