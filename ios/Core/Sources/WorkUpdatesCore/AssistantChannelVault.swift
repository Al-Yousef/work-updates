import Foundation
import Security

public enum AssistantChannelVault {
    private static func held(_ status:OSStatus) -> PeerError {
        if status==errSecMissingEntitlement {return .server("This build cannot access the iPhone Keychain. Use a correctly signed build.")}
        return .server("The private assistant credential is unavailable in Keychain. Unlock this device and reconnect; no question was sent.")
    }
    private static let service="io.workupdates.iphone.private-assistant"
    public static func load() throws -> String? {
        let query:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:service,kSecAttrAccount as String:"owner-channel",kSecReturnData as String:true,kSecMatchLimit as String:kSecMatchLimitOne]
        var item:CFTypeRef?;let status=SecItemCopyMatching(query as CFDictionary,&item)
        if status==errSecItemNotFound {return nil}
        guard status==errSecSuccess,let data=item as? Data,let code=String(data:data,encoding:.utf8) else {throw held(status)}
        _ = try AssistantChannelCode(code);return code
    }
    public static func save(_ code:String?) throws {
        let query:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:service,kSecAttrAccount as String:"owner-channel"]
        guard let code else {let status=SecItemDelete(query as CFDictionary);guard status==errSecSuccess || status==errSecItemNotFound else {throw held(status)};return}
        _ = try AssistantChannelCode(code);let data=Data(code.utf8)
        let status=SecItemUpdate(query as CFDictionary,[kSecValueData as String:data] as CFDictionary)
        if status==errSecItemNotFound {var add=query;add[kSecValueData as String]=data;add[kSecAttrAccessible as String]=kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            let added=SecItemAdd(add as CFDictionary,nil);guard added==errSecSuccess else {throw held(added)}}
        else if status != errSecSuccess {throw held(status)}
    }
}
