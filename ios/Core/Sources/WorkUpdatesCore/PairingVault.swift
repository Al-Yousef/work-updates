import Foundation
import Security
public enum PairingVault {
    private static let service="io.workupdates.iphone.devices"
    public static func load() throws -> [PairedComputer] {
        let query:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:service,
            kSecAttrAccount as String:"paired-computers",kSecReturnData as String:true,kSecMatchLimit as String:kSecMatchLimitOne]
        var result:CFTypeRef?
        let status=SecItemCopyMatching(query as CFDictionary,&result)
        if status == errSecItemNotFound {return []}
        guard status == errSecSuccess,let data=result as? Data else {throw PeerError.server("Unlock your iPhone to read its saved device connections.")}
        return try JSONDecoder().decode([PairedComputer].self,from:data)
    }
    public static func save(_ computers:[PairedComputer]) throws {
        let query:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:service,kSecAttrAccount as String:"paired-computers"]
        if computers.isEmpty {let status=SecItemDelete(query as CFDictionary);guard status == errSecSuccess || status == errSecItemNotFound else {throw PeerError.server("Could not forget saved pairings.")};return}
        let data=try JSONEncoder().encode(computers)
        let status=SecItemUpdate(query as CFDictionary,[kSecValueData as String:data] as CFDictionary)
        if status == errSecItemNotFound {
            var add=query;add[kSecValueData as String]=data;add[kSecAttrAccessible as String]=kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            guard SecItemAdd(add as CFDictionary,nil) == errSecSuccess else {throw PeerError.server("Could not save the pairing in your iPhone Keychain.")}
        } else if status != errSecSuccess {throw PeerError.server("Could not save the pairing in your iPhone Keychain.")}
    }
}
