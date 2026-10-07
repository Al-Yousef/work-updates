import Foundation
import Security

public enum AssistantChannelVault {
    private static let service="io.workupdates.iphone.private-assistant"
    public static func load() throws -> String? {
        let query:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:service,kSecAttrAccount as String:"owner-channel",kSecReturnData as String:true,kSecMatchLimit as String:kSecMatchLimitOne]
        var item:CFTypeRef?;let status=SecItemCopyMatching(query as CFDictionary,&item)
        if status==errSecItemNotFound {return nil}
        guard status==errSecSuccess,let data=item as? Data,let code=String(data:data,encoding:.utf8) else {throw PeerError.unpaired}
        _ = try AssistantChannelCode(code);return code
    }
    public static func save(_ code:String?) throws {
        let query:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:service,kSecAttrAccount as String:"owner-channel"]
        guard let code else {let status=SecItemDelete(query as CFDictionary);guard status==errSecSuccess || status==errSecItemNotFound else {throw PeerError.unpaired};return}
        _ = try AssistantChannelCode(code);let data=Data(code.utf8)
        let status=SecItemUpdate(query as CFDictionary,[kSecValueData as String:data] as CFDictionary)
        if status==errSecItemNotFound {var add=query;add[kSecValueData as String]=data;add[kSecAttrAccessible as String]=kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            guard SecItemAdd(add as CFDictionary,nil)==errSecSuccess else {throw PeerError.unpaired}}
        else if status != errSecSuccess {throw PeerError.unpaired}
    }
}
