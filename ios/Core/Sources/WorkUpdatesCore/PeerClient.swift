import Foundation
import Security
import CryptoKit

// The private endpoint and its exact certificate are validated before URLSession
// can send the bearer token. Redirects never carry credentials to another endpoint.
final class PinnedDelegate: NSObject, URLSessionDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    let pairing: PairingCode
    init(_ pairing: PairingCode) {self.pairing=pairing}
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        authenticate(challenge, completionHandler:completionHandler)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        authenticate(challenge, completionHandler:completionHandler)
    }
    private func authenticate(_ challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host == pairing.host,
              challenge.protectionSpace.port == pairing.port,
              let trust = challenge.protectionSpace.serverTrust,
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let cert = chain.first else {
            completionHandler(.cancelAuthenticationChallenge,nil); return
        }
        let raw = SecCertificateCopyData(cert) as Data
        let pin = SHA256.hash(data: raw).map {String(format:"%02x",$0)}.joined()
        guard pin == pairing.pin else {completionHandler(.cancelAuthenticationChallenge,nil);return}
        completionHandler(.useCredential,URLCredential(trust:trust))
    }
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {completionHandler(nil)}
}
public protocol PeerConnection: AnyObject, Sendable {
    func state() async throws -> QueueState
    func events(_ receive: @escaping @Sendable (QueueState) async throws -> Void) async throws
    func command(_ method: String, input: [String:JSONValue]) async throws -> JSONValue
    func close()
}
public final class PeerClient: PeerConnection, @unchecked Sendable {
    public let pairing: PairingCode
    private let session: URLSession
    private let delegate: PinnedDelegate
    public init(code: String) throws {
        pairing = try PairingCode(code)
        delegate = PinnedDelegate(pairing)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 45
        configuration.timeoutIntervalForResource = 86_400
        configuration.tlsMinimumSupportedProtocolVersion = .TLSv12
        session = URLSession(configuration:configuration,delegate:delegate,delegateQueue:nil)
    }
    private func request(_ path: String, method: String = "GET", body: Data? = nil) -> URLRequest {
        var request = URLRequest(url:pairing.baseURL.appendingPathComponent(path))
        request.httpMethod = method
        request.setValue("Bearer " + pairing.token,forHTTPHeaderField:"Authorization")
        request.setValue("application/json",forHTTPHeaderField:"Accept")
        request.httpBody = body
        if body != nil {request.setValue("application/json",forHTTPHeaderField:"Content-Type")}
        return request
    }
    private func status(_ response: URLResponse) throws -> Int {
        guard let response = response as? HTTPURLResponse else {throw PeerError.unsupportedState}
        if response.statusCode == 401 {throw PeerError.revoked}
        if (300...399).contains(response.statusCode) {throw PeerError.redirect}
        return response.statusCode
    }
    public func state() async throws -> QueueState {
        let (bytes,response) = try await session.bytes(for:request("state"),delegate:delegate)
        guard try status(response) == 200 else {throw PeerError.server("The computer could not return its queue.")}
        var data = Data()
        for try await byte in bytes {
            data.append(byte)
            if data.count > 16_000_000 {throw PeerError.responseTooLarge}
        }
        return try QueueState.decode(data)
    }
    public func events(_ receive: @escaping @Sendable (QueueState) async throws -> Void) async throws {
        let (bytes,response) = try await session.bytes(for:request("events"),delegate:delegate)
        guard try status(response) == 200 else {throw PeerError.server("The computer could not stream updates.")}
        var frame = Data(), line = Data()
        for try await byte in bytes {
            try Task.checkCancellation()
            if byte == 10 {
                if line.last == 13 {line.removeLast()}
                if line.isEmpty {
                    if !frame.isEmpty {try await receive(QueueState.decode(frame));frame.removeAll(keepingCapacity:true)}
                } else if line.starts(with:Data("data: ".utf8)) {
                    if !frame.isEmpty {frame.append(10)}
                    frame.append(line.dropFirst(6))
                }
                line.removeAll(keepingCapacity:true)
            } else {line.append(byte)}
            if frame.count + line.count > 16_000_000 {throw PeerError.responseTooLarge}
        }
        throw PeerError.server("Connection ended. Reconnecting to this computer.")
    }
    public func command(_ method: String, input: [String:JSONValue]) async throws -> JSONValue {
        let allowed=PeerContract.supported
        guard allowed.contains(method) else {throw PeerError.server("Unsupported app action.")}
        var parameters=input
        let epoch=parameters.removeValue(forKey:"_peerHostEpoch")?.string
        var envelope:[String:JSONValue]=["method":.string(method),"input":.object(parameters)]
        if let epoch {envelope["peerProtocolVersion"] = .number(2);envelope["hostEpoch"] = .string(epoch)}
        let data = try JSONEncoder().encode(JSONValue.object(envelope))
        guard data.count <= 64_000 else {throw PeerError.server("This message is too long.")}
        do {
            let (bytes,response) = try await session.bytes(for:request("command",method:"POST",body:data),delegate:delegate)
            let code = try status(response)
            guard code == 200 || code == 400 else {throw PeerError.uncertainDelivery}
            var result = Data()
            for try await byte in bytes {
                result.append(byte)
                if result.count > 16_000_000 {throw PeerError.responseTooLarge}
            }
            let envelope = try JSONDecoder().decode(JSONValue.self,from:result).object
            guard case .bool(true)? = envelope?["ok"] else {
                throw PeerError.server(envelope?["error"]?.string ?? "The computer rejected this action.")
            }
            return envelope?["value"] ?? .null
        } catch let error as PeerError {throw error}
          catch {throw PeerError.uncertainDelivery}
    }
    public func close() {session.invalidateAndCancel()}
}
