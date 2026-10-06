import XCTest
final class WorkUpdatesUITests:XCTestCase {
    override func setUpWithError() throws {continueAfterFailure=false}
    private func launchDemo()->XCUIApplication {
        let app=XCUIApplication();app.launchArguments=["--demo"];app.launch();return app
    }
    private func capture(_ name:String) {
        let image=XCTAttachment(screenshot:XCUIApplication().screenshot());image.name=name;image.lifetime = .keepAlways;add(image)
    }
    func testNotificationHierarchyAndClickDetails() {
        let app=launchDemo()
        XCTAssertTrue(app.buttons["notification-choice"].waitForExistence(timeout:10))
        XCTAssertTrue(app.staticTexts["Choose the compact layout"].exists)
        capture("Portrait queue")
        app.buttons["notification-choice"].tap()
        XCTAssertTrue(app.buttons["reviewed"].waitForExistence(timeout:5))
        XCTAssertTrue(app.buttons["snooze"].exists)
        XCTAssertTrue(app.staticTexts["Chat · Interface review"].exists)
        capture("Native task sheet")
        app.buttons["dismiss-chat"].tap()
        XCTAssertTrue(app.buttons["notification-choice"].exists)
    }
    func testDevicesAndComposerAreNativeSheets() {
        let app=launchDemo();app.buttons["devices"].tap()
        XCTAssertTrue(app.navigationBars["Your devices"].waitForExistence(timeout:5))
        XCTAssertTrue(app.staticTexts["Windows PC"].exists)
        app.navigationBars["Your devices"].buttons["Done"].tap()
        app.buttons["new-task"].tap()
        XCTAssertTrue(app.textFields["task-title"].waitForExistence(timeout:5))
        XCTAssertFalse(app.buttons["queue-task"].isEnabled)
        app.buttons["Cancel"].tap()
    }
    func testLandscapeRemainsScrollable() {
        let app=launchDemo();XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(app.buttons["devices"].waitForExistence(timeout:5))
        app.swipeUp();XCTAssertTrue(app.buttons["notification-work"].exists)
        capture("Landscape queue")
        XCUIDevice.shared.orientation = .portrait
    }
    func testLargeTypeRemainsUsable() {
        let app=XCUIApplication();app.launchArguments=["--demo","--large-type"];app.launch()
        XCTAssertTrue(app.buttons["notification-choice"].waitForExistence(timeout:10))
        capture("Accessibility text queue")
        app.buttons["notification-choice"].tap()
        XCTAssertTrue(app.buttons["dismiss-chat"].waitForExistence(timeout:5))
        app.swipeUp();XCTAssertTrue(app.buttons["snooze"].exists)
        capture("Accessibility task sheet")
        app.buttons["dismiss-chat"].tap()
    }
    func testRealNativePhoneQueueReplyAndReview() throws {
        let file=ProcessInfo.processInfo.environment["WU_TEST_CODE_FILE"] ?? "/tmp/work-updates-ios-pairing-code"
        guard let code=try? String(contentsOfFile:file,encoding:.utf8) else {throw XCTSkip("Private synthetic TLS fixture is not running.")}
        let app=XCUIApplication();app.launchArguments=["--integration-test"]
        app.launchEnvironment["WU_PAIRING_CODE"]=code
        app.launch()
        XCTAssertTrue(app.staticTexts["Connected to Test computer"].waitForExistence(timeout:20))
        app.buttons["new-task"].tap()
        app.textFields["task-title"].tap();app.textFields["task-title"].typeText("iPhone integration sample")
        app.textViews["task-prompt"].tap();app.textViews["task-prompt"].typeText("Synthetic completion only.")
        app.buttons["queue-start-task"].tap()
        let card=app.buttons.matching(NSPredicate(format:"label CONTAINS %@","iPhone integration sample")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout:20));card.tap()
        let input=app.textViews["chat-input"]
        XCTAssertTrue(input.waitForExistence(timeout:10));input.tap();input.typeText("Synthetic follow-up.\n")
        XCTAssertTrue(app.staticTexts["Synthetic follow-up."].waitForExistence(timeout:15))
        app.swipeUp();app.buttons["reviewed"].tap()
        XCTAssertTrue(app.buttons["queue-menu"].waitForExistence(timeout:10))
    }
}
