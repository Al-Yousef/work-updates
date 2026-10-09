import XCTest
import WorkUpdatesCore
@testable import WorkUpdates

final class PhoneAssistantTests:XCTestCase {
    @MainActor func testCancelledStartupCannotClearANewerSessionOrReadCredentials() async throws {
        var credentialReads=0,credentialWrites=0
        let assistant=PhoneAssistant(loadCredential:{credentialReads+=1;return nil},saveCredential:{_ in credentialWrites+=1})
        let current: [String:Any]=[
            "schema":1,"version":1,"channelId":"11111111-1111-4111-8111-111111111111",
            "hostId":"22222222-2222-4222-8222-222222222222","actorId":"human:synthetic",
            "epoch":"33333333-3333-4333-8333-333333333333","until":1000,
            "responding":false,"error":false,"messages":[],
            "stateVersion":["epoch":"33333333-3333-4333-8333-333333333333","revision":1],
            "capabilities":["history":true,"questions":true,"taskActions":false,"attachments":false,"sharedAudience":false]]
        let state=try JSONDecoder().decode(AssistantChannelState.self,from:JSONSerialization.data(withJSONObject:current))
        assistant.state=state;assistant.message="Current synthetic session"
        // MainActor cannot run this task until the test yields. Cancellation
        // therefore precedes connect entry, reproducing a superseded view task.
        let superseded=Task { @MainActor in await assistant.connect() }
        superseded.cancel();await superseded.value
        XCTAssertEqual(credentialReads,0)
        XCTAssertEqual(credentialWrites,0)
        XCTAssertEqual(assistant.state?.channelId,state.channelId)
        XCTAssertEqual(assistant.state?.epoch,state.epoch)
        XCTAssertEqual(assistant.message,"Current synthetic session")
    }
}
