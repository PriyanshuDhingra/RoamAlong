import ExpoModulesCore
import CoreMotion

public class HeadphoneMotionModule: Module {
  private let manager = CMHeadphoneMotionManager()

  public func definition() -> ModuleDefinition {
    Name("HeadphoneMotion")

    Events("onHeadphoneMotion")

    Function("isAvailable") { () -> Bool in
      return self.manager.isDeviceMotionAvailable
    }

    Function("start") { () -> Bool in
      guard self.manager.isDeviceMotionAvailable else {
        return false
      }
      if self.manager.isDeviceMotionActive {
        return true
      }
      self.manager.startDeviceMotionUpdates(to: OperationQueue.main) { [weak self] motion, error in
        guard let self = self, let motion = motion, error == nil else {
          return
        }
        // CoreMotion yaw is counter-clockwise (left positive) in radians; convert to clockwise degrees
        let yawDeg = -motion.attitude.yaw * 180.0 / .pi
        let pitchDeg = motion.attitude.pitch * 180.0 / .pi
        let rollDeg = motion.attitude.roll * 180.0 / .pi
        self.sendEvent("onHeadphoneMotion", [
          "yawDeg": yawDeg,
          "pitchDeg": pitchDeg,
          "rollDeg": rollDeg
        ])
      }
      return true
    }

    Function("stop") {
      if self.manager.isDeviceMotionActive {
        self.manager.stopDeviceMotionUpdates()
      }
    }
  }
}
