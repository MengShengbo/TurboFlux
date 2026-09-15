import AppKit
import ApplicationServices
import Darwin
import Foundation

typealias JSON = [String: Any]

private let maxWindows = 120
private let maxElements = 160
private let maxElementDepth = 9

private func respond(_ payload: JSON, code: Int32 = 0) -> Never {
    var result = payload
    result["ok"] = code == 0
    if let data = try? JSONSerialization.data(withJSONObject: result, options: []) {
        FileHandle.standardOutput.write(data)
    }
    exit(code)
}

private func fail(_ message: String) -> Never {
    respond(["error": message], code: 1)
}

private func requestJSON() -> JSON {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard !data.isEmpty,
          let value = try? JSONSerialization.jsonObject(with: data),
          let request = value as? JSON else {
        fail("Invalid JSON request")
    }
    return request
}

private func string(_ value: Any?) -> String? {
    guard let value = value as? String else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
}

private func number(_ value: Any?) -> Double? {
    if let value = value as? NSNumber { return value.doubleValue }
    return nil
}

private func integer(_ value: Any?) -> Int? {
    if let value = value as? NSNumber { return value.intValue }
    return nil
}

private func appJSON(_ app: NSRunningApplication) -> JSON {
    var result: JSON = [
        "pid": Int(app.processIdentifier),
        "name": app.localizedName ?? "Application",
        "active": app.isActive,
        "hidden": app.isHidden,
    ]
    if let bundleIdentifier = app.bundleIdentifier { result["bundleId"] = bundleIdentifier }
    if let bundleURL = app.bundleURL { result["bundlePath"] = bundleURL.path }
    return result
}

private func runningApp(pid: pid_t) -> NSRunningApplication? {
    NSRunningApplication(processIdentifier: pid)
}

