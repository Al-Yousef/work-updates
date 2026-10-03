// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "WorkUpdatesCore", platforms: [.iOS(.v17), .macOS(.v13)],
    products: [.library(name: "WorkUpdatesCore", targets: ["WorkUpdatesCore"])],
    targets: [.target(name: "WorkUpdatesCore"), .testTarget(name: "WorkUpdatesCoreTests", dependencies: ["WorkUpdatesCore"])])
