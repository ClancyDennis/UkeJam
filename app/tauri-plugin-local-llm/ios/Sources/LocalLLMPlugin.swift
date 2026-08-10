import FoundationModels
import SwiftRs
import Tauri
import UIKit
import WebKit

/// One OpenAI-style chat turn coming from the web layer.
struct ChatMessageArg: Decodable {
    let role: String
    let content: String
}

/// Mirrors the Rust `ChatRequest` payload.
struct ChatRequestArgs: Decodable {
    let messages: [ChatMessageArg]
    let maxTokens: Int?
    let temperature: Double?
}

/// Bridges Apple's on-device Foundation model to Tauri's `invoke` mechanism.
/// One stateless `chat` per call — a fresh session whose `system` messages
/// become the instructions — which fits ukejam's one completion per tab import.
class LocalLLMPlugin: Plugin {
    /// Why on-device generation is (un)available, so the UI can explain rather
    /// than silently offering a mode that will fail.
    @objc public func availability(_ invoke: Invoke) {
        invoke.resolve(["status": LocalLLMPlugin.availabilityStatus()])
    }

    /// Single completion within a fresh session. The `system` messages become
    /// the model's instructions; the remaining turns become the prompt.
    @objc public func chat(_ invoke: Invoke) {
        guard #available(iOS 26.0, *) else {
            invoke.reject("This device's OS doesn't support on-device models.")
            return
        }

        let args: ChatRequestArgs
        do {
            args = try invoke.parseArgs(ChatRequestArgs.self)
        } catch {
            invoke.reject("Invalid chat request: \(error.localizedDescription)")
            return
        }

        let instructions = args.messages
            .filter { $0.role == "system" }
            .map { $0.content }
            .joined(separator: "\n\n")
        let prompt = args.messages
            .filter { $0.role != "system" }
            .map { $0.content }
            .joined(separator: "\n\n")

        Task {
            do {
                let model = SystemLanguageModel.default
                guard model.isAvailable else {
                    invoke.reject("The on-device model is not available right now.")
                    return
                }

                let session = instructions.isEmpty
                    ? LanguageModelSession()
                    : LanguageModelSession(instructions: instructions)

                let options = GenerationOptions(
                    temperature: args.temperature,
                    maximumResponseTokens: args.maxTokens
                )

                let response = try await session.respond(to: prompt, options: options)
                invoke.resolve(["content": response.content])
            } catch {
                invoke.reject("On-device generation failed: \(error.localizedDescription)")
            }
        }
    }

    private static func availabilityStatus() -> String {
        if #available(iOS 26.0, *) {
            let model = SystemLanguageModel.default
            switch model.availability {
            case .available:
                // Apple Intelligence is gated on the Siri language, not the
                // system language — an English device can still report
                // available yet reject generation if Siri's language is off.
                return model.supportsLocale(Locale.current) ? "available" : "languageNotSupported"
            case let .unavailable(reason):
                switch reason {
                case .deviceNotEligible:
                    return "deviceNotEligible"
                case .appleIntelligenceNotEnabled:
                    return "appleIntelligenceNotEnabled"
                case .modelNotReady:
                    return "modelNotReady"
                @unknown default:
                    return "unavailable"
                }
            }
        }
        return "unsupportedOS"
    }
}

@_cdecl("init_plugin_local_llm")
func initPlugin() -> Plugin {
    return LocalLLMPlugin()
}