private func windowList() -> [JSON] {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return [] }
    var windows: [JSON] = []
    for item in raw {
        guard windows.count < maxWindows,
              let windowId = item[kCGWindowNumber as String] as? NSNumber,
              let ownerPID = item[kCGWindowOwnerPID as String] as? NSNumber,
              let ownerName = item[kCGWindowOwnerName as String] as? String,
              let boundsDictionary = item[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: boundsDictionary) else { continue }
        let layer = (item[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
        let alpha = (item[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
        if bounds.width < 2 || bounds.height < 2 || alpha <= 0 { continue }
        var window: JSON = [
            "id": windowId.intValue,
            "pid": ownerPID.intValue,
            "appName": ownerName,
            "bounds": ["x": bounds.origin.x, "y": bounds.origin.y, "width": bounds.width, "height": bounds.height],
            "layer": layer,
            "onscreen": (item[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? true,
        ]
        if let title = string(item[kCGWindowName as String]) { window["title"] = String(title.prefix(300)) }
        if let app = runningApp(pid: ownerPID.int32Value), let bundleId = app.bundleIdentifier { window["bundleId"] = bundleId }
        windows.append(window)
    }
    return windows
}

private func focusedWindowJSON(_ windows: [JSON], frontmostPID: pid_t?) -> JSON? {
    guard let frontmostPID else { return nil }
    return windows.first { integer($0["pid"]) == Int(frontmostPID) && integer($0["layer"]) == 0 }
}

private func bounds(_ value: Any?) -> CGRect? {
    guard let value = value as? JSON,
          let x = number(value["x"]), let y = number(value["y"]),
          let width = number(value["width"]), let height = number(value["height"]) else { return nil }
    return CGRect(x: x, y: y, width: width, height: height)
}

private func windowContainsPoint(_ window: JSON, point: CGPoint) -> Bool {
    guard let frame = bounds(window["bounds"]) else { return false }
    return frame.contains(point)
}

private func boundsMatch(_ actual: CGRect, _ expected: CGRect, tolerance: CGFloat = 2) -> Bool {
    abs(actual.origin.x - expected.origin.x) <= tolerance
        && abs(actual.origin.y - expected.origin.y) <= tolerance
        && abs(actual.width - expected.width) <= tolerance
        && abs(actual.height - expected.height) <= tolerance
}

private struct ExpectedTarget {
    let pid: Int
    let bundleId: String
    let windowId: Int
    let bounds: CGRect
}

private func validateExpectedTarget(_ rawExpected: JSON?, requireFrontmost: Bool = true) -> (ExpectedTarget, [JSON]) {
    guard let rawExpected,
          let expectedPID = integer(rawExpected["pid"]),
          let expectedBundleID = string(rawExpected["bundleId"]),
          let expectedWindowID = integer(rawExpected["windowId"]),
          let expectedBounds = bounds(rawExpected["bounds"]),
          expectedBounds.width >= 2,
          expectedBounds.height >= 2 else {
        fail("A complete expected computer target is required")
    }

    let expected = ExpectedTarget(
        pid: expectedPID,
        bundleId: expectedBundleID,
        windowId: expectedWindowID,
        bounds: expectedBounds
    )
    guard let targetApplication = runningApp(pid: pid_t(expected.pid)),
          targetApplication.bundleIdentifier == expected.bundleId else {
        fail("The target application closed or changed; observe again")
    }

    let windows = windowList()
    guard let targetWindow = windows.first(where: { integer($0["id"]) == expected.windowId }),
          integer(targetWindow["pid"]) == expected.pid,
          string(targetWindow["bundleId"]) == expected.bundleId,
          let targetBounds = bounds(targetWindow["bounds"]),
          boundsMatch(targetBounds, expected.bounds) else {
        fail("The target window moved, closed, or changed; observe again")
    }
    if requireFrontmost {
        guard let frontmostApplication = NSWorkspace.shared.frontmostApplication,
              Int(frontmostApplication.processIdentifier) == expected.pid,
              frontmostApplication.bundleIdentifier == expected.bundleId,
              let focusedWindow = focusedWindowJSON(windows, frontmostPID: frontmostApplication.processIdentifier),
              integer(focusedWindow["id"]) == expected.windowId else {
            fail("The foreground application changed; observe again")
        }
    }
    return (expected, windows)
}

private func validatePointerTargets(points: [CGPoint], expected: JSON?) {
    let (target, windows) = validateExpectedTarget(expected)
    for point in points {
        guard let owner = windows.first(where: { windowContainsPoint($0, point: point) }),
              integer(owner["id"]) == target.windowId,
              integer(owner["pid"]) == target.pid,
              string(owner["bundleId"]) == target.bundleId,
              let ownerBounds = bounds(owner["bounds"]),
              boundsMatch(ownerBounds, target.bounds) else {
            fail("The pointer target is no longer owned by the observed window")
        }
    }
}

private func validatePointerTarget(point: CGPoint, expected: JSON?) {
    guard expected != nil else {
        fail("A complete expected pointer target is required")
    }
    validatePointerTargets(points: [point], expected: expected)
}

private func axValue(_ element: AXUIElement, _ attribute: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
    return value
}

private func axString(_ element: AXUIElement, _ attribute: CFString) -> String? {
    guard let value = axValue(element, attribute) else { return nil }
    if let text = value as? String { return string(text) }
    if let attributed = value as? NSAttributedString { return string(attributed.string) }
    if let number = value as? NSNumber { return number.stringValue }
    return nil
}

private func axBool(_ element: AXUIElement, _ attribute: CFString) -> Bool? {
    (axValue(element, attribute) as? NSNumber)?.boolValue
}

private func axElement(_ element: AXUIElement, _ attribute: CFString) -> AXUIElement? {
    guard let value = axValue(element, attribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(value, to: AXUIElement.self)
}

private func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    guard let value = axValue(element, kAXChildrenAttribute as CFString) as? [Any] else { return [] }
    return value.compactMap { child in
        let reference = child as CFTypeRef
        guard CFGetTypeID(reference) == AXUIElementGetTypeID() else { return nil }
        return unsafeBitCast(reference, to: AXUIElement.self)
    }
}

private func axPoint(_ element: AXUIElement, _ attribute: CFString) -> CGPoint? {
    guard let value = axValue(element, attribute), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    return AXValueGetValue(unsafeBitCast(value, to: AXValue.self), .cgPoint, &point) ? point : nil
}

private func axSize(_ element: AXUIElement, _ attribute: CFString) -> CGSize? {
    guard let value = axValue(element, attribute), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var size = CGSize.zero
    return AXValueGetValue(unsafeBitCast(value, to: AXValue.self), .cgSize, &size) ? size : nil
}

private func focusedApplicationElement() -> AXUIElement? {
    axElement(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute as CFString)
}

private func focusedWindowElement() -> AXUIElement? {
    guard let application = focusedApplicationElement() else { return nil }
    AXUIElementSetMessagingTimeout(application, 1.5)
    return axElement(application, kAXFocusedWindowAttribute as CFString)
}

private func targetWindowElement(pid: pid_t, window: JSON?) -> AXUIElement? {
    let application = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(application, 1.5)
    guard let rawWindows = axValue(application, kAXWindowsAttribute as CFString) as? [Any] else { return nil }
    let candidates = rawWindows.compactMap { value -> AXUIElement? in
        let reference = value as CFTypeRef
        guard CFGetTypeID(reference) == AXUIElementGetTypeID() else { return nil }
        return unsafeBitCast(reference, to: AXUIElement.self)
    }
    if let expectedBounds = bounds(window?["bounds"]) {
        if let matched = candidates.first(where: { element in
            guard let position = axPoint(element, kAXPositionAttribute as CFString),
                  let size = axSize(element, kAXSizeAttribute as CFString) else { return false }
            return boundsMatch(CGRect(origin: position, size: size), expectedBounds)
        }) { return matched }
    }
    return axElement(application, kAXFocusedWindowAttribute as CFString) ?? candidates.first
}

private func focusedElementJSON() -> JSON? {
    let system = AXUIElementCreateSystemWide()
    guard let element = axElement(system, kAXFocusedUIElementAttribute as CFString) else { return nil }
    let role = axString(element, kAXRoleAttribute as CFString)
    let subrole = axString(element, kAXSubroleAttribute as CFString)
    let secure = subrole == "AXSecureTextField"
    var result: JSON = ["secure": secure]
    if let role { result["role"] = role }
    if let subrole { result["subrole"] = subrole }
    if let title = axString(element, kAXTitleAttribute as CFString) { result["title"] = String(title.prefix(240)) }
    return result
}

private let observedRoles: Set<String> = [
    "AXButton", "AXCheckBox", "AXComboBox", "AXDisclosureTriangle", "AXLink", "AXMenuButton",
    "AXMenuItem", "AXPopUpButton", "AXRadioButton", "AXSearchField", "AXSecureTextField",
    "AXSlider", "AXStaticText", "AXTab", "AXTextArea", "AXTextField", "AXToolbarButton",
]

private func elementJSON(_ element: AXUIElement, ref: String) -> JSON? {
    guard let role = axString(element, kAXRoleAttribute as CFString) else { return nil }
    let subrole = axString(element, kAXSubroleAttribute as CFString)
    let title = axString(element, kAXTitleAttribute as CFString)
        ?? axString(element, kAXDescriptionAttribute as CFString)
        ?? axString(element, kAXHelpAttribute as CFString)
    let position = axPoint(element, kAXPositionAttribute as CFString)
    let size = axSize(element, kAXSizeAttribute as CFString)
    let secure = subrole == "AXSecureTextField" || role == "AXSecureTextField"
    if !observedRoles.contains(role) && title == nil { return nil }
    if let size, (size.width < 1 || size.height < 1) { return nil }
    var result: JSON = [
        "ref": ref,
        "role": role,
        "enabled": axBool(element, kAXEnabledAttribute as CFString) ?? true,
        "focused": axBool(element, kAXFocusedAttribute as CFString) ?? false,
        "secure": secure,
    ]
    if let subrole { result["subrole"] = subrole }
    if let title { result["title"] = String(title.prefix(300)) }
    if let description = axString(element, kAXDescriptionAttribute as CFString) { result["description"] = String(description.prefix(300)) }
    if !secure, let value = axString(element, kAXValueAttribute as CFString), value != title { result["value"] = String(value.prefix(400)) }
    if let position, let size {
        result["bounds"] = ["x": position.x, "y": position.y, "width": size.width, "height": size.height]
    }
    return result
}

private func accessibilityElements(root requestedRoot: AXUIElement? = nil) -> [JSON] {
    guard AXIsProcessTrusted(), let root = requestedRoot ?? focusedWindowElement() else { return [] }
    var result: [JSON] = []
    var visited = Set<CFHashCode>()
    func visit(_ element: AXUIElement, path: [Int], depth: Int) {
        guard result.count < maxElements, depth <= maxElementDepth else { return }
        let hash = CFHash(element)
        guard !visited.contains(hash) else { return }
        visited.insert(hash)
        let ref = "ax:" + path.map(String.init).joined(separator: ".")
        if let item = elementJSON(element, ref: ref) { result.append(item) }
        for (index, child) in axChildren(element).enumerated() {
            if result.count >= maxElements { break }
            visit(child, path: path + [index], depth: depth + 1)
        }
    }
    visit(root, path: [], depth: 0)
    return result
}

private func resolveElement(ref: String, root requestedRoot: AXUIElement? = nil) -> AXUIElement? {
    guard ref.hasPrefix("ax:"), let root = requestedRoot ?? focusedWindowElement() else { return nil }
    let suffix = String(ref.dropFirst(3))
    if suffix.isEmpty { return root }
    var current = root
    for component in suffix.split(separator: ".") {
        guard let index = Int(component) else { return nil }
        let children = axChildren(current)
        guard index >= 0 && index < children.count else { return nil }
        current = children[index]
    }
    return current
}

private func validateElement(_ element: AXUIElement, expected: JSON?) {
    guard let expected else { return }
    if let role = string(expected["role"]), axString(element, kAXRoleAttribute as CFString) != role {
        fail("The accessibility reference is stale; observe the application again")
    }
    if let title = string(expected["title"]),
       let actual = axString(element, kAXTitleAttribute as CFString) ?? axString(element, kAXDescriptionAttribute as CFString),
       actual != title {
        fail("The accessibility reference changed; observe the application again")
    }
}

private func ensureAccessibilityTrusted() {
    guard AXIsProcessTrusted() else { fail("Accessibility permission is required") }
}

private func ensureSessionUnlocked() {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else {
        fail("Unable to verify the screen lock state")
    }
    if session["CGSSessionScreenIsLocked"] as? Bool == true {
        fail("Computer control is unavailable while the screen is locked")
    }
}

private func ensureInputTrusted() {
    ensureSessionUnlocked()
    ensureAccessibilityTrusted()
    guard CGPreflightPostEventAccess() else { fail("Input control permission is required") }
}

private func requestAccessibilityAccess() -> Bool {
    let options = [
        kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true,
    ] as CFDictionary
    return AXIsProcessTrustedWithOptions(options)
}

private func mouseButton(_ value: String?) -> CGMouseButton {
    switch value?.lowercased() {
    case "right": return .right
    case "middle": return .center
    default: return .left
    }
}

private func mouseType(button: CGMouseButton, down: Bool, dragged: Bool = false) -> CGEventType {
    if dragged {
        if button == .right { return .rightMouseDragged }
        if button == .center { return .otherMouseDragged }
        return .leftMouseDragged
    }
    if button == .right { return down ? .rightMouseDown : .rightMouseUp }
    if button == .center { return down ? .otherMouseDown : .otherMouseUp }
    return down ? .leftMouseDown : .leftMouseUp
}

private func postMouse(type: CGEventType, point: CGPoint, button: CGMouseButton, clickState: Int64 = 1) {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
        fail("Unable to create mouse event")
    }
    event.setIntegerValueField(.mouseEventClickState, value: clickState)
    event.post(tap: .cghidEventTap)
}

private let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8,
    "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
    "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33,
    "i": 34, "p": 35, "enter": 36, "return": 36, "l": 37, "j": 38, "'": 39,
    "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47,
    "tab": 48, "space": 49, "backspace": 51, "delete": 51, "escape": 53, "esc": 53,
    "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119,
    "pageup": 116, "pagedown": 121, "forwarddelete": 117,
]

private func keyFlags(_ keys: [String]) -> CGEventFlags {
    var flags: CGEventFlags = []
    for key in keys.map({ $0.lowercased() }) {
        if ["meta", "command", "cmd"].contains(key) { flags.insert(.maskCommand) }
        if ["control", "ctrl"].contains(key) { flags.insert(.maskControl) }
        if ["option", "alt"].contains(key) { flags.insert(.maskAlternate) }
        if key == "shift" { flags.insert(.maskShift) }
    }
    return flags
}

private func postKey(keys: [String], pid: pid_t?) {
    let normalized = keys.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }.filter { !$0.isEmpty }
    let modifiers = Set(["meta", "command", "cmd", "control", "ctrl", "option", "alt", "shift"])
    guard let key = normalized.last(where: { !modifiers.contains($0) }), let code = keyCodes[key] else {
        fail("Unsupported key combination")
    }
    let flags = keyFlags(normalized)
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else {
        fail("Unable to create keyboard event")
    }
    down.flags = flags
    up.flags = flags
    if let pid {
        down.postToPid(pid)
        usleep(18_000)
        up.postToPid(pid)
    } else {
        down.post(tap: .cghidEventTap)
        usleep(18_000)
        up.post(tap: .cghidEventTap)
    }
}

private func postText(_ text: String, pid: pid_t?) {
    for chunkStart in stride(from: 0, to: text.utf16.count, by: 24) {
        let units = Array(text.utf16.dropFirst(chunkStart).prefix(24))
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
            fail("Unable to create text event")
        }
        units.withUnsafeBufferPointer { buffer in
            guard let base = buffer.baseAddress else { return }
            down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
            up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
        }
        if let pid {
            down.postToPid(pid)
            up.postToPid(pid)
        } else {
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
        }
        usleep(10_000)
    }
}

private func findApplication(_ request: JSON) -> NSRunningApplication? {
    let applications = NSWorkspace.shared.runningApplications
    if let pid = integer(request["pid"]) { return applications.first { Int($0.processIdentifier) == pid } }
    if let bundleId = string(request["bundleId"]) { return applications.first { $0.bundleIdentifier == bundleId } }
    if let name = string(request["name"]) {
        return applications.first { ($0.localizedName ?? "").localizedCaseInsensitiveCompare(name) == .orderedSame }
    }
    return nil
}

private func waitForApplication(bundleId: String?, name: String?, timeout: TimeInterval = 5) -> NSRunningApplication? {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
        if let bundleId,
           let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == bundleId }) { return app }
        if let name,
           let app = NSWorkspace.shared.runningApplications.first(where: { ($0.localizedName ?? "").localizedCaseInsensitiveCompare(name) == .orderedSame }) { return app }
        usleep(80_000)
    } while Date() < deadline
    return nil
}

