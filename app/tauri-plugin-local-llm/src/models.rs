use serde::{Deserialize, Serialize};

/// One OpenAI-style chat turn. The app already speaks this shape, so the
/// bridge accepts it verbatim and the Swift side splits `system` (instructions)
/// from the conversation turns.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub messages: Vec<ChatMessage>,
    /// Caps the on-device response length (maps to `maximumResponseTokens`).
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub temperature: Option<f64>,
}

/// The generated completion text. Callers wrap this back into an OpenAI
/// `choices[0].message.content` envelope where they need one.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatReply {
    pub content: String,
}

/// Mirrors the native availability enum so the UI can explain why on-device is
/// off rather than silently failing: `available`, `deviceNotEligible`,
/// `appleIntelligenceNotEnabled`, `modelNotReady`, `languageNotSupported`,
/// `unsupportedOS`, `unsupportedHost`, or `unavailable`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AvailabilityResponse {
    pub status: String,
}
