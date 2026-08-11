import AuthenticationServices
import SwiftRs
import Tauri
import UIKit

/// Mirrors the Rust `NativeAuthorizeRequest` payload.
struct AuthorizeArgs: Decodable {
    /// The provider's authorize URL, redirect URI already appended by the Rust
    /// side (it owns the loopback listener that redirect points at).
    let url: String
    /// Custom scheme the loopback callback bounces to. The session watches for
    /// it and dismisses itself on the first navigation that uses it — no
    /// `Info.plist` registration and no associated domain involved.
    let scheme: String
}

/// Presents sign-in in a Safari-backed sheet rather than the app's webview.
///
/// `ASWebAuthenticationSession` is the only iOS surface that gives a web
/// sign-in everything the player expects: a Cancel button and a visible URL,
/// Safari's cookie jar (so an existing openrouter.ai session needs one tap),
/// iCloud Keychain autofill, passkeys, and federated sign-in that identity
/// providers don't reject the way they reject embedded webviews.
class WebAuthPlugin: Plugin, ASWebAuthenticationPresentationContextProviding {
    /// Exact string the web layer branches on — a dismissal is a normal
    /// outcome, not an error worth reporting as a failure.
    static let cancelledSentinel = "cancelled"

    /// The session deallocates (and the sheet vanishes) if nothing holds it.
    private var session: ASWebAuthenticationSession?

    @objc public func authorize(_ invoke: Invoke) {
        let args: AuthorizeArgs
        do {
            args = try invoke.parseArgs(AuthorizeArgs.self)
        } catch {
            invoke.reject("Invalid sign-in request: \(error.localizedDescription)")
            return
        }
        guard let url = URL(string: args.url) else {
            invoke.reject("The sign-in URL could not be parsed.")
            return
        }

        // Commands arrive on the plugin manager's IPC queue; UIKit presentation
        // has to happen on the main thread.
        DispatchQueue.main.async { [weak self] in
            guard let self = self else {
                invoke.reject("The sign-in sheet is no longer available.")
                return
            }
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: args.scheme
            ) { callbackURL, error in
                self.session = nil
                if let callbackURL = callbackURL {
                    invoke.resolve(["callbackUrl": callbackURL.absoluteString])
                    return
                }
                if let error = error as? ASWebAuthenticationSessionError,
                    error.code == .canceledLogin
                {
                    invoke.reject(WebAuthPlugin.cancelledSentinel)
                    return
                }
                invoke.reject(error?.localizedDescription ?? "The sign-in sheet closed unexpectedly.")
            }
            session.presentationContextProvider = self
            // Deliberately NOT ephemeral. The shared Safari data store is the
            // whole point: it's what makes an existing provider session,
            // Keychain passwords and passkeys reachable from the sheet. It is
            // also what prompts iOS's one-time "…wants to use openrouter.ai to
            // sign in" consent alert.
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            if !session.start() {
                self.session = nil
                invoke.reject("iOS would not present the sign-in sheet.")
            }
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        if let window = manager.viewController?.view.window {
            return window
        }
        // The plugin manager learns its view controller when the webview is
        // created; fall back to the active scene in case that ordering ever
        // changes, since a detached anchor cannot present anything.
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
        return windows.first(where: { $0.isKeyWindow }) ?? windows.first ?? ASPresentationAnchor()
    }
}

@_cdecl("init_plugin_web_auth")
func initPlugin() -> Plugin {
    return WebAuthPlugin()
}