private func openApplication(_ request: JSON) -> NSRunningApplication? {
    let bundleId = string(request["bundleId"])
    let name = string(request["name"])
    if let running = findApplication(request) {
        _ = running.activate(options: [.activateAllWindows])
        return running
    }
    var url: URL?
    if let bundleId { url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) }
    if url == nil, let name {
        let candidates = [
            "/Applications/\(name).app",
            "/System/Applications/\(name).app",
            "/System/Applications/Utilities/\(name).app",
            NSString(string: "~/Applications/\(name).app").expandingTildeInPath,
        ]
        url = candidates.first(where: { FileManager.default.fileExists(atPath: $0) }).map(URL.init(fileURLWithPath:))
    }
    guard let applicationURL = url else { return nil }
    let semaphore = DispatchSemaphore(value: 0)
    var launched: NSRunningApplication?
    NSWorkspace.shared.openApplication(at: applicationURL, configuration: NSWorkspace.OpenConfiguration()) { app, _ in
        launched = app
        semaphore.signal()
    }
    _ = semaphore.wait(timeout: .now() + 5)
    let app = launched ?? waitForApplication(bundleId: bundleId, name: name)
    if let app { _ = app.activate(options: [.activateAllWindows]) }
    return app
}

private let request = requestJSON()
guard let command = string(request["command"]) else { fail("Missing command") }

