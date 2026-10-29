import Foundation

/// Pure policies: guidance never prevents saving partial work.
struct CaptureQuality {
  let percent: Int
  let walls: Int
  let photos: Int
  var ready: Bool { walls >= 3 && photos >= 8 && percent >= 85 }
  var message: String {
    if walls < 3 { return "Measuring the room and saving photos automatically." }
    if photos < 8 { return "Collecting useful viewpoints automatically as you scan." }
    if ready { return "Good photo detail. Save and review for gaps." }
    return "Photos are saved automatically as you move around the room."
  }
}

struct CaptureBudget {
  let constrained: Bool
  let critical: Bool
  init(thermal: ProcessInfo.ThermalState, photos: Int, memoryPressure: Bool) {
    critical = thermal == .critical
    constrained = memoryPressure || photos >= 150 || thermal == .serious || critical
  }
  var depthInterval: Double { critical ? 1 : constrained ? 0.5 : 0.2 }
  var evaluationInterval: Double { constrained ? 0.3 : 0.1 }
  var photoInterval: Double { constrained ? 1.2 : 0.4 }
}
