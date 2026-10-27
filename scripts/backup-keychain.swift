import Foundation
import Security

// This executable has access to one newly provisioned backup key only. Compile
// it once at the stable private tools path; do not read the login keychain broadly.
let service = "jesie-backup-2026"
let account = "aes256gcm-v1"

func fail(_ code: String, _ status: OSStatus? = nil) -> Never {
    var result: [String: Any] = ["ok": false, "code": code, "keyService": service]
    if let value = status { result["status"] = Int(value) }
    if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) {
        FileHandle.standardError.write(data)
        FileHandle.standardError.write(Data([10]))
    }
    exit(1)
}

// No password or approval dialog may be opened by this helper. A locked keychain
// or a missing application permission fails closed for the operator to inspect.
let interactionStatus = SecKeychainSetUserInteractionAllowed(false)
if interactionStatus != errSecSuccess { fail("KEYCHAIN_INTERACTION_GUARD_FAILED", interactionStatus) }
guard CommandLine.arguments.count == 2 else { fail("KEYCHAIN_MODE_REQUIRED") }
let mode = CommandLine.arguments[1]
let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
    kSecAttrSynchronizable as String: false,
]

if mode == "create" {
    let key = FileHandle.standardInput.readDataToEndOfFile()
    guard key.count == 32 else { fail("BACKUP_KEY_LENGTH_INVALID") }
    var trusted: SecTrustedApplication?
    let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.path
    let trustedStatus = SecTrustedApplicationCreateFromPath(executable, &trusted)
    guard trustedStatus == errSecSuccess, let trustedApplication = trusted else {
        fail("KEYCHAIN_TRUSTED_APPLICATION_FAILED", trustedStatus)
    }
    var access: SecAccess?
    let accessStatus = SecAccessCreate("jesie.pl encrypted backup key" as CFString,
                                     [trustedApplication] as CFArray, &access)
    guard accessStatus == errSecSuccess, let entryAccess = access else {
        fail("KEYCHAIN_ACCESS_POLICY_FAILED", accessStatus)
    }
    var item = query
    item[kSecValueData as String] = key
    item[kSecAttrLabel as String] = "jesie.pl backup AES-256-GCM (2026)"
    item[kSecAttrAccess as String] = entryAccess
    let status = SecItemAdd(item as CFDictionary, nil)
    guard status == errSecSuccess || status == errSecDuplicateItem else {
        fail("KEYCHAIN_CREATE_FAILED", status)
    }
    let result: [String: Any] = ["ok": true, "created": status == errSecSuccess,
                               "keyService": service, "keyAccount": account]
    guard let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) else {
        fail("KEYCHAIN_RESPONSE_FAILED")
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
} else if mode == "read" {
    var readQuery = query
    readQuery[kSecReturnData as String] = true
    readQuery[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(readQuery as CFDictionary, &result)
    guard status == errSecSuccess, let key = result as? Data, key.count == 32 else {
        fail("KEYCHAIN_READ_FAILED", status)
    }
    // Raw key bytes are an internal pipe to encrypt-backup.ts, never a log line.
    FileHandle.standardOutput.write(key)
} else {
    fail("KEYCHAIN_MODE_INVALID")
}