switch command {
case "snapshot":
    let frontmost = NSWorkspace.shared.frontmostApplication
    let windows = windowList()
    var payload: JSON = [
        "accessibilityTrusted": AXIsProcessTrusted(),
        "postEventTrusted": CGPreflightPostEventAccess(),
        "windows": windows,
    ]
    if let frontmost { payload["frontmostApp"] = appJSON(frontmost) }
    if let focusedWindow = focusedWindowJSON(windows, frontmostPID: frontmost?.processIdentifier) { payload["focusedWindow"] = focusedWindow }
    if let focusedElement = focusedElementJSON() { payload["focusedElement"] = focusedElement }
    let targetPID = integer(request["targetPid"]).map(pid_t.init)
    let targetWindowID = integer(request["targetWindowId"])
    let targetWindow = targetPID.flatMap { pid in
        windows.first { window in
            integer(window["pid"]) == Int(pid)
                && integer(window["layer"]) == 0
                && (targetWindowID == nil || integer(window["id"]) == targetWindowID)
        }
    }
    if let targetPID, let targetApplication = runningApp(pid: targetPID) { payload["targetApp"] = appJSON(targetApplication) }
    if let targetWindow { payload["targetWindow"] = targetWindow }
    if request["includeElements"] as? Bool == true {
        let targetRoot = targetPID.flatMap { targetWindowElement(pid: $0, window: targetWindow) }
        payload["elements"] = accessibilityElements(root: targetRoot)
    }
    respond(payload)

case "apps":
    let applications = NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular && $0.localizedName != nil }
        .map(appJSON)
    respond(["apps": applications])

