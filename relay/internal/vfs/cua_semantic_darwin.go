//go:build darwin

package vfs

import "github.com/PekingSpades/Synapse/relay/internal/relaypaths"

func newCUASemanticProvider(paths relaypaths.ResolvedPaths) cuaSemanticProvider {
	return &scriptCUASemanticProvider{
		backend:     "ax",
		interpreter: "swift",
		extension:   ".swift",
		tempRoot:    semanticProviderTempRoot(paths),
		args:        []string{},
		script: `import Foundation
import ApplicationServices
import AppKit

struct Rect: Codable {
    let x: Int
    let y: Int
    let w: Int
    let h: Int
}

struct Node: Codable {
    let id: String
    let parentId: String
    let depth: Int
    let role: String
    let name: String
    let description: String
    let value: String
    let text: String
    let bounds: Rect
    let state: [String]
    let attributes: [String: String]
    let appName: String
    let windowTitle: String
    let processId: Int
    let summary: String
    var childIds: [String]
    var actions: [String]
}

struct Tree: Codable {
    let supported: Bool
    let backend: String
    let message: String
    let appName: String
    let windowTitle: String
    let processId: Int
    let rootIds: [String]
    let focusedId: String
    let nodes: [Node]
}

func emit(_ tree: Tree) {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(tree), let text = String(data: data, encoding: .utf8) {
        print(text)
    } else {
        print("{\"supported\":false,\"backend\":\"ax\",\"message\":\"failed to encode AX tree\",\"rootIds\":[],\"nodes\":[]}")
    }
}

func clip(_ value: String?, limit: Int = 240) -> String {
    let text = (value ?? "").replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty {
        return ""
    }
    if text.count <= limit {
        return text
    }
    return String(text.prefix(limit)) + "…"
}

func axValue(_ element: AXUIElement, _ attr: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, attr, &value)
    if error == .success {
        return value
    }
    return nil
}

func stringAttr(_ element: AXUIElement, _ attr: CFString) -> String {
    if let value = axValue(element, attr) {
        if CFGetTypeID(value) == CFStringGetTypeID() {
            return clip(value as? String, limit: 200)
        }
    }
    return ""
}

func boolAttr(_ element: AXUIElement, _ attr: CFString) -> Bool? {
    if let value = axValue(element, attr) {
        if CFGetTypeID(value) == CFBooleanGetTypeID() {
            return (value as? Bool) ?? false
        }
    }
    return nil
}

func pointAttr(_ element: AXUIElement, _ attr: CFString) -> CGPoint? {
    guard let value = axValue(element, attr) else { return nil }
    guard CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    let axValue = value as! AXValue
    if AXValueGetType(axValue) != .cgPoint {
        return nil
    }
    var point = CGPoint.zero
    return AXValueGetValue(axValue, .cgPoint, &point) ? point : nil
}

func sizeAttr(_ element: AXUIElement, _ attr: CFString) -> CGSize? {
    guard let value = axValue(element, attr) else { return nil }
    guard CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    let axValue = value as! AXValue
    if AXValueGetType(axValue) != .cgSize {
        return nil
    }
    var size = CGSize.zero
    return AXValueGetValue(axValue, .cgSize, &size) ? size : nil
}

func bounds(_ element: AXUIElement) -> Rect {
    let point = pointAttr(element, kAXPositionAttribute as CFString) ?? .zero
    let size = sizeAttr(element, kAXSizeAttribute as CFString) ?? .zero
    return Rect(x: Int(point.x), y: Int(point.y), w: Int(size.width), h: Int(size.height))
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    if let value = axValue(element, kAXChildrenAttribute as CFString) {
        if CFGetTypeID(value) == CFArrayGetTypeID() {
            return (value as? [AXUIElement]) ?? []
        }
    }
    if let value = axValue(element, kAXVisibleChildrenAttribute as CFString) {
        if CFGetTypeID(value) == CFArrayGetTypeID() {
            return (value as? [AXUIElement]) ?? []
        }
    }
    return []
}

func roleName(_ element: AXUIElement) -> String {
    clip(stringAttr(element, kAXRoleAttribute as CFString), limit: 120)
}

func valueText(_ element: AXUIElement) -> String {
    let value = stringAttr(element, kAXValueAttribute as CFString)
    if !value.isEmpty {
        return value
    }
    return stringAttr(element, kAXTitleAttribute as CFString)
}

func summary(_ role: String, _ name: String, _ value: String) -> String {
    var parts: [String] = []
    if !role.isEmpty { parts.append("[" + role + "]") }
    if !name.isEmpty { parts.append(String(reflecting: name)) }
    if !value.isEmpty && value != name { parts.append(String(reflecting: value)) }
    return clip(parts.joined(separator: " "), limit: 240)
}

if !AXIsProcessTrusted() {
    emit(Tree(supported: false, backend: "ax", message: "Accessibility permission is not granted for this process. Enable it in System Settings > Privacy & Security > Accessibility.", appName: "", windowTitle: "", processId: 0, rootIds: [], focusedId: "", nodes: []))
    exit(0)
}

guard let app = NSWorkspace.shared.frontmostApplication else {
    emit(Tree(supported: false, backend: "ax", message: "No frontmost macOS application is available.", appName: "", windowTitle: "", processId: 0, rootIds: [], focusedId: "", nodes: []))
    exit(0)
}

let system = AXUIElementCreateSystemWide()
let focusedElement = axValue(system, kAXFocusedUIElementAttribute as CFString) as? AXUIElement
let appElement = AXUIElementCreateApplication(app.processIdentifier)

var root = focusedElement ?? appElement
var parent = axValue(root, kAXParentAttribute as CFString) as? AXUIElement
while let currentParent = parent {
    let role = roleName(currentParent)
    if role == kAXApplicationRole as String {
        break
    }
    root = currentParent
    parent = axValue(currentParent, kAXParentAttribute as CFString) as? AXUIElement
}

let MAX_NODES = 800
var nodes: [Node] = []
var focusedId = ""
var truncated = false

func serialize(_ element: AXUIElement, parentId: String, id: String, depth: Int) {
    if nodes.count >= MAX_NODES {
        truncated = true
        return
    }
    let role = roleName(element)
    let name = clip(stringAttr(element, kAXTitleAttribute as CFString).isEmpty ? stringAttr(element, kAXDescriptionAttribute as CFString) : stringAttr(element, kAXTitleAttribute as CFString), limit: 200)
    let description = stringAttr(element, kAXDescriptionAttribute as CFString)
    let value = valueText(element)
    let text = value
    var state: [String] = []
    if (boolAttr(element, kAXFocusedAttribute as CFString) ?? false) {
        state.append("focused")
        if focusedId.isEmpty { focusedId = id }
    }
    if (boolAttr(element, kAXEnabledAttribute as CFString) ?? true) {
        state.append("enabled")
    } else {
        state.append("disabled")
    }
    if (boolAttr(element, kAXSelectedAttribute as CFString) ?? false) {
        state.append("selected")
    }
    if (boolAttr(element, kAXExpandedAttribute as CFString) ?? false) {
        state.append("expanded")
    }
    let windowTitle = stringAttr(element, kAXTitleAttribute as CFString)
    var node = Node(
        id: id,
        parentId: parentId,
        depth: depth,
        role: role,
        name: name,
        description: description,
        value: value,
        text: text,
        bounds: bounds(element),
        state: state,
        attributes: [:],
        appName: clip(app.localizedName, limit: 160),
        windowTitle: windowTitle,
        processId: Int(app.processIdentifier),
        summary: summary(role, name, value),
        childIds: [],
        actions: []
    )
    let childrenElements = children(element)
    for (index, child) in childrenElements.enumerated() {
        let childId = id == "root" ? "\(index)" : "\(id).\(index)"
        node.childIds.append(childId)
        serialize(child, parentId: id, id: childId, depth: depth + 1)
    }
    nodes.append(node)
}

serialize(root, parentId: "", id: "root", depth: 0)
let message = truncated ? "AX tree was truncated at \(MAX_NODES) nodes." : ""
emit(Tree(supported: true, backend: "ax", message: message, appName: clip(app.localizedName, limit: 160), windowTitle: stringAttr(root, kAXTitleAttribute as CFString), processId: Int(app.processIdentifier), rootIds: ["root"], focusedId: focusedId, nodes: nodes))
`,
	}
}
