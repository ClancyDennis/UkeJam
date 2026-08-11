// Apple on-device model host for macOS, driven over newline-delimited JSON.
//
// One request per stdin line, one reply per stdout line, correlated by `id` so
// replies may come back out of order — each generation takes seconds and several
// may be in flight.
//
// The command set and error strings mirror the iOS plugin, trimmed to ukejam's
// needs: `availability` and one-shot `chat`.
import Foundation
import FoundationModels

// MARK: - Wire types

struct Request: Decodable {
    let id: Int
    let cmd: String
    let messages: [WireMessage]?
    let maxTokens: Int?
    let temperature: Double?
}

struct WireMessage: Decodable {
    let role: String
    let content: String
}

/// Replies are hand-encoded so a serialisation failure can never swallow a reply
/// and leave the Rust side waiting forever.
func reply(_ fields: [String: Any]) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: fields),
        let text = String(data: data, encoding: .utf8)
    else {
        return "{\"id\":0,\"ok\":false,\"error\":\"helper failed to encode a reply\"}"
    }
    return text
}

/// stdout is shared by every in-flight request, so writes are serialised through
/// one actor. A partial interleaved line would corrupt the protocol.
actor Out {
    static let shared = Out()
    func send(_ line: String) {
        FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }
}

// MARK: - Availability

@available(macOS 26.0, *)
func availabilityStatus() -> String {
    switch SystemLanguageModel.default.availability {
    case .available:
        return "available"
    case .unavailable(let reason):
        switch reason {
        case .deviceNotEligible: return "deviceNotEligible"
        case .appleIntelligenceNotEnabled: return "appleIntelligenceNotEnabled"
        case .modelNotReady: return "modelNotReady"
        @unknown default: return "unavailable"
        }
    @unknown default:
        return "unavailable"
    }
}

/// Translate a generation failure into a message the UI can show as-is.
@available(macOS 26.0, *)
func describe(_ error: Error) -> String {
    if let generation = error as? LanguageModelSession.GenerationError {
        if case .exceededContextWindowSize = generation {
            return "the tab is too long for the on-device model's context window"
        }
        if case .guardrailViolation = generation {
            return "the on-device model's safety guardrail rejected this text — try again or use a cloud provider"
        }
    }
    return "On-device generation failed: \(error.localizedDescription)"
}

// MARK: - Command handling

@available(macOS 26.0, *)
func handle(_ request: Request) async {
    let id = request.id

    func fail(_ message: String) async {
        await Out.shared.send(reply(["id": id, "ok": false, "error": message]))
    }
    func ok(_ fields: [String: Any]) async {
        await Out.shared.send(reply(fields.merging(["id": id, "ok": true]) { a, _ in a }))
    }

    switch request.cmd {
    case "availability":
        await ok(["status": availabilityStatus()])

    case "chat":
        // Stateless one-shot: `system` messages become the instructions, the rest
        // the prompt — same split as the iOS plugin's `chat`.
        guard SystemLanguageModel.default.isAvailable else {
            await fail("The on-device model is not available right now.")
            return
        }
        let messages = request.messages ?? []
        let instructions = messages.filter { $0.role == "system" }.map(\.content).joined(
            separator: "\n\n")
        let prompt = messages.filter { $0.role != "system" }.map(\.content).joined(
            separator: "\n\n")
        let session =
            instructions.isEmpty
            ? LanguageModelSession() : LanguageModelSession(instructions: instructions)
        let options = GenerationOptions(
            temperature: request.temperature, maximumResponseTokens: request.maxTokens)
        do {
            let response = try await session.respond(to: prompt, options: options)
            await ok(["content": response.content])
        } catch {
            await fail(describe(error))
        }

    default:
        await fail("unknown command: \(request.cmd)")
    }
}

// MARK: - Main loop

guard #available(macOS 26.0, *) else {
    // Report the same status the Rust stub used to, then exit quietly. The plugin
    // treats a helper that will not start as "no on-device model".
    print("{\"id\":0,\"ok\":true,\"status\":\"unsupportedOS\"}")
    exit(0)
}

// Fan each request out to its own Task, so a multi-second generation never
// blocks the next request from being read.
let decoder = JSONDecoder()
while let line = readLine(strippingNewline: true) {
    if line.isEmpty { continue }
    guard let request = try? decoder.decode(Request.self, from: Data(line.utf8)) else {
        await Out.shared.send(
            reply(["id": 0, "ok": false, "error": "helper could not parse a request line"]))
        continue
    }
    // DETACHED deliberately. Top-level code in main.swift is MainActor-bound, so a
    // plain `Task { }` would inherit MainActor and could never run while this loop
    // sits blocked in readLine() — the helper would accept requests and answer
    // none. Detaching runs generation on the cooperative pool instead.
    Task.detached { await handle(request) }
}

// stdin closed — the app is gone, so are we. In-flight work is abandoned
// deliberately: its answers have nowhere to go.