case "requestPostEvent":
    respond(["granted": CGRequestPostEventAccess()])

case "requestAccessibility":
    respond(["granted": requestAccessibilityAccess()])

case "activate":
    guard let app = findApplication(request) else { fail("Application is not running") }
    guard app.activate(options: [.activateAllWindows]) else { fail("Application could not be activated") }
    usleep(120_000)
    respond(["app": appJSON(app)])

case "open":
    guard let app = openApplication(request) else { fail("Application could not be opened") }
    usleep(160_000)
    respond(["app": appJSON(app)])

case "pointOwner":
    guard let x = number(request["x"]), let y = number(request["y"]) else { fail("Missing point") }
    let point = CGPoint(x: x, y: y)
    let owner = windowList().first { windowContainsPoint($0, point: point) }
    if let owner {
        var result: JSON = [
            "pid": integer(owner["pid"]) ?? 0,
            "appName": string(owner["appName"]) ?? "Application",
            "windowId": integer(owner["id"]) ?? 0,
            "bounds": owner["bounds"] as Any,
        ]
        if let title = owner["title"] { result["title"] = title }
        if let bundleId = owner["bundleId"] { result["bundleId"] = bundleId }
        respond(["owner": result])
    }
    respond(["owner": NSNull()])

case "click":
    ensureInputTrusted()
    guard let x = number(request["x"]), let y = number(request["y"]) else { fail("Missing point") }
    let point = CGPoint(x: x, y: y)
    let button = mouseButton(string(request["button"]))
    let count = max(1, min(2, integer(request["count"]) ?? 1))
    for clickIndex in 1...count {
        validatePointerTarget(point: point, expected: request["expectedTarget"] as? JSON)
        postMouse(type: mouseType(button: button, down: true), point: point, button: button, clickState: Int64(clickIndex))
        usleep(28_000)
        postMouse(type: mouseType(button: button, down: false), point: point, button: button, clickState: Int64(clickIndex))
        if count == 2 { usleep(55_000) }
    }
    respond([:])

