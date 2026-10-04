import Foundation
import Speech

// asi-speech <audio-file> [locale]
// Transcribes a recording with Apple's on-device recognizer and prints one line of JSON.
// It refuses to run if the recognizer cannot work on-device: audio never leaves this Mac.

func finish(_ obj: [String: Any], code: Int32) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: obj)
    print(String(data: data, encoding: .utf8)!)
    exit(code)
}

let args = CommandLine.arguments
guard args.count >= 2 else { finish(["error": "usage: asi-speech <audio-file> [locale]"], code: 64) }
let url = URL(fileURLWithPath: args[1])
let locale = Locale(identifier: args.count >= 3 ? args[2] : "en-US")

if args[1] == "--status" {
    let s = SFSpeechRecognizer.authorizationStatus()
    let name = ["notDetermined", "denied", "restricted", "authorized"][Int(s.rawValue)]
    finish(["status": name, "onDevice": SFSpeechRecognizer(locale: locale)?.supportsOnDeviceRecognition ?? false], code: 0)
}

let sem = DispatchSemaphore(value: 0)
var authStatus: SFSpeechRecognizerAuthorizationStatus = .notDetermined
SFSpeechRecognizer.requestAuthorization { authStatus = $0; sem.signal() }
sem.wait()
guard authStatus == .authorized else { finish(["error": "speech recognition is not allowed", "status": "\(authStatus.rawValue)"], code: 3) }

guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else { finish(["error": "no recognizer for \(locale.identifier)"], code: 4) }
guard recognizer.supportsOnDeviceRecognition else { finish(["error": "on-device recognition is not available for \(locale.identifier); download the language in System Settings > Keyboard > Dictation"], code: 5) }

let request = SFSpeechURLRecognitionRequest(url: url)
request.requiresOnDeviceRecognition = true
request.shouldReportPartialResults = false
request.addsPunctuation = true

var done = false
recognizer.recognitionTask(with: request) { result, error in
    if let result = result, result.isFinal {
        finish(["text": result.bestTranscription.formattedString], code: 0)
    } else if let error = error {
        // "No speech detected" is not a failure for push-to-talk
        let msg = error.localizedDescription
        if msg.lowercased().contains("no speech") { finish(["text": ""], code: 0) }
        finish(["error": msg], code: 6)
    }
}
while !done { RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.2)) ; if false { done = true } }