case "move":
    ensureInputTrusted()
    guard let x = number(request["x"]), let y = number(request["y"]) else { fail("Missing point") }
    let point = CGPoint(x: x, y: y)
    validatePointerTarget(point: point, expected: request["expectedTarget"] as? JSON)
    postMouse(type: .mouseMoved, point: point, button: .left)
    respond([:])

case "drag":
    ensureInputTrusted()
    guard let rawPoints = request["points"] as? [JSON], rawPoints.count >= 2 else { fail("Drag needs at least two points") }
    let points = rawPoints.compactMap { item -> CGPoint? in
        guard let x = number(item["x"]), let y = number(item["y"]) else { return nil }
        return CGPoint(x: x, y: y)
    }
    guard points.count == rawPoints.count else { fail("Invalid drag path") }
    let button = mouseButton(string(request["button"]))
    validatePointerTargets(points: [points[0], points.last!], expected: request["expectedTarget"] as? JSON)
    postMouse(type: mouseType(button: button, down: true), point: points[0], button: button)
    usleep(45_000)
    for point in points.dropFirst() {
        postMouse(type: mouseType(button: button, down: true, dragged: true), point: point, button: button)
        usleep(18_000)
    }
    postMouse(type: mouseType(button: button, down: false), point: points.last!, button: button)
    respond([:])

case "scroll":
    ensureInputTrusted()
    guard let x = number(request["x"]), let y = number(request["y"]),
          let deltaX = number(request["deltaX"]), let deltaY = number(request["deltaY"]) else { fail("Invalid scroll request") }
    let point = CGPoint(x: x, y: y)
    validatePointerTarget(point: point, expected: request["expectedTarget"] as? JSON)
    postMouse(type: .mouseMoved, point: point, button: .left)
    guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(deltaY), wheel2: Int32(deltaX), wheel3: 0) else {
        fail("Unable to create scroll event")
    }
    event.post(tap: .cghidEventTap)
    respond([:])

case "press":
    ensureInputTrusted()
    guard let keys = request["keys"] as? [String], !keys.isEmpty, keys.count <= 5 else { fail("Invalid key combination") }
    let pid = integer(request["pid"]).map(pid_t.init)
    let (target, _) = validateExpectedTarget(request["expectedTarget"] as? JSON)
    guard pid == pid_t(target.pid) else { fail("The keyboard target does not match the observed application") }
    postKey(keys: keys, pid: pid)
    respond([:])

case "type":
    ensureInputTrusted()
    guard let text = request["text"] as? String, !text.isEmpty, text.utf16.count <= 8_000 else { fail("Invalid text input") }
    let pid = integer(request["pid"]).map(pid_t.init)
    let (target, _) = validateExpectedTarget(request["expectedTarget"] as? JSON)
    guard pid == pid_t(target.pid) else { fail("The text target does not match the observed application") }
    if focusedElementJSON()?["secure"] as? Bool == true { fail("Secure text fields require user takeover") }
    postText(text, pid: pid)
    respond(["characters": text.count])

case "pressElement":
    ensureSessionUnlocked()
    ensureAccessibilityTrusted()
    let (target, windows) = validateExpectedTarget(request["expectedTarget"] as? JSON, requireFrontmost: false)
    let targetWindow = windows.first { integer($0["id"]) == target.windowId }
    let root = targetWindowElement(pid: pid_t(target.pid), window: targetWindow)
    guard let ref = string(request["ref"]), let element = resolveElement(ref: ref, root: root) else { fail("The accessibility reference is stale; observe again") }
    validateElement(element, expected: request["expected"] as? JSON)
    if axString(element, kAXSubroleAttribute as CFString) == "AXSecureTextField" { fail("Secure controls require user takeover") }
    guard AXUIElementPerformAction(element, kAXPressAction as CFString) == .success else { fail("The control does not support the press action") }
    respond([:])

case "setElementValue":
    ensureSessionUnlocked()
    ensureAccessibilityTrusted()
    let (target, windows) = validateExpectedTarget(request["expectedTarget"] as? JSON, requireFrontmost: false)
    let targetWindow = windows.first { integer($0["id"]) == target.windowId }
    let root = targetWindowElement(pid: pid_t(target.pid), window: targetWindow)
    guard let ref = string(request["ref"]), let text = request["text"] as? String,
          let element = resolveElement(ref: ref, root: root) else { fail("The accessibility reference is stale; observe again") }
    validateElement(element, expected: request["expected"] as? JSON)
    let role = axString(element, kAXRoleAttribute as CFString)
    let subrole = axString(element, kAXSubroleAttribute as CFString)
    if role == "AXSecureTextField" || subrole == "AXSecureTextField" { fail("Secure text fields require user takeover") }
    guard text.utf16.count <= 8_000 else { fail("Text input is too long") }
    guard AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFTypeRef) == .success else {
        fail("The control does not support direct text entry")
    }
    respond(["characters": text.count])

default:
    fail("Unknown helper command")
}
